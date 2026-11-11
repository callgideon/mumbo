/**
 * Process environment and CLI shims that bind git, gh, and lark-cli to the deployment's accounts and block disallowed commands.
 * Variables read by workers avoid `KEY|PASSWORD|SECRET|TOKEN` in their names because DSH strips credential-shaped variables from child environments.
 * Provides default-path guardrails rather than an OS-level security boundary when workers run under the operator's OS user;
 * under a run-as subprocess provider every worker command, and every command on a ticket directory, runs as the run-as user.
 */
import { lstat, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { delimiter, dirname, join, resolve } from 'node:path'
import type { SubprocessOutputReader, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { Deployment } from '../deployment.ts'
import { SetupError } from '../setup.ts'
import { CliError } from './commands.ts'

const MARKER = '# Written by dsh-superagent on every start; edits are lost.'
/** Markers of files written under the project's earlier names (`dsh-tag`, `dsh-go`, `dsh-freelancer`), which `dsh-superagent` owns and replaces too. */
const LEGACY_MARKERS = ['dsh-tag', 'dsh-go', 'dsh-freelancer'].map(name => `# Written by ${name} on every start; edits are lost.`)
/** Commands workers need, which `blockedCommands` cannot block: the shims and git. */
export const WORKER_COMMANDS: readonly string[] = ['gh', 'git', 'lark-cli']
export const workerBin = (workerDirectory: string): string => join(workerDirectory, 'worker-bin')
export const workerGitConfig = (workerDirectory: string): string => join(workerDirectory, 'worker-gitconfig')
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
const gitQuote = (value: string): string => `"${value.replace(/[\\"]/g, char => `\\${char}`)}"`
export const credentialHelper = (cli: string): string => `!${shellQuote(cli)} auth git-credential`

export function sameDirectory(a: string, b: string): boolean {
  const real = (path: string): string => { try { return realpathSync(path) } catch { return resolve(path) } }
  return real(a) === real(b)
}
export function withoutDirectory(path: string, dir: string): string {
  return path.split(delimiter).filter(entry => !sameDirectory(entry, dir)).join(delimiter)
}

/**
 * Refuses a path the orchestrator runs or reads as root when another user could change it: the path must be owned by this
 * process's user and writable by no other user, as must everything below it, with no symbolic link inside; every ancestor
 * must be owned by root or this user and writable by no other, except a sticky ancestor whose entry on the path this user owns.
 * @param path - absolute path of a file or directory.
 * @param label - what the path is, named in a refusal.
 * @returns the real path that was checked.
 * @throws when the path does not resolve or fails any of these conditions.
 */
export function assertOwnedByRoot(path: string, label: string): string {
  const uid = process.getuid?.()
  const refuse = (at: string, why: string): never => {
    throw new Error(`dsh-superagent ${label}: ${at} ${why}; it must be owned by uid ${uid} and writable by no other user, because the orchestrator runs or reads it as that user`)
  }
  let real = ''
  try { real = realpathSync(path) } catch (error) { refuse(path, `does not resolve (${error instanceof Error ? error.message : String(error)})`) }
  const othersWrite = (mode: number): boolean => (mode & 0o022) !== 0
  for (let child = real, parent = dirname(real); parent !== child; child = parent, parent = dirname(parent)) {
    const info = statSync(parent)
    if (info.uid !== 0 && info.uid !== uid) refuse(parent, 'is owned by another user')
    if (othersWrite(info.mode) && !((info.mode & 0o1000) !== 0 && statSync(child).uid === uid)) refuse(parent, 'is writable by its group or other users')
  }
  const below = (entry: string): void => {
    const info = lstatSync(entry)
    if (info.isSymbolicLink()) refuse(entry, 'is a symbolic link')
    if (info.uid !== uid) refuse(entry, 'is owned by another user')
    if (othersWrite(info.mode)) refuse(entry, 'is writable by its group or other users')
    if (info.isDirectory()) for (const name of readdirSync(entry)) below(join(entry, name))
  }
  below(real)
  return real
}

/**
 * The variables that tell git which repository, work tree and index to act on. A host started inside git, such as by
 * `git rebase --exec`, passes them on, and a git started below it would act on that repository. GIT_CEILING_DIRECTORIES is
 * kept: it names no repository, and it stops git's search for one where the operator chose.
 */
export const GIT_LOCATION: readonly string[] = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE']

/**
 * Returns environment variable overrides that strip ambient GitHub tokens, interactive prompts, the repository the host's own
 * environment may name, and operator git identity/config overrides.
 */
export function agentVariables(workerDirectory: string): Record<string, string | undefined> {
  return {
    GH_TOKEN: undefined, GITHUB_TOKEN: undefined,
    // A worker's git finds the repository from its directory, never from the host's environment.
    ...Object.fromEntries(GIT_LOCATION.map(name => [name, undefined])),
    GIT_CONFIG_GLOBAL: workerGitConfig(workerDirectory), GIT_CONFIG_NOSYSTEM: '1',
    // Clear environment git config overrides; configuration passed through the environment would otherwise reach every git command the agent runs.
    GIT_CONFIG_COUNT: undefined, GIT_CONFIG_PARAMETERS: undefined,
    // When the credential helper has no answer, git must fail rather than prompt; `GIT_ASKPASS: ''` also overrides `core.askPass` and `SSH_ASKPASS`.
    GIT_ASKPASS: '', SSH_ASKPASS: undefined, GIT_TERMINAL_PROMPT: '0',
    // Clear operator commit identity variables; prompts specify commit identity and operator env vars would override what a worker sets.
    GIT_AUTHOR_NAME: undefined, GIT_COMMITTER_NAME: undefined, GIT_AUTHOR_EMAIL: undefined, GIT_COMMITTER_EMAIL: undefined,
  }
}

/** True when a regular file starts with the dsh-superagent marker in its first two lines; a symbolic link, directory, or other non-regular file never counts as written by dsh-superagent. */
async function written(file: string): Promise<boolean> {
  if (!(await lstat(file)).isFile()) return false
  const head = (await readFile(file, 'utf8')).split('\n', 2)
  return [MARKER, ...LEGACY_MARKERS].some(marker => head.includes(marker))
}
async function own(file: string, text: string, mode: number): Promise<void> {
  let foreign = false
  try { foreign = !await written(file) } catch { /* The file does not exist yet. */ }
  if (foreign) throw new SetupError('foreignFile', { file })
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, text, { mode })
  await rename(temporary, file)
}

/**
 * Atomically writes worker CLI shims and the isolated git configuration file into the worker directory, refusing to overwrite foreign files.
 * Each shim strips the shim directory from PATH before exec so wrapper scripts resolving `gh` or `lark-cli` by name reach the real binary.
 * Shims are `0750` and the git configuration `0640`, so in a set-group-ID worker directory the worker's group runs and reads them but
 * cannot change them.
 */
export async function writeEnvironment(deployment: Pick<Deployment, 'workerDirectory' | 'repository' | 'github' | 'feishu'>, blockedCommands: readonly string[]): Promise<void> {
  const { workerDirectory, repository, github, feishu } = deployment
  const dir = workerBin(workerDirectory)
  await mkdir(dir, { recursive: true, mode: 0o750 })
  const before = await readdir(dir)
  for (const name of before) { const file = join(dir, name); if (!await written(file)) throw new SetupError('foreignFile', { file }) }
  // Workers may be running concurrently: write each shim to a temp file and atomically rename it so no command ever resolves past the shim directory.
  const kept = new Set<string>()
  const shim = async (name: string, body: string): Promise<void> => {
    const temporary = join(dir, `.${name}.${process.pid}.tmp`)
    await writeFile(temporary, `#!/bin/sh\n${MARKER}\n${body}\n`, { mode: 0o750 })
    await rename(temporary, join(dir, name))
    kept.add(name)
  }
  const withoutShims = [
    `self=${shellQuote(dir)}`, 'rest=', 'IFS=:', 'set -f',
    'for entry in $PATH; do [ "$entry" = "$self" ] || rest="${rest:+$rest:}$entry"; done',
    'set +f', 'unset IFS', 'PATH=$rest', 'export PATH',
  ].join('\n')
  const run = (program: string): string => `${withoutShims}\nexec ${shellQuote(program)} "$@"`
  const fail = (message: string): string => `echo ${shellQuote(message)} >&2\nexit 1`
  await shim('gh', run(github.cli))
  await shim('lark-cli', feishu ? run(feishu.cli) : fail('lark-cli is unavailable: this installation has no Feishu bot.'))
  for (const name of new Set(blockedCommands.filter(name => !WORKER_COMMANDS.includes(name)))) {
    await shim(name, fail(`${name} is blocked in this installation; use gh, which acts as ${github.login}.`))
  }
  for (const name of before) if (!kept.has(name)) await unlink(join(dir, name))
  await own(workerGitConfig(workerDirectory), [
    MARKER,
    // Make git refuse to commit without an explicit identity set by the worker instead of guessing from the operator's OS user.
    '[user]', '\tuseConfigOnly = true',
    '[credential]', '\thelper =',
    '[credential "https://github.com"]', `\thelper = ${gitQuote(credentialHelper(github.cli))}`,
    '[url "https://github.com/"]', '\tinsteadOf = git@github.com:', '\tinsteadOf = ssh://git@github.com/',
    // Include Git LFS filters because the operator's global gitconfig (which usually holds them) is ignored.
    '[filter "lfs"]', '\tclean = git-lfs clean -- %f', '\tsmudge = git-lfs smudge -- %f', '\tprocess = git-lfs filter-process', '\trequired = true',
  ].join('\n') + '\n', 0o640)
}

/** Applies environment overrides and prepends worker shims to `process.env.PATH`, returning a restore callback. */
export function applyEnvironment(variables: Record<string, string | undefined>, workerDirectory: string, path: string): () => void {
  const values = { ...variables, PATH: [workerBin(workerDirectory), path].join(delimiter) }
  const previous = Object.fromEntries(Object.keys(values).map(name => [name, process.env[name]]))
  const apply = (env: Record<string, string | undefined>): void => { for (const [name, value] of Object.entries(env)) { if (value === undefined) delete process.env[name]; else process.env[name] = value } }
  apply(values)
  return () => { apply(previous) }
}

/** Spawns a command through the DSH subprocess runtime, which strips credential-shaped environment variables. */
export async function runAsWorker(subprocess: SubprocessRuntime, argv: string[], cwd: string, signal: AbortSignal, env?: Record<string, string>): Promise<string> {
  const handle = subprocess.spawn({ argv, cwd, graceMs: 2000, signal, ...env ? { env } : {}, stdio: { stdin: 'ignore', stdout: { maxBytes: 1 << 20 }, stderr: { maxBytes: 1 << 16 } } })
  const { exitCode } = await handle.done
  const read = (reader: SubprocessOutputReader | undefined): string => reader?.readFrom(0).text ?? ''
  if (exitCode === 0) return read(handle.collected.stdout)
  const ended = exitCode === null ? 'was stopped before it finished' : `exited with ${exitCode}`
  throw new CliError(read(handle.collected.stderr).trim() || `${argv.join(' ')} ${ended}`, undefined, exitCode ?? undefined)
}

/**
 * Creates a directory and its missing parents as the worker, through the subprocess service that runs worker commands, so
 * under a run-as provider the worker owns what it creates and root never creates anything on a path the worker can change.
 * @param subprocess - the service that starts worker commands.
 * @param path - absolute directory to create.
 * @param signal - cancellation.
 * @returns the command's output.
 */
export const makeWorkerDirectory = (subprocess: SubprocessRuntime, path: string, signal: AbortSignal): Promise<string> =>
  runAsWorker(subprocess, ['mkdir', '-p', '--', path], '/', signal)

/**
 * Verifies that worker git invocations resolve the deployment's GitHub credential helper. The check runs in `/`, where no
 * repository a worker made can add its own configuration; a git failure other than finding no helper is reported as it is.
 */
export async function verifyEnvironment(deployment: Pick<Deployment, 'github' | 'workerDirectory'>, subprocess: SubprocessRuntime, signal: AbortSignal): Promise<void> {
  const { github, workerDirectory } = deployment
  // `-z` separates fields with NUL and never quotes paths; `--get-all` exits with code 1 when no helper is set.
  const output = await runAsWorker(subprocess, ['git', 'config', '-z', '--show-origin', '--get-all', 'credential.https://github.com.helper'], '/', AbortSignal.any([signal, AbortSignal.timeout(60_000)]))
    .catch((error: unknown) => { if (error instanceof CliError && error.exitCode === 1) return ''; throw error })
  if (output !== [`file:${workerGitConfig(workerDirectory)}`, credentialHelper(github.cli), ''].join('\0')) {
    throw new SetupError('gitTooOld', { output: output === '' ? 'git reports no github.com credential helper' : `git reports ${output.split('\0').filter(Boolean).join(' ')}` })
  }
}

/**
 * Verifies that a ticket directory's local or worktree git config defines no custom `credential.*` or `http.*extraheader`
 * keys, which the agent's git would read from the repository's own config and act on.
 */
export async function verifyDirectory(directory: string, subprocess: SubprocessRuntime, signal: AbortSignal): Promise<void> {
  const keys = ['git', 'config', '-z', '--show-scope', '--get-regexp', '^(credential\\..*|http\\..*extraheader)$']
  // `git config --get-regexp` exits with code 1 when no keys match.
  const output = await runAsWorker(subprocess, keys, directory, AbortSignal.any([signal, AbortSignal.timeout(60_000)]))
    .catch((error: unknown) => { if (error instanceof CliError && error.exitCode === 1) return ''; throw error })
  const scoped = output.split('\0')
  const local = scoped.flatMap((scope, index) => index % 2 === 0 && (scope === 'local' || scope === 'worktree') ? [scoped[index + 1]!.split('\n')[0]!] : [])
  if (local.length) throw new Error(`The git configuration of the repository in ${directory} sets ${local.join(', ')}, which the agent's git would also read; remove them.`)
}
