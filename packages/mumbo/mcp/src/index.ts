/** Loopback MCP door: named, allowlisted people drive the host's assistant through one authenticated `/mcp` route. */

import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'
import { McpServer } from '@modelcontextprotocol/server'
import { HANDLE_PATTERN } from './auth.ts'
import { createRouteHandler } from './http.ts'

/** Cordis function-plugin name. */
export const name = 'mumbo-mcp'
/** Host services required before the route registers. */
export const inject = ['webServer']

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
 * Read the key, then register `/mcp` for the plugin's lifetime.
 * @param ctx - plugin context carrying the injected WebServer.
 * @param config - validated configuration.
 * @throws when the key file is unreadable or holds only whitespace; no route registers then.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const key = (await readFile(config.keyFile, 'utf8')).trim()
  if (key === '') throw new Error(`mumbo-mcp: keyFile ${config.keyFile} is empty`)
  /** One server per request, its tools bound to the authenticated principal; each tool module registers here. */
  const buildServer = (_principal: string): McpServer =>
    new McpServer({ name, version: '0.0.1' }, { capabilities: { tools: {} } })
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_PATH,
    handler: createRouteHandler({ key, allowlist: config.allowlist, buildServer }),
  }), `mumbo-mcp: ${ROUTE_PATH}`)
}
