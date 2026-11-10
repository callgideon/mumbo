/**
 * Servers the manager starts under a run-as subprocess provider: a stdio entry, which names no identity, runs as the
 * provider's default identity with that identity's environment. The test is not root, so the run-as identity is this
 * process's own and the environment tells the two paths apart.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import McpServerManager from '../src/index.ts'

const linux = process.platform === 'linux' ? describe : describe.skip
const fixture = fileURLToPath(new URL('../../mcp-client/tests/fixtures/environment-server.mjs', import.meta.url))
const scratch: string[] = []
const containing = (text: string): string => expect.stringContaining(text) as string

afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'dsh-mcp-manager-run-as-'))
  scratch.push(path)
  return path
}

/** A tool context and a run-as provider whose identity is this process's own; the provider's fiber is returned. */
async function contained() {
  // Run-as refuses a temporary directory other users can write.
  vi.stubEnv('TMPDIR', directory())
  vi.stubEnv('AMBIENT_ONLY', 'leak')
  const groups = readFileSync('/proc/self/status', 'utf8').split('\n').find(line => line.startsWith('Groups:'))!
    .slice('Groups:'.length).trim().split(/\s+/u).filter(id => id !== '').map(Number).sort((a, b) => a - b)
  const own = { uid: process.getuid!(), gid: process.getgid!(), groups }
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  const config = { runAs: { ...own, inherit: [], set: { HOME: '/home/agent', USER: 'agent' }, secretNames: ['DEEPSEEK_API_KEY', 'GITHUB_TOKEN'] } }
  const provider = ctx.plugin(LocalSubprocessRuntime, config)
  await provider
  return { ctx, own, provider, mount: () => ctx.plugin(LocalSubprocessRuntime, config) }
}

async function environment(ctx: Context, id: string) {
  const result = await executeToolFixture(ctx, { signal: new AbortController().signal, callId: ToolCallId(id), name: 'mcp__added__environment', arguments: {} })
  return JSON.parse((result.content[0] as { type: 'text'; text: string }).text) as { uid: number; cwd: string; env: Record<string, string> }
}

linux('a stdio server the manager starts under a run-as provider', () => {
  it('runs as the provider\'s default identity with only that identity\'s environment and the entry\'s', async () => {
    const { ctx, own } = await contained()
    const cwd = directory()
    await ctx.plugin(McpServerManager, { servers: { added: { transport: 'stdio', command: process.execPath, args: [fixture], env: { ENTRY: 'set' }, cwd } } })
    const manager = ctx.get('mcpManager')!
    await vi.waitFor(() => { expect(manager.list()[0]?.status.state).toBe('connected') }, { timeout: 30_000 })
    expect(await environment(ctx, 'manager-run-as-1')).toEqual({ uid: own.uid, cwd, env: { ENTRY: 'set', HOME: '/home/agent', USER: 'agent' } })
  }, 40_000)

  it('fails an entry whose environment names a secret with the refused name, and probes and restarts it again', async () => {
    const { ctx } = await contained()
    const entry = { transport: 'stdio' as const, command: process.execPath, args: [fixture], env: { GITHUB_TOKEN: 'person-token' }, cwd: directory(),
      reconnect: { maxAttempts: 1 } }
    await ctx.plugin(McpServerManager, { servers: { added: entry } })
    const manager = ctx.get('mcpManager')!
    await vi.waitFor(() => {
      expect(manager.list()[0]?.status).toMatchObject({ state: 'failed', reason: 'gave-up', lastError: containing('environment contains GITHUB_TOKEN') })
    }, { timeout: 30_000 })
    for (const attempt of [1, 2]) {
      const probe = await manager.probe('added')
      expect(probe, `probe ${attempt}`).toMatchObject({ ok: false, stage: 'connect', closeConfirmed: true, message: containing('GITHUB_TOKEN') })
      expect(probe.cleanupError).toBeUndefined()
    }
    await expect(manager.restart('added')).resolves.toBeUndefined()
  }, 40_000)

  it('mounted with a required subprocess service, starts no server as this process while the provider is gone, and as the run-as identity once it is back', async () => {
    const { ctx, own, provider, mount } = await contained()
    const sdk = vi.spyOn(StdioClientTransport.prototype, 'start')
    const cwd = directory()
    // As a contained box's manager row declares `inject: [credentials, subprocess]`.
    ctx.plugin({
      inject: ['subprocess'],
      apply: (scope: Context) => {
        scope.plugin(McpServerManager, { servers: { added: {
          transport: 'stdio', command: process.execPath, args: [fixture], env: { ENTRY: 'set' }, cwd, reconnect: { initialDelayMs: 1, maxDelayMs: 5, maxAttempts: 100 },
        } } })
      },
    })
    await vi.waitFor(() => { expect(ctx.get('mcpManager')?.list()[0]?.status.state).toBe('connected') }, { timeout: 30_000 })
    await provider.dispose()
    expect(ctx.get('mcpManager')).toBeUndefined()
    await new Promise(resolve => setTimeout(resolve, 500))
    expect(sdk).not.toHaveBeenCalled()
    await mount()
    await vi.waitFor(() => { expect(ctx.get('mcpManager')?.list()[0]?.status.state).toBe('connected') }, { timeout: 30_000 })
    expect(await environment(ctx, 'manager-run-as-3')).toEqual({ uid: own.uid, cwd, env: { ENTRY: 'set', HOME: '/home/agent', USER: 'agent' } })
    expect(sdk).not.toHaveBeenCalled()
  }, 60_000)
})
