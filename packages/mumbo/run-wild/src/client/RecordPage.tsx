/** The "What ran without asking" main panel: the record across Sessions, newest first, with filters and a Yesterday row. */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { Button, PermissionIconFullAccessRegular, Tag, Tooltip, relativeTime } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarPanelIconOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { RECORD_FILTER_KINDS, type RecordCounts, type RecordCursor, type RecordEntry, type RecordPage as Page, type RecordQuery } from '../record-types.ts'
import type { RunWildKey } from './locales.ts'
import css from './RecordPage.module.css'

/** What the plugin injects: the two record reads and the Session navigation. */
export interface RecordPageInjected {
  /** Read one page of the record. */
  list: (query: RecordQuery) => Promise<Page>
  /** Count the record's entries per kind in a window. */
  counts: (since: number, until: number) => Promise<RecordCounts>
  /** Show a root Session's Conversation. */
  openSession: (root: SessionId) => void
}

/** Full component props. */
export type RecordPageProps = PropsRuntime<'main'> & PropsLocale<'mumbo.runWild'> & InjectFace<RecordPageInjected>

/** A view filter: every kind, or one of {@link RECORD_FILTER_KINDS}. */
type Filter = 'all' | typeof RECORD_FILTER_KINDS[number]

/** Kinds the dictionaries name; every other kind reads "Other action". */
const NAMED_KINDS: ReadonlySet<string> = new Set(['approval', 'plan-review', 'question', 'refusal', ...RECORD_FILTER_KINDS])

/** Entries per page. */
const PAGE = 50

/** A summary longer than this, or with a line break, starts clamped to two lines with a toggle. */
const LONG_SUMMARY = 160

const UNITS = { minutes: 'minute', hours: 'hour', days: 'day', months: 'month', years: 'year' } as const

/**
 * The panel's left-nav glyph: Run Wild's own, the Full access glyph.
 * @param props.size - the glyph's size.
 * @returns the glyph.
 */
export function RecordIcon({ size }: SidebarPanelIconOwnerProps) {
  return <PermissionIconFullAccessRegular size={size} />
}

/** Join the class names that apply. */
function classes(...names: (string | false | undefined)[]): string {
  return names.filter(Boolean).join(' ')
}

/** The dictionary key part of a kind. */
function kindKey(kind: string): string {
  return NAMED_KINDS.has(kind) ? kind : 'other'
}

/** Local midnight `days` days before today's. */
function midnight(days: number): number {
  const at = new Date()
  at.setHours(0, 0, 0, 0)
  at.setDate(at.getDate() - days)
  return at.getTime()
}

/** One entry row. */
function Row({ entry, now, title, listed, openSession, t }: {
  entry: RecordEntry
  now: number
  title: string | undefined
  listed: boolean
  openSession: (root: SessionId) => void
  t: RecordPageProps['t']
}) {
  const [expanded, setExpanded] = useState(false)
  const locale = t('time.locale')
  const ago = relativeTime(entry.time, now)
  const when = ago.unit === 'now' ? t('time.now') : new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(-ago.n, UNITS[ago.unit])
  const long = entry.summary.length > LONG_SUMMARY || entry.summary.includes('\n')
  return (
    <li className={css.row}>
      <div className={css.rowHead}>
        <span className={css.kind}>{t(`kind.${kindKey(entry.kind)}` as RunWildKey)}</span>
        <code className={css.target}>{entry.target}</code>
        <Tooltip label={new Date(entry.time).toLocaleString(locale)} side="bottom" portal>
          <time className={css.time} dateTime={new Date(entry.time).toISOString()} tabIndex={0}>{when}</time>
        </Tooltip>
      </div>
      {entry.summary !== '' && <p className={classes(css.summary, long && !expanded && css.clamped)}>{entry.summary}</p>}
      {long && <button type="button" className={css.toggle} aria-expanded={expanded} onClick={() => { setExpanded(value => !value) }}>
        {t(expanded ? 'summary.less' : 'summary.more')}
      </button>}
      {/* A question's reason is always the decide-yourself reply the model received, the same on every such row. */}
      {entry.kind !== 'question' && <p className={css.reason}>{entry.reason}</p>}
      <div className={css.session}>
        {listed
          ? <>
            <span className={css.sessionTitle}>{title}</span>
            <Button size="sm" variant="outline" onClick={() => { openSession(entry.root) }}>{t('session.open')}</Button>
          </>
          : <span className={css.sessionTitle}>{t('session.missing')}</span>}
        {entry.session !== entry.root && <span className={css.child}>{t('session.child')}</span>}
      </div>
    </li>
  )
}

/**
 * Render the record: title and retention, the Yesterday counts, the kind filters, and the entries with their Session
 * links. It reads the record when it opens, on Refresh and on Try again; agent-written text renders as plain text.
 * @param props - composed slot props.
 * @returns the panel.
 */
export function RecordPage({ list, counts, openSession, useSessions, t }: RecordPageProps) {
  const [filter, setFilter] = useState<Filter>('all')
  const [entries, setEntries] = useState<readonly RecordEntry[]>([])
  const [next, setNext] = useState<RecordCursor | undefined>(undefined)
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [page, setPage] = useState<Pick<Page, 'incomplete' | 'retentionDays'> | undefined>(undefined)
  const [yesterday, setYesterday] = useState<RecordCounts['counts'] | undefined>(undefined)
  const [now, setNow] = useState(Date.now)
  // Only the latest read may publish: a filter change or a refresh supersedes one still in flight.
  const generation = useRef(0)
  const sessions = useSessions(state => state)

  const load = useCallback(async (from?: RecordCursor) => {
    const own = ++generation.current
    setStatus('loading')
    try {
      const read = await list({ limit: PAGE, ...filter === 'all' ? {} : { kinds: [filter] }, ...from === undefined ? {} : { cursor: from } })
      if (own !== generation.current) return
      setEntries(shown => from === undefined ? read.entries : [...shown, ...read.entries])
      setNext(read.next)
      setPage({ incomplete: read.incomplete, retentionDays: read.retentionDays })
      setNow(Date.now())
      setStatus('ready')
    } catch {
      // The rows already shown stay; the notice offers Try again.
      if (own === generation.current) setStatus('failed')
    }
  }, [list, filter])

  const refresh = useCallback(() => {
    void load()
    counts(midnight(1), midnight(0)).then((read) => { setYesterday(read.counts) }, () => { setYesterday(undefined) })
  }, [load, counts])

  useEffect(() => { refresh() }, [refresh])

  const tags = Object.entries(yesterday ?? {}).filter(([, n]) => n > 0)
  return (
    <section className={css.page} aria-label={t('title')}>
      <div className={css.pageScroll}>
        <div className={css.pageContent}>
          <div className={css.pageHeading}>
            <h1>{t('title')}</h1>
            <Button size="sm" variant="outline" onClick={refresh}>{t('refresh')}</Button>
          </div>
          {page !== undefined && <p className={css.description}>{t('description', { days: page.retentionDays })}</p>}
          {tags.length > 0 && <div className={css.yesterday} role="group" aria-label={t('yesterday')}>
            <span className={css.yesterdayLabel}>{t('yesterday')}</span>
            {tags.map(([kind, n]) => (
              <Tag key={kind}>{t(`count.${kindKey(kind)}.${n === 1 ? 'one' : 'other'}` as RunWildKey, { count: n })}</Tag>
            ))}
          </div>}
          <div className={css.filters} role="group" aria-label={t('filter.label')}>
            {(['all', ...RECORD_FILTER_KINDS] as const).map(value => (
              <button key={value} type="button" className={classes(css.filter, filter === value && css.filterActive)}
                aria-pressed={filter === value} onClick={() => {
                  if (value === filter) return
                  // Another filter's rows never show under this one, not even while it loads or after it fails.
                  setFilter(value)
                  setEntries([])
                  setNext(undefined)
                }}>
                {t(`filter.${value}`)}
              </button>
            ))}
          </div>
          {page?.incomplete === true && <p className={css.notice} role="status">{t('incomplete')}</p>}
          {status === 'failed' && <div className={classes(css.notice, entries.length === 0 && css.centered)} role="alert">
            <span>{t('error.load')}</span>
            <Button size="sm" variant="outline" onClick={() => { void load() }}>{t('retry')}</Button>
          </div>}
          {status === 'ready' && entries.length === 0 && <p className={css.empty} role="status">{t(`empty.${filter}`)}</p>}
          {/* An empty sentence or a failed first read stands alone: an empty list after it reads as "list, 0 items". */}
          {(status === 'loading' || entries.length > 0) && <ul className={css.rows} aria-label={t('list.label')}
            aria-busy={status === 'loading'}>
            {status === 'loading' && entries.length === 0 && [0, 1, 2].map(n => <li key={n} className={css.skeleton} aria-hidden />)}
            {entries.map(entry => (
              <Row key={`${entry.session}:${String(entry.seq)}`} entry={entry} now={now} t={t} openSession={openSession}
                listed={sessions.ids.includes(entry.root)} title={sessions.byId[entry.root]?.displayTitle} />
            ))}
          </ul>}
          {next !== undefined && status !== 'loading' && <Button className={css.older} variant="outline" onClick={() => { void load(next) }}>{t('older')}</Button>}
        </div>
      </div>
    </section>
  )
}
