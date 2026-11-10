/** The Desktop and Browser tab body: the desktop live view, connected only while the tab shows. */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from './locales.ts'
import css from './LiveView.module.css'

/** What the tab's registration injects. */
export interface LiveViewInjected {
  /** Desktop live view URL, on the app's own origin. */
  readonly url: string
  /**
   * Bring Chrome to the front through the owner-only Host call; present only on the Browser tab.
   * @param signal - aborts the call, and with it the Host's command, when the tab hides.
   * @returns the failure detail, or undefined when the Host brought Chrome to the front.
   */
  readonly front?: (signal: AbortSignal) => Promise<string | undefined>
}

/** Props assembled by the right Sidebar's tab seat. */
export type LiveViewProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'boxLinks'> & InjectFace<LiveViewInjected>

/**
 * Render the live view while the tab shows; each time a Browser tab shows, call the Host once to bring Chrome to
 * the front, and abort that call when the tab hides. A failed call shows its detail and a retry above the live view,
 * which stays usable.
 * @param props - tab information, the live view URL, the optional Host call, and copy.
 * @returns the tab body.
 */
export function LiveView({ useTabInfo, url, front, t }: LiveViewProps): ReactNode {
  const { visible } = useTabInfo().tab
  const [attempt, setAttempt] = useState(0)
  const [failure, setFailure] = useState<string>()
  useEffect(() => {
    if (!visible || front === undefined) return
    // Hiding the tab aborts its call, so a call nobody waits for neither raises Chrome later nor holds the Host's queue.
    const call = new AbortController()
    setFailure(undefined)
    void front(call.signal).then((detail) => { if (!call.signal.aborted) setFailure(detail) })
    return () => { call.abort() }
  }, [visible, front, attempt])
  return (
    <section className={css.root}>
      {failure !== undefined && (
        <div className={css.failure} role="alert">
          <span className={css.message}>{t('browser.failed', { detail: failure })}</span>
          <Button variant="outline" size="sm" onClick={() => { setAttempt(value => value + 1) }}>{t('browser.retry')}</Button>
        </div>
      )}
      {/* Same origin as the app, so a sandbox would add nothing; hidden tabs drop the frame and its stream. */}
      {visible && <iframe className={css.frame} src={url} title={t('view')} />}
    </section>
  )
}
