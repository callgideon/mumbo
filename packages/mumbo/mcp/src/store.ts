/** Durable plugin state: results of retried tool calls by request id, the assistant Session, and the halt flag. */

import { createHash } from 'node:crypto'
import { defineDomain, domainTable, type KvTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { ToolError } from './errors.ts'

/** How long a request id stays bound to its first result. */
export const IDEMPOTENCY_WINDOW_MS = 86_400_000

const idemRecord = z.object({
  /** SHA-256 of the call's arguments as JSON with sorted object keys. */
  bodySha256: z.string(),
  /** The tool result returned for the first call. */
  result: z.string(),
  /** Epoch milliseconds when the result was stored. */
  at: z.number(),
}).strict()

const assistantRecord = z.object({
  /** The Session the tools talk to. */
  sessionId: z.string(),
}).strict()

const haltRecord = z.object({
  /** Whether runs are halted until a resume. */
  halted: z.boolean(),
}).strict()

/** One remembered tool result. */
export type IdemRecord = z.infer<typeof idemRecord>
/** The assistant Session, stored at key `main` once created. */
export type AssistantRecord = z.infer<typeof assistantRecord>
/** The halt flag, stored at key `main` once set. */
export type HaltRecord = z.infer<typeof haltRecord>

/**
 * Storage domain `mumbo_mcp`: table `idem` keyed by {@link idemKey}, tables `assistant` and `halt` keyed `main`.
 * The assistant Session and the halt flag are separate records, so their writers never overwrite each other.
 */
export const mcpDomain = defineDomain({
  name: 'mumbo_mcp',
  version: 1,
  layout: 'per-record',
  invalidRecords: 'backup-and-skip',
  tables: {
    idem: domainTable<string, IdemRecord>(idemRecord),
    assistant: domainTable<'main', AssistantRecord>(assistantRecord),
    halt: domainTable<'main', HaltRecord>(haltRecord),
  },
})

/** Hex SHA-256 of a string. */
function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** JSON with every object's keys sorted, so equal arguments hash equally whatever their key order. */
function sortedJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return item
    const entries = new Map(Object.entries(item))
    return Object.fromEntries([...entries.keys()].sort().map(key => [key, entries.get(key)]))
  })
}

/**
 * Key of one tool call in the `idem` table.
 * @param tool - the tool name.
 * @param requestId - the caller's request id.
 * @returns hex SHA-256 of `tool`, a newline, and `requestId`.
 */
export function idemKey(tool: string, requestId: string): string {
  return sha256(`${tool}\n${requestId}`)
}

/**
 * Run a tool call at most once per request id within {@link IDEMPOTENCY_WINDOW_MS}.
 * A repeat with equal arguments returns the stored result without running; a failed run stores nothing.
 * Two concurrent calls with one request id both run, and a crash after `run` succeeds
 * but before the result is stored lets a retry run again.
 * @param table - the `idem` table.
 * @param tool - the tool name.
 * @param requestId - the caller's request id.
 * @param args - the call's JSON arguments.
 * @param run - performs the call and returns its result.
 * @param now - clock in epoch milliseconds.
 * @returns the first result for this tool and request id.
 * @throws {ToolError} `request_id_reused` when the id was used with other arguments inside the window.
 */
export async function once(
  table: KvTable<string, IdemRecord>,
  tool: string,
  requestId: string,
  args: unknown,
  run: () => Promise<string>,
  now: () => number = Date.now,
): Promise<string> {
  const key = idemKey(tool, requestId)
  const bodySha256 = sha256(sortedJson(args))
  const stored = table.get(key)
  if (stored !== undefined && now() - stored.at < IDEMPOTENCY_WINDOW_MS) {
    if (stored.bodySha256 !== bodySha256) {
      throw new ToolError('request_id_reused', `request_id ${requestId} was already used with other arguments; send a new request_id`)
    }
    return stored.result
  }
  const result = await run()
  await table.put(key, { bodySha256, result, at: now() })
  return result
}

/**
 * Delete `idem` rows at least {@link IDEMPOTENCY_WINDOW_MS} old.
 * @param table - the `idem` table.
 * @param now - clock in epoch milliseconds.
 */
export async function prune(table: KvTable<string, IdemRecord>, now: () => number = Date.now): Promise<void> {
  const cutoff = now() - IDEMPOTENCY_WINDOW_MS
  for (const [key, record] of table.entries()) {
    if (record.at <= cutoff) await table.delete(key)
  }
}
