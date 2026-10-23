/** Tool registration shared by every tool module: argument validation, result text, and coded errors. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { CallToolResult, McpServer, StandardSchemaWithJSON } from '@modelcontextprotocol/server'
import { z } from 'zod'
import type { PendingAsk } from './asks.ts'
import { ToolError } from './errors.ts'
import type { IdemRecord } from './store.ts'

/** What each tool module's `register` receives for one request's server. */
export interface ToolDeps {
  /** Plugin context. */
  readonly ctx: Context
  /** The authenticated handle the tools act for. */
  readonly principal: string
  /** Remembered results by request id. */
  readonly idem: KvTable<string, IdemRecord>
  /** Resolve, or create once, the assistant Session's live Agent. */
  readonly assistant: () => Promise<Agent>
  /** Open asks by `ask_id`, shared by every request. */
  readonly asks: ReadonlyMap<string, PendingAsk>
}

/**
 * List `schema` to the caller while letting every argument reach the handler,
 * whose own parse then answers a bad argument with code `invalid`.
 */
function listedOnly(schema: z.ZodObject): StandardSchemaWithJSON {
  const { vendor, jsonSchema } = schema['~standard']
  return { '~standard': { version: 1, vendor, jsonSchema, validate: value => ({ value }) } }
}

/** A result of one text block, flagged as a tool error when `isError`. */
function text(value: string, isError = false): CallToolResult {
  return { content: [{ type: 'text', text: value }], ...(isError ? { isError } : {}) }
}

/**
 * Register one tool whose result is JSON text.
 * @param server - the request's MCP server.
 * @param name - tool name.
 * @param description - what the tool does, for the caller's model.
 * @param schema - argument schema; a failing argument answers code `invalid`.
 * @param run - performs the call and returns its JSON text; a thrown {@link ToolError} answers an `isError`
 *   result whose text is `{code, message}`, and any other error reaches the SDK, which answers its message.
 */
export function defineTool<S extends z.ZodObject>(
  server: McpServer,
  name: string,
  description: string,
  schema: S,
  run: (args: z.output<S>, signal: AbortSignal) => string | Promise<string>,
): void {
  server.registerTool(name, { description, inputSchema: listedOnly(schema) }, async (raw, extra) => {
    try {
      const parsed = schema.safeParse(raw)
      if (!parsed.success) throw new ToolError('invalid', z.prettifyError(parsed.error))
      return text(await run(parsed.data, extra.mcpReq.signal))
    } catch (error: unknown) {
      if (!(error instanceof ToolError)) throw error
      return text(JSON.stringify({ code: error.code, message: error.message }), true)
    }
  })
}
