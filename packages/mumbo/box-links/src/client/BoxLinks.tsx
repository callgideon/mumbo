/** Sidebar-foot links that open the box home page and desktop live view in a new tab. */
import {
  IconGlobeOutlineRegular, IconLayersOutlineRegular, IconRightUpOutlineRegular, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { Config } from '../config.ts'
import type {} from './locales.ts'
import css from './BoxLinks.module.css'

/** Props composed by the sidebar footer-action slot. */
export type BoxLinksProps = PropsRuntime<'sidebar.footer.action'> & InjectFace<Config> & PropsLocale<'boxLinks'>

/**
 * Render one row per configured link: icon and label in the wide sidebar, icon with a tooltip in the rail.
 * @param props - sidebar width, configured links, and translator.
 * @returns the link rows.
 */
export function BoxLinks({ wide, home, desktop, t }: BoxLinksProps) {
  const rows = [
    { id: 'home', url: home, label: t('home'), Icon: IconLayersOutlineRegular },
    ...desktop === undefined ? [] : [{ id: 'desktop', url: desktop, label: t('desktop'), Icon: IconGlobeOutlineRegular }],
  ]
  return (
    <div className={wide ? css.links : `${css.links} ${css.rail}`}>
      {rows.map(({ id, url, label, Icon }) => (
        <Tooltip key={id} label={label} delayMs={500} disabled={wide}>
          {/* A new tab keeps this page's conversation, draft, and connection while the person uses the other page. */}
          <a className={css.link} href={url} target="_blank" rel="noopener noreferrer" aria-label={label}>
            <Icon size={wide ? 16 : 18} />
            {wide && <span className={css.label}>{label}</span>}
            {wide && <IconRightUpOutlineRegular size={12} />}
          </a>
        </Tooltip>
      ))}
    </div>
  )
}
