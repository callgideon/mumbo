/** The Desktop and Browser tab body: the desktop live view, connected only while the tab shows. */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { TakeoverState } from '../config.ts'
import type {} from './locales.ts'
import css from './LiveView.module.css'

/** The Host's take-over state, or why it did not arrive. */
export type TakeoverAnswer = TakeoverState | { readonly takenOver?: undefined; readonly failure: string }

/** The Browser tab's calls to the owner-only take-over route. */
export interface TakeoverCalls {
  /**
   * Read whether the person has taken over the browser.
   * @param signal - aborts the read when the tab hides.
   * @returns the Host's state, or why it did not arrive.
   */
  readonly read: (signal: AbortSignal) => Promise<TakeoverAnswer>
  /**
   * Take the browser over or hand it back. The request is not aborted when the tab hides, because the Host finishes
   * the change either way.
   * @param takenOver - true to take over, false to hand back.
   * @returns the Host's state after the change, with its failure, or why no state arrived.
   */
  readonly change: (takenOver: boolean) => Promise<TakeoverAnswer>
}

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
  /** Take-over calls; present only on the owner's Browser tab while the Host serves the take-over route. */
  readonly takeover?: TakeoverCalls
}

/** Props assembled by the right Sidebar's tab seat. */
export type LiveViewProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'boxLinks'> & InjectFace<LiveViewInjected>

/**
 * Render the live view while the tab shows; each time a Browser tab shows, call the Host once to bring Chrome to
 * the front, and abort that call when the tab hides. A failed call shows its detail and a retry above the live view,
 * which stays usable. With take-over calls, a bar above the live view says who has the browser and offers Take over
 * or Hand back.
 * @param props - tab information, the live view URL, the optional Host calls, and copy.
 * @returns the tab body.
 */
export function LiveView({ useTabInfo, url, front, takeover, t }: LiveViewProps): ReactNode {
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
      {takeover !== undefined && <Takeover visible={visible} calls={takeover} t={t} />}
      {/* Same origin as the app, so a sandbox would add nothing; hidden tabs drop the frame and its stream. */}
      {visible && <iframe className={css.frame} src={url} title={t('view')} />}
    </section>
  )
}

/** The take-over bar's props. */
interface TakeoverProps {
  readonly visible: boolean
  readonly calls: TakeoverCalls
  readonly t: LiveViewProps['t']
}

/**
 * Read who has the browser each time the tab shows, and offer Take over or Hand back. While a change runs, both
 * buttons are disabled and the pressed one says what is happening. A take over that did not finish says so, and that
 * the person should not type anything private yet, with a retry and Hand back.
 */
function Takeover({ visible, calls, t }: TakeoverProps): ReactNode {
  /** The Host's last answer and the request that produced it. */
  const [shown, setShown] = useState<{ readonly answer: TakeoverAnswer; readonly request: 'read' | 'take' | 'hand' }>()
  const [pending, setPending] = useState<'take' | 'hand'>()
  const [reads, setReads] = useState(0)
  useEffect(() => {
    if (!visible) return
    const call = new AbortController()
    void calls.read(call.signal).then((answer) => { if (!call.signal.aborted) setShown({ answer, request: 'read' }) })
    return () => { call.abort() }
  }, [visible, calls, reads])
  if (shown === undefined) return null
  const change = (request: 'take' | 'hand'): void => {
    setPending(request)
    void calls.change(request === 'take').then((answer) => {
      setShown({ answer, request })
      setPending(undefined)
    })
  }
  const { answer, request } = shown
  if (answer.takenOver === undefined) {
    return (
      <div className={css.failure} role="alert">
        <span className={css.message}>{t('takeover.unknown', { detail: answer.failure })}</span>
        <Button variant="outline" size="sm" onClick={() => { setReads(value => value + 1) }}>{t('browser.retry')}</Button>
      </div>
    )
  }
  const { takenOver, failure } = answer
  // A failed take over leaves the browser refused to Mumbo but maybe still connected; a failed hand back leaves it taken over.
  const unfinished = takenOver && request !== 'hand' ? failure : undefined
  const notHandedBack = request === 'hand' ? failure : undefined
  const button = (action: 'take' | 'hand', label: string): ReactNode => (
    <Button variant="outline" size="sm" disabled={pending !== undefined} onClick={() => { change(action) }}>{label}</Button>
  )
  if (!takenOver) {
    return (
      <div className={css.bar} role="status">
        <span className={css.message}>{t('takeover.free')}</span>
        {button('take', pending === 'take' ? t('takeover.taking') : t('takeover.take'))}
      </div>
    )
  }
  const handBack = button('hand', pending === 'hand' ? t('takeover.handing') : t('takeover.handBack'))
  if (unfinished !== undefined) {
    return (
      <div className={css.unfinished} role="alert">
        <span className={css.message}>{t('takeover.unfinished', { detail: unfinished })}</span>
        {button('take', pending === 'take' ? t('takeover.taking') : t('browser.retry'))}
        {handBack}
      </div>
    )
  }
  return (
    <>
      {notHandedBack !== undefined && (
        <div className={css.failure} role="alert">
          <span className={css.message}>{t('takeover.notHandedBack', { detail: notHandedBack })}</span>
        </div>
      )}
      <div className={css.held} role="status">
        <span className={css.message}>{t('takeover.held')}</span>
        {handBack}
      </div>
    </>
  )
}
