/**
 * The box-wide Run Wild record: every committed `runwild/decision` copied into one append-only JSONL file per UTC day
 * under the configured root, the `mumbo-run-wild-record` service that reads it, and the owner-only routes the view
 * calls. The Host writes it in its own process; no tool, command or route writes it.
 */
import { join } from 'node:path'
import { chmod, mkdir, open, readdir, readFile, rm } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subagent'
import z from '@deepseek-ai/schemastery'
import {
  LIST_LIMIT, RECORD_COUNTS_PATH, RECORD_GLOBAL, RECORD_PATH, SUMMARY_LIMIT,
  type RecordCounts, type RecordCursor, type RecordEntry, type RecordFlag, type RecordPage, type RecordQuery, type RunWildRecord,
} from './record-types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The box-wide Run Wild record; `@mumbo/run-wild` provides it while loaded. */
    'mumbo-run-wild-record': RunWildRecord
  }
}

/** Where the record lives and how long it keeps entries. */
export interface Config {
  /** Absolute directory of the day files; created `0700` at the first write. */
  root: string
  /** Days the record keeps; older day files are deleted. */
  retentionDays: number
}

/** Validate the record's directory and retention. */
export const Config: z<Config> = z.object({
  root: z.string().pattern(/^\//).required().description('Absolute directory of the record\'s day files, such as /root/.dsh/storages/runwild.'),
  retentionDays: z.number().step(1).min(1).default(90).description('Days the record keeps.'),
})

const DAY_MS = 86_400_000
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/
const CURSOR = /^(\d{4}-\d{2}-\d{2}):(\d+)$/

/**
 * Clip a decision's summary to the record's {@link SUMMARY_LIMIT}.
 * @param summary - the summary as logged.
 * @returns the summary, or its first characters followed by `…`.
 */
export function clipSummary(summary: string): string {
  return summary.length <= SUMMARY_LIMIT ? summary : `${summary.slice(0, SUMMARY_LIMIT - 1)}…`
}

/**
 * Whether `subagents.rootOf` failed because the caller is a delegated child whose root is no longer live.
 * @param error - what `rootOf` threw.
 * @returns whether it is that `SubagentError`.
 */
export function rootUnavailable(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && 'name' in error && error.name === 'SubagentError'
    && 'code' in error && error.code === 'UNAUTHORIZED'
}

/** The UTC day of a time, `YYYY-MM-DD`. */
function dayOf(time: number): string {
  return new Date(time).toISOString().slice(0, 10)
}

/** Whether a parsed line is an entry of format v1; other fields pass through. */
function isEntry(value: unknown): value is RecordEntry {
  if (typeof value !== 'object' || value === null) return false
  const line = value as Record<string, unknown>
  return line.v === 1 && typeof line.time === 'number' && typeof line.seq === 'number'
    && ['session', 'root', 'kind', 'target', 'summary', 'reason'].every(key => typeof line[key] === 'string')
}

/** One day file read: its entries with their line index, and how many lines were not entries. */
interface Day {
  entries: { entry: RecordEntry; line: number }[]
  skipped: number
}

/**
 * Write the record from `session/event`, delete day files past retention, and provide the reader and its routes.
 * @param ctx - plugin context; the listener, the service, the routes and pending writes end with it.
 * @param config - the record's directory and retention.
 */
export function record(ctx: Context, config: Config): void {
  const { root, retentionDays } = config
  let queue = Promise.resolve()
  let failures = 0
  let ready = false
  let prunedDay: string | undefined
  // Day files this process has appended to: their trailing partial line, if any, is closed once.
  const opened = new Set<string>()

  /** Delete day files dated before today minus the retention, so 90 to 91 days stay. */
  const prune = async (): Promise<void> => {
    const today = dayOf(Date.now())
    prunedDay = today
    const cutoff = dayOf(Date.now() - retentionDays * DAY_MS)
    let names: string[]
    try {
      names = await readdir(root)
    } catch (error: unknown) {
      // No directory yet: nothing was recorded, so nothing is due.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const name of names) {
      const day = DAY_FILE.exec(name)?.[1]
      if (day === undefined || day >= cutoff) continue
      await rm(join(root, name)).catch((error: unknown) => { ctx.logger.warn('mumbo-run-wild: could not delete an expired record file', name, error) })
    }
  }

  /** Append one line to its day file, creating the directory and the file with owner-only modes. */
  const append = async (day: string, text: string): Promise<void> => {
    if (!ready) {
      await mkdir(root, { recursive: true, mode: 0o700 })
      await chmod(root, 0o700)
      ready = true
    }
    if (prunedDay !== dayOf(Date.now())) await prune()
    const handle = await open(join(root, `${day}.jsonl`), 'a+', 0o600)
    try {
      let line = text
      if (!opened.has(day)) {
        await handle.chmod(0o600)
        const { size } = await handle.stat()
        const last = Buffer.alloc(1)
        if (size > 0) await handle.read(last, 0, 1, size - 1)
        // A crash can leave a partial line; the next line starts on its own.
        if (size > 0 && last[0] !== 0x0a) line = `\n${line}`
        opened.add(day)
      }
      await handle.appendFile(line)
    } finally {
      await handle.close()
    }
  }

  /** The root Session of a Session's Agent; its own id when it is a root or its root is no longer live. */
  const rootOf = (session: Session): Session['id'] => {
    const agent = ctx.get('agents')?.get(session.id)
    if (agent === undefined) return session.id
    try {
      return (ctx.get('subagents')?.rootOf(agent) ?? agent).session.id
    } catch (error: unknown) {
      // A child whose root is no longer live links to itself; the decision is still recorded.
      if (!rootUnavailable(error)) throw error
      return session.id
    }
  }

  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (event.type !== 'runwild/decision') return
    const lost = (error: unknown): void => {
      failures += 1
      // The summary may hold a refused call's arguments: the line names only where the decision is logged.
      ctx.logger.error('mumbo-run-wild: the record lost a decision', session.id, event.seq, error)
    }
    let root: Session['id']
    try {
      root = rootOf(session)
    } catch (error: unknown) {
      lost(error)
      return
    }
    const line = {
      ...event.data, summary: clipSummary(event.data.summary),
      v: 1, time: event.time, session: session.id, root, seq: event.seq,
    }
    const text = `${JSON.stringify(line)}\n`
    queue = queue.then(() => append(dayOf(event.time), text)).catch(lost)
  })
  queue = queue.then(prune).catch((error: unknown) => { ctx.logger.warn('mumbo-run-wild: could not read the record directory for retention', error) })
  ctx.effect(() => async () => { await queue }, 'mumbo-run-wild: record writes')

  /** Read one day file; undefined when it does not exist. */
  const readDay = async (day: string): Promise<Day | undefined> => {
    let text: string
    try {
      text = await readFile(join(root, `${day}.jsonl`), 'utf8')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    const result: Day = { entries: [], skipped: 0 }
    text.split('\n').forEach((raw, line) => {
      if (raw === '') return
      let value: unknown
      try {
        value = JSON.parse(raw)
      } catch {
        // A partial or damaged line is not an entry.
        result.skipped += 1
        return
      }
      if (isEntry(value)) result.entries.push({ entry: value, line }); else result.skipped += 1
    })
    // Newest first: by time, then by line order.
    result.entries.sort((a, b) => b.entry.time - a.entry.time || b.line - a.line)
    return result
  }

  /** The record's day names, newest first. */
  const days = async (): Promise<string[]> => {
    let names: string[]
    try {
      names = await readdir(root)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    return names.flatMap(name => DAY_FILE.exec(name)?.[1] ?? []).sort().reverse()
  }

  const service: RunWildRecord = {
    async list({ kinds, cursor, since, limit }: RecordQuery): Promise<RecordPage> {
      const page = { entries: [] as RecordEntry[], skipped: 0, incomplete: failures > 0, retentionDays }
      const [, afterDay, afterLine] = cursor === undefined ? [] : CURSOR.exec(cursor) ?? []
      let last = ''
      for (const day of await days()) {
        if (afterDay !== undefined && day > afterDay) continue
        if (since !== undefined && day < dayOf(since)) break
        const read = await readDay(day)
        if (read === undefined) continue
        page.skipped += read.skipped
        const from = afterDay === day ? read.entries.findIndex(item => item.line === Number(afterLine)) + 1 : 0
        for (const { entry, line } of read.entries.slice(from)) {
          if (since !== undefined && entry.time < since) break
          if (kinds !== undefined && !kinds.includes(entry.kind)) continue
          // One more entry than the page holds: the page ends at the last one it took.
          if (page.entries.length === limit) return { ...page, next: brandString<RecordCursor>(last) }
          page.entries.push(entry)
          last = `${day}:${String(line)}`
        }
      }
      return page
    },
    async count(since: number, until: number): Promise<RecordCounts> {
      const counts: Record<string, number> = {}
      let skipped = 0
      for (const day of await days()) {
        if (day < dayOf(since) || day > dayOf(until)) continue
        const read = await readDay(day)
        if (read === undefined) continue
        skipped += read.skipped
        for (const { entry } of read.entries) {
          if (entry.time >= since && entry.time < until) counts[entry.kind] = (counts[entry.kind] ?? 0) + 1
        }
      }
      return { counts, skipped, incomplete: failures > 0 }
    },
  }
  ctx.provide('mumbo-run-wild-record', service)

  ctx.on('webserver/index-inject', (table, peer) => {
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- other packages merge non-owner kinds into PrincipalMap.
    if (peer.principal.kind !== 'owner') return
    const value: RecordFlag = { record: true }
    table.push({ kind: 'global', name: RECORD_GLOBAL, value })
  })
  ctx.inject(['connection'], (ctx) => { serveRecord(ctx, service) })
}

/** A route answer with a plain-text message. */
function text(status: number, message: string): Response {
  return new Response(message, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } })
}

/** The largest distance from the epoch, in milliseconds, that a `Date` holds. */
const TIME_LIMIT = 8.64e15

/** A query integer: absent gives undefined, anything but a whole number within the `Date` range gives NaN. */
function integer(params: URLSearchParams, name: string): number | undefined {
  const raw = params.get(name)
  if (raw === null) return undefined
  return /^-?\d+$/.test(raw) && Math.abs(Number(raw)) <= TIME_LIMIT ? Number(raw) : Number.NaN
}

/** The listing request a `RECORD_PATH` query names, or the reason it is malformed. */
function listQuery(params: URLSearchParams): RecordQuery | string {
  const limit = integer(params, 'limit') ?? 100
  if (!Number.isInteger(limit) || limit < 1 || limit > LIST_LIMIT) return `limit must be a whole number from 1 to ${String(LIST_LIMIT)}`
  const since = integer(params, 'since')
  if (Number.isNaN(since)) return 'since must be a whole number of milliseconds'
  const cursor = params.get('cursor') ?? undefined
  if (cursor !== undefined && !CURSOR.test(cursor)) return 'cursor must be <YYYY-MM-DD>:<line>'
  const kinds = params.get('kinds')?.split(',')
  if (kinds?.some(kind => kind === '')) return 'kinds must be a comma-separated list of kinds'
  return {
    limit,
    ...since === undefined ? {} : { since },
    ...cursor === undefined ? {} : { cursor: brandString<RecordCursor>(cursor) },
    ...kinds === undefined ? {} : { kinds },
  }
}

/**
 * Register the two exact GET routes behind Connection's authentication. Neither declares `access`, so Connection
 * answers every non-owner Peer 403 before the route runs: a refusal's summary holds the refused call's arguments.
 * @param ctx - context carrying Connection; owns the routes' lifetime.
 * @param service - the record to read.
 */
function serveRecord(ctx: Context, service: RunWildRecord): void {
  /** Answer the read's JSON, or 500 with its failure. */
  const answer = async (read: () => Promise<unknown>): Promise<Response> => {
    try {
      return Response.json(await read())
    } catch (error: unknown) {
      ctx.logger.warn('mumbo-run-wild: reading the record failed', error)
      return text(500, String(error))
    }
  }
  ctx.connection.fetch.register({
    path: RECORD_PATH, methods: ['GET'], requestBody: 'buffered',
    fetch: (request) => {
      const query = listQuery(new URL(request.url).searchParams)
      return typeof query === 'string' ? Promise.resolve(text(400, query)) : answer(() => service.list(query))
    },
  })
  ctx.connection.fetch.register({
    path: RECORD_COUNTS_PATH, methods: ['GET'], requestBody: 'buffered',
    fetch: (request) => {
      const params = new URL(request.url).searchParams
      const since = integer(params, 'since'), until = integer(params, 'until')
      if (since === undefined || until === undefined || Number.isNaN(since) || Number.isNaN(until)) {
        return Promise.resolve(text(400, 'since and until must be whole numbers of milliseconds'))
      }
      return answer(() => service.count(since, until))
    },
  })
}
