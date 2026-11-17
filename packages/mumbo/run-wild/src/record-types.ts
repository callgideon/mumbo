/** The Run Wild record's entries, pages, routes and page flag, shared by the Host and Client halves. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Where a listing continues: `<YYYY-MM-DD>:<line index>` of the last entry returned, exclusive. */
export type RecordCursor = Branded<'RunWildRecordCursor'>

/**
 * One indexed `runwild/decision`: the event's data, with `summary` clipped, plus where and when it was logged. `kind`
 * is an open string: a kind this version does not name is kept, and every field a producer adds passes through.
 */
export interface RecordEntry {
  /** Index format version; readers skip lines with any other value. */
  readonly v: 1
  /** The event's time, Unix epoch milliseconds. */
  readonly time: number
  /** The Session that logged it: a delegated child's own id for a child. */
  readonly session: SessionId
  /** Its root Session when it was recorded; equal to `session` for a root. */
  readonly root: SessionId
  /** The event's sequence number in `session`. */
  readonly seq: number
  /** What the decision stood in for, such as `question` or `refusal`. */
  readonly kind: string
  /** The decision's target: a tool name, a call id, a subject or a question id. */
  readonly target: string
  /** The decision's summary, clipped to {@link SUMMARY_LIMIT} characters. */
  readonly summary: string
  /** Why it was decided this way. */
  readonly reason: string
  /** Fields a producer added to the event's data. */
  readonly [field: string]: unknown
}

/** One page of the record, newest first. */
export interface RecordPage {
  /** The entries, newest first. */
  readonly entries: readonly RecordEntry[]
  /** Where the next page starts; absent on the last page. */
  readonly next?: RecordCursor
  /** Lines in the files read that were not entries of this format, such as a partial line after a crash. */
  readonly skipped: number
  /** Whether a decision failed to reach the record since the Host started. */
  readonly incomplete: boolean
  /** Days the record keeps. */
  readonly retentionDays: number
}

/** Entries per kind within a time window. */
export interface RecordCounts {
  /** Count per `kind`; kinds without entries are absent. */
  readonly counts: Readonly<Record<string, number>>
  /** Lines in the files read that were not entries of this format. */
  readonly skipped: number
  /** Whether a decision failed to reach the record since the Host started. */
  readonly incomplete: boolean
}

/** One listing request. */
export interface RecordQuery {
  /** Only entries of these kinds; omitted, every kind. */
  readonly kinds?: readonly string[]
  /** Continue after this entry. */
  readonly cursor?: RecordCursor
  /** Only entries with `time >= since`. */
  readonly since?: number
  /** At most this many entries, 1 to {@link LIST_LIMIT}. */
  readonly limit: number
}

/** The box-wide record of what Run Wild decided, as the `mumbo-run-wild-record` service reads it. */
export interface RunWildRecord {
  /**
   * List entries newest first: by time, then by line order, both descending.
   * @param query - kinds, cursor, lower time bound and page size.
   * @returns one page of entries.
   * @throws when a day file cannot be read.
   */
  list(query: RecordQuery): Promise<RecordPage>
  /**
   * Count entries per kind with `since <= time < until`.
   * @param since - window start, Unix epoch milliseconds, inclusive.
   * @param until - window end, Unix epoch milliseconds, exclusive.
   * @returns the counts.
   * @throws when a day file cannot be read.
   */
  count(since: number, until: number): Promise<RecordCounts>
}

/** The kinds the view filters by, which RW2 emits for browser and computer-use writes. */
export const RECORD_FILTER_KINDS = ['send', 'post', 'purchase', 'delete'] as const

/** The largest page {@link RunWildRecord.list} returns. */
export const LIST_LIMIT = 200

/** The characters of a summary the record keeps; a longer one ends in `…`. */
export const SUMMARY_LIMIT = 2000

/** Owner-only route answering a {@link RecordPage}: query `kinds` (comma-separated), `cursor`, `since` and `limit`. */
export const RECORD_PATH = '/api/mumbo-run-wild.record'

/** Owner-only route answering {@link RecordCounts}: query `since` and `until`. */
export const RECORD_COUNTS_PATH = '/api/mumbo-run-wild.record-counts'

/** Page bootstrap global that tells the owner's page the record routes exist. */
export const RECORD_GLOBAL = '__MUMBO_RUN_WILD__'

/** What {@link RECORD_GLOBAL} carries. */
export interface RecordFlag {
  /** The Host serves the record routes. */
  readonly record: true
}
