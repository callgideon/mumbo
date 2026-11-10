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

/** The Host's answer to one request. */
type Host = (url: string, init?: RequestInit) => Promise<Response>

/** Mount the right Sidebar and this plugin for one on-screen Session, with `fetch` answering the Host calls. */
async function mount(links: unknown, host: Host = async () => new Response(null, { status: 204 })) {
  vi.stubGlobal(BOX_LINKS_GLOBAL, links)
  const fetch = vi.fn((url: string, init?: RequestInit) => host(url, init))
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
    async () => new Response('wmctrl -x -a failed (exit 1): Cannot open display.', { status: 500 }),
    async () => { throw new TypeError('Failed to fetch') },
    async () => new Response(null, { status: 403 }),
    async () => new Response(null, { status: 204 }),
  ]
  const h = await mount({ home: HOME, desktop: DESKTOP, browser: true }, () => answers.shift()!())
  h.open(BROWSER_KIND)
  const alert = await h.view.findByRole('alert')
  expect(alert.textContent).toContain('Chrome could not be brought to the front: wmctrl -x -a failed (exit 1): Cannot open display.')
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

it('aborts the Host call when the tab hides, and ignores the answer that arrives later', async () => {
  const late = Promise.withResolvers<Response>()
  const answers = [() => late.promise, async () => new Response(null, { status: 204 })]
  const h = await mount({ home: HOME, desktop: DESKTOP, browser: true }, () => answers.shift()!())
  h.open(BROWSER_KIND)
  await waitFor(() => { expect(h.fetch).toHaveBeenCalledTimes(1) })
  const signal = h.fetch.mock.calls[0]![1]!.signal!
  expect(signal.aborted).toBe(false)
  // A collapsed panel keeps the body mounted but hidden, so a late answer could still reach its state.
  act(() => { h.controller.toggleExpanded() })
  expect(signal.aborted).toBe(true)
  await act(async () => { late.resolve(new Response('wmctrl -x -a failed (exit 1): Cannot open display.', { status: 500 })) })
  expect(h.container.querySelector('[role="alert"]')).toBeNull()
  act(() => { h.controller.toggleExpanded() })
  await waitFor(() => { expect(h.fetch).toHaveBeenCalledTimes(2) })
  expect(h.fetch.mock.calls[1]![1]!.signal!.aborted).toBe(false)
  expect(h.container.querySelector('[role="alert"]')).toBeNull()
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

const TAKEOVER_ROUTE = 'api/box-links.browser-takeover'
const OWNER = { home: HOME, desktop: DESKTOP, browser: true, takeover: true }

/**
 * A Host whose Chrome call succeeds and whose take-over route gives the queued answers in order: a JSON state, a
 * Response, a promise of one, or a function that makes the answer when the request arrives.
 */
function takeoverHost(answers: Array<{ takenOver: boolean; failure?: string } | Response | Promise<Response> | (() => Promise<Response>)>) {
  const requests: string[] = []
  const host: Host = async (url, init) => {
    if (url !== TAKEOVER_ROUTE) return new Response(null, { status: 204 })
    requests.push(typeof init?.body === 'string' ? init.body : 'GET')
    const next = answers.shift()!
    if (typeof next === 'function') return next()
    if (next instanceof Response || next instanceof Promise) return next
    return Response.json(next, { status: next.failure === undefined ? 200 : 500 })
  }
  return { host, requests }
}

it('says who has the browser each time the Browser tab shows, and takes it over and hands it back', async () => {
  const taking = Promise.withResolvers<Response>()
  const { host, requests } = takeoverHost([{ takenOver: false }, taking.promise, ...[false, false, true].map(takenOver => ({ takenOver }))])
  const h = await mount(OWNER, host)
  const browser = h.open(BROWSER_KIND)
  const status = await h.view.findByRole('status')
  expect(status.textContent).toContain('Mumbo can use this browser. Take over to sign in or type something private.')
  fireEvent.click(h.view.getByRole('button', { name: 'Take over' }))
  expect(h.view.getByRole('button', { name: 'Taking over…' })).toHaveProperty('disabled', true)
  await act(async () => { taking.resolve(Response.json({ takenOver: true })) })
  expect(h.view.getByRole('status').textContent).toContain('You have the browser. Mumbo can\'t see or use it until you hand it back.')
  expect(h.frames()).toHaveLength(1)
  fireEvent.click(h.view.getByRole('button', { name: 'Hand back' }))
  expect(h.view.getByRole('button', { name: 'Handing back…' })).toHaveProperty('disabled', true)
  await waitFor(() => { expect(h.view.getByRole('button', { name: 'Take over' })).toHaveProperty('disabled', false) })
  // Showing the tab again reads the state again, here changed from another device.
  h.open('guide')
  act(() => { h.controller.focus(browser.id) })
  await waitFor(() => { expect(requests).toHaveLength(4) })
  h.open(DESKTOP_KIND)
  act(() => { h.controller.focus(browser.id) })
  await waitFor(() => { expect(h.view.getByRole('status').textContent).toContain('You have the browser.') })
  expect(requests).toEqual(['GET', '{"takenOver":true}', '{"takenOver":false}', 'GET', 'GET'])
  expect(h.fetch.mock.calls.filter(([url]) => url === TAKEOVER_ROUTE).map(([, init]) => init?.method)).toEqual([undefined, 'POST', 'POST', undefined, undefined])
})

it('warns while a take over did not finish, and reports a failed hand back and a route it cannot reach', async () => {
  const unfinished = 'a browser connection did not close: browser_close failed: timed out'
  const { host, requests } = takeoverHost([
    { takenOver: true, failure: unfinished }, { takenOver: true }, { takenOver: true, failure: 'EISDIR' },
    () => Promise.reject(new TypeError('Failed to fetch')),
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- a rejection that is not an Error still reaches the person.
    () => Promise.reject('offline'),
    new Response('Forbidden', { status: 403 }), new Response(null, { status: 404 }), { takenOver: false },
  ])
  const h = await mount(OWNER, host)
  const browser = h.open(BROWSER_KIND)
  const warning = await h.view.findByRole('alert')
  expect(warning.textContent).toContain(`Mumbo can't use the browser, but taking over didn't finish: ${unfinished}. Don't type anything private yet.`)
  expect(h.view.getByRole('button', { name: 'Hand back' })).toBeTruthy()
  fireEvent.click(h.view.getByRole('button', { name: 'Try again' }))
  await waitFor(() => { expect(h.view.getByRole('status').textContent).toContain('You have the browser.') })
  expect(h.view.queryByRole('alert')).toBeNull()
  fireEvent.click(h.view.getByRole('button', { name: 'Hand back' }))
  await waitFor(() => { expect(h.view.getByRole('alert').textContent).toBe('Couldn\'t hand the browser back: EISDIR') })
  expect(h.view.getByRole('status').textContent).toContain('You have the browser.')

  // Each time the tab shows it reads again; a read that gets no state says why and offers a retry.
  h.open('guide')
  act(() => { h.controller.focus(browser.id) })
  await waitFor(() => { expect(h.view.getByRole('alert').textContent).toContain('Couldn\'t check who has the browser: Failed to fetch') })
  fireEvent.click(h.view.getByRole('button', { name: 'Try again' }))
  await waitFor(() => { expect(h.view.getByRole('alert').textContent).toContain('Couldn\'t check who has the browser: offline') })
  fireEvent.click(h.view.getByRole('button', { name: 'Try again' }))
  await waitFor(() => { expect(h.view.getByRole('alert').textContent).toContain('Couldn\'t check who has the browser: Forbidden') })
  fireEvent.click(h.view.getByRole('button', { name: 'Try again' }))
  await waitFor(() => { expect(h.view.getByRole('alert').textContent).toContain('Couldn\'t check who has the browser: HTTP 404') })
  fireEvent.click(h.view.getByRole('button', { name: 'Try again' }))
  await waitFor(() => { expect(h.view.getByRole('button', { name: 'Take over' })).toBeTruthy() })
  expect(requests).toEqual(['GET', '{"takenOver":true}', '{"takenOver":false}', 'GET', 'GET', 'GET', 'GET', 'GET'])
})

it('aborts the read when the tab hides, ignores its late answer, and shows no take-over bar without the route', async () => {
  const late = Promise.withResolvers<Response>()
  const { host } = takeoverHost([late.promise, { takenOver: false }])
  const h = await mount(OWNER, host)
  h.open(BROWSER_KIND)
  await waitFor(() => { expect(h.fetch.mock.calls.filter(([url]) => url === TAKEOVER_ROUTE)).toHaveLength(1) })
  const signal = h.fetch.mock.calls.find(([url]) => url === TAKEOVER_ROUTE)![1]!.signal!
  act(() => { h.controller.toggleExpanded() })
  expect(signal.aborted).toBe(true)
  await act(async () => { late.resolve(Response.json({ takenOver: true })) })
  expect(h.container.querySelector('[role="status"]')).toBeNull()
  act(() => { h.controller.toggleExpanded() })
  await waitFor(() => { expect(h.view.getByRole('status').textContent).toContain('Mumbo can use this browser.') })
  // The Desktop tab, and a Browser tab whose Host serves no take-over route, draw no bar.
  h.open(DESKTOP_KIND)
  expect(h.container.querySelector('[role="status"]')).toBeNull()
  const plain = await mount({ home: HOME, desktop: DESKTOP, browser: true })
  plain.open(BROWSER_KIND)
  await waitFor(() => { expect(plain.calls()).toEqual([[ROUTE, 'POST']]) })
  expect(plain.container.querySelector('[role="status"]')).toBeNull()
})
