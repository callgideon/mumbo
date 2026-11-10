/**
 * A stdio server whose config names a subprocess identity starts through the subprocess service as that identity, in
 * that identity's home, and one that names none does too, as the provider's server identity in that identity's home,
 * when the provider runs children as a run-as identity.
 */
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { JSONRPCMessage } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessChildIdentity, SubprocessHandle, SubprocessOutcome, SubprocessServerIdentity, SubprocessSpawnSpec,
  SubprocessTerminalEnvironment, SubprocessTerminalHandle,
} from '@deepseek-ai/dsh-subprocess'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as McpClient from '../src/index.ts'
import { publicToolName } from '../src/tools.ts'
import { createTransport } from '../src/transport.ts'
import { TestCredentials } from './credential-fixture.ts'

const linux = process.platform === 'linux' ? describe : describe.skip
const fixture = fileURLToPath(new URL('./fixtures/environment-server.mjs', import.meta.url))
const scratch: string[] = []

afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'dsh-mcp-identity-'))
  scratch.push(path)
  return path
}

async function mountRegistry(): Promise<Context> {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  return ctx
}

function config(overrides: Partial<McpClient.StdioConfig> = {}): McpClient.StdioConfig {
  return McpClient.Config({
    transport: 'stdio', serverName: 'ident', command: process.execPath, args: [fixture], env: {}, identity: 'browsermcp',
    failOnStartupError: true, startupTimeoutMs: 30_000, ...overrides,
  }) as McpClient.StdioConfig
}

/** The same server config naming no identity. */
function anonymous(overrides: Partial<McpClient.StdioConfig> = {}): McpClient.StdioConfig {
  const { identity: _named, ...rest } = config(overrides)
  return rest
}

describe('a stdio server that names a subprocess identity', () => {
  it('fails at load when no subprocess service is mounted, before any tool registers', async () => {
    const ctx = await mountRegistry()
    await expect(ctx.plugin(McpClient, config())).rejects.toThrow('mcp-client(ident): identity "browsermcp" requires a subprocess service')
    expect(ctx.tools.schemas().filter(tool => tool.name.startsWith('mcp__ident__'))).toEqual([])
    expect(() => createTransport(config(), ctx)).toThrow('mcp-client(ident): identity "browsermcp" requires a subprocess service')
  })
})

linux('a stdio server started through the run-as provider', () => {
  /** This process's own credentials, which the tests give every identity. */
  function own() {
    const groups = readFileSync('/proc/self/status', 'utf8').split('\n').find(line => line.startsWith('Groups:'))!
      .slice('Groups:'.length).trim().split(/\s+/u).filter(id => id !== '').map(Number).sort((a, b) => a - b)
    return { uid: process.getuid!(), gid: process.getgid!(), groups }
  }

  it('runs as the named identity in its home, with only that identity\'s environment and the configured entries', async () => {
    // Run-as refuses a temporary directory other users can write.
    vi.stubEnv('TMPDIR', directory())
    vi.stubEnv('DEEPSEEK_API_KEY', 'box-token')
    vi.stubEnv('AMBIENT_ONLY', 'leak')
    const home = realpathSync(directory())
    const ctx = await mountRegistry()
    await ctx.plugin(LocalSubprocessRuntime, {
      runAs: { ...own(), inherit: [], set: { HOME: '/home/agent', USER: 'agent' }, secretNames: ['DEEPSEEK_API_KEY'] },
      identities: { browsermcp: { ...own(), inherit: [], set: { HOME: home, USER: 'browsermcp', PATH: '/usr/bin:/bin' }, secretNames: ['DEEPSEEK_API_KEY'] } },
    })
    const spawn = vi.spyOn(ctx.subprocess, 'spawn')
    await ctx.plugin(McpClient, config({ env: { PLAYWRIGHT_MCP_EXTENSION: '' } }))
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ argv: [process.execPath, fixture], identity: 'browsermcp', cwd: home }))
    const result = await executeToolFixture(ctx, {
      signal: new AbortController().signal, callId: ToolCallId('identity-1'), name: publicToolName('ident', 'environment'), arguments: {},
    })
    const block = result.content[0] as { type: 'text'; text: string }
    const report = JSON.parse(block.text) as { uid: number; cwd: string; env: Record<string, string> }
    expect(report).toEqual({
      uid: own().uid, cwd: home, env: { PLAYWRIGHT_MCP_EXTENSION: '', HOME: home, USER: 'browsermcp', PATH: '/usr/bin:/bin' },
    })
  }, 30_000)

  it('fails at load, before anything starts, for a named identity whose home or PATH the provider refuses, or another cwd', async () => {
    vi.stubEnv('TMPDIR', directory())
    const home = realpathSync(directory())
    const planted = realpathSync(directory())
    const ctx = await mountRegistry()
    await ctx.plugin(LocalSubprocessRuntime, {
      runAs: { ...own(), inherit: [], set: { HOME: '/home/agent', USER: 'agent' }, secretNames: ['DEEPSEEK_API_KEY'] },
      identities: {
        browsermcp: { ...own(), inherit: [], set: { HOME: home, PATH: `${planted}:/usr/bin` }, secretNames: ['DEEPSEEK_API_KEY'] },
        homeless: { ...own(), inherit: [], set: { PATH: '/usr/bin' }, secretNames: ['DEEPSEEK_API_KEY'] },
        desktop: { ...own(), inherit: [], set: { HOME: home, PATH: '/usr/bin' }, secretNames: ['DEEPSEEK_API_KEY'] },
      },
    })
    const spawn = vi.spyOn(ctx.subprocess, 'spawn')
    await expect(ctx.plugin(McpClient, config())).rejects.toThrow(`mcp-client(ident): subprocess-local: identities.browsermcp PATH entry ${JSON.stringify(planted)} must be an absolute existing directory that only root can change`)
    await expect(ctx.plugin(McpClient, config({ identity: 'homeless' }))).rejects.toThrow('mcp-client(ident): subprocess-local: identities.homeless.set.HOME must name the server identity\'s home')
    // The Session working directory a browser provider would have passed is not the identity's home.
    await expect(ctx.plugin(McpClient, config({ identity: 'desktop', cwd: '/root/projects' }))).rejects.toMatchObject({
      cause: { message: `mcp-client(ident): cwd "/root/projects" is not allowed: a stdio server that names identity desktop runs in its home ${JSON.stringify(home)}; remove cwd` },
    })
    expect(spawn).not.toHaveBeenCalled()
  }, 30_000)

  it('runs a server that names no identity as the provider\'s server identity in its home, never as this process or the default', async () => {
    vi.stubEnv('TMPDIR', directory())
    vi.stubEnv('AMBIENT_ONLY', 'leak')
    vi.stubEnv('LANG', 'C.UTF-8')
    const groups = readFileSync('/proc/self/status', 'utf8').split('\n').find(line => line.startsWith('Groups:'))!
      .slice('Groups:'.length).trim().split(/\s+/u).filter(id => id !== '').map(Number).sort((a, b) => a - b)
    const own = { uid: process.getuid!(), gid: process.getgid!(), groups }
    const home = directory()
    const ctx = await mountRegistry()
    await ctx.plugin(LocalSubprocessRuntime, {
      runAs: { ...own, inherit: [], set: { HOME: '/home/agent', USER: 'agent' }, secretNames: ['DEEPSEEK_API_KEY'] },
      identities: { mcpserver: { ...own, inherit: ['LANG'], set: { HOME: home, USER: 'mcpserver', PATH: '/usr/bin:/bin' }, secretNames: ['DEEPSEEK_API_KEY'] } },
      serverIdentity: 'mcpserver',
    })
    const spawn = vi.spyOn(ctx.subprocess, 'spawn')
    await ctx.plugin(McpClient, anonymous({ env: { ENTRY: 'set' } }))
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ argv: [process.execPath, fixture], identity: 'mcpserver', cwd: home, env: { ENTRY: 'set' } }))
    const result = await executeToolFixture(ctx, {
      signal: new AbortController().signal, callId: ToolCallId('identity-2'), name: publicToolName('ident', 'environment'), arguments: {},
    })
    const report = JSON.parse((result.content[0] as { type: 'text'; text: string }).text) as { uid: number; cwd: string; env: Record<string, string> }
    expect(report).toEqual({ uid: own.uid, cwd: home, env: { ENTRY: 'set', HOME: home, USER: 'mcpserver', PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } })
  }, 30_000)

  it('refuses a credential in the command line, which the model\'s identity can read, before resolving it, and passes one in env', async () => {
    vi.stubEnv('TMPDIR', directory())
    const groups = readFileSync('/proc/self/status', 'utf8').split('\n').find(line => line.startsWith('Groups:'))!
      .slice('Groups:'.length).trim().split(/\s+/u).filter(id => id !== '').map(Number).sort((a, b) => a - b)
    const own = { uid: process.getuid!(), gid: process.getgid!(), groups }
    const home = directory()
    const ctx = await mountRegistry()
    await ctx.plugin(TestCredentials)
    const credentials = ctx.get('credentials') as TestCredentials
    credentials.values.set('MCP_TOKEN', 'person-token')
    const resolve = vi.spyOn(credentials, 'resolve')
    await ctx.plugin(LocalSubprocessRuntime, {
      runAs: { ...own, inherit: [], set: { HOME: '/home/agent', USER: 'agent' }, secretNames: ['DEEPSEEK_API_KEY'] },
      identities: { mcpserver: { ...own, inherit: [], set: { HOME: home, USER: 'mcpserver', PATH: '/usr/bin:/bin' }, secretNames: ['DEEPSEEK_API_KEY'] } },
      serverIdentity: 'mcpserver',
    })
    const spawn = vi.spyOn(ctx.subprocess, 'spawn')
    const refusal = 'command or args reference ${credential:MCP_TOKEN}, which would put the credential in the server\'s command line'
    for (const exposed of [{ args: [fixture, '--token=${credential:MCP_TOKEN}'] }, { command: '${credential:MCP_TOKEN}' }]) {
      const config = anonymous({ ...exposed, expandTemplates: true })
      expect(await McpClient.probeServer(ctx, config)).toMatchObject({ ok: false, message: expect.stringContaining(refusal) as string })
      await expect(ctx.plugin(McpClient, config)).rejects.toMatchObject({ cause: { message: expect.stringContaining(refusal) as string } })
    }
    expect(spawn).not.toHaveBeenCalled()
    expect(resolve).not.toHaveBeenCalled()
    await ctx.plugin(McpClient, anonymous({ env: { TOKEN: '${credential:MCP_TOKEN}' }, expandTemplates: true }))
    const result = await executeToolFixture(ctx, {
      signal: new AbortController().signal, callId: ToolCallId('identity-3'), name: publicToolName('ident', 'environment'), arguments: {},
    })
    const report = JSON.parse((result.content[0] as { type: 'text'; text: string }).text) as { env: Record<string, string> }
    expect(report.env.TOKEN).toBe('person-token')
  }, 30_000)
})

/** A scripted process handle behind a subprocess service that only spawns. */
async function fakeService(options: {
  highWaterMark?: number; childIdentity?: SubprocessChildIdentity; serverIdentity?: SubprocessServerIdentity; refuse?: Error
  homes?: Record<string, string>
} = {}) {
  const homes = options.homes ?? { browsermcp: '/home/browsermcp' }
  const stdin = new PassThrough({ highWaterMark: options.highWaterMark ?? 16 * 1024 })
  const stdout = new PassThrough()
  const done = Promise.withResolvers<SubprocessOutcome>()
  const terminate = vi.fn(() => { done.resolve({ exitCode: null, signal: 'SIGTERM' }) })
  const specs: SubprocessSpawnSpec[] = []
  const handle: SubprocessHandle = {
    stdin, stdout, stderr: undefined, control: undefined, collected: {}, done: done.promise, terminate,
    waitForExit: () => done.promise.then(() => true, () => true),
  }
  class SpawnOnly extends SubprocessRuntime {
    override get childIdentity(): SubprocessChildIdentity | undefined { return options.childIdentity }
    override get serverIdentity(): SubprocessServerIdentity | undefined { return options.serverIdentity }
    override serverHome(identity: string): string { return homes[identity] ?? super.serverHome(identity) }
    override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
      specs.push(spec)
      if (options.refuse !== undefined) throw options.refuse
      return handle
    }
    override resolveExecutable(): Promise<string> { throw new Error('unused') }
    override terminalEnvironment(): Promise<SubprocessTerminalEnvironment> { throw new Error('unused') }
    override spawnTerminal(): Promise<SubprocessTerminalHandle> { throw new Error('unused') }
  }
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SpawnOnly)
  return { ctx, stdin, stdout, done, terminate, specs }
}

function observe(transport: ReturnType<typeof createTransport>) {
  const messages: JSONRPCMessage[] = []
  const errors: string[] = []
  let closed = 0
  transport.onmessage = (message) => { messages.push(message) }
  transport.onerror = (error) => { errors.push(error.message) }
  transport.onclose = () => { closed++ }
  return { messages, errors, closed: () => closed }
}

describe('the subprocess stdio transport', () => {
  it('starts the configured command once, in the named identity\'s home', async () => {
    const service = await fakeService()
    const transport = createTransport(config({ cwd: '', env: { A: 'b' } }), service.ctx)
    await transport.start()
    expect(service.specs).toEqual([{
      argv: [process.execPath, fixture], cwd: '/home/browsermcp', env: { A: 'b' }, identity: 'browsermcp', graceMs: 2000,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 0 } },
    }])
    expect(() => transport.start()).toThrow('MCP stdio transport already started')
    await transport.send({ jsonrpc: '2.0', method: 'ping' })
    expect(String(service.stdin.read())).toBe('{"jsonrpc":"2.0","method":"ping"}\n')
  })

  it('starts a server that names no identity through the service only when the service runs children as a run-as identity', async () => {
    const server = { name: 'mcpserver', home: '/home/mcpserver' }
    const contained = await fakeService({ childIdentity: { uid: 1001, gid: 1001, groups: [] }, serverIdentity: server })
    await createTransport(anonymous({ env: { ENTRY: 'set' } }), contained.ctx).start()
    await createTransport(anonymous({ cwd: '/home/mcpserver' }), contained.ctx).start()
    expect(contained.specs).toEqual([
      expect.objectContaining({ argv: [process.execPath, fixture], cwd: '/home/mcpserver', env: { ENTRY: 'set' }, identity: 'mcpserver' }),
      expect.objectContaining({ cwd: '/home/mcpserver', identity: 'mcpserver' }),
    ])
    const plain = await fakeService()
    expect(createTransport(anonymous(), plain.ctx)).toBeInstanceOf(StdioClientTransport)
    expect(plain.specs).toEqual([])
  })

  it('refuses, under a run-as provider, a server that names no identity in another directory, or with no server identity to run as', async () => {
    const contained = await fakeService({ childIdentity: { uid: 1001, gid: 1001, groups: [] }, serverIdentity: { name: 'mcpserver', home: '/home/mcpserver' } })
    expect(() => createTransport(anonymous({ cwd: '/root/projects' }), contained.ctx))
      .toThrow('mcp-client(ident): cwd "/root/projects" is not allowed: a stdio server that names no identity runs as mcpserver in its home "/home/mcpserver"; remove cwd')
    const unnamed = await fakeService({ childIdentity: { uid: 1001, gid: 1001, groups: [] } })
    expect(() => createTransport(anonymous(), unnamed.ctx)).toThrow('names no serverIdentity')
    expect([...contained.specs, ...unnamed.specs]).toEqual([])
  })

  it('refuses a named identity\'s server in any directory but that identity\'s home, or as an identity the service has no home for', async () => {
    const service = await fakeService()
    expect(() => createTransport(config({ cwd: '/root/projects' }), service.ctx))
      .toThrow('mcp-client(ident): cwd "/root/projects" is not allowed: a stdio server that names identity browsermcp runs in its home "/home/browsermcp"; remove cwd')
    expect(() => createTransport(config({ identity: 'nobody' }), service.ctx))
      .toThrow('mcp-client(ident): subprocess: this provider configures no identity "nobody", so no server can start as it')
    await createTransport(config({ cwd: '/home/browsermcp' }), service.ctx).start()
    expect(service.specs).toEqual([expect.objectContaining({ cwd: '/home/browsermcp', identity: 'browsermcp' })])
  })

  it('fails a start the service refuses with its reason, and reports closure once so the connection can be retried', async () => {
    const service = await fakeService({ refuse: new Error('refusing to start a process whose environment contains GITHUB_TOKEN') })
    const transport = createTransport(config({ env: { GITHUB_TOKEN: 'person-token' } }), service.ctx)
    const seen = observe(transport)
    await expect(transport.start()).rejects.toThrow('environment contains GITHUB_TOKEN')
    await vi.waitFor(() => { expect(seen.closed()).toBe(1) })
    await transport.close()
    expect(seen.closed()).toBe(1)
    await expect(transport.send({ jsonrpc: '2.0', method: 'late' })).rejects.toThrow('Not connected')
  })

  it('delivers newline-delimited messages across chunks and reports a line that is not a message', async () => {
    const service = await fakeService()
    const transport = createTransport(config(), service.ctx)
    const seen = observe(transport)
    await transport.start()
    service.stdout.write('{"jsonrpc":"2.0","method":"a"}\n{"jsonrpc":"2.0",')
    service.stdout.write('"method":"b"}\nnot json\n{"jsonrpc":"1.0"}\n')
    await new Promise(resolve => setImmediate(resolve))
    expect(seen.messages).toEqual([{ jsonrpc: '2.0', method: 'a' }, { jsonrpc: '2.0', method: 'b' }])
    expect(seen.errors).toHaveLength(1)
  })

  it('reports output beyond the read buffer and closes', async () => {
    const service = await fakeService()
    const transport = createTransport(config(), service.ctx)
    const seen = observe(transport)
    await transport.start()
    service.stdout.write(Buffer.alloc(10 * 1024 * 1024 + 1, 0x20))
    service.stdin.on('finish', () => { service.done.resolve({ exitCode: 0, signal: null }) })
    await vi.waitFor(() => { expect(seen.closed()).toBe(1) })
    expect(seen.errors).toEqual(['ReadBuffer exceeded maximum size of 10485760 bytes'])
    expect(service.terminate).not.toHaveBeenCalled()
  })

  it('writes messages, waiting for a full pipe to drain, and refuses to send when not running', async () => {
    const service = await fakeService({ highWaterMark: 1 })
    const transport = createTransport(config(), service.ctx)
    await expect(transport.send({ jsonrpc: '2.0', method: 'early' })).rejects.toThrow('Not connected')
    await transport.start()
    let sent = false
    const sending = transport.send({ jsonrpc: '2.0', method: 'ping' }).then(() => { sent = true })
    await new Promise(resolve => setImmediate(resolve))
    expect(sent).toBe(false)
    expect(String(service.stdin.read())).toBe('{"jsonrpc":"2.0","method":"ping"}\n')
    await sending
  })

  it('reports stream errors and a failed start, then closure', async () => {
    const service = await fakeService()
    const transport = createTransport(config(), service.ctx)
    const seen = observe(transport)
    await transport.start()
    service.stdin.emit('error', new Error('stdin broke'))
    service.stdout.emit('error', new Error('stdout broke'))
    service.done.reject('spawn failed')
    await vi.waitFor(() => { expect(seen.closed()).toBe(1) })
    expect(seen.errors).toEqual(['stdin broke', 'stdout broke', 'spawn failed'])
    await expect(transport.send({ jsonrpc: '2.0', method: 'late' })).rejects.toThrow('Not connected')

    const failed = await fakeService()
    const other = createTransport(config(), failed.ctx)
    const otherSeen = observe(other)
    await other.start()
    failed.done.reject(new Error('ENOENT'))
    await vi.waitFor(() => { expect(otherSeen.errors).toEqual(['ENOENT']) })
  })

  it('ends stdin on close and terminates a server that does not exit within the grace period', async () => {
    const service = await fakeService()
    const transport = createTransport(config(), service.ctx)
    const ended = new Promise(resolve => service.stdin.on('finish', resolve))
    service.stdin.resume()
    await transport.close()
    await transport.start()
    const closing = transport.close()
    await ended
    await closing
    expect(service.terminate).toHaveBeenCalledTimes(1)

    const failing = await fakeService()
    const other = createTransport(config(), failing.ctx)
    await other.start()
    failing.stdin.on('finish', () => { failing.done.reject(new Error('gone')) })
    failing.stdin.resume()
    await other.close()
    expect(failing.terminate).not.toHaveBeenCalled()
  }, 10_000)
})
