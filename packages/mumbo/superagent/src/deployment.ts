/** Plugin configuration and startup verification for repository access and agent CLI identities. */
import { LIMITS } from './limits.ts'
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import type { Volatile } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { z } from 'zod'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { assertOwnedByRoot, runAsWorker, sameDirectory, withoutDirectory, workerBin } from './infra/environment.ts'
import { SetupError } from './setup.ts'

const reason = (error: unknown): string => error instanceof Error ? error.message : String(error)
const absolute = (description: string) => s.string().pattern(/^\//).description(`${description} Absolute path.`)
/** Plugin configuration of the dsh-superagent entry. Volatile fields apply without a restart because dsh-superagent reads them on each use; changing `stateDir` remounts the plugin. */
export const Config = s.object({
  stateDir: absolute('Directory for the database, locks and, unless `workerDirectory` names another, the worker shims and the agent\'s git configuration.').required(),
  workDirectory: absolute('Directory that holds the ticket directories when the Execution settings name none; defaults to `<stateDir>/work`. Under a run-as subprocess provider the worker user must be able to write it.'),
  workerDirectory: absolute('Directory for the worker shims (`worker-bin`) and the agent\'s git configuration (`worker-gitconfig`), which workers run and read and the orchestrator reads too; defaults to `stateDir`. Required under a run-as subprocess provider, where it, every ancestor and everything in it must be owned by root and writable by no other user; give the worker\'s group read and search access, such as `root:agent` mode `2750`.'),
  ghConfigDirectory: absolute('`GH_CONFIG_DIR` of the orchestrator\'s own GitHub CLI calls; unset, the CLI uses its own default. Required under a run-as subprocess provider, where it, every ancestor and everything in it must be owned by root and writable by no other user, because a gh alias runs commands.'),
  promptMaxChars: s.number().min(LIMITS.promptMaxChars.min).max(LIMITS.promptMaxChars.max).step(1).default(100000)
    .description('Largest saved prompt configuration, in characters.').volatile(),
  admissionContextMaxPages: s.number().min(LIMITS.admissionContextMaxPages.min).max(LIMITS.admissionContextMaxPages.max).step(1).default(10)
    .description('Pages of thread context one assessment may read.').volatile(),
  admissionContextTimeoutMs: s.number().min(LIMITS.admissionContextTimeoutMs.min).max(LIMITS.admissionContextTimeoutMs.max).step(1)
    .default(15000).description('Time limit of one context read during an assessment, in milliseconds.').volatile(),
  panelAdmins: s.array(s.string().pattern(/^[^\s*,@A-Z]+@[^\s*,@A-Z]+$/)).default([])
    .description('Lowercased emails of the `edge-member` principals that may use the management panel besides the owner; exact matches only.'),
  // The union wrapper drops the implicit `{}` default of an object schema, so an absent key stays absent.
  githubApp: s.union([s.object({
    login: s.string().pattern(/^[A-Za-z0-9-]+\[bot\]$/).required().description('The App\'s bot login, `<slug>[bot]`.'),
    userId: s.number().min(1).step(1).required().description('The bot user\'s numeric id, from `gh api \'users/<slug>[bot]\' --jq .id`; not the App ID.'),
  })]).description('Act on GitHub as a GitHub App\'s bot. The agent CLI reaches GitHub with an installation token, which cannot read `/user` or notifications: setup takes the identity from here, and the GitHub Source reads the repository\'s Issues, pull requests and comments instead of notifications. Unset, the CLI is signed in to a user account.'),
})
export type DeploymentConfig = ReturnType<typeof Config>
export interface Machine {
  stateDir: string
  /** Default root of the ticket directories: `workDirectory`, else `<stateDir>/work`. */
  workDirectory: string
  /** Directory of `worker-bin` and `worker-gitconfig`: `workerDirectory`, else `stateDir`; under run-as, its checked real path. */
  workerDirectory: string
  /** `GH_CONFIG_DIR` of the orchestrator's own CLI calls; under run-as, its checked real path. */
  ghConfigDirectory?: string | undefined
  /** Whether the subprocess provider runs workers as a run-as identity, so root must never run what they can change. */
  runAs: boolean
  promptMaxChars: Volatile<number>
  admissionContextMaxPages: Volatile<number>
  admissionContextTimeoutMs: Volatile<number>
  /** Lowercased `edge-member` emails admitted to the management panel besides the owner. */
  panelAdmins: readonly string[]
  /** Set when the agent acts as a GitHub App's bot (App mode); unset when its CLI is signed in to a user account. */
  githubApp?: { login: string; userId: number } | undefined
}
const MOVED: Record<string, string> = {
  repository: 'on the GitHub Source', branchPrefix: 'in the prepare command of the Execution settings', github: 'on the GitHub Source',
  feishu: 'on the Feishu Source', author: 'prompt text', repositoryPath: 'in the prepare command of the Execution settings',
  worktreeRoot: 'the ticket directory of the Execution settings', blockedCommands: 'in the Execution settings',
}

/**
 * Read machine settings and reject unknown configuration keys (naming where deprecated keys moved). Under a run-as
 * subprocess provider the orchestrator runs as root what workers run as another user, so `workerDirectory` and
 * `ghConfigDirectory` must be set and pass {@link assertOwnedByRoot}; the machine keeps the real paths checked.
 * @param config - the validated plugin configuration.
 * @param runAs - whether the mounted subprocess provider runs children as a run-as identity.
 * @returns the machine settings.
 * @throws when a key is unknown, or under run-as when either directory is unset or another user could change it.
 */
export function machineOf(config: DeploymentConfig, runAs = false): Machine {
  const unknown = Object.keys(config).filter(key => !(key in (Config.dict ?? {})))
  if (unknown.length) throw new Error(`dsh-superagent configuration has keys it does not use: ${unknown.map(key => MOVED[key] ? `${key} (now ${MOVED[key]})` : key).join(', ')}; the keys are ${Object.keys(Config.dict ?? {}).join(', ')}`)
  const { stateDir, workDirectory, workerDirectory, ghConfigDirectory, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs, panelAdmins, githubApp } = config
  const contained = (key: 'workerDirectory' | 'ghConfigDirectory', path: string | undefined): string | undefined => {
    if (!runAs) return path
    if (path === undefined) throw new Error(`dsh-superagent ${key} must be set under a run-as subprocess provider: the orchestrator, as root, uses what it holds`)
    return assertOwnedByRoot(path, key)
  }
  return { stateDir, workDirectory: workDirectory ?? join(stateDir, 'work'), workerDirectory: contained('workerDirectory', workerDirectory) ?? stateDir,
    ghConfigDirectory: contained('ghConfigDirectory', ghConfigDirectory), runAs, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs, panelAdmins, githubApp }
}

/** `owner/name`, where neither part is `.` or `..`, which would leave `repos/` in an API path. */
const REPOSITORY = /^(?!\.\.?\/)[A-Za-z0-9_.-]+\/(?!\.\.?$)[A-Za-z0-9_.-]+$/
export const GithubAccountsSchema = z.object({
  repository: z.string().trim().regex(new RegExp(`^$|${REPOSITORY.source}`), 'owner/name').default(''),
  cli: z.string().trim().default(''),
})
export const FeishuBotSchema = z.object({ cli: z.string().trim().default('') })
/** Source configuration keys that affect deployment setup and trigger a restart when changed. */
export const SETUP_FIELDS: Readonly<Record<string, readonly string[]>> = { github: Object.keys(GithubAccountsSchema.shape), feishu: Object.keys(FeishuBotSchema.shape) }

export interface Deployment extends Machine {
  repository: string
  github: { cli: string; login: string; noreply: string }
  feishu?: FeishuBot
}
export interface FeishuBot { cli: string; appId: string; brand: 'feishu' | 'lark'; botId: string; name: string }

/** Resolve a command name or absolute path to an executable file, ignoring the worker shim directory. */
export function executable(name: string, path: string, exclude?: string): string {
  if (name.includes('/') && !isAbsolute(name)) throw new Error(`${name} must be a command name or an absolute path`)
  const candidates = isAbsolute(name) ? [name] : path.split(delimiter).filter(dir => isAbsolute(dir) && !(exclude && sameDirectory(dir, exclude))).map(dir => join(dir, name))
  for (const candidate of candidates) {
    try { if (statSync(candidate).isFile()) { accessSync(candidate, constants.X_OK); return candidate } }
    catch { /* Not an executable file here; try the next PATH directory. */ }
  }
  throw new Error(`${name} is not an executable file${isAbsolute(name) ? '' : ' on PATH'}`)
}

export type Probe = (argv: string[]) => Promise<string>
/**
 * Run startup checks through DSH's worker subprocess service with worker shims removed from PATH so a `gh` wrapper script reaches the real binary.
 * The checks run in `/`, where no repository a worker made can change what the CLIs read.
 * @param subprocess - the service that starts worker commands, as the run-as identity when it has one.
 * @param workerDirectory - the directory whose `worker-bin` is removed from PATH.
 * @param signal - cancellation; each check also stops after 60 seconds.
 * @returns the probe.
 */
export function workerProbe(subprocess: SubprocessRuntime, workerDirectory: string, signal: AbortSignal): Probe {
  const path = withoutDirectory(process.env.PATH ?? '', workerBin(workerDirectory))
  return argv => runAsWorker(subprocess, ['env', `PATH=${path}`, ...argv], '/', AbortSignal.any([signal, AbortSignal.timeout(60_000)]))
}

const GithubUser = z.object({ login: z.string().regex(/^[A-Za-z0-9-]+$/), id: z.number().int().positive() })
const RepositoryAccess = z.object({ name: z.string().regex(REPOSITORY), push: z.boolean().nullable() })
function parsed<T>(schema: z.ZodType<T>, text: string): T | undefined {
  let value: unknown
  try { value = JSON.parse(text) } catch { return undefined /* Non-JSON output; the caller surfaces the setup failure. */ }
  const result = schema.safeParse(value)
  return result.success ? result.data : undefined
}
/**
 * Verify the agent's GitHub CLI identity and push access to the configured repository.
 * With `machine.githubApp` the identity is the App's bot and `/user` is not read; an installation token does not report
 * `permissions`, so only a reported read-only access refuses. Under run-as the CLI is kept by the real path checked, and
 * GitHub's name for the repository, which the worker reports, must equal the configured one but for case.
 */
export async function resolveDeployment(machine: Machine, github: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<Deployment> {
  const { workerDirectory, githubApp } = machine
  const accounts = GithubAccountsSchema.parse(github ?? {})
  const remote = accounts.repository
  if (!remote) throw new SetupError('repositoryUnset')
  if (!accounts.cli) throw new SetupError('agentCliUnset')
  let cli: string
  try { cli = executable(accounts.cli, path, workerBin(workerDirectory)) } catch (error) { throw new SetupError('agentCliMissing', { output: reason(error) }) }
  // The orchestrator runs this CLI as root; under run-as, a CLI the worker could change would run the worker's code as root.
  // Every caller then runs the real path checked here, so a link on the way that the worker repoints later changes nothing.
  if (machine.runAs) try { cli = assertOwnedByRoot(cli, 'agent GitHub CLI') } catch (error) { throw new SetupError('agentCliUnsafe', { cli, output: reason(error) }) }
  const agent = githubApp ? { login: githubApp.login, id: githubApp.userId }
    : parsed(GithubUser, await probe([cli, 'api', 'user']).catch((error: unknown) => { throw new SetupError('agentCliSignedOut', { output: reason(error) }) }))
  if (!agent) throw new SetupError('agentCliNoAccount')
  // Use the canonical repository name returned by GitHub so renamed repositories match incoming notifications.
  const access = parsed(RepositoryAccess, await probe([cli, 'api', `repos/${remote}`, '--jq', '{name: .full_name, push: .permissions.push}']).catch((error: unknown) => {
    throw new SetupError('repositoryUnreadable', { account: agent.login, repository: remote, output: reason(error) })
  }))
  if (!access) throw new SetupError('repositoryUnreported', { repository: remote })
  // Under run-as the worker answers this probe, so its answer may only correct the name's case, never pick another repository.
  if (machine.runAs && access.name.toLowerCase() !== remote.toLowerCase()) throw new SetupError('repositoryRenamed', { repository: remote, name: access.name })
  const repository = access.name
  if (githubApp ? access.push === false : access.push !== true) throw new SetupError('repositoryReadOnly', { account: agent.login, repository })
  return { ...machine, repository, github: { cli, login: agent.login, noreply: `${agent.id}+${agent.login}@users.noreply.github.com` } }
}

const AuthStatus = z.object({ appId: z.string().regex(/^cli_[A-Za-z0-9]+$/), brand: z.enum(['feishu', 'lark']).default('feishu'), identities: z.object({ bot: z.object({ status: z.string() }) }) })
const BotInfo = z.object({ bot: z.object({ open_id: z.string().regex(/^ou_[A-Za-z0-9]+$/), app_name: z.string().default('') }) })
/**
 * Verify that the configured Feishu CLI is authenticated as a bot and restricted to strict mode `bot`.
 * Workers invoke this CLI as `lark-cli`, so a CLI that also permits a user identity would let workers act as that user.
 */
export async function resolveFeishuBot(machine: Machine, feishu: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<FeishuBot | undefined> {
  const { cli: name } = FeishuBotSchema.parse(feishu ?? {})
  if (!name) return undefined
  const fail = (error: unknown): never => { throw error instanceof SetupError ? error : new SetupError('feishuCliFailed', { output: reason(error) }) }
  let cli = ''
  try { cli = executable(name, path, workerBin(machine.workerDirectory)) } catch (error) { fail(error) }
  const run = (...args: string[]): Promise<string> => probe(['env', 'LARKSUITE_CLI_NO_UPDATE_NOTIFIER=1', 'LARKSUITE_CLI_NO_SKILLS_NOTIFIER=1', cli, ...args]).catch(fail)
  const text = await run('auth', 'status')
  const status = parsed(AuthStatus, text.slice(text.indexOf('{')))
  if (!status) return fail(new SetupError('feishuNoApp'))
  if (status.identities.bot.status !== 'ready') fail(new SetupError('feishuBotNotReady', { app: status.appId, status: status.identities.bot.status }))
  const mode = /strict-mode:\s*(\w+)/.exec(await run('config', 'strict-mode'))?.[1]
  if (mode !== 'bot') fail(new SetupError('feishuUserIdentity', { mode: mode ?? 'unknown' }))
  // `--format json` unwraps only `data`, whereas this endpoint returns the payload under `bot`.
  const info = parsed(BotInfo, (await run('api', 'GET', '/open-apis/bot/v3/info', '--as', 'bot', '--format', 'ndjson')).split('\n')[0] ?? '')
  if (!info) return fail(new SetupError('feishuNoBot'))
  return { cli, appId: status.appId, brand: status.brand, botId: info.bot.open_id, name: info.bot.app_name }
}
