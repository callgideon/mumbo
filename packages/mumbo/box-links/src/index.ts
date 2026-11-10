/** Host half: publishes the configured box links in every Web page and serves the Browser tab's owner-only calls. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'
import type {} from '@mumbo/browser-consent'
import { frontChrome } from './browser.ts'
import { BOX_LINKS_GLOBAL, BROWSER_FRONT_PATH, BROWSER_TAKEOVER_PATH, Config, type BrowserConfig, type PageLinks, type TakeoverState } from './config.ts'

export { Config } from './config.ts'

/** Cordis function-plugin name. */
export const name = 'mumbo-box-links'

/**
 * Embed the validated links in each page bootstrap, whichever Peer the page speaks for, and, with `browser`, register
 * the owner-only route that brings Chrome to the front and, while browser consent is loaded, the owner-only take-over
 * route; only the owner's page learns that the routes exist.
 * @param ctx - Host context serving Web pages.
 * @param config - validated links and Chrome control.
 * @throws when `browser` is configured without `desktop`.
 */
export function apply(ctx: Context, config: Config): void {
  const { browser: configured, ...links } = config
  // A YAML `browser:` key without a value validates to null and leaves the Browser tab off, as an omitted key does.
  const browser = configured ?? undefined
  if (browser !== undefined && links.desktop === undefined) throw new Error('mumbo-box-links: browser requires desktop, the live view the Browser tab shows')
  ctx.on('webserver/index-inject', (table, peer) => {
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- other packages merge non-owner kinds into PrincipalMap.
    const owner = browser !== undefined && peer.principal.kind === 'owner'
    const takeover = owner && ctx.get('mumbo-browser-consent') !== undefined
    const value: PageLinks = owner ? { ...links, browser: true, ...takeover ? { takeover } : {} } : links
    table.push({ kind: 'global', name: BOX_LINKS_GLOBAL, value })
  })
  if (browser === undefined) return
  ctx.inject(['connection', 'subprocess'], (ctx) => { serveBrowserFront(ctx, browser) })
  ctx.inject(['connection', 'mumbo-browser-consent'], (ctx) => { serveTakeover(ctx) })
}

/**
 * Register the exact route behind Connection's authentication. It declares no `access`, so Connection answers every
 * non-owner Peer 403 before the route runs. Calls run one at a time, so two calls never act on the windows at once.
 * @param ctx - context carrying Connection and the subprocess service; owns the route's lifetime.
 * @param config - Chrome control.
 */
function serveBrowserFront(ctx: Context, config: BrowserConfig): void {
  const lifetime = new AbortController()
  let queue = Promise.resolve()
  ctx.effect(() => async () => {
    lifetime.abort()
    await queue
  }, 'mumbo-box-links: Chrome calls')
  ctx.connection.fetch.register({
    path: BROWSER_FRONT_PATH, methods: ['POST'], requestBody: 'buffered',
    fetch: (request) => {
      const call = queue.then(() => frontChrome(ctx, config, AbortSignal.any([request.signal, lifetime.signal])))
      // The queue only orders calls; this call's own response reports its failure.
      queue = call.then(() => {}, () => {})
      return call.then(
        () => new Response(null, { status: 204 }),
        (error: unknown) => {
          ctx.logger.warn('mumbo-box-links: bringing Chrome to the front failed', error)
          return new Response(error instanceof Error ? error.message : String(error), { status: 500, headers: { 'content-type': 'text/plain; charset=utf-8' } })
        },
      )
    },
  })
}

/** A take-over request's body. */
const TakeoverRequest: z<{ takenOver: boolean }> = z.object({ takenOver: z.boolean().required() })

/**
 * Register the exact take-over route behind Connection's authentication. Like the Chrome route it declares no
 * `access`, so Connection answers every non-owner Peer 403 before the route runs. GET answers the
 * {@link TakeoverState} that browser consent reports; POST with `{ takenOver: true }` takes the browser over and with
 * `false` hands it back, then answers the state with status 200, or 500 with the failure.
 * @param ctx - context carrying Connection and browser consent; owns the route's lifetime.
 */
function serveTakeover(ctx: Context): void {
  const takeover = ctx['mumbo-browser-consent']
  const state = (failure?: string): TakeoverState => ({ hold: takeover.hold, ...failure === undefined ? {} : { failure } })
  ctx.connection.fetch.register({
    path: BROWSER_TAKEOVER_PATH, methods: ['GET', 'POST'], requestBody: 'buffered',
    fetch: async (request) => {
      if (request.method === 'GET') return Response.json(state())
      let takenOver: boolean
      try {
        // The schema checks the body the type names.
        takenOver = TakeoverRequest(await request.json() as { takenOver: boolean }).takenOver
      } catch (error: unknown) {
        return new Response(`Expected a JSON body {"takenOver": true | false}: ${String(error)}`, { status: 400, headers: { 'content-type': 'text/plain; charset=utf-8' } })
      }
      try {
        await (takenOver ? takeover.takeOver() : takeover.handBack())
        return Response.json(state())
      } catch (error: unknown) {
        const failure = error instanceof Error ? error.message : String(error)
        ctx.logger.warn(`mumbo-box-links: ${takenOver ? 'taking over' : 'handing back'} the browser failed: ${failure}`)
        return Response.json(state(failure), { status: 500 })
      }
    },
  })
}
