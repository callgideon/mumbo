/** Real Loader and AgentLoop composition shared by the composition spec and the Xvfb end-to-end test. */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { deflateSync, crc32 } from 'node:zlib'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import ComputerUseRegistry from '@deepseek-ai/dsh-computer-use'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import type { LlmAdapter } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as X11Provider from '../src/index.ts'

/**
 * Boot the provider from a test-only cordis.yml through the Loader and create one Agent.
 * @param root - temporary directory holding cordis.yml and attachment storage.
 * @param config - provider configuration row.
 * @param model - model adapter registered for provider `x11-fixture`.
 * @returns the root context and an Agent bound to model `vision`.
 */
export async function bootComposition(
  root: string, config: Record<string, unknown>, model: LlmAdapter,
): Promise<{ context: Context; agent: Agent }> {
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-tool-executor-native', NativeToolExecutor],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
    ['@deepseek-ai/dsh-attachment-local', LocalAttachmentStore],
    ['@deepseek-ai/dsh-subprocess-local', LocalSubprocessRuntime],
    ['@deepseek-ai/dsh-computer-use', ComputerUseRegistry],
    ['@deepseek-ai/dsh-computer-use-x11', X11Provider],
  ])
  const configs: Record<string, unknown> = {
    '@deepseek-ai/dsh-attachment-local': { dshHome: root },
    '@deepseek-ai/dsh-computer-use-x11': config,
  }
  const configPath = join(root, 'cordis.yml')
  // JSON is YAML flow syntax, so each row's config is written verbatim.
  await writeFile(configPath, [...modules.keys()].map(name => configs[name] === undefined
    ? `- name: '${name}'`
    : `- name: '${name}'\n  config: ${JSON.stringify(configs[name])}`).join('\n') + '\n')
  const context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`Unexpected fixture module: ${specifier}`)
      return modules.get(specifier)
    },
  } as never
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await context.loader.await()
  for (const entry of context.loader.entries()) await entry.fiber?.await()
  context.llm.registerAdapter(['x11-fixture'], model)
  const agent = await context.agentLoop.create(SessionId('x11-composition'), { provider: 'x11-fixture', model: 'vision' })
  return { context, agent }
}

/**
 * Encode an opaque white RGB PNG.
 * @param width - image width in pixels.
 * @param height - image height in pixels.
 * @returns the PNG bytes.
 */
export function whitePng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const checksum = Buffer.alloc(4)
    checksum.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, checksum])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 2, 0, 0, 0], 8)
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0xff)])
  const pixels = Buffer.concat(Array.from({ length: height }, () => row))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0)),
  ])
}
