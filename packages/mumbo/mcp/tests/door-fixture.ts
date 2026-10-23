/** Test host for the MCP door: a real WebServer and JSON storage under a temp root, with fake Session services. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { type Mock, vi } from 'vitest'
import type * as McpDoor from '../src/index.ts'

/** Bearer key every fixture host accepts. */
export const KEY = 'fixture-key-0123456789'

/** One logged event as the fake history page returns it. */
export interface FakeEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: object
  readonly surfaceOp: 'append' | { readonly op: 'replace'; readonly startSeq: number; readonly endSeq: number }
}

/** A live fake Agent: its Session log and the messages sent to it. */
export interface FakeAgent {
  readonly id: string
  readonly session: { readonly id: string; readonly seq: number }
  readonly log: FakeEvent[]
  readonly followup: Mock<(message: object) => void>
}

/** A started fixture host; the plugin is not loaded. */
export interface Host {
  readonly ctx: Context
  readonly root: string
  readonly config: McpDoor.Config
  /** URL of `/mcp` on the fixture WebServer. */
  readonly url: string
  /** Fake service calls in order, such as `create:w1`. */
  readonly calls: string[]
  /** Live fake Agents by Session id. */
  readonly agents: Map<string, FakeAgent>
  /** Session ids whose resolve fails with `session/writer-held`. */
  readonly held: Set<string>
  /** Add a live fake Agent. */
  addAgent(id: string): FakeAgent
}

const contexts: Context[] = []
const roots: string[] = []

/** Dispose every fixture host and remove its temp root. */
export async function stopHosts(): Promise<void> {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
}

/**
 * Start a WebServer on an OS port, JSON storage, and fake `sessionController` and `workspaceRegistry` services.
 * @param options - key file text and allowlist.
 * @returns the host; load the plugin with `host.ctx.plugin(McpDoor, host.config)`.
 */
export async function startHost(options: { keyText?: string; allowlist?: string[] } = {}): Promise<Host> {
  const root = await mkdtemp(join(tmpdir(), 'mumbo-mcp-'))
  roots.push(root)
  const keyFile = join(root, 'key')
  await writeFile(keyFile, options.keyText ?? `${KEY}\n`)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(root, 'storage') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })

  const calls: string[] = []
  const agents = new Map<string, FakeAgent>()
  const held = new Set<string>()
  const addAgent = (id: string): FakeAgent => {
    const log: FakeEvent[] = []
    const agent = { id, session: { id, get seq() { return log.length } }, log, followup: vi.fn() }
    agents.set(id, agent)
    return agent
  }
  ctx.provide('workspaceRegistry', {
    create: async (path: string) => {
      calls.push(`workspace:${path}`)
      return { id: 'w1', path }
    },
  } as never)
  ctx.provide('sessionController', {
    resolveAgent: async (sessionId: string) => {
      calls.push(`resolve:${sessionId}`)
      if (held.has(sessionId)) return { error: Object.assign(new Error('writer held'), { code: 'session/writer-held' }) }
      const agent = agents.get(sessionId)
      return agent === undefined
        ? { error: Object.assign(new Error('not found'), { code: 'session/not-found' }) }
        : { agent }
    },
    create: async (request: { workspaceId: string }) => {
      calls.push(`create:${request.workspaceId}`)
      const agent = addAgent(`s${String(agents.size + 1)}`)
      agent.log.push(event(agent, 'session/title', {}))
      return { sessionId: agent.id }
    },
    rename: async (request: { sessionId: string; title: string }) => {
      calls.push(`rename:${request.sessionId}:${request.title}`)
      return { title: request.title, seq: 0 }
    },
    page: async (request: { address: { sessionId: string }; throughSeq: number }) => {
      calls.push(`page:${request.address.sessionId}:${String(request.throughSeq)}`)
      const log = agents.get(request.address.sessionId)?.log ?? []
      return { records: log.filter(entry => entry.seq <= request.throughSeq).map(entry => ({ type: 'event', event: entry })), hasMore: false }
    },
  } as never)

  const config = {
    keyFile,
    allowlist: options.allowlist ?? ['ann'],
    assistantTitle: 'assistant',
    assistantCwd: root,
    irreversibleTools: ['deploy'],
  } satisfies McpDoor.Config
  return { ctx, root, config, url: `${ctx.webServer.getOrigin()}/mcp`, calls, agents, held, addAgent }
}

/**
 * Build the next event of an Agent's log without appending it.
 * @param agent - the Agent whose log decides the sequence number.
 * @param type - event type.
 * @param data - event payload.
 * @param surfaceOp - surface operation; `append` by default.
 * @returns the event.
 */
export function event(agent: FakeAgent, type: string, data: object, surfaceOp: FakeEvent['surfaceOp'] = 'append'): FakeEvent {
  return { type, seq: agent.log.length, time: 0, data, surfaceOp }
}

/**
 * Append one message event to an Agent's log.
 * @param agent - the Agent.
 * @param role - `user` or `assistant`.
 * @param source - the logged message source.
 * @param content - the logged content blocks.
 * @returns the appended event.
 */
export function message(agent: FakeAgent, role: 'user' | 'assistant', source: object, content: object[]): FakeEvent {
  const entry = event(agent, `${role}/message`, { id: `m${String(agent.log.length)}`, role, content, source })
  agent.log.push(entry)
  return entry
}

/** One tool result: its error flag, and its JSON text parsed, or the plain text of an SDK-reported failure. */
export interface ToolReply {
  readonly isError: boolean
  readonly value: unknown
}

/**
 * Call one tool through the SDK client over HTTP.
 * @param url - the `/mcp` URL.
 * @param name - tool name.
 * @param args - tool arguments.
 * @param principal - the calling handle.
 * @returns the error flag and the first content block's text, parsed when it is a JSON object.
 */
export async function call(url: string, name: string, args: Record<string, unknown>, principal = 'ann'): Promise<ToolReply> {
  const client = new Client({ name: 'fixture', version: '0.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { authorization: `Bearer ${KEY}`, 'x-mcp-principal': principal } },
  }))
  try {
    const result = await client.callTool({ name, arguments: args })
    const [block] = result.content
    if (block?.type !== 'text') throw new Error(`tool ${name} returned no text block`)
    return { isError: result.isError === true, value: block.text.startsWith('{') ? JSON.parse(block.text) : block.text }
  } finally {
    await client.close()
  }
}
