/** Host half: publishes the configured box links in every Web page. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { BOX_LINKS_GLOBAL, Config } from './config.ts'

export { Config } from './config.ts'

/** Cordis function-plugin name. */
export const name = 'mumbo-box-links'

/**
 * Embed the validated links in each page bootstrap, whichever Peer the page speaks for.
 * @param ctx - Host context serving Web pages.
 * @param config - validated links.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'global', name: BOX_LINKS_GLOBAL, value: config })
  })
}
