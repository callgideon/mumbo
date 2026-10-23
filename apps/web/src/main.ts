/** Browser entry for the Web client. */
import '@deepseek-ai/dsh-client-ui-theme/brand-font.css'
import { AppWebEntry, applyIndexInjections } from '@deepseek-ai/dsh-client-web'

interface DesktopBootGlobal {
  dshDesktopBoot?: {
    failed(message: string): Promise<void>
    ready(): Promise<{ injections: Parameters<typeof applyIndexInjections>[0]; streamBaseUrl: string }>
  }
}
// iOS shows the on-screen keyboard over the layout viewport and shrinks only the
// visual one; base.css sizes #root to this height on touch screens so the
// composer stays above the keyboard instead of being scrolled out of view.
const visual = globalThis.visualViewport
if (visual !== null) {
  const fitVisualViewport = (): void => {
    document.documentElement.style.setProperty('--dsh-visual-height', `${visual.height}px`)
    if (window.scrollY !== 0) window.scrollTo(0, 0)
  }
  visual.addEventListener('resize', fitVisualViewport)
  fitVisualViewport()
}

const desktop = (globalThis as DesktopBootGlobal).dshDesktopBoot
const reportFailure = (reason: unknown): void => {
  if (desktop === undefined) throw reason
  void desktop.failed(reason instanceof Error ? reason.message : String(reason)).catch(console.error)
}

try {
  const el = document.getElementById('root')
  if (el === null) throw new Error('web app: missing #root')
  const entry = new AppWebEntry(el)
  if (desktop !== undefined) {
    const gate = (globalThis as { __DSH_BOOT_READY__?: PromiseWithResolvers<void> }).__DSH_BOOT_READY__
    if (gate === undefined) throw new Error('desktop web: boot readiness is missing')
    void desktop.ready().then(async ({ injections, streamBaseUrl }) => {
      const transport = globalThis as { __DSH_TRANSPORT__?: { ownsHost: boolean; streamBaseUrl: string } }
      transport.__DSH_TRANSPORT__ = { ownsHost: true, streamBaseUrl }
      await applyIndexInjections(injections, src => new Promise<void>((resolve, reject) => {
        const script = document.createElement('script')
        script.src = src
        script.onload = () => { resolve() }
        script.onerror = () => { reject(new Error(`desktop web: failed to load ${src}`)) }
        document.head.append(script)
      }))
      gate.resolve()
    }).catch((error: unknown) => { gate.reject(error) })
  }
  void entry.run(desktop === undefined ? undefined : reportFailure)
} catch (reason) {
  reportFailure(reason)
}
