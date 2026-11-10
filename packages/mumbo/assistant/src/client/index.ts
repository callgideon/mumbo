/** Client half: Mumbo's sidebar entry, its absence from the Workspace lists, and its opening on a first page load. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { MUMBO_SESSION_ID } from '../session.ts'
import { de, en, es, fr, ja, NS, pt, ru } from './locales.ts'
import { MumboIcon } from './MumboIcon.tsx'

/** Services the sidebar entry, the Workspace list registration, and the first-load decision use. */
export const inject = ['sessions', 'uiWorkspace', 'slots', 'locale']

/**
 * Register Mumbo's sidebar entry, which opens the Mumbo Session from the navigation band ahead of Plugins, and hide
 * Mumbo from the Workspace browser's lists. Then decide once per start of this plugin, when Workspace navigation's
 * startup restoration starts: a `saved` restoration reopens the Session the person chose, blank or not, and is left
 * alone; a `fresh` one would open a Workspace blank, and opening Mumbo supersedes it. Nothing opens when the Host did not
 * list Mumbo, when Mumbo or a Session with a turn is already open, or when restoration never runs because a Session was
 * opened first.
 * @param ctx - Client plugin context.
 */
export function apply(ctx: Context): void {
  const { sessions, uiWorkspace } = ctx
  ctx.effect(() => ctx.locale.register(NS, { en, ja, es, fr, de, ru, pt }), 'mumbo-assistant: dictionaries')
  const t = ctx.locale.bind(NS)
  // Plugins sits at order 0, so Mumbo leads the band.
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: 'mumbo', order: -10, label: () => t('entry'), session: MUMBO_SESSION_ID,
  }, MumboIcon))
  ctx.effect(() => uiWorkspace.hideSession(MUMBO_SESSION_ID), 'mumbo-assistant: hidden from the Workspace lists')
  const check = (): void => {
    const restoration = uiWorkspace.restoration.getSnapshot()
    if (restoration === 'pending') return
    stop()
    if (restoration === 'fresh') {
      // After restoration's synchronous part, so this navigation is the later one.
      queueMicrotask(() => {
        const { ids, byId } = sessions.list.getSnapshot()
        // A re-applied plugin (an HMR rebuild) reads the page's earlier `fresh`: keep a Session the person opened since.
        const chosen = Object.values(byId).some(row => (row.retainedBy.mainView ?? 0) > 0 && (!row.blank || row.id === MUMBO_SESSION_ID))
        if (ids.includes(MUMBO_SESSION_ID) && !chosen) uiWorkspace.openSession(MUMBO_SESSION_ID)
      })
    }
  }
  const stop = uiWorkspace.restoration.subscribe(check)
  ctx.effect(() => stop, 'mumbo-assistant: first-load navigation')
  check()
}
