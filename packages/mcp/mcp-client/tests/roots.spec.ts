/** A stdio server's MCP roots: the client offers the configured directories, and declares no `roots` capability without them. */
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as McpClient from '../src/index.ts'
import { publicToolName } from '../src/tools.ts'

const fixture = fileURLToPath(new URL('./fixtures/roots-server.mjs', import.meta.url))

async function mountRegistry(): Promise<Context> {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  return ctx
}

/** Connect the fixture with `roots` and return what its tool reports. */
async function report(roots?: string[]): Promise<{ capabilities: Record<string, unknown>; answer: unknown }> {
  const ctx = await mountRegistry()
  await ctx.plugin(McpClient, McpClient.Config({
    transport: 'stdio', serverName: 'roots', command: process.execPath, args: [fixture], failOnStartupError: true, startupTimeoutMs: 30_000,
    ...roots === undefined ? {} : { roots },
  }))
  const result = await executeToolFixture(ctx, {
    signal: new AbortController().signal, callId: ToolCallId('roots-1'), name: publicToolName('roots', 'roots'), arguments: {},
  })
  return JSON.parse((result.content[0] as { type: 'text'; text: string }).text) as { capabilities: Record<string, unknown>; answer: unknown }
}

describe('a stdio server\'s MCP roots', () => {
  it('answers roots/list with the configured directories as file URIs, in order', async () => {
    const { capabilities, answer } = await report(['/var/lib/mumbo/uploads', '/srv/two words'])
    expect(capabilities).toHaveProperty('roots')
    expect(answer).toMatchObject({ result: { roots: [{ uri: 'file:///var/lib/mumbo/uploads' }, { uri: pathToFileURL('/srv/two words').href }] } })
  }, 30_000)

  it('declares no roots capability when none are configured', async () => {
    const { capabilities, answer } = await report()
    expect(capabilities).not.toHaveProperty('roots')
    expect(answer).toBeNull()
  }, 30_000)

  it('fails at load for a relative root, before the server starts', async () => {
    const ctx = await mountRegistry()
    await expect(ctx.plugin(McpClient, McpClient.Config({ transport: 'stdio', serverName: 'roots', command: process.execPath, args: [fixture], roots: ['uploads'] })))
      .rejects.toThrow('mcp-client(roots): roots entry "uploads" must be an absolute directory')
  })
})
