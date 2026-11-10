/** Client half: opens Mumbo when a page first loads with no Session open. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { MUMBO_SESSION_ID } from '../session.ts'

/** Services the first-load decision reads and the navigation it performs. */
export const inject = ['sessions', 'workspaces', 'uiWorkspace']

/**
 * Decide once, when the Session and Workspace lists first settle: Workspace navigation restores the saved selection in
 * that same notification, so a Session the person chose is open by the next microtask. When none is open, navigation is
 * still preparing a blank Session, and opening Mumbo supersedes it. Nothing happens when the Host did not list Mumbo.
 * @param ctx - Client plugin context.
 */
export function apply(ctx: Context): void {
  const { sessions, workspaces } = ctx
  const unsubscribe: (() => void)[] = []
  const stop = (): void => { for (const dispose of unsubscribe.splice(0)) dispose() }
  const decide = (): void => {
    const listed = sessions.list.getSnapshot()
    if (!listed.ids.includes(MUMBO_SESSION_ID)) return
    if (Object.values(listed.byId).some(row => (row.retainedBy.mainView ?? 0) > 0)) return
    ctx.uiWorkspace.openSession(MUMBO_SESSION_ID)
  }
  const check = (): void => {
    if (sessions.list.getSnapshot().phase !== 'ready' || workspaces.list.getSnapshot().phase !== 'ready') return
    stop()
    queueMicrotask(decide)
  }
  unsubscribe.push(sessions.list.subscribe(check), workspaces.list.subscribe(check))
  ctx.effect(() => stop, 'mumbo-assistant: first-load navigation')
  check()
}
