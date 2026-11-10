// @vitest-environment jsdom
/** The Desktop and Browser tabs through the real right Sidebar: registry bands, the live view, and the Host call. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { apply as applyMenus, inject as injectMenus } from '@deepseek-ai/dsh-client-ui-context-menu/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as applySidebar, inject as injectSidebar } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { apply, inject } from '../src/client/index.ts'
import { BROWSER_ID, BROWSER_KIND, DESKTOP_ID, DESKTOP_KIND } from '../src/client/views.ts'
import { BOX_LINKS_GLOBAL } from '../src/config.ts'

const SESSION = 's-box' as SessionId
const HOME = 'https://boxes.example/home'
const DESKTOP = 'https://boxes.example/desktop/'
const ROUTE = 'api/box-links.browser-front'

const runtimes: SlotTestRuntime[] = []
let getAnimations: PropertyDescriptor | undefined

beforeEach(() => {
  // jsdom has no Web Animations; the Sidebar reads its panel transitions through this method.
  getAnimations = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations')
  Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, writable: true, value: () => [] })
})

afterEach(async () => {
  try { for (const runtime of runtimes.splice(0)) await runtime.dispose() }
  finally {
    cleanup()
    vi.unstubAllGlobals()
    if (getAnimations === undefined) Reflect.deleteProperty(Element.prototype, 'getAnimations')
    else Object.defineProperty(Element.prototype, 'getAnimations', getAnimations)
  }
})

/** Mount the right Sidebar and this plugin for one on-screen Session, with `fetch` answering the Host call. */
async function mount(links: unknown, host: () => Promise<Response> = async () => new Response(null, { status: 204 })) {
  vi.stubGlobal(BOX_LINKS_GLOBAL, links)
  const fetch = vi.fn((_url: string, _init?: RequestInit) => host())
  vi.stubGlobal('fetch', fetch)
  const runtime = await SlotTestRuntime.create()
  runtimes.push(runtime)
  runtime.ctx.provide('layout', { openRightbar: vi.fn(), closeRightbar: vi.fn(), panelInfo: runtime.panelInfo } as never)
  runtime.ctx.provide('resources', { pin: vi.fn() } as never)
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.ctx.provide('shortcuts', { register: () => () => {}, catalog: createSnapshotStore([]) } as never)
  runtime.slots.installLocale(locale)
  await runtime.mount({ inject: [...injectMenus], apply: applyMenus })
  await runtime.declare({
    'rightbar': { kind: 'single', scope: 'root' },
    'shell.overlay': { kind: 'list', scope: 'root' },
    'conversation.session.header.corner': { kind: 'single', scope: 'session' },
    'sidebar.footer.action': { kind: 'list', scope: 'root' },
  })
  await runtime.sessions.add({ id: SESSION })
  runtime.sessions.retainFor(runtime.ctx, SESSION, { source: 'mainView' })
  await runtime.mount({ inject: [...injectSidebar], apply: applySidebar })
  const plugin = await runtime.mount({ inject, apply })
  const { container, view } = runtime.renderSlot('rightbar', { width: 420, viewportWidth: 1440, canShow: true })
  const controller = runtime.ctx.sidebarRight
  const open = (kind: string) => {
    act(() => { controller.openTab(kind) })
    return controller.active()!
  }
  const frames = () => [...container.querySelectorAll('iframe')]
  const calls = () => fetch.mock.calls.map(([url, init]) => [url, init?.method])
  return { runtime, plugin, container, view, controller, tabs: runtime.ctx.sidebarRightTabs, open, frames, fetch, calls }
}

it('registers the Desktop and Browser kinds in the builtin band after Terminal, and removes them on unload', async () => {
  const h = await mount({ home: HOME, desktop: DESKTOP, browser: true })
  expect(h.tabs.get(DESKTOP_KIND)).toMatchObject({ id: DESKTOP_ID, priority: 'builtin' })
  expect(h.tabs.get(BROWSER_KIND)).toMatchObject({ id: BROWSER_ID, priority: 'builtin' })
  expect(h.tabs.get(DESKTOP_KIND)?.title('')).toBe('Desktop')
  expect(h.tabs.get(BROWSER_KIND)?.title('')).toBe('Browser')
  expect(h.tabs.guide().filter(entry => entry.providerId.startsWith('@mumbo/')).map(entry => [entry.kind, entry.id, entry.order, entry.title(), entry.description?.()]))
    .toEqual([[BROWSER_KIND, 'open', 30, 'Browser', 'Chrome on your box'], [DESKTOP_KIND, 'open', 35, 'Desktop', 'Your box\'s whole desktop']])
  expect(h.runtime.slots.entries('sidebar.right.pane.tab').map(entry => entry.options.key)).toEqual(expect.arrayContaining([DESKTOP_ID, BROWSER_ID]))
  await h.plugin.dispose()
  expect(h.tabs.get(DESKTOP_KIND)).toBeUndefined()
  expect(h.tabs.get(BROWSER_KIND)).toBeUndefined()
  expect(h.runtime.slots.entries('sidebar.right.pane.tab').map(entry => entry.options.key)).not.toEqual(expect.arrayContaining([DESKTOP_ID]))
  expect(h.runtime.slots.entries('sidebar.right.pane.tab').map(entry => entry.options.key)).not.toEqual(expect.arrayContaining([BROWSER_ID]))
})

it.each([
  ['a page that may not call the Host', { home: HOME, desktop: DESKTOP }, [DESKTOP_KIND]],
  ['a box without a desktop', { home: HOME, browser: true }, []],
])('registers only the tabs %s can use', async (_case, links, kinds) => {
  const h = await mount(links)
  expect([DESKTOP_KIND, BROWSER_KIND].filter(kind => h.tabs.get(kind) !== undefined)).toEqual(kinds)
})

it('shows the desktop live view, unsandboxed, only while the Desktop tab shows', async () => {
  const h = await mount({ home: HOME, desktop: DESKTOP, browser: true })
  const desktop = h.open(DESKTOP_KIND)
  const [frame] = h.frames()
  expect(h.frames()).toHaveLength(1)
  expect(frame!.getAttribute('src')).toBe(DESKTOP)
  expect(frame!.hasAttribute('sandbox')).toBe(false)
  expect(frame!.getAttribute('title')).toBe('Live view of your box desktop')
  // Another tab in the pane unmounts the body; collapsing the panel keeps it mounted but drops the frame.
  h.open('guide')
  expect(h.frames()).toEqual([])
  act(() => { h.controller.focus(desktop.id) })
  expect(h.frames()).toHaveLength(1)
  expect(h.frames()[0]).not.toBe(frame)
  act(() => { h.controller.toggleExpanded() })
  expect(h.frames()).toEqual([])
  act(() => { h.controller.toggleExpanded() })
  expect(h.frames()).toHaveLength(1)
  expect(h.fetch).not.toHaveBeenCalled()
})

it('calls the Host once each time the Browser tab shows, beside the same live view', async () => {
  const h = await mount({ home: HOME, desktop: DESKTOP, browser: true })
  const browser = h.open(BROWSER_KIND)
  expect(h.frames().map(frame => frame.getAttribute('src'))).toEqual([DESKTOP])
  await waitFor(() => { expect(h.calls()).toEqual([[ROUTE, 'POST']]) })
  h.open('guide')
  act(() => { h.controller.focus(browser.id) })
  await waitFor(() => { expect(h.calls()).toHaveLength(2) })
  act(() => { h.controller.toggleExpanded() })
  act(() => { h.controller.toggleExpanded() })
  await waitFor(() => { expect(h.calls()).toHaveLength(3) })
  // Opening the Desktop tab in its pane hides the Browser tab; showing it again is one more call.
  h.open(DESKTOP_KIND)
  act(() => { h.controller.focus(browser.id) })
  await waitFor(() => { expect(h.calls()).toHaveLength(4) })
  expect(h.calls()).toEqual(Array.from({ length: 4 }, () => [ROUTE, 'POST']))
})

it('reports a failed call above the live view and calls again on retry', async () => {
  const answers = [
    async () => new Response('xdotool search failed (exit 1): Error: Can\'t open display: :1', { status: 500 }),
    async () => { throw new TypeError('Failed to fetch') },
    async () => new Response(null, { status: 403 }),
    async () => new Response(null, { status: 204 }),
  ]
  const h = await mount({ home: HOME, desktop: DESKTOP, browser: true }, () => answers.shift()!())
  h.open(BROWSER_KIND)
  const alert = await h.view.findByRole('alert')
  expect(alert.textContent).toContain('Chrome could not be brought to the front: xdotool search failed (exit 1): Error: Can\'t open display: :1')
  expect(h.frames()).toHaveLength(1)
  fireEvent.click(h.view.getByRole('button', { name: 'Try again' }))
  await waitFor(() => { expect(h.view.getByRole('alert').textContent).toContain('front: Failed to fetch') })
  fireEvent.click(h.view.getByRole('button', { name: 'Try again' }))
  await waitFor(() => { expect(h.view.getByRole('alert').textContent).toContain('front: HTTP 403') })
  fireEvent.click(h.view.getByRole('button', { name: 'Try again' }))
  await waitFor(() => { expect(h.view.queryByRole('alert')).toBeNull() })
  expect(h.fetch).toHaveBeenCalledTimes(4)
  expect(h.frames()).toHaveLength(1)
})

it('yields the Browser kind to an extension-band registration and falls back to the live view when it leaves', async () => {
  const h = await mount({ home: HOME, desktop: DESKTOP, browser: true })
  h.open(BROWSER_KIND)
  await waitFor(() => { expect(h.fetch).toHaveBeenCalledTimes(1) })
  let leave = (): void => {}
  act(() => {
    const type = h.tabs.register({ id: 'test/local-browser', kind: BROWSER_KIND, priority: 'extension', title: () => 'Local' })
    const body = h.runtime.slots.register({ name: 'sidebar.right.pane.tab', key: 'test/local-browser' }, () => <p data-local-browser />)
    leave = () => { body(); type() }
  })
  expect(h.tabs.get(BROWSER_KIND)?.id).toBe('test/local-browser')
  expect(h.container.querySelector('[data-local-browser]')).not.toBeNull()
  expect(h.frames()).toEqual([])
  act(() => { leave() })
  expect(h.tabs.get(BROWSER_KIND)?.id).toBe(BROWSER_ID)
  expect(h.container.querySelector('[data-local-browser]')).toBeNull()
  expect(h.frames()).toHaveLength(1)
  await waitFor(() => { expect(h.fetch).toHaveBeenCalledTimes(2) })
})
