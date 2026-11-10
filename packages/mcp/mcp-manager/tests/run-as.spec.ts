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
import McpServerManager from '../src/index.ts'

const linux = process.platform === 'linux' ? describe : describe.skip
const fixture = fileURLToPath(new URL('../../mcp-client/tests/fixtures/environment-server.mjs', import.meta.url))
const scratch: string[] = []

afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'dsh-mcp-manager-run-as-'))
  scratch.push(path)
  return path
}

linux('a stdio server the manager starts under a run-as provider', () => {
  it('runs as the provider\'s default identity with only that identity\'s environment and the entry\'s', async () => {
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
    await ctx.plugin(LocalSubprocessRuntime, {
      runAs: { ...own, inherit: [], set: { HOME: '/home/agent', USER: 'agent' }, secretNames: ['DEEPSEEK_API_KEY'] },
    })
    const cwd = directory()
    await ctx.plugin(McpServerManager, { servers: { added: { transport: 'stdio', command: process.execPath, args: [fixture], env: { ENTRY: 'set' }, cwd } } })
    const manager = ctx.get('mcpManager')!
    await vi.waitFor(() => { expect(manager.list()[0]?.status.state).toBe('connected') }, { timeout: 30_000 })
    const result = await executeToolFixture(ctx, {
      signal: new AbortController().signal, callId: ToolCallId('manager-run-as-1'), name: 'mcp__added__environment', arguments: {},
    })
    const report = JSON.parse((result.content[0] as { type: 'text'; text: string }).text) as { uid: number; cwd: string; env: Record<string, string> }
    expect(report).toEqual({ uid: own.uid, cwd, env: { ENTRY: 'set', HOME: '/home/agent', USER: 'agent' } })
  }, 40_000)
})
