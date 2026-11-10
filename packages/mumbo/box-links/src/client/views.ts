/** The Desktop and Browser tab kinds of the right Sidebar, both showing the box desktop's live view. */
import type { Context } from '@deepseek-ai/cordis'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import { GuideArtworkBrowser } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { BROWSER_FRONT_PATH, BROWSER_TAKEOVER_PATH, TakeoverState } from '../config.ts'
import { LiveView, type LiveViewInjected, type TakeoverAnswer, type TakeoverCalls } from './LiveView.tsx'
import { NS } from './locales.ts'

/** Desktop tab kind. */
export const DESKTOP_KIND = 'box-desktop'
/** Browser tab kind; a local browser registered for it in the `extension` band takes it over. */
export const BROWSER_KIND = 'box-browser'
/** Desktop implementation identity and keyed Slot dispatch key. */
export const DESKTOP_ID = '@mumbo/box-links/desktop'
/** Browser implementation identity and keyed Slot dispatch key. */
export const BROWSER_ID = '@mumbo/box-links/browser'

/**
 * The two tab definitions, in the `builtin` band; each guide entry's id is `open`.
 * @param t - namespace-bound translate, read on every use.
 * @returns the Desktop definition (guide order 35) and the Browser definition (guide order 30).
 */
export function viewDefinitions(t: TranslateNS<'boxLinks'>): { desktop: SidebarRightTabDefinition; browser: SidebarRightTabDefinition } {
  return {
    desktop: {
      id: DESKTOP_ID, kind: DESKTOP_KIND, priority: 'builtin', title: () => t('desktop'),
      guide: [{ id: 'open', order: 35, title: () => t('desktop'), description: () => t('desktop.description') }],
    },
    browser: {
      id: BROWSER_ID, kind: BROWSER_KIND, priority: 'builtin', title: () => t('browser'),
      guide: [{ id: 'open', order: 30, title: () => t('browser'), description: () => t('browser.description'), icon: GuideArtworkBrowser }],
    },
  }
}

/**
 * POST the owner-only Host call that brings Chrome to the front.
 * @param signal - aborts the request; the Host then aborts its command.
 * @returns the failure detail, or undefined on success.
 */
async function frontChrome(signal: AbortSignal): Promise<string | undefined> {
  try {
    // Document-relative, so a page served under a path prefix reaches its own Host.
    const response = await fetch(BROWSER_FRONT_PATH.slice(1), { method: 'POST', signal })
    if (response.ok) return undefined
    const text = (await response.text()).trim()
    return text === '' ? `HTTP ${String(response.status)}` : text
  } catch (error) {
    // The request did not complete: offline, the page is unloading, or the tab hid and aborted it.
    return error instanceof Error ? error.message : String(error)
  }
}

/**
 * Call the owner-only take-over route.
 * @param init - GET with the tab's abort signal to read, or POST with `{ takenOver }` to change.
 * @returns the Host's state, with the failure of a change that did not finish, or why no state arrived.
 */
async function takeoverRoute(init: RequestInit): Promise<TakeoverAnswer> {
  let response: Response
  let text: string
  try {
    // Document-relative, so a page served under a path prefix reaches its own Host.
    response = await fetch(BROWSER_TAKEOVER_PATH.slice(1), init)
    text = await response.text()
  } catch (error) {
    // The request did not complete: offline, the page is unloading, or the tab hid and aborted the read.
    return { failure: error instanceof Error ? error.message : String(error) }
  }
  try {
    // The schema checks the answer the type names.
    return TakeoverState(JSON.parse(text) as TakeoverState)
  } catch {
    // Not the route's JSON, such as Connection's 403 or a proxy's error page: report the response itself.
    return { failure: text.trim() === '' ? `HTTP ${String(response.status)}` : text.trim() }
  }
}

/** The Browser tab's take-over calls. */
const takeoverCalls: TakeoverCalls = {
  read: signal => takeoverRoute({ signal }),
  change: takenOver => takeoverRoute({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ takenOver }) }),
}

/**
 * Register the Desktop tab and, when the Host serves its call, the Browser tab, while the right Sidebar is present.
 * @param ctx - Client plugin context carrying slots and locale.
 * @param url - desktop live view URL.
 * @param browser - whether the Host serves the Browser tab's call for this page.
 * @param takeover - whether the Host also serves the Browser tab's take-over route for this page.
 */
export function registerViews(ctx: Context, url: string, browser: boolean, takeover: boolean): void {
  const definitions = viewDefinitions(ctx.locale.bind(NS))
  ctx.inject(['sidebarRightTabs'], (ctx) => {
    const views: { definition: SidebarRightTabDefinition; inject: LiveViewInjected }[] = [
      { definition: definitions.desktop, inject: { url } },
    ]
    if (browser) {
      views.push({ definition: definitions.browser, inject: { url, front: frontChrome, ...takeover ? { takeover: takeoverCalls } : {} } })
    }
    for (const { definition, inject } of views) {
      ctx.effect(() => ctx.sidebarRightTabs.register(definition), `mumbo-box-links: ${definition.kind} tab`)
      ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab', key: definition.id, locale: NS, inject: () => inject,
      }, LiveView))
    }
  })
}
