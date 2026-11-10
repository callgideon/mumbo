/** A stdio server whose config names a subprocess identity starts through the subprocess service as that identity. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { JSONRPCMessage } from '@modelcontextprotocol/client'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec, SubprocessTerminalEnvironment, SubprocessTerminalHandle } from '@deepseek-ai/dsh-subprocess'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as McpClient from '../src/index.ts'
import { publicToolName } from '../src/tools.ts'
import { createTransport } from '../src/transport.ts'

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

describe('a stdio server that names a subprocess identity', () => {
  it('fails at load when no subprocess service is mounted, before any tool registers', async () => {
    const ctx = await mountRegistry()
    await expect(ctx.plugin(McpClient, config())).rejects.toThrow('mcp-client(ident): identity "browsermcp" requires a subprocess service')
    expect(ctx.tools.schemas().filter(tool => tool.name.startsWith('mcp__ident__'))).toEqual([])
    expect(() => createTransport(config(), ctx)).toThrow('mcp-client(ident): identity "browsermcp" requires a subprocess service')
  })
})

linux('a stdio server started through the run-as provider', () => {
  it('runs as the named identity with only that identity\'s environment and the configured entries', async () => {
    // Run-as refuses a temporary directory other users can write.
    vi.stubEnv('TMPDIR', directory())
    vi.stubEnv('DEEPSEEK_API_KEY', 'box-token')
    vi.stubEnv('AMBIENT_ONLY', 'leak')
    const groups = readFileSync('/proc/self/status', 'utf8').split('\n').find(line => line.startsWith('Groups:'))!
      .slice('Groups:'.length).trim().split(/\s+/u).filter(id => id !== '').map(Number).sort((a, b) => a - b)
    const own = { uid: process.getuid!(), gid: process.getgid!(), groups }
    const ctx = await mountRegistry()
    await ctx.plugin(LocalSubprocessRuntime, {
      runAs: { ...own, inherit: [], set: { HOME: '/home/agent', USER: 'agent' }, secretNames: ['DEEPSEEK_API_KEY'] },
      identities: { browsermcp: { ...own, inherit: [], set: { HOME: '/home/browsermcp', USER: 'browsermcp' }, secretNames: ['DEEPSEEK_API_KEY'] } },
    })
    const spawn = vi.spyOn(ctx.subprocess, 'spawn')
    const cwd = directory()
    await ctx.plugin(McpClient, config({ env: { PLAYWRIGHT_MCP_EXTENSION: '' }, cwd }))
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ argv: [process.execPath, fixture], identity: 'browsermcp' }))
    const result = await executeToolFixture(ctx, {
      signal: new AbortController().signal, callId: ToolCallId('identity-1'), name: publicToolName('ident', 'environment'), arguments: {},
    })
    const block = result.content[0] as { type: 'text'; text: string }
    const report = JSON.parse(block.text) as { uid: number; cwd: string; env: Record<string, string> }
    expect(report).toEqual({
      uid: own.uid, cwd, env: { PLAYWRIGHT_MCP_EXTENSION: '', HOME: '/home/browsermcp', USER: 'browsermcp' },
    })
  }, 30_000)
})

/** A scripted process handle behind a subprocess service that only spawns. */
async function fakeService(options: { highWaterMark?: number } = {}) {
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
    override spawn(spec: SubprocessSpawnSpec): SubprocessHandle { specs.push(spec); return handle }
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
  it('starts the configured command once, in this process\'s directory when none is configured', async () => {
    const service = await fakeService()
    const transport = createTransport(config({ cwd: '', env: { A: 'b' } }), service.ctx)
    await transport.start()
    expect(service.specs).toEqual([{
      argv: [process.execPath, fixture], cwd: process.cwd(), env: { A: 'b' }, identity: 'browsermcp', graceMs: 2000,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' },
    }])
    expect(() => transport.start()).toThrow('MCP stdio transport already started')
    await transport.send({ jsonrpc: '2.0', method: 'ping' })
    expect(String(service.stdin.read())).toBe('{"jsonrpc":"2.0","method":"ping"}\n')
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
