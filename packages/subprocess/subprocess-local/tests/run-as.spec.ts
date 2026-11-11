import { EventEmitter } from 'node:events'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessSpawnSpec, SubprocessTerminalHandle } from '@deepseek-ai/dsh-subprocess'
import LocalSubprocessRuntime, { SubprocessSecretEnvironmentError } from '@deepseek-ai/dsh-subprocess-local'
import type { RunAs } from '@deepseek-ai/dsh-subprocess-local'
import { assertNoSecretNames, assertRootOwnedPath, assertRunAsHost, resolveServerIdentity, runAsEnvironment, validateRunAs } from '../src/run-as.ts'
import { launchLinuxBootstrap, launchLinuxScope, prepareLinuxTerminalBootstrap, prepareLinuxTerminalScope } from '../src/linux-scope.ts'
import { consumeLinuxLaunchRequest, linuxLaunchFilesFromLocator, openLinuxStartupError, readLinuxStartupError, createLinuxLaunchFiles } from '../src/runner-protocol.ts'
import { SUBPROCESS_RUNNER_ENV } from '../src/runner-launch.ts'
import { runSpawnRunner } from '../src/spawn-runner.ts'
import type { SpawnRunnerInternals } from '../src/spawn-runner.ts'
import { prepareShellActivity } from '../src/shell-activity.ts'

const linux = process.platform === 'linux' ? describe : describe.skip
const onLinux = process.platform === 'linux' ? it : it.skip
const scratch: string[] = []
const fibers: { dispose(): Promise<unknown> }[] = []

beforeEach(() => {
  // Run-as refuses a temporary directory other users can write; every test gets a private one.
  vi.stubEnv('TMPDIR', directory())
})

afterEach(async () => {
  for (const fiber of fibers.splice(0)) await fiber.dispose()
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true })
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

/** The ids on one /proc/self/status line, sorted. */
function statusIds(status: string, field: 'Uid' | 'Gid' | 'Groups'): number[] {
  const line = status.split('\n').find(entry => entry.startsWith(`${field}:`)) as string
  return line.slice(field.length + 1).trim().split(/\s+/u).filter(id => id !== '').map(Number).sort((a, b) => a - b)
}

/** This test process's own identity, the only one a non-root test can switch to. */
function ownIdentity(): Pick<RunAs, 'uid' | 'gid' | 'groups'> {
  const status = readFileSync('/proc/self/status', 'utf8')
  return { uid: process.getuid!(), gid: process.getgid!(), groups: statusIds(status, 'Groups') }
}

function runAs(overrides: Partial<RunAs> = {}): RunAs {
  return {
    ...ownIdentity(),
    inherit: ['PATH'],
    set: { HOME: '/home/agent', USER: 'agent' },
    secretNames: ['DEEPSEEK_API_KEY', 'MUMBO_MEMBER_KEY'],
    ...overrides,
  }
}

/** Point the OS temporary directory at a fresh private directory for the rest of the test. */
function privateTmpdir(): string {
  const path = directory()
  vi.stubEnv('TMPDIR', path)
  return path
}

function directory(): string {
  const path = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'dsh-run-as-'))
  scratch.push(path)
  return path
}

/** What {@link REPORT} prints: the child's kernel credentials and its exact environment. */
interface Report { uid: number[]; gid: number[]; groups: number[]; env: Record<string, string>; noNewPrivs: string; capEff: string }

/** A Node child that reports its kernel credentials and its exact environment as JSON. */
const REPORT = [
  "const status = require('fs').readFileSync('/proc/self/status', 'utf8')",
  "const ids = f => status.split('\\n').find(l => l.startsWith(f + ':')).slice(f.length + 1).trim().split(/\\s+/).filter(Boolean).map(Number)",
  "const field = f => status.split('\\n').find(l => l.startsWith(f + ':')).slice(f.length + 1).trim()",
  "process.stdout.write(JSON.stringify({ uid: ids('Uid'), gid: ids('Gid'), groups: ids('Groups').sort((a, b) => a - b), env: process.env, noNewPrivs: field('NoNewPrivs'), capEff: field('CapEff') }))",
].join(';')

function reportSpec(cwd: string, env?: NodeJS.ProcessEnv): SubprocessSpawnSpec {
  return {
    argv: [process.execPath, '-e', REPORT],
    cwd,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 1 << 20 }, stderr: { maxBytes: 1 << 16 } },
    graceMs: 200,
    ...env === undefined ? {} : { env },
  }
}

async function runtime(
  config: RunAs | undefined,
  identities?: Record<string, RunAs>,
  directories: { shellActivityDirectory?: string; spillDirectory?: string } = {},
): Promise<Context> {
  const ctx = new Context()
  fibers.push(await ctx.plugin(LocalSubprocessRuntime, {
    ...config === undefined ? {} : { runAs: config },
    ...identities === undefined ? {} : { identities },
    ...directories,
  }))
  return ctx
}

describe('run-as configuration', () => {
  it.each([
    [{ uid: 0 }, 'runAs .uid must be a positive integer, not 0; 0 is root'],
    [{ gid: 0 }, 'runAs .gid must be a positive integer, not 0; 0 is root'],
    [{ groups: [5, 0] }, 'runAs .groups must be a positive integer, not 0; 0 is root'],
    [{ uid: 1.5 }, 'runAs .uid must be a positive integer, not 1.5; 0 is root'],
    [{ secretNames: [] }, 'runAs .secretNames must name at least one variable'],
    [{ inherit: ['BAD-NAME'] }, 'runAs names an invalid environment variable "BAD-NAME"'],
    [{ set: { '1X': 'v' } }, 'runAs names an invalid environment variable "1X"'],
    [{ secretNames: ['A=B'] }, 'runAs names an invalid environment variable "A=B"'],
    [{ inherit: ['GITHUB_TOKEN'] }, 'runAs .inherit names credential-shaped GITHUB_TOKEN, which is never inherited; supply it through .set if the child needs it'],
    [{ set: { HOME: 'a\0b' } }, 'runAs .set values must not contain NUL'],
    [{ inherit: ['mumbo_launch'], secretNames: ['MUMBO_LAUNCH'] }, 'runAs passes mumbo_launch, which .secretNames lists'],
    [{ set: { DEEPSEEK_API_KEY: 'x' } }, 'runAs passes DEEPSEEK_API_KEY, which .secretNames lists'],
  ] as const)('rejects %o', (overrides, message) => {
    expect(() => { validateRunAs(runAs(overrides as Partial<RunAs>), 'linux') }).toThrow(`subprocess-local: ${message}`)
  })

  it('refuses every non-Linux host', () => {
    expect(() => { validateRunAs(runAs(), 'darwin') }).toThrow('subprocess-local: runAs requires Linux; this host is darwin')
  })

  it('accepts an identity with no supplementary groups', () => {
    expect(() => { validateRunAs(runAs({ groups: [] }), 'linux') }).not.toThrow()
  })

  it('names the identity whose field is unusable', () => {
    expect(() => { validateRunAs(runAs({ uid: 0 }), 'linux', 'identities.desktop') })
      .toThrow('subprocess-local: identities.desktop .uid must be a positive integer, not 0; 0 is root')
  })

  onLinux.each([
    [{ identities: { desktop: runAs() } }, 'subprocess-local: identities requires runAs, the identity of every child whose spawn names none'],
    [{ runAs: runAs(), identities: { 'Desk top': runAs() } }, 'subprocess-local: identities name "Desk top" must match /^[a-z][a-z0-9-]{0,31}$/u'],
    [{ runAs: runAs(), identities: { desktop: runAs({ uid: 0 }) } }, 'subprocess-local: identities.desktop .uid must be a positive integer, not 0; 0 is root'],
    [{ runAs: runAs(), identities: { desktop: runAs({ set: { MUMBO_MEMBER_KEY: 'x' } }) } }, 'subprocess-local: identities.desktop passes MUMBO_MEMBER_KEY, which .secretNames lists'],
  ])('fails the plugin at load for unusable identities %#', async (config, message) => {
    const ctx = new Context()
    await expect(ctx.plugin(LocalSubprocessRuntime, config)).rejects.toThrow(message)
    expect(ctx.get('subprocess')).toBeUndefined()
  })

  onLinux('fails the plugin at load for a root identity and leaves no service', async () => {
    const ctx = new Context()
    await expect(ctx.plugin(LocalSubprocessRuntime, { runAs: runAs({ uid: 0 }) }))
      .rejects.toThrow('subprocess-local: runAs .uid must be a positive integer, not 0; 0 is root')
    expect(ctx.get('subprocess')).toBeUndefined()
  })

  onLinux('fails the plugin at load when the exec bootstrap is unavailable', async () => {
    vi.resetModules()
    vi.doMock('../src/linux-scope.ts', async original => ({
      ...await original<typeof import('../src/linux-scope.ts')>(),
      probeLinuxBootstrap: () => false,
    }))
    try {
      const { default: Isolated } = await import('../src/index.ts')
      expect(() => new Isolated(new Context(), { runAs: runAs() })).toThrow(
        'subprocess-local: runAs requires the Linux exec bootstrap (the koffi execve binding and the runner entry), which is unavailable',
      )
    } finally {
      vi.doUnmock('../src/linux-scope.ts')
    }
  })
})

describe('run-as host facts', () => {
  it('accepts a private temporary directory below a sticky shared one, with protected hard links', () => {
    expect(() => { assertRunAsHost(directory(), () => '1\n') }).not.toThrow()
  })

  it('refuses a shared or group-writable temporary directory, or a writable non-sticky ancestor', () => {
    const message = (path: string) => `subprocess-local: runAs requires a temporary directory no other user can write, but ${JSON.stringify(path)} is not; start dsh with TMPDIR set to a root-only directory such as /root/.dsh/tmp`
    expect(() => { assertRunAsHost('/tmp', () => '1') }).toThrow(message('/tmp'))
    const grouped = directory()
    chmodSync(grouped, 0o770)
    expect(() => { assertRunAsHost(grouped, () => '1') }).toThrow(message(grouped))
    const open = directory()
    chmodSync(open, 0o777)
    const inner = join(open, 'inner')
    mkdirSync(inner, { mode: 0o700 })
    expect(() => { assertRunAsHost(inner, () => '1') }).toThrow(message(inner))
    chmodSync(open, 0o700)
  })

  it('refuses a temporary directory inside a directory another user owns, which it could rename', () => {
    const inner = join(realpathSync(directory()), 'inner')
    mkdirSync(inner, { mode: 0o700 })
    const parent = dirname(inner)
    const otherOwner = (path: string) => path === parent ? { uid: process.getuid!() + 1, gid: 1, mode: 0o40755 } : statSync(path)
    expect(() => { assertRunAsHost(inner, () => '1', otherOwner) })
      .toThrow(`subprocess-local: runAs requires a temporary directory no other user can write, but ${JSON.stringify(inner)} is not`)
    expect(() => { assertRunAsHost(inner, () => '1', path => path === parent ? { uid: 0, gid: 0, mode: 0o40755 } : statSync(path)) }).not.toThrow()
  })

  it('refuses a temporary directory named through a link, since later writes would follow the link', () => {
    const real = realpathSync(directory())
    const link = join(directory(), 'link')
    symlinkSync(real, link)
    expect(() => { assertRunAsHost(link, () => '1') })
      .toThrow(`subprocess-local: runAs requires TMPDIR to name its real path, but ${JSON.stringify(link)} resolves to ${JSON.stringify(real)}; start dsh with TMPDIR=${real}`)
  })

  it('refuses unprotected hard links', () => {
    expect(() => { assertRunAsHost(directory(), () => '0\n') })
      .toThrow('subprocess-local: runAs requires fs.protected_hardlinks=1, so the run-as user cannot hard-link files it may not read; set it with sysctl before starting dsh')
  })

  onLinux('fails the plugin at load in a shared temporary directory', async () => {
    vi.stubEnv('TMPDIR', '/tmp')
    await expect(new Context().plugin(LocalSubprocessRuntime, { runAs: runAs() })).rejects.toThrow('runAs requires a temporary directory no other user can write')
  })

  onLinux('fails the plugin at load when a configured directory is missing, relative, or writable by others', async () => {
    const shared = directory()
    chmodSync(shared, 0o770)
    for (const [config, message] of [
      [{ shellActivityDirectory: 'relative' }, 'subprocess-local: shellActivityDirectory "relative" must be an absolute existing directory'],
      [{ spillDirectory: join(shared, 'missing') }, `subprocess-local: spillDirectory ${JSON.stringify(join(shared, 'missing'))} must be an absolute existing directory`],
      [{ runAs: runAs(), spillDirectory: shared }, `subprocess-local: spillDirectory ${JSON.stringify(shared)} must be owned by this process and writable by no other user, directly or through an ancestor`],
      [{ runAs: runAs(), shellActivityDirectory: shared }, `subprocess-local: shellActivityDirectory ${JSON.stringify(shared)} must be owned by this process and writable by no other user, directly or through an ancestor`],
    ] as const) {
      const ctx = new Context()
      await expect(ctx.plugin(LocalSubprocessRuntime, config)).rejects.toThrow(message)
      expect(ctx.get('subprocess')).toBeUndefined()
    }
  })

  onLinux('fails the plugin at load when the run-as user cannot search the directory that holds shell records', async () => {
    const own = ownIdentity()
    const records = realpathSync(tmpdir())
    // The first directory on the way to the records that others cannot search: the records directory itself, or an
    // ancestor such as a CI runner's 0750 home.
    const prefixes = records.split('/').filter(Boolean).map((_, i, names) => `/${names.slice(0, i + 1).join('/')}`)
    const blocked = prefixes.find(path => (statSync(path).mode & 0o001) === 0) ?? records
    await expect(new Context().plugin(LocalSubprocessRuntime, { runAs: runAs({ uid: own.uid + 1, gid: own.gid + 1, groups: [] }) }))
      .rejects.toThrow(`subprocess-local: the run-as user (uid ${own.uid + 1}) cannot search ${JSON.stringify(blocked)}, so its shells cannot reach their activity records under ${JSON.stringify(records)}; set shellActivityDirectory to a directory it can search, such as /run/dsh-shell (root, 0711)`)
  })
})

describe('run-as environment', () => {
  it('inherits only allowlisted ambient names, then explicit entries, then fixed values', () => {
    vi.stubEnv('KEPT', 'ambient')
    vi.stubEnv('DROPPED', 'ambient')
    vi.stubEnv('REMOVED', 'ambient')
    vi.stubEnv('HOME', '/root')
    const config = runAs({ inherit: ['KEPT', 'REMOVED', 'ABSENT'], set: { HOME: '/home/agent', FIXED: 'operator' } })
    expect(runAsEnvironment(config, { REMOVED: undefined, CALLER: 'explicit', FIXED: 'caller' })).toEqual({
      KEPT: 'ambient', CALLER: 'explicit', HOME: '/home/agent', FIXED: 'operator',
    })
    expect(runAsEnvironment(config)).toEqual({ KEPT: 'ambient', REMOVED: 'ambient', HOME: '/home/agent', FIXED: 'operator' })
  })

  it('never inherits a credential-shaped ambient name even when a consumer would', () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'box-token')
    vi.stubEnv('MUMBO_MEMBER_KEY', 'member-key')
    const env = runAsEnvironment(runAs({ inherit: ['PATH'] }))
    expect(Object.keys(env)).not.toContain('DEEPSEEK_API_KEY')
    expect(Object.keys(env)).not.toContain('MUMBO_MEMBER_KEY')
  })

  it('refuses a final environment naming a secret in any case and reports names only', () => {
    expect(() => { assertNoSecretNames(runAs(), { PATH: '/bin', deepseek_api_key: 'value' }) })
      .toThrow(new SubprocessSecretEnvironmentError(['deepseek_api_key']))
    try {
      assertNoSecretNames(runAs(), { MUMBO_MEMBER_KEY: 'secret-value' })
    } catch (error) {
      expect(error).toBeInstanceOf(SubprocessSecretEnvironmentError)
      expect((error as SubprocessSecretEnvironmentError).names).toEqual(['MUMBO_MEMBER_KEY'])
      expect((error as Error).message).toBe('subprocess-local: refusing to start a process whose environment contains MUMBO_MEMBER_KEY; a run-as child must never receive these names')
      expect((error as Error).message).not.toContain('secret-value')
    }
    expect(() => { assertNoSecretNames(runAs(), { PATH: '/bin' }) }).not.toThrow()
  })
})

linux('run-as children through the provider', () => {
  it('runs an ordinary child with the configured identity and exactly the explicit environment', async () => {
    vi.stubEnv('PATH', process.env.PATH)
    vi.stubEnv('DEEPSEEK_API_KEY', 'box-token')
    vi.stubEnv('AMBIENT_ONLY', 'leak')
    const config = runAs({ inherit: ['PATH'], set: { HOME: '/home/agent', USER: 'agent' } })
    const ctx = await runtime(config)
    const cwd = directory()
    const handle = ctx.subprocess.spawn(reportSpec(cwd, { CALLER: 'explicit', PATH: undefined }))
    await expect(handle.done).resolves.toEqual({ exitCode: 0, signal: null })
    const report = JSON.parse(handle.collected.stdout!.readFrom(0).text) as Report
    expect(report.uid).toEqual(Array(4).fill(config.uid))
    expect(report.gid).toEqual(Array(4).fill(config.gid))
    expect(report.groups).toEqual(config.groups)
    expect([report.noNewPrivs, report.capEff]).toEqual(['1', '0000000000000000'])
    expect(report.env).toEqual({ CALLER: 'explicit', HOME: '/home/agent', USER: 'agent' })
  })

  it('runs a child as the identity its spawn names, with that identity\'s environment and secret names', async () => {
    vi.stubEnv('PATH', process.env.PATH)
    const desktop = runAs({ inherit: [], set: { HOME: '/home/desktop', USER: 'desktop' }, secretNames: ['XAUTH_COOKIE'] })
    const ctx = await runtime(runAs({ inherit: [], set: { HOME: '/home/agent', USER: 'agent' } }), { desktop })
    const named = ctx.subprocess.spawn({ ...reportSpec(directory(), { DISPLAY: ':1' }), identity: 'desktop' })
    await expect(named.done).resolves.toEqual({ exitCode: 0, signal: null })
    const report = JSON.parse(named.collected.stdout!.readFrom(0).text) as Report
    expect(report.uid).toEqual(Array(4).fill(desktop.uid))
    expect([report.noNewPrivs, report.capEff]).toEqual(['1', '0000000000000000'])
    expect(report.env).toEqual({ DISPLAY: ':1', HOME: '/home/desktop', USER: 'desktop' })
    const unnamed = ctx.subprocess.spawn(reportSpec(directory(), { XAUTH_COOKIE: 'agent may' }))
    await expect(unnamed.done).resolves.toEqual({ exitCode: 0, signal: null })
    expect((JSON.parse(unnamed.collected.stdout!.readFrom(0).text) as Report).env)
      .toEqual({ XAUTH_COOKIE: 'agent may', HOME: '/home/agent', USER: 'agent' })
    expect(() => ctx.subprocess.spawn({ ...reportSpec(directory(), { XAUTH_COOKIE: 'x' }), identity: 'desktop' }))
      .toThrow(new SubprocessSecretEnvironmentError(['XAUTH_COOKIE']))
    expect(ctx.subprocess.childIdentity).toEqual({ uid: desktop.uid, gid: desktop.gid, groups: desktop.groups })
  })

  it('refuses a spawn naming an identity that is not configured, before anything starts', async () => {
    const launches = privateTmpdir()
    const contained = await runtime(runAs(), { desktop: runAs() })
    expect(() => contained.subprocess.spawn({ ...reportSpec(directory()), identity: 'browsermcp' }))
      .toThrow('subprocess-local: no run-as identity named "browsermcp" is configured; list it under identities')
    const plain = await runtime(undefined)
    expect(() => plain.subprocess.spawn({ ...reportSpec(directory()), identity: 'desktop' }))
      .toThrow('subprocess-local: no run-as identity named "desktop" is configured; list it under identities')
    await expect(plain.subprocess.resolveExecutable('sh', undefined, undefined, 'desktop'))
      .rejects.toThrow('subprocess-local: no run-as identity named "desktop" is configured; list it under identities')
    expect(readdirSync(launches).filter(name => name.startsWith('dsh-subprocess-launch-'))).toEqual([])
  })

  it('looks executables up on the PATH of the identity named for the lookup', async () => {
    const ctx = await runtime(runAs({ inherit: [], set: { PATH: '/usr/bin:/bin' } }), {
      desktop: runAs({ inherit: [], set: { PATH: '/nonexistent-desktop-path' } }),
    })
    await expect(ctx.subprocess.resolveExecutable('sh')).resolves.toMatch(/\/sh$/u)
    await expect(ctx.subprocess.resolveExecutable('sh', undefined, undefined, 'desktop')).rejects.toThrow('was not found on PATH')
  })

  it('reports its child identity, and none without run-as', async () => {
    const config = runAs()
    expect((await runtime(config)).subprocess.childIdentity).toEqual({ uid: config.uid, gid: config.gid, groups: config.groups })
    expect((await runtime(undefined)).subprocess.childIdentity).toBeUndefined()
  })

  it('looks executables up on the run-as PATH', async () => {
    const ctx = await runtime(runAs({ inherit: [], set: { PATH: '/nonexistent-run-as-path' } }))
    await expect(ctx.subprocess.resolveExecutable('sh')).rejects.toThrow('was not found on PATH')
    await expect(ctx.subprocess.resolveExecutable('sh', { PATH: '/bin:/usr/bin' })).rejects.toThrow('was not found on PATH')
    const usable = await runtime(runAs({ inherit: [], set: { PATH: '/usr/bin:/bin' } }))
    await expect(usable.subprocess.resolveExecutable('sh')).resolves.toMatch(/\/sh$/u)
  })

  it('reports the run-as shell, never this account\'s', async () => {
    vi.stubEnv('SHELL', '/bin/root-shell')
    await expect((await runtime(runAs({ set: { SHELL: '/bin/agent-shell' } }))).subprocess.terminalEnvironment())
      .resolves.toEqual({ platform: 'posix', defaultShell: '/bin/agent-shell' })
    await expect((await runtime(runAs({ set: {} }))).subprocess.terminalEnvironment())
      .resolves.toEqual({ platform: 'posix' })
  })

  it('refuses a caller-forwarded secret before anything starts', async () => {
    const ctx = await runtime(runAs())
    // Launch files land in this spec's own temporary directory, so concurrent specs cannot change the count.
    const launches = privateTmpdir()
    expect(() => ctx.subprocess.spawn(reportSpec(directory(), { DEEPSEEK_API_KEY: 'forwarded' })))
      .toThrow(SubprocessSecretEnvironmentError)
    await expect(ctx.subprocess.spawnTerminal({
      argv: ['/bin/sh'], cwd: directory(), env: { MUMBO_MEMBER_KEY: 'forwarded' }, rows: 24, cols: 80, terminalType: 'xterm', graceMs: 200,
    })).rejects.toThrow(SubprocessSecretEnvironmentError)
    expect(readdirSync(launches).filter(name => name.startsWith('dsh-subprocess-launch-'))).toEqual([])
  })

  it('refuses a terminal whose launch-specific additions name a secret', async () => {
    const ctx = await runtime(runAs({ secretNames: ['TERM'] }))
    await expect(ctx.subprocess.spawnTerminal({
      argv: ['/bin/sh'], cwd: directory(), rows: 24, cols: 80, terminalType: 'xterm', graceMs: 200,
    })).rejects.toThrow(new SubprocessSecretEnvironmentError(['TERM']))
  })

  it('fails closed when the identity cannot be taken', async () => {
    const own = ownIdentity()
    const withDaemonGroup = [...new Set([...own.groups, 1])].sort((a, b) => a - b)
    const otherGroup = await runtime(runAs({ groups: withDaemonGroup }))
    const groupHandle = otherGroup.subprocess.spawn(reportSpec(directory()))
    await expect(groupHandle.done).rejects.toThrow(/^run-as: could not take uid \d+, gid \d+, groups \[[\d, ]+\]: /u)
    expect(groupHandle.collected.stdout!.readFrom(0).text).toBe('')

    // The other user searches its shell record directory through the group bit.
    chmodSync(tmpdir(), 0o711)
    const records = directory()
    chmodSync(records, 0o711)
    const otherUser = await runtime(runAs({ uid: own.uid + 1 }), undefined, { shellActivityDirectory: records })
    const userHandle = otherUser.subprocess.spawn(reportSpec(directory()))
    await expect(userHandle.done).rejects.toThrow(`run-as: could not take uid ${own.uid + 1}`)
    expect(userHandle.collected.stdout!.readFrom(0).text).toBe('')
  })

  it('never hands a run-as child this process\'s standard output or error', async () => {
    const ctx = await runtime(runAs())
    const handle = ctx.subprocess.spawn({
      argv: [process.execPath, '-e', "process.stdout.write('discarded'); process.stderr.write(require('fs').readlinkSync('/proc/self/fd/1'))"],
      cwd: directory(),
      stdio: { stdin: 'ignore', stdout: 'inherit', stderr: { maxBytes: 1024 } },
      graceMs: 200,
    })
    await expect(handle.done).resolves.toEqual({ exitCode: 0, signal: null })
    expect(handle.stdout).toBeUndefined()
    expect(handle.collected.stderr!.readFrom(0).text).not.toBe(readlinkSync('/proc/self/fd/1'))
    const reporter = ctx.subprocess.spawn({
      argv: [process.execPath, '-e', "process.stdout.write(require('fs').readlinkSync('/proc/self/fd/2'))"],
      cwd: directory(),
      stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: 'inherit' },
      graceMs: 200,
    })
    await expect(reporter.done).resolves.toEqual({ exitCode: 0, signal: null })
    const childStderr = reporter.collected.stdout!.readFrom(0).text
    expect(childStderr).not.toBe(readlinkSync('/proc/self/fd/2'))
  })

  it('writes spill files readable by the spill directory\'s group into the configured directory', async () => {
    const spill = realpathSync(directory())
    const ctx = await runtime(runAs(), undefined, { spillDirectory: spill })
    const handle = ctx.subprocess.spawn({
      argv: [process.execPath, '-e', "process.stdout.write('y'.repeat(4096))"],
      cwd: directory(),
      stdio: { stdin: 'ignore', stdout: { maxBytes: 16, spill: { maxBytes: 1 << 20 } }, stderr: { maxBytes: 16 } },
      graceMs: 200,
    })
    await handle.done
    const path = handle.collected.stdout!.readFrom(0).spillPath!
    expect(dirname(path)).toBe(spill)
    expect(statSync(path).mode & 0o777).toBe(0o640)
    expect(readFileSync(path, 'utf8')).toBe('y'.repeat(4096))
  })

  it('keeps writing spill files and shell records where it checked at load after a link in the configured spelling is repointed', async () => {
    const spill = realpathSync(directory())
    const records = realpathSync(directory())
    chmodSync(records, 0o711)
    const elsewhere = realpathSync(directory())
    const links = directory()
    symlinkSync(spill, join(links, 'spill'))
    symlinkSync(records, join(links, 'records'))
    const ctx = await runtime(runAs({ inherit: ['PATH'], set: { HOME: directory() } }), undefined, {
      spillDirectory: join(links, 'spill'), shellActivityDirectory: join(links, 'records'),
    })
    for (const name of ['spill', 'records']) {
      rmSync(join(links, name))
      symlinkSync(elsewhere, join(links, name))
    }
    const handle = ctx.subprocess.spawn({
      argv: [process.execPath, '-e', "process.stdout.write('y'.repeat(4096))"],
      cwd: directory(),
      stdio: { stdin: 'ignore', stdout: { maxBytes: 16, spill: { maxBytes: 1 << 20 } }, stderr: { maxBytes: 16 } },
      graceMs: 200,
    })
    await handle.done
    expect(dirname(handle.collected.stdout!.readFrom(0).spillPath!)).toBe(spill)
    const terminal = await ctx.subprocess.spawnTerminal({
      argv: ['/bin/bash', '-i'], cwd: directory(), rows: 24, cols: 80, terminalType: 'xterm', graceMs: 500, shellActivity: true,
    })
    try {
      expect(readdirSync(records)).toEqual([expect.stringMatching(/^dsh-shell-/u)])
      expect(readdirSync(elsewhere)).toEqual([])
      await vi.waitFor(async () => { expect((await terminal.inspectActivity()).state).toBe('idle') }, { timeout: 10_000, interval: 50 })
    } finally {
      await terminal.terminate()
    }
  })

  it('reports a directory the identity cannot enter as a spawn failure', async () => {
    const ctx = await runtime(runAs())
    const handle = ctx.subprocess.spawn(reportSpec(join(directory(), 'missing')))
    await expect(handle.done).rejects.toThrow(`spawn ${process.execPath} ENOENT`)
  })

  it('runs a terminal with the configured identity and environment and shares only its activity records', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'box-token')
    const config = runAs({ inherit: ['PATH'], set: { HOME: '/home/agent' } })
    const ctx = await runtime(config)
    const cwd = directory()
    const terminal: SubprocessTerminalHandle = await ctx.subprocess.spawnTerminal({
      argv: [process.execPath, '-e', REPORT], cwd, env: { CALLER: 'explicit' }, rows: 24, cols: 400, terminalType: 'xterm', graceMs: 500,
    })
    let output = ''
    terminal.output.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
    await expect(terminal.done).resolves.toEqual({ exitCode: 0, signal: null })
    await terminal.terminate()
    const report = JSON.parse(output.slice(output.indexOf('{'), output.lastIndexOf('}') + 1)) as Report
    expect(report.uid).toEqual(Array(4).fill(config.uid))
    expect(report.gid).toEqual(Array(4).fill(config.gid))
    expect(report.groups).toEqual(config.groups)
    expect(report.env).toEqual({ PATH: process.env.PATH, CALLER: 'explicit', HOME: '/home/agent', PWD: cwd, TERM: 'xterm' })
  })

  it('observes an interactive run-as bash through activity records it can write but not replace', async () => {
    const records = directory()
    chmodSync(records, 0o711)
    const ctx = await runtime(runAs({ inherit: ['PATH'], set: { HOME: directory() } }), undefined, { shellActivityDirectory: records })
    const terminal = await ctx.subprocess.spawnTerminal({
      argv: ['/bin/bash', '-i'], cwd: directory(), rows: 24, cols: 80, terminalType: 'xterm', graceMs: 500, shellActivity: true,
    })
    try {
      expect(readdirSync(records)).toEqual([expect.stringMatching(/^dsh-shell-/u)])
      const deadline = Date.now() + 10_000
      let state = (await terminal.inspectActivity()).state
      while (state !== 'idle' && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50))
        state = (await terminal.inspectActivity()).state
      }
      expect(state).toBe('idle')
    } finally {
      await terminal.terminate()
    }
  })
})

describe('run-as launch requests', () => {
  class FakeChild extends EventEmitter {
    pid = 4321
    exitCode: number | null = null
    signalCode: NodeJS.Signals | null = null
    stdin = new PassThrough()
    stdout = new PassThrough()
    stderr = new PassThrough()
    stdio = [this.stdin, this.stdout, this.stderr, null, null, null, null, new PassThrough()]
  }

  const identity = { uid: 2000, gid: 3000, groups: [3001] }
  const ordinary: SubprocessSpawnSpec = {
    argv: ['tool', 'arg'], cwd: '/work', stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }, graceMs: 100,
  }

  function capture() {
    const calls: { command: string; args: readonly string[]; env: NodeJS.ProcessEnv }[] = []
    const child = new FakeChild()
    const spawn = vi.fn((command: string, args: readonly string[], options: { env: NodeJS.ProcessEnv }) => {
      calls.push({ command, args, env: options.env })
      return child
    })
    return { calls, child, spawn }
  }

  function consumed(env: NodeJS.ProcessEnv) {
    const locator = env[SUBPROCESS_RUNNER_ENV] as string
    scratch.push(linuxLaunchFilesFromLocator(locator).directory)
    return consumeLinuxLaunchRequest(locator)
  }

  it('hands the identity to the bootstrap inside a systemd scope', () => {
    const { calls, spawn } = capture()
    launchLinuxScope(ordinary, { TARGET: 'yes' }, [], { spawn: spawn as never, runnerInvocation: ['/node', '/runner.js'], systemdRun: '/bin/systemd-run' }, identity)
    expect(calls[0]?.command).toBe('/bin/systemd-run')
    expect(calls[0]?.args.slice(-5)).toEqual(['/node', '/runner.js', '--', 'tool', 'arg'])
    expect(consumed(calls[0]!.env)).toEqual({ cwd: '/work', env: { TARGET: 'yes' }, runAs: identity })
    const terminal = prepareLinuxTerminalScope({ argv: ordinary.argv, cwd: ordinary.cwd, graceMs: 100, rows: 1, cols: 1, terminalType: 'xterm' }, { T: '1' }, [], { runnerInvocation: ['/node', '/runner.js'] }, identity)
    expect(consumed(terminal.env)).toEqual({ cwd: '/work', env: { T: '1' }, runAs: identity })
    terminal.cleanup()
  })

  it('runs the bootstrap directly as a detached group when no scope exists, and removes its files', async () => {
    const { calls, child, spawn } = capture()
    const launch = launchLinuxBootstrap({ ...ordinary, stdio: { ...ordinary.stdio, control: 'pipe' } }, { TARGET: 'yes' }, identity, {
      spawn: spawn as never, runnerInvocation: ['/node', '/runner.js'],
    })
    expect(calls[0]?.command).toBe('/node')
    expect(calls[0]?.args).toEqual(['/runner.js', '--', 'tool', 'arg'])
    const locator = calls[0]!.env[SUBPROCESS_RUNNER_ENV] as string
    const files = linuxLaunchFilesFromLocator(locator)
    expect(consumeLinuxLaunchRequest(locator)).toEqual({ cwd: '/work', env: { TARGET: 'yes' }, control: 'pipe', runAs: identity })
    vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }) })
    child.exitCode = 0
    child.emit('exit', 0, null)
    await expect(launch.direct).resolves.toEqual({ exitCode: 0, signal: null })
    await launch.owner.waitForExit()
    launch.owner.cleanup?.()
    expect(existsSync(files.directory)).toBe(false)
  })

  it('reports a bootstrap that never consumed its request and removes the files on spawn failure', async () => {
    const { calls, child, spawn } = capture()
    const launch = launchLinuxBootstrap(ordinary, {}, identity, { spawn: spawn as never, runnerInvocation: ['/node', '/runner.js'] })
    scratch.push(linuxLaunchFilesFromLocator(calls[0]!.env[SUBPROCESS_RUNNER_ENV] as string).directory)
    child.emit('exit', 1, null)
    await expect(launch.direct).rejects.toThrow('subprocess bootstrap exited before it consumed the launch request; its target never ran')

    // Launch files land in this spec's own temporary directory, so concurrent specs cannot change the count.
    const launches = privateTmpdir()
    expect(() => launchLinuxBootstrap(ordinary, {}, identity, {
      spawn: () => { throw new Error('spawn refused') }, runnerInvocation: ['/node', '/runner.js'],
    })).toThrow('spawn refused')
    expect(readdirSync(launches).filter(name => name.startsWith('dsh-subprocess-launch-'))).toEqual([])
  })

  it('prepares a terminal bootstrap whose outcome reads the startup error and removes the files', () => {
    const terminal = prepareLinuxTerminalBootstrap({ argv: ordinary.argv, cwd: ordinary.cwd, graceMs: 100, rows: 1, cols: 1, terminalType: 'xterm' }, { T: '1' }, identity, {
      runnerInvocation: ['/node', '/runner.js'],
    })
    expect(terminal.command).toBe('/node')
    expect(terminal.args).toEqual(['/runner.js', '--', 'tool', 'arg'])
    const files = linuxLaunchFilesFromLocator(terminal.env[SUBPROCESS_RUNNER_ENV] as string)
    expect(consumeLinuxLaunchRequest(files.requestPath)).toEqual({ cwd: '/work', env: { T: '1' }, runAs: identity })
    openLinuxStartupError(files)({ type: 'error', error: { name: 'Error', message: 'run-as: refused' } })
    expect(() => terminal.resolveOutcome({ exitCode: 127, signal: null })).toThrow('run-as: refused')
    expect(existsSync(files.directory)).toBe(false)
  })

  it('reads a pre-opened startup error file left empty by a successful exec as no failure', () => {
    const files = createLinuxLaunchFiles({ cwd: '/', env: {}, runAs: identity })
    scratch.push(files.directory)
    openLinuxStartupError(files)
    expect(readLinuxStartupError(files.startupErrorPath)).toBeUndefined()
  })

  it('rejects a launch request whose identity is malformed', () => {
    for (const runAsValue of [{ uid: 1, gid: 1 }, { uid: -1, gid: 1, groups: [] }, { uid: 1, gid: 1, groups: ['x'] }, { uid: 1, gid: 1, groups: [], extra: 1 }, 'root']) {
      const files = createLinuxLaunchFiles({ cwd: '/', env: {}, runAs: runAsValue as never })
      scratch.push(files.directory)
      expect(() => consumeLinuxLaunchRequest(files.requestPath)).toThrow('subprocess runner received an invalid Linux launch request')
    }
  })
})

linux('run-as shell activity records', () => {
  it.each(['bash', 'zsh'])('lets a %s child traverse its record directory and write only the records', (shell) => {
    const identity = ownIdentity()
    const activity = prepareShellActivity({
      argv: [`/bin/${shell}`, '-i'], cwd: '/', rows: 1, cols: 1, terminalType: 'xterm', graceMs: 1, shellActivity: true,
    }, {}, 'linux', tmpdir(), identity)!
    const startup = shell === 'bash' ? activity.argv[2] as string : join(activity.env.ZDOTDIR as string, '.zshenv')
    const records = join(startup, '..')
    try {
      expect(statSync(records).mode & 0o777).toBe(0o711)
      expect(statSync(startup).mode & 0o777).toBe(0o644)
      for (const record of ['state', 'guards']) {
        const info = statSync(join(records, record))
        expect([info.mode & 0o777, info.uid, info.gid]).toEqual([0o600, identity.uid, identity.gid])
      }
    } finally {
      activity.dispose()
    }
  })
})

describe('run-as exec bootstrap', () => {
  const identity = { uid: 2000, gid: 3000, groups: [3002, 3001, 3001] }
  const contained = 'CapPrm:\t0000000000000000\nCapEff:\t0000000000000000\nCapAmb:\t0000000000000000\nNoNewPrivs:\t1\n'
  const status = (uid: number, gid: number, groups: string, rest = contained): string =>
    `Name:\tnode\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\nGid:\t${gid}\t${gid}\t${gid}\t${gid}\nGroups:\t${groups}\n${rest}`

  function host(steps: string[], overrides: Record<string, unknown> = {}) {
    return {
      env: {}, exitCode: undefined as number | undefined, connected: false, directory: '/',
      cwd() { return this.directory },
      chdir(path: string) { steps.push(`chdir ${path}`); this.directory = path },
      on() {}, off() {}, once() {}, disconnect() {},
      setgroups: (groups: number[]) => { steps.push(`setgroups ${groups.join(',')}`) },
      setgid: (gid: number) => { steps.push(`setgid ${gid}`) },
      setuid: (uid: number) => { steps.push(`setuid ${uid}`) },
      ...overrides,
    }
  }

  function bootstrap(statuses: string[], steps: string[], overrides: Record<string, unknown> = {}) {
    const files = createLinuxLaunchFiles({ cwd: '/target', env: { PATH: '/bin', ONLY: 'target' }, runAs: identity })
    scratch.push(files.directory)
    const execve = vi.fn((file: string) => {
      steps.push(`execve ${file}`)
      throw Object.assign(new Error('stop'), { code: 'ENOEXEC_TEST' })
    })
    const runner = host(steps, overrides)
    const internals: SpawnRunnerInternals = {
      execve,
      readProcessStatus: vi.fn(() => statuses.shift() ?? ''),
      setNoNewPrivileges: vi.fn(() => { steps.push('no_new_privs') }),
      loadWin32ProcessBindings: vi.fn(),
      spawnCurrentTokenJobProcess: vi.fn(),
      closeFileDescriptor: vi.fn(),
      resolveWindowsExecutable: vi.fn(),
      pollProcessExit: vi.fn(),
      isJobEmpty: vi.fn(),
      terminateJob: vi.fn(),
      closeHandleChecked: vi.fn(),
    }
    return { files, runner, execve, run: () => runSpawnRunner(files.requestPath, ['--', '/bin/tool'], runner as never, internals) }
  }

  it('takes groups, then group, then user, verifies them, and only then enters the target', async () => {
    const steps: string[] = []
    const { files, run, runner } = bootstrap([status(0, 0, '0'), status(2000, 3000, '3001 3002')], steps)
    await run()
    expect(steps).toEqual(['setgroups 3001,3002', 'setgid 3000', 'setuid 2000', 'no_new_privs', 'chdir /target', 'execve /bin/tool'])
    expect(runner.exitCode).toBe(127)
    expect(readLinuxStartupError(files.startupErrorPath)?.error.message).toBe('spawn /bin/tool ENOEXEC_TEST')
  })

  it('leaves an already matching group list alone', async () => {
    const steps: string[] = []
    const { run } = bootstrap([status(0, 0, '3002 3001'), status(2000, 3000, '3001 3002')], steps)
    await run()
    expect(steps.slice(0, 3)).toEqual(['setgid 3000', 'setuid 2000', 'no_new_privs'])
  })

  it.each([
    ['a user id that did not change', status(0, 3000, '3001 3002')],
    ['a saved group id that did not change', 'Uid:\t2000\t2000\t2000\t2000\nGid:\t3000\t3000\t0\t3000\nGroups:\t3001 3002\n'],
    ['groups that did not change', status(2000, 3000, '3001')],
  ])('refuses %s and never enters the target', async (_case, after) => {
    const steps: string[] = []
    const { files, run, execve, runner } = bootstrap([status(0, 0, ''), after], steps)
    await run()
    expect(execve).not.toHaveBeenCalled()
    expect(steps).not.toContain('chdir /target')
    expect(runner.exitCode).toBe(127)
    expect(readLinuxStartupError(files.startupErrorPath)?.error.message)
      .toBe('run-as: credentials after the change do not match uid 2000, gid 3000, groups [3001, 3002]')
  })

  it.each([
    ['setgroups', status(0, 0, '0'), 'run-as: could not take uid 2000, gid 3000, groups [3001, 3002]: run-as: process.setgroups is unavailable on this host'],
    ['setuid', status(0, 0, '3001 3002'), 'run-as: could not take uid 2000, gid 3000, groups [3001, 3002]: run-as: process.setuid is unavailable on this host'],
  ])('fails closed when %s is unavailable', async (missing, before, message) => {
    const steps: string[] = []
    const { files, run, execve } = bootstrap([before], steps, { [missing]: undefined })
    await run()
    expect(execve).not.toHaveBeenCalled()
    expect(readLinuxStartupError(files.startupErrorPath)?.error.message).toBe(message)
  })

  it.each([
    ['kept capabilities', 'CapPrm:\t0000000000000000\nCapEff:\t0000000000000400\nCapAmb:\t0000000000000000\nNoNewPrivs:\t1\n'],
    ['no no_new_privs', 'CapPrm:\t0000000000000000\nCapEff:\t0000000000000000\nCapAmb:\t0000000000000000\nNoNewPrivs:\t0\n'],
  ])('refuses %s and never enters the target', async (_case, rest) => {
    const steps: string[] = []
    const { files, run, execve } = bootstrap([status(0, 0, ''), status(2000, 3000, '3001 3002', rest)], steps)
    await run()
    expect(execve).not.toHaveBeenCalled()
    expect(readLinuxStartupError(files.startupErrorPath)?.error.message)
      .toBe('run-as: the process kept capabilities or lacks no_new_privs after the change')
  })

  it('fails closed when the kernel reports no credentials', async () => {
    const steps: string[] = []
    const { files, run, execve } = bootstrap(['Name:\tnode\n'], steps)
    await run()
    expect(execve).not.toHaveBeenCalled()
    expect(readLinuxStartupError(files.startupErrorPath)?.error.message)
      .toBe('run-as: could not take uid 2000, gid 3000, groups [3001, 3002]: run-as: /proc/self/status has no Groups line')
  })
})

linux('the server identity', () => {
  /** A provider whose `serverIdentity` names `mcpserver`, this process's own identity with `server` as its own config. */
  async function serving(server: Partial<RunAs> = {}): Promise<Context> {
    const ctx = new Context()
    fibers.push(await ctx.plugin(LocalSubprocessRuntime, {
      runAs: runAs({ inherit: [] }),
      identities: { mcpserver: runAs({ inherit: [], set: { HOME: realpathSync(directory()), USER: 'mcpserver', PATH: '/usr/bin:/bin' }, ...server }) },
      serverIdentity: 'mcpserver',
    }))
    return ctx
  }

  it('reports its name and its home, where servers start, and none without serverIdentity', async () => {
    const home = realpathSync(directory())
    const ctx = await serving({ set: { HOME: home, USER: 'mcpserver', PATH: '/usr/bin:/bin' } })
    expect(ctx.subprocess.serverIdentity).toEqual({ name: 'mcpserver', home })
    expect((await runtime(runAs())).subprocess.serverIdentity).toBeUndefined()
  })

  it('accepts only directories root alone can change on a server\'s PATH, by their spelling and their real path', () => {
    expect(() => { assertRootOwnedPath('/usr/bin', 'refused') }).not.toThrow()
    expect(() => { assertRootOwnedPath('/bin', 'refused') }).not.toThrow()
    const own = directory()
    const linked = join(directory(), 'bin')
    symlinkSync('/usr/bin', linked)
    // Owned by this user, not root; a link in a directory this user can change; relative; missing.
    for (const path of [own, linked, 'usr/bin', join(own, 'missing')]) expect(() => { assertRootOwnedPath(path, 'refused') }, path).toThrow('refused')
    const groupWritable = (path: string) => Object.assign(statSync(path), { uid: 0, mode: path === '/usr' ? 0o40775 : statSync(path).mode })
    expect(() => { assertRootOwnedPath('/usr/bin', 'refused', groupWritable) }).toThrow('refused')
  })

  it.each([
    ['an identity it does not list', { serverIdentity: 'nobody' }, 'serverIdentity "nobody" must name an entry of identities'],
    ['no HOME', { set: { USER: 'mcpserver', PATH: '/usr/bin' } }, 'identities.mcpserver.set.HOME must name the server identity\'s home, an absolute directory'],
    ['a missing HOME', { set: { HOME: '/nonexistent-mcpserver', PATH: '/usr/bin' } }, 'set.HOME "/nonexistent-mcpserver" must be an existing directory named by its real path'],
    ['no PATH of its own', { set: { HOME: 'HOME' } }, 'identities.mcpserver.set.PATH must be set, so no caller replaces the server identity\'s PATH'],
    ['a PATH entry a user other than root owns', { set: { HOME: 'HOME', PATH: 'OWN:/usr/bin' } }, 'identities.mcpserver PATH entry "OWN" must be an absolute existing directory that only root can change'],
    ['an inherited NODE_PATH entry a user other than root owns', { inherit: ['NODE_PATH'], set: { HOME: 'HOME', PATH: '/usr/bin' } }, 'identities.mcpserver NODE_PATH entry "OWN"'],
  ])('fails at load for %s', async (_case, change, message) => {
    const home = realpathSync(directory())
    const own = realpathSync(directory())
    vi.stubEnv('NODE_PATH', own)
    const set = Object.fromEntries(Object.entries((change as { set?: Record<string, string> }).set ?? { HOME: home, PATH: '/usr/bin' })
      .map(([name, value]) => [name, value.replace('HOME', home).replace('OWN', own)]))
    const ctx = new Context()
    await expect(ctx.plugin(LocalSubprocessRuntime, {
      runAs: runAs({ inherit: [] }),
      identities: { mcpserver: runAs({ inherit: (change as { inherit?: string[] }).inherit ?? [], set }) },
      serverIdentity: (change as { serverIdentity?: string }).serverIdentity ?? 'mcpserver',
    })).rejects.toThrow(message.replace('OWN', own))
    expect(ctx.get('subprocess')).toBeUndefined()
  })

  it('refuses a home spelled through a link, owned by another user, or the identity cannot search', () => {
    const home = realpathSync(directory())
    const link = join(directory(), 'home')
    symlinkSync(home, link)
    const identity = (set: Record<string, string>) => new Map([['mcpserver', runAs({ inherit: [], set: { PATH: '/usr/bin', ...set } })]])
    expect(() => resolveServerIdentity('mcpserver', identity({ HOME: link }))).toThrow('must be an existing directory named by its real path')
    const foreign = (path: string) => Object.assign(statSync(path), { uid: path === home ? 4242 : statSync(path).uid })
    expect(() => resolveServerIdentity('mcpserver', identity({ HOME: home }), foreign)).toThrow(`must be owned by uid ${String(process.getuid!())} and writable by no other user but root`)
    const unsearchable = (path: string) => Object.assign(statSync(path), { mode: path === home ? 0o40600 : statSync(path).mode })
    expect(() => resolveServerIdentity('mcpserver', identity({ HOME: home }), unsearchable)).toThrow('cannot search')
    expect(resolveServerIdentity('mcpserver', identity({ HOME: home }))).toEqual({ name: 'mcpserver', home })
  })

  it('refuses a server spawn whose final NODE_PATH names a directory another user could change, before anything starts', async () => {
    const launches = privateTmpdir()
    const ctx = await serving()
    const own = directory()
    expect(() => ctx.subprocess.spawn({ ...reportSpec(directory(), { NODE_PATH: own }), identity: 'mcpserver' }))
      .toThrow(`identities.mcpserver NODE_PATH entry ${JSON.stringify(own)} must be an absolute existing directory that only root can change`)
    expect(readdirSync(launches).filter(name => name.startsWith('dsh-subprocess-launch-'))).toEqual([])
    const allowed = ctx.subprocess.spawn({ ...reportSpec(directory(), { NODE_PATH: '/usr/lib' }), identity: 'mcpserver' })
    await expect(allowed.done).resolves.toEqual({ exitCode: 0, signal: null })
  })

  /** A provider with further identities and no server identity, as a box's that names the Playwright server's in its row. */
  async function identified(identities: Record<string, Partial<RunAs>>): Promise<Context> {
    const ctx = new Context()
    fibers.push(await ctx.plugin(LocalSubprocessRuntime, {
      runAs: runAs({ inherit: [] }),
      identities: Object.fromEntries(Object.entries(identities).map(([name, identity]) => [name, runAs({ inherit: [], ...identity })])),
    }))
    return ctx
  }

  it('gives the home of another identity a server starts as only when it passes the server identity\'s checks', async () => {
    const home = realpathSync(directory())
    const own = realpathSync(directory())
    const ctx = await identified({
      browsermcp: { set: { HOME: home, USER: 'browsermcp', PATH: '/usr/bin:/bin' } },
      planted: { set: { HOME: home, PATH: `${own}:/usr/bin` } },
      homeless: { set: { PATH: '/usr/bin' } },
    })
    expect(ctx.subprocess.serverHome('browsermcp')).toBe(home)
    expect(() => ctx.subprocess.serverHome('nobody')).toThrow('no run-as identity named "nobody" is configured; list it under identities')
    expect(() => ctx.subprocess.serverHome('planted')).toThrow(`identities.planted PATH entry ${JSON.stringify(own)} must be an absolute existing directory that only root can change`)
    expect(() => ctx.subprocess.serverHome('homeless')).toThrow('identities.homeless.set.HOME must name the server identity\'s home, an absolute directory')
    // The base provider configures no identity.
    expect(() => SubprocessRuntime.prototype.serverHome.call(ctx.subprocess, 'browsermcp')).toThrow('this provider configures no identity "browsermcp"')
  })

  it('checks the final NODE_PATH of each spawn as an identity once a server took its home', async () => {
    const launches = privateTmpdir()
    const ctx = await identified({ browsermcp: { set: { HOME: realpathSync(directory()), PATH: '/usr/bin:/bin' } } })
    ctx.subprocess.serverHome('browsermcp')
    const own = directory()
    expect(() => ctx.subprocess.spawn({ ...reportSpec(directory(), { NODE_PATH: own }), identity: 'browsermcp' }))
      .toThrow(`identities.browsermcp NODE_PATH entry ${JSON.stringify(own)} must be an absolute existing directory that only root can change`)
    expect(readdirSync(launches).filter(name => name.startsWith('dsh-subprocess-launch-'))).toEqual([])
  })
})
