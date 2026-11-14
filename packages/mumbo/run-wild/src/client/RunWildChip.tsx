/** The "Run Wild" chip in the header of a Session in Run Wild, with its menu: the view, or back to Full access. */
import { useState } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { Menu, PermissionIconFullAccessRegular, Toast, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the header slot's SlotMap entry and the `permissions` projection's merge.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-permission-presets/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import css from './RunWildChip.module.css'

/** The `permission` row preset name of Run Wild; the client half never imports the Host entry. */
export const RUN_WILD_PRESET = 'run-wild'

/** What leaving Run Wild did: switched, sent nothing because the Session had already left it, or failed. */
export type LeaveOutcome = 'switched' | 'skipped' | 'failed'

/** What the plugin injects. */
export interface RunWildChipInjected {
  /** Show the "What ran without asking" panel. */
  openView: () => void
  /** Switch a Session to Full access, only while it still reads Run Wild when called. */
  leave: (sessionId: SessionId) => Promise<LeaveOutcome>
}

/** Full component props. */
export type RunWildChipProps =
  PropsRuntime<'conversation.session.header.actions'> & PropsLocale<'mumbo.runWild'> & InjectFace<RunWildChipInjected>

const MENU = ['view', 'leave'] as const

/**
 * Render the chip while this Session's `permissions` projection reads Run Wild; nothing for any other preset.
 * @param props - composed slot props.
 * @returns the chip and its menu, or null.
 */
export function RunWildChip({ sessionId, useProjection, openView, leave, t }: RunWildChipProps) {
  const current = useProjection('permissions', selection => selection?.currentValue)
  const [open, setOpen] = useState(false)
  const [failed, setFailed] = useState(0)
  if (current !== RUN_WILD_PRESET) return null
  return (
    <>
      <Menu open={open} onClose={() => { setOpen(false) }} portal align="start"
        items={MENU.map(id => ({ id, label: t(id === 'view' ? 'chip.view' : 'chip.leave') }))}
        onSelect={(id) => {
          setOpen(false)
          if (id === 'view') { openView(); return }
          void leave(sessionId).then((outcome) => { if (outcome === 'failed') setFailed(n => n + 1) })
        }}
        anchor={<Tooltip label={t('chip.label')} side="bottom" portal disabled={open}>
          <button type="button" className={css.chip} aria-label={t('chip.aria')} aria-haspopup="menu" aria-expanded={open}
            onClick={() => { setOpen(value => !value) }}>
            <PermissionIconFullAccessRegular size={14} />
            <span className={css.label}>{t('chip.label')}</span>
          </button>
        </Tooltip>} />
      {failed > 0 && <Toast key={failed} text={t('chip.leaveFailed')} onDone={() => { setFailed(0) }} />}
    </>
  )
}
