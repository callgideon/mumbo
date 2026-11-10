/** Client half: registers the box links at the sidebar foot and the Desktop and Browser tabs when the page bootstrap carries them. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { BOX_LINKS_GLOBAL, PageLinks } from '../config.ts'
import { BoxLinks } from './BoxLinks.tsx'
import { de, en, es, fr, ja, NS, pt, ru } from './locales.ts'
import { registerViews } from './views.ts'

/** Services the registration needs. */
export const inject = ['slots', 'locale']

/**
 * Validate the links the Host half embedded, then register them beside Settings, and the tabs when a desktop is configured.
 * @param ctx - Client plugin context.
 * @throws when the embedded links fail validation.
 */
export function apply(ctx: Context): void {
  const embedded = (globalThis as Partial<Record<typeof BOX_LINKS_GLOBAL, PageLinks>>)[BOX_LINKS_GLOBAL]
  // A page rendered before the Host row started carries no links; the next page load does.
  if (embedded === undefined) return
  const links = PageLinks(embedded)
  ctx.effect(() => ctx.locale.register(NS, { en, ja, es, fr, de, ru, pt }), 'box-links: dictionaries')
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action', id: 'box-links', locale: NS, inject: () => links,
  }, BoxLinks))
  if (links.desktop !== undefined) registerViews(ctx, links.desktop, links.browser === true)
}
