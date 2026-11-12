// @vitest-environment jsdom
/** The "What ran without asking" panel: rows, filters, paging, states, Session links and the Yesterday row. */
import type { Context } from '@deepseek-ai/cordis'
import { act, cleanup, fireEvent } from '@testing-library/react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, expect, it, vi } from 'vitest'
import { apply, inject, PANEL_ID } from '../src/client/index.ts'
import { de, en, es, fr, ja, pt, ru } from '../src/client/locales.ts'
import { RECORD_COUNTS_PATH, RECORD_GLOBAL, RECORD_PATH, type RecordEntry, type RecordPage } from '../src/record-types.ts'

const NOW = Date.parse('2026-11-12T12:00:00')
const runtimes = new Set<SlotTestRuntime>()
afterEach(async () => {
  try { for (const runtime of runtimes) await runtime.dispose() }
  finally { runtimes.clear(); cleanup(); vi.unstubAllGlobals(); vi.useRealTimers() }
})

/** One record entry. */
function entry(fields: Partial<RecordEntry> = {}): RecordEntry {
  return { v: 1, time: NOW - 5 * 60_000, session: SessionId('root'), root: SessionId('root'), seq: 1, kind: 'question', target: 'env', summary: 'Which environment?', reason: 'Run Wild: decide.', ...fields }
}

/** A Host stand-in for the two routes: `pages` answers each record request in turn, `counts` the counts request. */
function host(pages: (RecordPage | Error)[], counts: Record<string, number> | Error = {}) {
  const requests: URL[] = []
  vi.stubGlobal('fetch', vi.fn((input: string) => {
    const url = new URL(input, 'http://box.test/')
    requests.push(url)
    const counted = counts instanceof Error ? counts : { counts, skipped: 0, incomplete: false }
    const answer = url.pathname === RECORD_COUNTS_PATH ? counted : pages.shift()!
    if (answer instanceof Error) return Promise.resolve(new Response(answer.message, { status: 500 }))
    return Promise.resolve(Response.json(answer))
  }))
  return requests
}

const page = (entries: RecordEntry[], fields: Partial<RecordPage> = {}): RecordPage => ({
  entries, skipped: 0, incomplete: false, retentionDays: 90, ...fields,
})

/** Mount the Client half, on a page whose bootstrap carries the flag when `flagged`; `listed` are the Sessions the list holds. */
async function bench(flagged = true, listed: string[] = ['root']) {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  if (flagged) vi.stubGlobal(RECORD_GLOBAL, { record: true })
  const runtime = await SlotTestRuntime.create()
  runtimes.add(runtime)
  const opened: unknown[] = []
  const selected: unknown[] = []
  await runtime.mount({
    inject: ['slots'],
    apply(ctx: Context) {
      const locale = new LocaleRuntime(ctx)
      locale.setLocale('en')
      ctx.provide('locale', locale)
      ctx.slots.installLocale(locale)
      ctx.provide('layout', { selectPanel: (id: unknown) => { selected.push(id) } } as never)
      ctx.provide('uiWorkspace', { openSession: (id: unknown) => { opened.push(id) } } as never)
    },
  })
  for (const id of listed) await runtime.sessions.add({ id, summary: { displayTitle: `Title of ${id}` } })
  await runtime.declare({ 'main': { kind: 'keyed', scope: 'root' }, 'sidebar.panellist': { kind: 'list', scope: 'root' } })
  const plugin = await runtime.mount({ inject, apply })
  return { runtime, plugin, opened, selected }
}

/** Render the panel and wait for its first read. */
async function rendered(runtime: SlotTestRuntime) {
  const view = runtime.renderSlot('main', {}, { entryKey: PANEL_ID })
  await act(async () => { await Promise.resolve() })
  return view
}

it('lists entries newest first as plain text, with kind labels, the Session link and the child marker', async () => {
  host([page([
    entry({ kind: 'refusal', target: 'bash', summary: '<b>{"command":"ls"}</b>', reason: 'bash did not run', seq: 3 }),
    entry({ kind: 'paint', seq: 2 }),
    entry({ session: SessionId('child'), seq: 1 }),
    entry({ root: SessionId('gone'), seq: 4 }),
  ])])
  const { runtime, opened } = await bench()
  const { view } = await rendered(runtime)
  const rows = view.getAllByRole('listitem')
  expect(rows.map(row => row.querySelector('span')?.textContent)).toEqual(['Refused', 'Other action', 'Answered a question', 'Answered a question'])
  expect(rows[0]!.textContent).toContain('<b>{"command":"ls"}</b>')
  expect(rows[0]!.querySelector('b')).toBeNull()
  expect(rows[0]!.querySelector('time')?.textContent).toBe('5 minutes ago')
  expect(rows[2]!.textContent).toContain('in a subagent')
  expect(rows[3]!.textContent).toContain('Session not available')
  expect(rows[3]!.querySelector('button')).toBeNull()
  fireEvent.click(view.getAllByRole('button', { name: 'Open session' })[0]!)
  expect(opened).toEqual(['root'])
  expect(view.getByText('What Mumbo did in Run Wild without asking you, from the last 90 days. Each action is recorded in its session too.')).toBeTruthy()
})

it('sends each filter as kinds, shows its empty sentence, and pages with Show older', async () => {
  const requests = host([page([entry()], { next: '2026-11-12:0' as never }), page([entry({ seq: 9, target: 'older' })]), page([]), page([])])
  const { runtime } = await bench()
  const { view } = await rendered(runtime)
  fireEvent.click(view.getByRole('button', { name: 'Show older' }))
  await act(async () => { await Promise.resolve() })
  expect(view.getAllByRole('listitem')).toHaveLength(2)
  expect(view.queryByRole('button', { name: 'Show older' })).toBeNull()
  fireEvent.click(view.getByRole('button', { name: 'Sends' }))
  await act(async () => { await Promise.resolve() })
  expect(view.getByRole('button', { name: 'Sends' }).getAttribute('aria-pressed')).toBe('true')
  expect(view.getByText('Nothing was sent without asking.')).toBeTruthy()
  fireEvent.click(view.getByRole('button', { name: 'Deletes' }))
  await act(async () => { await Promise.resolve() })
  expect(view.getByText('Nothing was deleted without asking.')).toBeTruthy()
  const listed = requests.filter(url => url.pathname === RECORD_PATH).map(url => Object.fromEntries(url.searchParams))
  expect(listed).toEqual([{ limit: '50' }, { limit: '50', cursor: '2026-11-12:0' }, { limit: '50', kinds: 'send' }, { limit: '50', kinds: 'delete' }])
})

it('keeps the rows on a failed read and offers Try again; an empty panel centers the notice', async () => {
  host([page([entry()], { next: '2026-11-12:0' as never }), new Error('disk gone'), page([entry(), entry({ seq: 2 })])])
  const { runtime } = await bench()
  const { view } = await rendered(runtime)
  fireEvent.click(view.getByRole('button', { name: 'Show older' }))
  await act(async () => { await Promise.resolve() })
  expect(view.getByRole('alert').textContent).toContain('Could not load the record.')
  expect(view.getAllByRole('listitem')).toHaveLength(1)
  fireEvent.click(view.getByRole('button', { name: 'Try again' }))
  await act(async () => { await Promise.resolve() })
  expect([view.queryByRole('alert'), view.getAllByRole('listitem').length]).toEqual([null, 2])
})

it('shows the empty sentence for All, a loading skeleton first, and the incomplete notice', async () => {
  host([page([], { incomplete: true })])
  const { runtime } = await bench()
  const view = runtime.renderSlot('main', {}, { entryKey: PANEL_ID }).view
  expect(view.getByRole('list').getAttribute('aria-busy')).toBe('true')
  await act(async () => { await Promise.resolve() })
  expect(view.getByText('Nothing has run without asking yet.')).toBeTruthy()
  expect(view.getByText('Some actions since the box last started may be missing here.')).toBeTruthy()
})

it('reads the Yesterday counts between local midnights and shows each kind, hidden when every count is zero', async () => {
  const requests = host([page([]), page([])], { send: 6, post: 1, question: 0, paint: 2 })
  const { runtime } = await bench()
  const { view } = await rendered(runtime)
  const counts = requests.find(url => url.pathname === RECORD_COUNTS_PATH)!
  expect([Number(counts.searchParams.get('since')), Number(counts.searchParams.get('until'))])
    .toEqual([new Date(2026, 10, 11).getTime(), new Date(2026, 10, 12).getTime()])
  expect(view.getByRole('group', { name: 'Yesterday' }).textContent).toBe('Yesterday6 sent1 posted2 other actions')
  host([page([])], { send: 0 })
  fireEvent.click(view.getByRole('button', { name: 'Refresh' }))
  await act(async () => { await Promise.resolve() })
  expect(view.queryByRole('group', { name: 'Yesterday' })).toBeNull()
})

it('hides the Yesterday row when its read fails', async () => {
  host([page([])], new Error('no counts'))
  const { runtime } = await bench()
  const { view } = await rendered(runtime)
  expect(view.queryByRole('group', { name: 'Yesterday' })).toBeNull()
})

it('clamps a long summary with a disclosure, and says just now for a fresh entry', async () => {
  host([page([entry({ summary: 'plan '.repeat(40), time: NOW }), entry({ summary: 'two\nlines', seq: 2 }), entry({ summary: '', seq: 3 })])])
  const { runtime } = await bench()
  const { view } = await rendered(runtime)
  const [toggle, second] = view.getAllByRole('button', { name: 'Show more' })
  expect(toggle!.getAttribute('aria-expanded')).toBe('false')
  fireEvent.click(toggle!)
  expect([toggle!.textContent, toggle!.getAttribute('aria-expanded'), second]).toEqual(['Show less', 'true', expect.anything()])
  expect(view.getAllByRole('listitem')[0]!.querySelector('time')?.textContent).toBe('just now')
  expect(view.getAllByRole('listitem')[2]!.querySelectorAll('p')).toHaveLength(1)
})

it('drops a read a newer one superseded, and says why a read failed without a message', async () => {
  let release: (response: Response) => void = () => {}
  vi.stubGlobal('fetch', vi.fn((input: string) => {
    const url = new URL(input, 'http://box.test/')
    if (url.pathname === RECORD_COUNTS_PATH) return Promise.resolve(Response.json({ counts: {}, skipped: 0, incomplete: false }))
    if (url.searchParams.get('kinds') === 'post') return Promise.resolve(new Response('', { status: 502 }))
    return new Promise<Response>((resolve) => { release = resolve })
  }))
  const { runtime } = await bench()
  const { view } = await rendered(runtime)
  fireEvent.click(view.getByRole('button', { name: 'Posts' }))
  await act(async () => { await Promise.resolve() })
  await act(async () => { release(Response.json(page([entry()]))) })
  expect(view.queryAllByRole('listitem')).toHaveLength(0)
  expect(view.getByRole('alert').textContent).toContain('Could not load the record.')
})

it('ignores a failure of a read a newer one superseded', async () => {
  let fail: (response: Response) => void = () => {}
  vi.stubGlobal('fetch', vi.fn((input: string) => {
    const url = new URL(input, 'http://box.test/')
    if (url.pathname === RECORD_COUNTS_PATH) return Promise.resolve(Response.json({ counts: {}, skipped: 0, incomplete: false }))
    if (url.searchParams.get('kinds') === 'post') return Promise.resolve(Response.json(page([])))
    return new Promise<Response>((resolve) => { fail = resolve })
  }))
  const { runtime } = await bench()
  const { view } = await rendered(runtime)
  fireEvent.click(view.getByRole('button', { name: 'Posts' }))
  await act(async () => { await Promise.resolve() })
  await act(async () => { fail(new Response('late', { status: 500 })) })
  expect([view.queryByRole('alert'), view.getByText('Nothing was posted without asking.')]).toEqual([null, expect.anything()])
})

it('adds the left-nav entry at order 20 and selects nothing by itself', async () => {
  host([])
  const { runtime, selected } = await bench()
  expect(runtime.slots.entries('sidebar.panellist').map(entry => [entry.options.id, entry.options.order])).toEqual([[PANEL_ID, 20]])
  expect((runtime.slots.entries('sidebar.panellist')[0]!.options.label as () => string)()).toBe('Ran without asking')
  const { container } = runtime.renderSlot('sidebar.panellist', { size: 16, active: false })
  expect(container.querySelector('svg')).not.toBeNull()
  expect(selected).toEqual([])
})

it('registers nothing without the page flag, and nothing stays after unload', async () => {
  const { runtime } = await bench(false)
  expect([runtime.slots.entries('main'), runtime.slots.entries('sidebar.panellist')]).toEqual([[], []])
  host([])
  const flagged = await bench()
  await flagged.plugin.dispose()
  expect([flagged.runtime.slots.entries('main'), flagged.runtime.slots.entries('sidebar.panellist')]).toEqual([[], []])
})

it('has every key in every locale', () => {
  for (const dictionary of [ja, es, fr, de, ru, pt]) expect(Object.keys(dictionary).sort()).toEqual(Object.keys(en).sort())
})
