/** Host half: publishes the configured box links in every Web page and serves the Browser tab's owner-only call. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { frontChrome } from './browser.ts'
import { BOX_LINKS_GLOBAL, BROWSER_FRONT_PATH, Config, type BrowserConfig, type PageLinks } from './config.ts'

export { Config } from './config.ts'

/** Cordis function-plugin name. */
export const name = 'mumbo-box-links'

/**
 * Embed the validated links in each page bootstrap, whichever Peer the page speaks for, and, with `browser`, register
 * the owner-only route that brings Chrome to the front; only the owner's page learns that the route exists.
 * @param ctx - Host context serving Web pages.
 * @param config - validated links and Chrome control.
 * @throws when `browser` is configured without `desktop`.
 */
export function apply(ctx: Context, config: Config): void {
  const { browser, ...links } = config
  if (browser !== undefined && links.desktop === undefined) throw new Error('mumbo-box-links: browser requires desktop, the live view the Browser tab shows')
  ctx.on('webserver/index-inject', (table, peer) => {
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- other packages merge non-owner kinds into PrincipalMap.
    const value: PageLinks = browser !== undefined && peer.principal.kind === 'owner' ? { ...links, browser: true } : links
    table.push({ kind: 'global', name: BOX_LINKS_GLOBAL, value })
  })
  if (browser !== undefined) ctx.inject(['connection', 'subprocess'], (ctx) => { serveBrowserFront(ctx, browser) })
}

/**
 * Register the exact route behind Connection's authentication. It declares no `access`, so Connection answers every
 * non-owner Peer 403 before the route runs. Calls run one at a time, so a Chrome one call started is the window the
 * next call finds.
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
