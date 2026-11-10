/** Client half: opens Mumbo when a page first loads with no saved Session to restore. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { MUMBO_SESSION_ID } from '../session.ts'

/** Services the first-load decision reads and the navigation it performs. */
export const inject = ['sessions', 'uiWorkspace']

/**
 * Decide once, when Workspace navigation's startup restoration starts: a `saved` restoration reopens the Session the
 * person chose, blank or not, and is left alone; a `fresh` one would open a Workspace blank, and opening Mumbo
 * supersedes it. Nothing happens when the Host did not list Mumbo, or when restoration never runs because a Session was
 * opened first.
 * @param ctx - Client plugin context.
 */
export function apply(ctx: Context): void {
  const { sessions, uiWorkspace } = ctx
  const check = (): void => {
    const restoration = uiWorkspace.restoration.getSnapshot()
    if (restoration === 'pending') return
    stop()
    if (restoration === 'fresh') {
      // After restoration's synchronous part, so this navigation is the later one.
      queueMicrotask(() => {
        if (sessions.list.getSnapshot().ids.includes(MUMBO_SESSION_ID)) uiWorkspace.openSession(MUMBO_SESSION_ID)
      })
    }
  }
  const stop = uiWorkspace.restoration.subscribe(check)
  ctx.effect(() => stop, 'mumbo-assistant: first-load navigation')
  check()
}
