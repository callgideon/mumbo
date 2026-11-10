/**
 * Local Service Provider for the subprocess capability seam. Each spawn owns a
 * platform-selected managed range with the spec's per-stream stdio dispositions.
 * Normal disposal terminates and joins live ranges; Node's synchronous exit
 * phase force-stops any ranges the service still owns. Every disposition and
 * limit arrives on the spec, so deployment-varying choices stay with the
 * caller's config (the bash executor's, the LSP host's, …). The provider
 * config `runAs` starts every child on Linux as a fixed non-root identity with
 * an explicit environment; `identities` adds further such identities that a
 * spawn spec selects by name. A run-as child never receives this process's
 * standard output or error: output a spec asks to inherit is read and discarded.
 * @module @deepseek-ai/dsh-subprocess-local
 */

import { constants, statSync } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { delimiter, extname, isAbsolute, resolve } from 'node:path'
import type { Duplex } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type * as NodePty from 'node-pty'
import type { IPtyForkOptions, IWindowsPtyForkOptions } from 'node-pty'
import { createLazyRequire } from '@deepseek-ai/dsh-lazy-require'
import { SubprocessRuntime, SubprocessExecutableNotFoundError } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessHandle,
  SubprocessSpawnSpec,
  SubprocessTerminalHandle,
  SubprocessTerminalEnvironment,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import {
  bindManagedProcess,
  childEnv,
  spawnSubprocess,
  validateSubprocessSpec,
} from './spawn.ts'
import { logSpillFailure, prepareManagedProcessBinding } from './output.ts'
import type { LocalSubprocessHandle, SpawnInternals } from './spawn.ts'
import {
  confirmLinuxManager,
  LinuxScopeNotStartedError,
  launchLinuxBootstrap,
  launchLinuxScope,
  linuxManagerListener,
  prepareLinuxTerminalBootstrap,
  prepareLinuxTerminalScope,
  probeLinuxBootstrap,
  probeLinuxNative,
  signalLinuxDirectProcess,
  systemdRunIdentity,
} from './linux-scope.ts'
import type { LinuxTerminalBootstrapLaunch, LinuxTerminalScopeLaunch } from './linux-scope.ts'
import {
  assertNoSecretNames, assertPrivateDirectory, assertRunAsHost, assertSearchable, credentialsOf, IDENTITY_NAME, RunAs,
  runAsEnvironment, validateRunAs,
} from './run-as.ts'
import type { RunAsIdentity } from './run-as.ts'
import { LinuxScopeSelector } from './linux-scope-selector.ts'
import type { LinuxScopeDecision } from './linux-scope-selector.ts'
import { launchWindowsJob, probeWindowsJob } from './windows-job.ts'
import { targetEnvironment } from './runner-launch.ts'
import { createProcessInspector } from './process-inspector.ts'
import type { ProcessInspector } from './process-inspector.ts'
import { LocalTerminalHandle } from './terminal.ts'
import { prepareShellActivity } from './shell-activity.ts'

const requireNodePty = createLazyRequire<typeof NodePty>('node-pty', import.meta.url)

export { SubprocessSecretEnvironmentError } from './run-as.ts'
export type { RunAs, RunAsIdentity } from './run-as.ts'

/** Provider configuration. */
export interface Config {
  /** Start every child as this identity with this environment; omitted, children run as this process with its scrubbed environment. */
  runAs?: RunAs | undefined
  /**
   * Further run-as identities by name, each with its own environment and secret names. A spawn spec that names one
   * starts its child as it; every other child starts as `runAs`, which these require. A spawn naming an identity not
   * listed here is refused.
   */
  identities?: Record<string, RunAs> | undefined
  /**
   * Absolute existing directory that receives each interactive shell's private activity records; omitted, the OS
   * temporary directory. Under `runAs` it must be writable by no other user, directly or through an ancestor, and
   * searchable by the run-as user through every ancestor, so a root-only temporary directory needs this set.
   */
  shellActivityDirectory?: string | undefined
  /**
   * Absolute existing directory that receives spill files, created mode `0640`; omitted, a private per-process
   * directory under the OS temporary directory. Under `runAs` it must be writable by no other user, directly or
   * through an ancestor.
   */
  spillDirectory?: string | undefined
}

/** The directories a provider writes into, resolved from its config. */
interface Directories {
  /** Parent of each interactive shell's activity record directory. */
  shellActivity: string
  /** Spill file directory; undefined selects the private per-process directory. */
  spill: string | undefined
}

/**
 * Resolve and check the directories of a provider config, failing at load on any unusable entry. Under `runAs` each
 * directory is replaced by the real path the checks examined, so no later write goes through a link in its spelling.
 * @param config - the provider config.
 * @returns the resolved directories.
 * @throws when an entry is not an absolute existing directory, or under `runAs` fails its ownership or search check.
 */
function resolveDirectories(config: Config): Directories {
  for (const [field, path] of [['shellActivityDirectory', config.shellActivityDirectory], ['spillDirectory', config.spillDirectory]] as const) {
    if (path === undefined) continue
    let directory = false
    try {
      directory = isAbsolute(path) && statSync(path).isDirectory()
    } catch (_missing) {
      // Reported below as not an existing directory.
    }
    if (!directory) throw new Error(`subprocess-local: ${field} ${JSON.stringify(path)} must be an absolute existing directory`)
  }
  const directories = { shellActivity: config.shellActivityDirectory ?? tmpdir(), spill: config.spillDirectory }
  const runAs = config.runAs
  if (runAs === undefined) return directories
  const unshared = (field: string, path: string): string => `subprocess-local: ${field} ${JSON.stringify(path)} must be owned by this process and writable by no other user, directly or through an ancestor`
  const shellActivity = assertPrivateDirectory(directories.shellActivity, unshared(config.shellActivityDirectory === undefined ? 'shellActivityDirectory (the temporary directory)' : 'shellActivityDirectory', directories.shellActivity))
  assertSearchable(shellActivity, credentialsOf(runAs), path => `subprocess-local: the run-as user (uid ${runAs.uid}) cannot search ${JSON.stringify(path)}, so its shells cannot reach their activity records under ${JSON.stringify(shellActivity)}; set shellActivityDirectory to a directory it can search, such as /run/dsh-shell (root, 0711)`)
  const spill = directories.spill === undefined ? undefined : assertPrivateDirectory(directories.spill, unshared('spillDirectory', directories.spill))
  return { shellActivity, spill }
}

/**
 * Local subprocess service: platform-selected managed ranges, Node-shaped stdio
 * dispositions (raw pipes, inherit, bounded tail-keep collection with spill
 * files), credential-scrubbed environment, and provider-owned range signalling.
 * POSIX paths stage TERM before KILL; Windows paths terminate immediately.
 * JavaScript-observable host exit also performs synchronous final termination.
 */
export class LocalSubprocessRuntime extends SubprocessRuntime {
  /** Live handles retained for normal disposal and synchronous host-exit finalization. */
  private live = new Set<LocalSubprocessHandle>()
  /** Live terminals retained through normal quiescence or host-exit finalization. */
  private terminals = new Set<LocalTerminalHandle>()
  /** Caller endpoints retained until close, independently of managed process lifetime. */
  private controlChannels = new Set<Duplex>()
  /** Test hook: process, spill, and platform operations forwarded to spawnSubprocess. */
  internals: SpawnInternals = {}
  /** Provider-lifetime latch suppressing repeated weaker-containment warnings. */
  private fallbackWarningIssued = false
  /**
   * Linux native containment decisions. Each probe is a spawnSync that blocks the event loop and forks the
   * host, so the selector reruns it only after an event invalidates the previous verdict.
   */
  private readonly linuxScope = new LinuxScopeSelector({
    probe: () => probeLinuxNative(),
    managerListener: () => linuxManagerListener(),
    confirmManager: () => confirmLinuxManager(),
    launcherIdentity: () => systemdRunIdentity(),
  })
  /** Scope decision of the launch in progress; selectContainmentMode sets it immediately before the launch reads it. */
  private linuxScopeDecision: Extract<LinuxScopeDecision, { kind: 'scope' }> | undefined
  /** Test hook for platform process inspection; production resolves lazily on terminal spawn. */
  terminalInspector: ProcessInspector | undefined
  /** The identity and environment every child starts with, when configured. */
  private readonly runAs: RunAs | undefined
  /** The credentials alone, as the exec bootstrap receives them. */
  private readonly identity: RunAsIdentity | undefined
  /** Further identities a spawn spec selects by name. */
  private readonly identities: ReadonlyMap<string, RunAs>
  /** The directories this provider writes into. */
  private readonly directories: Directories

  /** The run-as identity every child starts with, when configured. */
  override get childIdentity(): RunAsIdentity | undefined {
    return this.identity
  }

  static Config: z<Config> = z.object({
    runAs: z.union([RunAs, z.const(undefined)]),
    identities: z.union([z.dict(RunAs), z.const(undefined)]),
    shellActivityDirectory: z.union([String, z.const(undefined)]),
    spillDirectory: z.union([String, z.const(undefined)]),
  })

  constructor(ctx: Context, config: Config = {}) {
    super(ctx)
    const identities = Object.entries(config.identities ?? {})
    if (identities.length > 0 && config.runAs === undefined) {
      throw new Error('subprocess-local: identities requires runAs, the identity of every child whose spawn names none')
    }
    for (const [name, runAs] of identities) {
      if (!IDENTITY_NAME.test(name)) throw new Error(`subprocess-local: identities name ${JSON.stringify(name)} must match ${String(IDENTITY_NAME)}`)
      validateRunAs(runAs, process.platform, `identities.${name}`)
    }
    if (config.runAs !== undefined) {
      validateRunAs(config.runAs, process.platform)
      assertRunAsHost(tmpdir())
      // Only the exec bootstrap can take the identity before the target runs, with or without a systemd scope.
      if (!probeLinuxBootstrap()) throw new Error('subprocess-local: runAs requires the Linux exec bootstrap (the koffi execve binding and the runner entry), which is unavailable')
    }
    this.directories = resolveDirectories(config)
    this.runAs = config.runAs
    this.identity = config.runAs === undefined ? undefined : credentialsOf(config.runAs)
    this.identities = new Map(identities)
    ctx.effect(() => {
      const onHostExit = (): void => { this.terminateForHostExit() }
      process.prependListener('exit', onHostExit)
      return async () => {
        await this.disposeManagedProcesses()
        process.off('exit', onHostExit)
      }
    }, 'local subprocess teardown')
  }

  /** Spill failures reach the plugin logger; the log line is the only trace of why a result has no spill path. */
  private readonly reportSpillFailure = logSpillFailure(this.ctx.logger, 'subprocess-local')

  private terminateForHostExit(): void {
    for (const handle of this.live) {
      try {
        handle.terminateForHostExit()
      } catch (_ordinaryRangeTerminationFailed) {
        // Host exit cannot await or report one target; continue with the rest.
      }
    }
    for (const terminal of this.terminals) {
      try {
        terminal.terminateForHostExit()
      } catch (_terminalTerminationFailed) {
        // One terminal must not prevent final termination of another target.
      }
    }
  }

  private async disposeManagedProcesses(): Promise<void> {
    // Request termination, then await MANAGED-RANGE exit — not just the
    // direct command's settlement — so even a surviving descendant cannot
    // outlive the fiber. Keep both sets authoritative while these waits are
    // pending so a shorter process-level exit bound can still force-kill them.
    const pending: Promise<unknown>[] = []
    for (const handle of this.live) {
      handle.terminate()
      // Direct result and range observation are independent. Start both so an
      // unreadable owner cannot hide behind a result that never settles.
      pending.push(Promise.all([
        handle.done.catch(() => {}),
        handle.waitForExit(),
      ]).then(() => { this.live.delete(handle) }))
    }
    for (const terminal of this.terminals) {
      pending.push(terminal.terminate().then(() => { this.terminals.delete(terminal) }))
    }
    const outcomes = await Promise.allSettled(pending)
    await Promise.all([...this.controlChannels].map(control => new Promise<void>((resolveClose) => {
      control.once('close', () => { resolveClose() })
      control.destroy()
    })))
    this.controlChannels.clear()
    const failures: unknown[] = []
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') failures.push(outcome.reason)
    }
    if (failures.length > 0) this.terminateForHostExit()
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'local subprocess teardown failed')
  }

  async resolveExecutable(
    command: string,
    env?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
    identity?: string,
  ): Promise<string> {
    if (command.length === 0) throw new Error('subprocess-local: executable must be non-empty')
    signal?.throwIfAborted()
    const runAs = this.runAsFor(identity)
    const environment = runAs === undefined ? childEnv(env) : runAsEnvironment(runAs, env)
    const absolute = isAbsolute(command)
    if (!absolute && (command.includes('/') || (process.platform === 'win32' && command.includes('\\')))) {
      throw new Error(
        `subprocess-local: command ${JSON.stringify(command)} is a relative path; use an absolute path or a bare PATH name`,
      )
    }
    const candidates = absolute ? [command] : this.executableCandidates(command, environment)
    for (const candidate of candidates) {
      signal?.throwIfAborted()
      try {
        const info = await stat(candidate)
        if (!info.isFile()) continue
        await access(candidate, constants.X_OK)
        signal?.throwIfAborted()
        return candidate
      } catch {
        // Try the next PATH candidate; the final miss receives one stable error.
      }
    }
    signal?.throwIfAborted()
    throw new SubprocessExecutableNotFoundError(absolute
      ? `subprocess-local: command ${JSON.stringify(command)} is not an executable file`
      : `subprocess-local: command ${JSON.stringify(command)} was not found on PATH`)
  }

  private executableCandidates(command: string, env: NodeJS.ProcessEnv): string[] {
    const path = environmentValue(env, 'PATH') ?? ''
    const extensions = process.platform === 'win32' && extname(command) === ''
      ? (environmentValue(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';')
      : ['']
    return path.split(delimiter).flatMap(directory =>
      extensions.map(extension => resolve(process.cwd(), directory, command + extension)))
  }

  /**
   * The run-as configuration of one launch.
   * @param name - the identity a spawn spec names; undefined selects `runAs`.
   * @returns the configuration, or undefined when children run as this process.
   * @throws when no identity of that name is configured.
   */
  private runAsFor(name: string | undefined): RunAs | undefined {
    if (name === undefined) return this.runAs
    const runAs = this.identities.get(name)
    if (runAs === undefined) throw new Error(`subprocess-local: no run-as identity named ${JSON.stringify(name)} is configured; list it under identities`)
    return runAs
  }

  /** The complete target environment: run-as composition plus the secret guard, or the scrubbed parent base. */
  private targetEnvironment(spec: Parameters<typeof targetEnvironment>[0], runAs: RunAs | undefined): Record<string, string> {
    if (runAs === undefined) return targetEnvironment(spec)
    const env = targetEnvironment(spec, explicit => runAsEnvironment(runAs, explicit))
    assertNoSecretNames(runAs, env)
    return env
  }

  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    validateSubprocessSpec(spec)
    const runAs = this.runAsFor(spec.identity)
    const request = runAs === undefined ? spec : withoutInheritedOutput(spec)
    const identity = runAs === undefined ? undefined : credentialsOf(runAs)
    const env = this.targetEnvironment(request, runAs)
    const containmentMode = this.selectContainmentMode('ordinary')
    let handle: LocalSubprocessHandle
    const spillDir = this.internals.spillDir ?? this.directories.spill
    const internals: SpawnInternals = {
      ...this.internals, ...spillDir === undefined ? {} : { spillDir }, onSpillFailure: this.reportSpillFailure,
    }
    const linuxScope = containmentMode === 'linux-scope' ? this.linuxScopeDecision : undefined
    if (containmentMode === 'fallback' && identity === undefined) {
      handle = spawnSubprocess(request, internals)
    } else {
      const binding = prepareManagedProcessBinding(internals)
      const launch = linuxScope !== undefined
        ? launchLinuxScope(request, env, linuxScope.literalArgv, {}, identity)
        : identity !== undefined
          ? launchLinuxBootstrap(request, env, identity)
          : launchWindowsJob(request, env)
      handle = bindManagedProcess(request, launch, binding)
      if (linuxScope !== undefined) this.watchLinuxScopeStart(handle.done, linuxScope.generation)
    }
    this.live.add(handle)
    const control = handle.control
    if (control !== undefined) {
      this.controlChannels.add(control)
      control.once('close', () => { this.controlChannels.delete(control) })
    }
    // Release ownership only once the whole managed range is gone, not at direct-child
    // settlement — a TERM-trapping helper that outlives the leader must stay
    // owned so teardown can still escalate it. For the common no-survivor
    // case waitForExit resolves immediately after settlement.
    const release = (): Promise<void> =>
      handle.waitForExit().then(() => { this.live.delete(handle) })
    void handle.done.then(release, release).catch(() => {})
    return handle
  }

  /** Probe again before the next launch when a scope launched under generation never started its target. */
  private watchLinuxScopeStart(done: Promise<unknown>, generation: number): void {
    void done.catch((error: unknown) => {
      if (error instanceof LinuxScopeNotStartedError) this.linuxScope.scopeNotStarted(generation)
    })
  }

  private selectContainmentMode(
    kind: 'ordinary' | 'terminal',
  ): 'linux-scope' | 'windows-job' | 'fallback' {
    const platform = this.internals.platform ?? process.platform
    let fallbackReason: string | undefined
    if (platform === 'linux') {
      const decision = this.linuxScope.select()
      const probe = decision.probe === undefined ? '' : `, probed after ${decision.probe}`
      this.ctx.logger.debug(`linux native containment: ${decision.kind} (${decision.reason}${probe})`)
      if (decision.kind === 'scope') {
        this.linuxScopeDecision = decision
        return 'linux-scope'
      }
      fallbackReason = 'the current user-systemd scope or private bootstrap is unavailable'
    }
    if (kind === 'ordinary' && platform === 'win32') {
      const available = probeWindowsJob()
      if (available) return 'windows-job'
    }
    this.warnFallback(platform, kind, fallbackReason)
    return 'fallback'
  }

  private warnFallback(
    platform: NodeJS.Platform,
    kind: 'ordinary' | 'terminal',
    selectedReason?: string,
  ): void {
    if (this.fallbackWarningIssued) return
    this.fallbackWarningIssued = true
    const reason = selectedReason ?? (platform === 'darwin'
      ? 'macOS has no supported persistent process-range owner'
      : platform === 'win32'
        ? kind === 'terminal'
          ? 'Windows ConPTY remains outside Job containment'
          : 'the Win32 Job runner is unavailable'
        : `platform ${platform} has no native managed range`)
    this.ctx.logger.warn(
      `subprocess-local is using weaker process-tree containment because ${reason}; descendants that escape the process group or direct-parent tree are not guaranteed to terminate or delay waitForExit()`,
    )
  }

  /** @inheritdoc */
  // oxlint-disable-next-line typescript/require-await -- Keep the provider promise rejection semantics for cancelled inspection.
  async terminalEnvironment(signal?: AbortSignal): Promise<SubprocessTerminalEnvironment> {
    signal?.throwIfAborted()
    const platform = process.platform === 'win32' ? 'windows' : 'posix'
    // A run-as child's shell comes from its own environment, never from this process's account.
    const defaultShell = this.runAs !== undefined ? runAsEnvironment(this.runAs).SHELL || undefined
      : platform === 'windows' ? process.env.ComSpec || undefined : process.env.SHELL || userInfo().shell || undefined
    return { platform, ...defaultShell === undefined ? {} : { defaultShell } }
  }

  // Local PTY allocation is synchronous, but the provider contract permits remote asynchronous allocation.
  // oxlint-disable-next-line typescript/require-await -- Preserve promise rejection semantics at the async provider contract.
  async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    const file = spec.argv[0]
    if (file === undefined || file.length === 0) {
      throw new Error('subprocess-local: terminal argv must contain a program')
    }
    spec.signal?.throwIfAborted()
    const inspector = this.terminalInspector ?? createProcessInspector()
    const containmentMode = this.selectContainmentMode('terminal')
    const env = this.targetEnvironment(spec, this.runAs)
    const platform = this.internals.platform ?? process.platform
    const activity = prepareShellActivity(spec, env, platform, this.directories.shellActivity, this.identity)
    const launch = activity === undefined ? spec : { ...spec, argv: activity.argv, env: activity.env }
    const options: IPtyForkOptions | IWindowsPtyForkOptions = {
      name: spec.terminalType,
      rows: spec.rows,
      cols: spec.cols,
      cwd: spec.cwd,
      env: { ...activity?.env ?? env, TERM: spec.terminalType },
      // Windows' own console host (the standby pool runs Server 2022 and
      // Windows 10 22H2) renders the persistent-pwsh prompt tail in a form the
      // readiness path cannot match; the console host node-pty ships emits it
      // verbatim, see [Agent Note](../../../../.agents/notes/implemented/bug-fix/2026-09-28-pty-bundled-console-host.md).
      ...(platform === 'win32' ? { useConptyDll: true } : {}),
    }
    const linuxScope = containmentMode === 'linux-scope' ? this.linuxScopeDecision : undefined
    let scope: LinuxTerminalBootstrapLaunch | undefined
    let bindOwner: LinuxTerminalScopeLaunch['bindOwner'] | undefined
    let terminal: NodePty.IPty
    try {
      const bootstrapEnv = { ...activity?.env ?? env, PWD: spec.cwd, TERM: spec.terminalType }
      if (this.runAs !== undefined) assertNoSecretNames(this.runAs, bootstrapEnv)
      if (linuxScope !== undefined) {
        const scoped = prepareLinuxTerminalScope(launch, bootstrapEnv, linuxScope.literalArgv, {}, this.identity)
        bindOwner = scoped.bindOwner
        scope = scoped
      } else if (this.identity !== undefined) {
        scope = prepareLinuxTerminalBootstrap(launch, bootstrapEnv, this.identity)
      }
      if (scope !== undefined) { options.cwd = scope.cwd; options.env = scope.env }
      terminal = requireNodePty().spawn(
        scope?.command ?? file,
        scope?.args ?? [...launch.argv.slice(1)],
        options,
      )
    } catch (error) {
      scope?.cleanup()
      activity?.dispose()
      throw error
    }
    // oxlint-disable-next-line eslint/prefer-const -- The owner can query readiness before the handle is published.
    let handle: LocalTerminalHandle | undefined
    const directSettlement = Promise.withResolvers<void>()
    const owner = bindOwner?.({
      running: () => handle?.running ?? true,
      settled: directSettlement.promise,
      // node-pty swallows signal errors; the scope owner requires their delivery result.
      signal: signal => signalLinuxDirectProcess(terminal.pid, () => process.kill(terminal.pid, signal)),
    })
    handle = new LocalTerminalHandle(
      terminal,
      inspector,
      spec.graceMs,
      platform,
      owner,
      scope?.resolveOutcome,
      activity,
      () => { this.terminals.delete(handle as LocalTerminalHandle) },
      spec.shellActivity === true,
    )
    this.terminals.add(handle)
    if (linuxScope !== undefined) this.watchLinuxScopeStart(handle.done, linuxScope.generation)
    const release = async (): Promise<void> => {
      // terminate() can wait on this direct-exit promise.
      directSettlement.resolve()
      if (spec.shellActivity === true) return
      await handle.terminate()
      this.terminals.delete(handle)
    }
    void handle.done.then(release, release).catch(() => {})
    return handle
  }
}

/** Collection that keeps no byte: the provider reads the stream and discards it. */
const DISCARD = { maxBytes: 0 } as const

/**
 * A run-as request with each output stream it asks to inherit read and discarded instead, so a contained child never
 * holds this process's standard output or error, such as a root-only log another program parses.
 * @param spec - the validated request.
 * @returns the request with `'inherit'` output replaced by a collection that keeps nothing.
 */
function withoutInheritedOutput(spec: SubprocessSpawnSpec): SubprocessSpawnSpec {
  const { stdout, stderr } = spec.stdio
  if (stdout !== 'inherit' && stderr !== 'inherit') return spec
  return {
    ...spec,
    stdio: { ...spec.stdio, stdout: stdout === 'inherit' ? DISCARD : stdout, stderr: stderr === 'inherit' ? DISCARD : stderr },
  }
}

/** Read a Windows environment key using the platform's case-insensitive semantics. */
function environmentValue(env: NodeJS.ProcessEnv, name: 'PATH' | 'PATHEXT'): string | undefined {
  const exact = env[name]
  if (exact !== undefined || process.platform !== 'win32') return exact
  const normalized = name.toUpperCase()
  return Object.entries(env).find(([key]) => key.toUpperCase() === normalized)?.[1]
}

export default LocalSubprocessRuntime
