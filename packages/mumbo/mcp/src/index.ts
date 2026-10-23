/** Loopback MCP door: named, allowlisted people drive the host's assistant through one authenticated `/mcp` route. */

import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'
import { McpServer } from '@modelcontextprotocol/server'
import { listenForAsks, register as registerAsks } from './asks.ts'
import { ensureAssistant } from './assistant.ts'
import { HANDLE_PATTERN } from './auth.ts'
import { register as registerConversation } from './conversation.ts'
import { gateWhileHalted, register as registerHalt } from './halt.ts'
import { createRouteHandler } from './http.ts'
import { register as registerStatus } from './status.ts'
import { mcpDomain, prune } from './store.ts'
import type { ToolDeps } from './tool.ts'

/** Cordis function-plugin name. */
export const name = 'mumbo-mcp'
/** Host services required before the route registers; `sessionController` keeps the plugin to Web profiles. */
export const inject = [
  'webServer',
  'storageDomain',
  'sessionController',
  'workspaceRegistry',
  'agents',
  'subagents',
  'jobs',
  'sessionProjections',
  'subprocess',
]

/** Route path on the injected WebServer; the listener, not the path, varies per deployment. */
const ROUTE_PATH = '/mcp'

/** MCP door configuration. */
export interface Config {
  /** File holding the bearer key; surrounding whitespace is ignored and an empty key fails load. */
  readonly keyFile: string
  /** Principal handles allowed to call, each matching `^[a-z][a-z0-9-]{0,31}$`. */
  readonly allowlist: string[]
  /** Title of the assistant Session the tools talk to. */
  readonly assistantTitle: string
  /** Workspace directory of the assistant Session. */
  readonly assistantCwd: string
  /** Tool names whose approval only a person in the browser may give. */
  readonly irreversibleTools: string[]
}

export const Config: z<Config> = z.object({
  keyFile: z.string().required(),
  allowlist: z.array(z.string().pattern(HANDLE_PATTERN)).required(),
  assistantTitle: z.string().default('assistant'),
  assistantCwd: z.string().required(),
  irreversibleTools: z.array(z.string()).default([]),
})

/**
 * Read the key, open the `mumbo_mcp` storage domain and prune expired request ids, gate model steps on the
 * stored halt flag, and answer asks, then register `/mcp`; all for the plugin's lifetime.
 * @param ctx - plugin context carrying the injected services.
 * @param config - validated configuration.
 * @throws when the key file is unreadable or holds only whitespace, or the domain does not open; no route registers then.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const key = (await readFile(config.keyFile, 'utf8')).trim()
  if (key === '') throw new Error(`mumbo-mcp: keyFile ${config.keyFile} is empty`)
  const domain = await ctx.storageDomain.open(mcpDomain)
  ctx.effect(() => () => domain.close(), 'mumbo-mcp: storage')
  const idem = domain.table('idem')
  await prune(idem)
  const halt = domain.table('halt')
  gateWhileHalted(ctx, halt)
  // Concurrent first calls share one creation, so they find one assistant Session.
  let ensuring: Promise<Agent> | undefined
  const assistant = (): Promise<Agent> => ensuring ??= ensureAssistant(ctx, config, domain.table('assistant')).finally(() => { ensuring = undefined })
  const asks = listenForAsks(ctx, config.irreversibleTools)
  /** One server per request, its tools bound to the authenticated principal; each tool module registers here. */
  const buildServer = (principal: string): McpServer => {
    const server = new McpServer({ name, version: '0.0.1' }, { capabilities: { tools: {} } })
    const deps: ToolDeps = { ctx, principal, idem, halt, assistantCwd: config.assistantCwd, assistant, asks }
    registerConversation(server, deps)
    registerAsks(server, deps)
    registerStatus(server, deps)
    registerHalt(server, deps)
    return server
  }
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_PATH,
    handler: createRouteHandler({ key, allowlist: config.allowlist, buildServer }),
  }), `mumbo-mcp: ${ROUTE_PATH}`)
}
