import { execFile } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Config, GithubAccountsSchema, executable, machineOf, resolveDeployment, resolveFeishuBot, type Machine, type Probe } from '../src/deployment.ts'
import { Commands } from '../src/infra/commands.ts'
import { gitEnv } from './fixtures/git.ts'

const exec = promisify(execFile)
let dir: string
let path: string
const program = (file: string, body = ''): string => { writeFileSync(file, `#!/bin/sh\n${body}\n`); chmodSync(file, 0o755); return file }
/** Fake gh CLI signed in as `login` with configurable push access to acme/widgets (including its former name acme/gadgets). */
const gh = (file: string, login: string, push: boolean | null = true): string => program(file, `case "$*" in\n  "api user") echo '{"login":"${login}","id":7}' ;;\n  "api repos/acme/"*" --jq {name: .full_name, push: .permissions.push}") echo '{"name":"acme/widgets","push":${push}}' ;;\n  *) exit 1 ;;\nesac`)
/** Fake lark-cli script body returning canned auth, strict-mode, and bot info responses. */
const lark = (status: object, mode = 'bot', bot: object = { bot: { open_id: 'ou_bot', app_name: 'Widgets Bot' }, code: 0 }): string =>
  `case "$*" in\n  "auth status") echo '${JSON.stringify(status)}' ;;\n  "config strict-mode") echo 'strict-mode: ${mode} (source: profile)' ;;\n  "api GET /open-apis/bot/v3/info --as bot --format ndjson") echo '${JSON.stringify(bot)}' ;;\nesac`
const minimal = (overrides: Record<string, unknown> = {}) => ({ stateDir: join(dir, 'state'), ...overrides })
const machine = (overrides: Partial<Machine> = {}): Machine => ({ ...machineOf(Config(minimal())), ...overrides })
/** Runs commands like worker shells do, but locally: the stand-ins first on PATH, then the system's git. */
const probe: Probe = async argv => (await exec(argv[0]!, argv.slice(1), { env: { PATH: path, HOME: dir } })).stdout
const setupError = (place: string, code: string, values: Record<string, unknown> = {}) => expect.objectContaining({ place, code, values: expect.objectContaining(values) })

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'deployment-'))
  mkdirSync(join(dir, 'bin')); mkdirSync(join(dir, 'state', 'worker-bin'), { recursive: true }); mkdirSync(join(dir, 'widgets', 'src'), { recursive: true })
  path = [join(dir, 'state-link', 'worker-bin'), `${join(dir, 'state', 'worker-bin')}/`, join(dir, 'bin'), '/usr/bin', '/bin'].join(':')
  gh(join(dir, 'bin', 'gh'), 'Agent-Bot')
  program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', brand: 'lark', identities: { bot: { status: 'ready' } } }))
  // Stale worker shims with the same binary name must be skipped regardless of PATH normalization or symlinks.
  program(join(dir, 'state', 'worker-bin', 'gh'))
  symlinkSync(join(dir, 'state'), join(dir, 'state-link'))
  await exec('git', ['init', '-q', join(dir, 'widgets')], { env: gitEnv() })
  await exec('git', ['-C', join(dir, 'widgets'), 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git'], { env: gitEnv() })
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

// Setup spawns CLI subprocesses that can take several seconds when tests run in parallel.
vi.setConfig({ testTimeout: 30_000 })

describe('configuration schema', () => {
  it('requires only the state directory and reads the editable fields through references', () => {
    expect(() => Config({})).toThrow('stateDir')
    const read = machineOf(Config({ stateDir: join(dir, 'state') }))
    // Limits are volatile references that the loader updates in place and callers read when used.
    expect({ ...read, promptMaxChars: read.promptMaxChars.get(), admissionContextMaxPages: read.admissionContextMaxPages.get(),
      admissionContextTimeoutMs: read.admissionContextTimeoutMs.get() })
      .toEqual({ stateDir: join(dir, 'state'), workDirectory: join(dir, 'state', 'work'), workerDirectory: join(dir, 'state'), runAs: false,
        promptMaxChars: 100000, admissionContextMaxPages: 10, admissionContextTimeoutMs: 15000, panelAdmins: [] })
    // The ticket directories' root is its own row setting, as a contained box puts them inside the model's directories.
    expect(machineOf(Config({ stateDir: join(dir, 'state'), workDirectory: '/root/work' })).workDirectory).toBe('/root/work')
    expect(() => Config(minimal({ workDirectory: 'relative/work' }))).toThrow()
    expect(() => Config(minimal({ stateDir: 'relative/dir' }))).toThrow()
    expect(() => Config(minimal({ stateDir: '~/dir' }))).toThrow()
  })
  it('accepts panel admins only as lowercased email addresses', () => {
    expect(machineOf(Config(minimal({ panelAdmins: ['alice@example.com', 'bob.o+x@sub.example.org'] }))).panelAdmins)
      .toEqual(['alice@example.com', 'bob.o+x@sub.example.org'])
    for (const entry of ['Alice@example.com', 'alice', '*@example.com', '@example.com', 'alice@', ' alice@example.com', 'a@b@c']) {
      expect(() => Config(minimal({ panelAdmins: [entry] })), entry).toThrow()
    }
  })
  it('reads a GitHub App bot only as a `<slug>[bot]` login with a positive integer user id', () => {
    const app = { login: 'mumbo-bot[bot]', userId: 341797844 }
    expect(machineOf(Config(minimal({ githubApp: app }))).githubApp).toEqual(app)
    expect(machineOf(Config(minimal())).githubApp).toBeUndefined()
    for (const githubApp of [{ ...app, login: 'mumbo-bot' }, { ...app, login: 'mumbo bot[bot]' }, { ...app, userId: 0 }, { ...app, userId: 1.5 },
      { login: app.login }, { userId: app.userId }]) {
      expect(() => machineOf(Config(minimal({ githubApp }))), JSON.stringify(githubApp)).toThrow()
    }
  })
  it('reads the edge only with an https endpoint (http on 127.0.0.1 alone), an absolute token file and a project id', () => {
    const edge = { url: 'https://llm.app.mumbo.si/mcp', tokenFile: '/root/.mumbo/edge.token', project: '0123456789abcdef' }
    expect(machineOf(Config(minimal({ edge }))).edge).toEqual(edge)
    expect(machineOf(Config(minimal({ edge: { ...edge, url: 'http://127.0.0.1:8080/mcp' } }))).edge?.url).toBe('http://127.0.0.1:8080/mcp')
    expect(machineOf(Config(minimal())).edge).toBeUndefined()
    for (const bad of [{ ...edge, url: 'http://llm.app.mumbo.si/mcp' }, { ...edge, url: 'https://llm.app.mumbo.si' }, { ...edge, url: 'ftp://x/mcp' },
      { ...edge, tokenFile: 'edge.token' }, { ...edge, project: 'Project-1' }, { url: edge.url, tokenFile: edge.tokenFile }, { url: edge.url, project: edge.project }]) {
      expect(() => machineOf(Config(minimal({ edge: bad }))), JSON.stringify(bad)).toThrow()
    }
  })
  it('names keys the configuration does not define, and where the values of older keys live now', () => {
    const raw = minimal({ repository: 'acme/widgets', repositoryPath: '/srv/widgets', blockedCommands: [], author: { name: 'Alice' }, extra: 1 })
    expect(() => machineOf(Config(raw))).toThrow('keys it does not use: repository (now on the GitHub Source), repositoryPath (now in the prepare command of the Execution settings), blockedCommands (now in the Execution settings), author (now prompt text), extra; the keys are stateDir, workDirectory, workerDirectory, ghConfigDirectory, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs, panelAdmins')
  })
})

describe('under a run-as subprocess provider', () => {
  const contained = (overrides: Record<string, unknown> = {}) =>
    machineOf(Config(minimal({ workDirectory: join(dir, 'work'), workerDirectory: join(dir, 'worker'), ghConfigDirectory: join(dir, 'gh'), ...overrides })), true)
  beforeEach(() => {
    // Modes are set explicitly: the test process's umask may leave new entries group-writable.
    mkdirSync(join(dir, 'worker', 'worker-bin'), { recursive: true }); chmodSync(join(dir, 'worker'), 0o750); chmodSync(join(dir, 'worker', 'worker-bin'), 0o750)
    chmodSync(join(dir, 'bin'), 0o755)
    writeFileSync(join(dir, 'worker', 'worker-gitconfig'), '', { mode: 0o640 })
    mkdirSync(join(dir, 'gh'), { mode: 0o700 }); writeFileSync(join(dir, 'gh', 'config.yml'), '', { mode: 0o600 })
    mkdirSync(join(dir, 'state'), { recursive: true })
  })
  it('requires the worker directory and the orchestrator\'s gh configuration, and keeps the real paths it checked', () => {
    expect(() => machineOf(Config(minimal({ ghConfigDirectory: join(dir, 'gh') })), true)).toThrow('workerDirectory must be set under a run-as subprocess provider')
    expect(() => machineOf(Config(minimal({ workerDirectory: join(dir, 'worker') })), true)).toThrow('ghConfigDirectory must be set under a run-as subprocess provider')
    expect(contained()).toMatchObject({ workerDirectory: join(dir, 'worker'), ghConfigDirectory: join(dir, 'gh'), runAs: true })
    symlinkSync(join(dir, 'gh'), join(dir, 'gh-link'))
    expect(contained({ ghConfigDirectory: join(dir, 'gh-link') })).toMatchObject({ workerDirectory: join(dir, 'worker'), ghConfigDirectory: join(dir, 'gh'), runAs: true })
    // Without run-as nothing is checked, and the worker files stay in the state directory.
    expect(machineOf(Config(minimal()))).toMatchObject({ workerDirectory: join(dir, 'state'), ghConfigDirectory: undefined, runAs: false })
  })
  it('refuses at load a work directory in the state directory, which workers cannot enter, its default included', () => {
    const state = join(dir, 'state')
    expect(() => contained({ workDirectory: undefined })).toThrow(`dsh-superagent workDirectory ${join(state, 'work')} (its default, <stateDir>/work) is in stateDir ${state}, which workers cannot enter under a run-as subprocess provider; set workDirectory to a directory outside stateDir, such as /root/work`)
    for (const work of [state, join(state, 'tickets'), `${state}/../state/work`]) {
      expect(() => contained({ workDirectory: work }), work).toThrow(`is in stateDir ${state}, which workers cannot enter`)
    }
    expect(contained({ workDirectory: `${state}-work` }).workDirectory).toBe(`${state}-work`)
    // Without run-as the default stays in the state directory.
    expect(machineOf(Config(minimal())).workDirectory).toBe(join(state, 'work'))
  })
  it('refuses at load a directory, an entry in it or an ancestor that another user could change, and a link inside', () => {
    const refused = (change: () => void, restore: () => void, message: string) => {
      change()
      expect(() => contained()).toThrow(message)
      restore()
      expect(contained().runAs).toBe(true)
    }
    const worker = join(dir, 'worker'), config = join(worker, 'worker-gitconfig'), shim = join(worker, 'worker-bin', 'gh')
    refused(() => { chmodSync(worker, 0o770) }, () => { chmodSync(worker, 0o750) }, `workerDirectory: ${worker} is writable by its group or other users`)
    refused(() => { chmodSync(config, 0o660) }, () => { chmodSync(config, 0o640) }, `workerDirectory: ${config} is writable by its group or other users`)
    refused(() => { symlinkSync('/usr/bin/gh', shim) }, () => { rmSync(shim) }, `workerDirectory: ${shim} is a symbolic link`)
    refused(() => { chmodSync(join(dir, 'gh', 'config.yml'), 0o606) }, () => { chmodSync(join(dir, 'gh', 'config.yml'), 0o600) },
      `ghConfigDirectory: ${join(dir, 'gh', 'config.yml')} is writable by its group or other users`)
    refused(() => { chmodSync(dir, 0o777) }, () => { chmodSync(dir, 0o700) }, `workerDirectory: ${dir} is writable by its group or other users`)
    expect(() => contained({ workerDirectory: join(dir, 'missing') })).toThrow(`workerDirectory: ${join(dir, 'missing')} does not resolve`)
  })
  it('refuses an agent GitHub CLI another user could change, because the orchestrator runs it as root', async () => {
    const cli = gh(join(dir, 'bin', 'gh-shared'), 'Agent-Bot')
    chmodSync(cli, 0o775)
    const repository = 'acme/widgets'
    await expect(resolveDeployment({ ...machine(), runAs: true }, { repository, cli }, probe, probe, path))
      .rejects.toEqual(setupError('github', 'agentCliUnsafe', { cli, output: expect.stringContaining(`${cli} is writable by its group or other users`) }))
    // Without run-as the operator's own CLI is not checked.
    await expect(resolveDeployment(machine(), { repository, cli }, probe, probe, path)).resolves.toMatchObject({ github: { cli } })
    chmodSync(cli, 0o755)
    await expect(resolveDeployment({ ...machine(), runAs: true }, { repository, cli }, probe, probe, path)).resolves.toMatchObject({ github: { cli } })
  })
  it('runs the real path of the agent GitHub CLI it checked, so a link the worker repoints after setup runs nothing else as root', async () => {
    const real = gh(join(dir, 'bin', 'gh-real'), 'Agent-Bot')
    const shared = join(dir, 'shared')
    mkdirSync(shared)
    chmodSync(shared, 0o777)
    const link = join(shared, 'gh')
    symlinkSync(real, link)
    const deployment = await resolveDeployment({ ...machine(), runAs: true }, { repository: 'acme/widgets', cli: link }, probe, probe, path)
    expect(deployment.github.cli).toBe(real)
    rmSync(link)
    symlinkSync(program(join(shared, 'worker-gh'), 'echo \'{"login":"worker"}\''), link)
    const commands = new Commands(() => deployment, {}, new AbortController().signal)
    expect(await commands.gh(['api', 'user'])).toEqual({ login: 'Agent-Bot', id: 7 })
  })
  it('under run-as takes GitHub\'s name for the repository, which the worker reports, only when it differs from the configured one in case alone', async () => {
    const cli = program(join(dir, 'bin', 'gh-any'), `case "$*" in\n  "api user") echo '{"login":"Agent-Bot","id":7}' ;;\n  "api repos/"*) echo '{"name":"acme/widgets","push":true}' ;;\nesac`)
    await expect(resolveDeployment({ ...machine(), runAs: true }, { repository: 'victim/private', cli }, probe, probe, path))
      .rejects.toEqual(setupError('github', 'repositoryRenamed', { repository: 'victim/private', name: 'acme/widgets' }))
    expect((await resolveDeployment({ ...machine(), runAs: true }, { repository: 'ACME/Widgets', cli }, probe, probe, path)).repository).toBe('acme/widgets')
    // Without run-as the operator's own CLI may resolve a renamed repository.
    expect((await resolveDeployment(machine(), { repository: 'victim/private', cli }, probe, probe, path)).repository).toBe('acme/widgets')
  })
  it('under run-as takes the agent\'s login from the orchestrator\'s own CLI calls, not from what the worker answers', async () => {
    const cli = gh(join(dir, 'bin', 'gh-agent'), 'Agent-Bot')
    // The worker answers `/user` through a gh configuration it can write.
    const worker: Probe = argv => argv.join(' ') === `${cli} api user` ? Promise.resolve('{"login":"maintainer","id":42}') : probe(argv)
    const contained = { ...machine(), runAs: true }
    expect((await resolveDeployment(contained, { repository: 'acme/widgets', cli }, worker, probe, path)).github)
      .toEqual({ cli, login: 'Agent-Bot', noreply: '7+Agent-Bot@users.noreply.github.com' })
    const signedOut: Probe = argv => argv.includes('user') ? Promise.reject(new Error('gh auth login')) : probe(argv)
    await expect(resolveDeployment(contained, { repository: 'acme/widgets', cli }, worker, signedOut, path))
      .rejects.toEqual(setupError('github', 'agentCliSignedOut', { output: 'gh auth login' }))
    // Without run-as the CLI as worker shells run it names the account, as upstream.
    expect((await resolveDeployment(machine(), { repository: 'acme/widgets', cli }, worker, signedOut, path)).github.login).toBe('maintainer')
  })
  it('refuses a repository whose owner or name is . or .., which would leave repos/ in an API path', () => {
    for (const repository of ['../..', './x', 'acme/..', 'acme/.']) expect(() => GithubAccountsSchema.parse({ repository }), repository).toThrow('owner/name')
    expect(GithubAccountsSchema.parse({ repository: 'acme/.github' }).repository).toBe('acme/.github')
  })
})

describe('setup', () => {
  it('reads the repository from the GitHub Source and the accounts from their CLIs, skipping the worker shims', async () => {
    const deployment = await resolveDeployment(machine(), { repository: 'acme/widgets', cli: 'gh' }, probe, probe, path)
    expect(deployment).toMatchObject({ repository: 'acme/widgets', github: { cli: join(dir, 'bin', 'gh'), login: 'Agent-Bot', noreply: '7+Agent-Bot@users.noreply.github.com' } })
    expect(deployment.github).toEqual({ cli: join(dir, 'bin', 'gh'), login: 'Agent-Bot', noreply: '7+Agent-Bot@users.noreply.github.com' })
    expect(deployment).not.toHaveProperty('feishu')
    // A renamed repository is still resolved by its old name; notifications carry GitHub's current full_name.
    expect((await resolveDeployment(machine(), { repository: 'acme/gadgets', cli: 'gh' }, probe, probe, path)).repository).toBe('acme/widgets')
  })
  it('names what setup needs and where it is set', async () => {
    const needs = (place: string, code: string, values: Record<string, unknown>, github: unknown) =>
      expect(resolveDeployment(machine(), github, probe, probe, path)).rejects.toEqual(setupError(place, code, values))
    const repository = 'acme/widgets'
    await needs('github', 'repositoryUnset', {}, { cli: 'gh' })
    await needs('github', 'agentCliUnset', {}, { repository })
    await needs('github', 'agentCliMissing', { output: `${join(dir, 'missing')} is not an executable file` }, { repository, cli: join(dir, 'missing') })
    await needs('github', 'agentCliMissing', { output: 'bin/gh must be a command name or an absolute path' }, { repository, cli: 'bin/gh' })
    await needs('github', 'agentCliSignedOut', {}, { repository, cli: program(join(dir, 'bin', 'gh-broken'), 'exit 1') })
    await needs('github', 'repositoryReadOnly', { account: 'Agent-Bot', repository: 'acme/widgets' }, { repository, cli: gh(join(dir, 'bin', 'gh-reader'), 'Agent-Bot', false) })
    // A user account must be reported able to push; only a GitHub App's installation token reports no permissions.
    await needs('github', 'repositoryReadOnly', { account: 'Agent-Bot', repository: 'acme/widgets' }, { repository, cli: gh(join(dir, 'bin', 'gh-unreported'), 'Agent-Bot', null) })
    // Signed in, but the account cannot read the repository, or the CLI names no account.
    const unreadable = program(join(dir, 'bin', 'gh-outsider'),
      `case "$*" in\n  "api user") echo '{"login":"Agent-Bot","id":7}' ;;\n  *) echo 'HTTP 404' >&2; exit 1 ;;\nesac`)
    const output = expect.stringContaining('HTTP 404') as unknown
    await needs('github', 'repositoryUnreadable', { account: 'Agent-Bot', repository: 'acme/widgets', output }, { repository, cli: unreadable })
    await needs('github', 'agentCliNoAccount', {}, { repository, cli: program(join(dir, 'bin', 'gh-anonymous'), `echo '{}'`) })
    expect(() => executable('nothing-here', join(dir, 'bin'))).toThrow('nothing-here is not an executable file on PATH')
  })
  it('takes a GitHub App\'s identity from the configuration, reads only the repository, and refuses only reported read-only access', async () => {
    const githubApp = { login: 'mumbo-bot[bot]', userId: 341797844 }
    // An installation token: `/user` answers 403, and the repository reports no `permissions` unless `push` is given.
    const appGh = (file: string, push: string): string => program(file, `case "$*" in\n  "api user") echo 'HTTP 403' >&2; exit 1 ;;\n  "api repos/acme/"*" --jq {name: .full_name, push: .permissions.push}") echo '{"name":"acme/widgets","push":${push}}' ;;\n  *) exit 1 ;;\nesac`)
    const calls: string[][] = []
    const recording: Probe = argv => { calls.push(argv); return probe(argv) }
    const resolve = (cli: string) => resolveDeployment(machine({ githubApp }), { repository: 'acme/widgets', cli }, recording, probe, path)
    const cli = appGh(join(dir, 'bin', 'gh-app'), 'null')
    const deployment = await resolve(cli)
    expect(deployment.github).toEqual({ cli, login: 'mumbo-bot[bot]', noreply: '341797844+mumbo-bot[bot]@users.noreply.github.com' })
    expect(deployment.githubApp).toEqual(githubApp)
    expect(calls.map(argv => argv.slice(1, 3).join(' '))).toEqual(['api repos/acme/widgets'])
    expect((await resolve(appGh(join(dir, 'bin', 'gh-app-push'), 'true'))).repository).toBe('acme/widgets')
    await expect(resolve(appGh(join(dir, 'bin', 'gh-app-reader'), 'false')))
      .rejects.toEqual(setupError('github', 'repositoryReadOnly', { account: 'mumbo-bot[bot]', repository: 'acme/widgets' }))
    // The edge serves only the project's repositories; another one answers 404.
    const outside = program(join(dir, 'bin', 'gh-app-outside'), `echo 'HTTP 404' >&2; exit 1`)
    await expect(resolve(outside)).rejects.toEqual(setupError('github', 'repositoryUnreadable',
      { account: 'mumbo-bot[bot]', repository: 'acme/widgets', output: expect.stringContaining('HTTP 404') }))
  })
  it('reads the Feishu bot from a bot-only lark-cli, or finds none when the Feishu Source names no CLI', async () => {
    expect(await resolveFeishuBot(machine(), {}, probe, path)).toBeUndefined()
    expect(await resolveFeishuBot(machine(), { cli: 'lark-cli' }, probe, path)).toEqual({ cli: join(dir, 'bin', 'lark-cli'), appId: 'cli_bot', brand: 'lark', botId: 'ou_bot', name: 'Widgets Bot' })
    const refuses = async (code: string, values: Record<string, unknown> = {}) => expect(resolveFeishuBot(machine(), { cli: 'lark-cli' }, probe, path)).rejects.toEqual(setupError('feishu', code, values))
    program(join(dir, 'bin', 'lark-cli'), lark({ identities: { bot: { status: 'ready' } } }))
    await refuses('feishuNoApp')
    program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', identities: { bot: { status: 'missing' } } }))
    await refuses('feishuBotNotReady', { app: 'cli_bot', status: 'missing' })
    program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', identities: { bot: { status: 'ready' } } }, 'off'))
    await refuses('feishuUserIdentity', { mode: 'off' })
    program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', identities: { bot: { status: 'ready' } } }, 'bot', { code: 0, data: {} }))
    await refuses('feishuNoBot')
    program(join(dir, 'bin', 'lark-cli'), 'echo "not configured" >&2; exit 1')
    await refuses('feishuCliFailed', { output: expect.stringContaining('not configured') })
  })
})
