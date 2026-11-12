/**
 * Client half: on the owner's page of a box that serves the record, registers the "What ran without asking" main
 * panel with its left-nav entry, and the Run Wild chip in the header of each Session in Run Wild.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionFace } from '@deepseek-ai/dsh-api-session-controller/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { PermissionSelection } from '@deepseek-ai/dsh-permission-presets/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { RECORD_COUNTS_PATH, RECORD_GLOBAL, RECORD_PATH, type RecordCounts, type RecordFlag, type RecordPage as Page, type RecordQuery } from '../record-types.ts'
import { de, en, es, fr, ja, NS, pt, ru } from './locales.ts'
import { RecordIcon, RecordPage } from './RecordPage.tsx'
import { RUN_WILD_PRESET, RunWildChip, type LeaveOutcome } from './RunWildChip.tsx'

/** The panel's main key and left-nav id. */
export const PANEL_ID = 'mumbo-run-wild' as MainPanelId

/** Services the registrations need. */
export const inject = ['slots', 'locale', 'layout', 'sessions', 'uiWorkspace']

/**
 * GET one of the owner-only record routes.
 * @param path - the route's absolute path.
 * @param query - its query parameters.
 * @returns the route's JSON answer.
 * @throws with the route's message when it answers anything but 200.
 */
async function read<T>(path: string, query: URLSearchParams): Promise<T> {
  // Document-relative, so a page served under a path prefix reaches its own Host.
  const response = await fetch(`${path.slice(1)}?${query.toString()}`)
  if (!response.ok) throw new Error((await response.text()).trim() || `HTTP ${String(response.status)}`)
  // The Host's route answers the type it names.
  return await response.json() as T
}

/** Read one page of the record; the view never bounds it by time. */
function list(query: RecordQuery): Promise<Page> {
  const params = new URLSearchParams({ limit: String(query.limit) })
  if (query.kinds !== undefined) params.set('kinds', query.kinds.join(','))
  if (query.cursor !== undefined) params.set('cursor', query.cursor)
  return read<Page>(RECORD_PATH, params)
}

/** Count the record's entries per kind in a window. */
function counts(since: number, until: number): Promise<RecordCounts> {
  return read<RecordCounts>(RECORD_COUNTS_PATH, new URLSearchParams({ since: String(since), until: String(until) }))
}

/**
 * Register the panel, its left-nav entry and the header chip when the page bootstrap says the Host serves the record.
 * @param ctx - Client plugin context.
 */
export function apply(ctx: Context): void {
  // Only the owner's page of a box that mounts the Host half carries the flag.
  if ((globalThis as Partial<Record<typeof RECORD_GLOBAL, RecordFlag>>)[RECORD_GLOBAL] === undefined) return
  ctx.effect(() => ctx.locale.register(NS, { en, ja, es, fr, de, ru, pt }), 'mumbo-run-wild: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: PANEL_ID, locale: NS,
    inject: () => ({ list, counts, openSession: (root: SessionId) => { ctx.uiWorkspace.openSession(root) } }),
  }, RecordPage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: () => t('entry'), locale: NS,
  }, RecordIcon))
  const leave = async (sessionId: SessionId): Promise<LeaveOutcome> => {
    const session: SessionFace | undefined = ctx.sessions.binding(sessionId)?.session
    // Re-read when clicked: from anything but Run Wild, such as after a switch in another tab, this switch could raise
    // authority instead of removing it.
    const selection = session?.projections.faceOf('permissions').getSnapshot() as PermissionSelection | undefined
    if (session === undefined || selection?.currentValue !== RUN_WILD_PRESET) return 'skipped'
    try {
      const result = await session.command('/permission danger-full-access')
      return result.ok && result.value.matched ? 'switched' : 'failed'
    } catch {
      // The command did not reach the Host, such as on a lost connection.
      return 'failed'
    }
  }
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions', id: 'run-wild',
    // Just after the agent-preset label (-10), in the header's leading band of session context.
    order: -9, locale: NS,
    inject: () => ({ openView: () => { ctx.layout.selectPanel(PANEL_ID) }, leave }),
  }, RunWildChip))
}
