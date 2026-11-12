// @vitest-environment jsdom
/** Mumbo's entry in the sidebar's navigation band, through the shipped sidebar shell. */
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { IconPluginPinwheelOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { apply as applySidebar, inject as sidebarInject } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { UiWorkspaceRestoration } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { SlotTestRuntime, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject } from '../src/client/index.ts'
import { MUMBO_SESSION_ID } from '../src/session.ts'

usePinnedBrowserLanguages('en-US')

const runtimes = new Set<SlotTestRuntime>()
afterEach(async () => {
  try { for (const runtime of runtimes) await runtime.dispose() } finally { runtimes.clear(); cleanup() }
})

/**
 * A page with the shipped sidebar, a Plugins row at its order 0, and Workspace navigation that retains an opened Session
 * as the main view. Restoration stays `pending`, so the first-load decision opens nothing on its own.
 * @param withPlugin - load `@mumbo/assistant`'s Client half, or leave it out as a project box does.
 * @returns the runtime, the plugin fiber, the rendered sidebar, and the navigation's records.
 */
async function page(withPlugin = true) {
  const runtime = await SlotTestRuntime.create()
  runtimes.add(runtime)
  await runtime.sessions.add({ id: MUMBO_SESSION_ID })
  const hidden: SessionId[] = []
  let main: { release(): void } | undefined
  const uiWorkspace = {
    restoration: createSnapshotStore<UiWorkspaceRestoration>('pending'),
    newSessionAccess: createSnapshotStore(true),
    startSession: vi.fn(),
    openSession: vi.fn((sessionId: SessionId) => {
      main?.release()
      main = runtime.sessions.retain(sessionId, { source: 'mainView' })
      runtime.panelInfo.set({ activePanelId: null })
    }),
    hideSession: vi.fn((sessionId: SessionId) => {
      hidden.push(sessionId)
      return () => { hidden.splice(hidden.indexOf(sessionId), 1) }
    }),
  }
  await runtime.mount({
    inject: ['slots'],
    apply(ctx: Context) {
      const locale = new LocaleRuntime(ctx)
      locale.setLocale('en')
      ctx.effect(() => locale.register('common', { en: commonEn }))
      ctx.provide('locale', locale)
      ctx.slots.installLocale(locale)
      ctx.provide('layout', { toggleSidebar: vi.fn(), selectPanel: vi.fn() } as never)
      ctx.provide('shortcuts', { catalog: createSnapshotStore([]) } as never)
      ctx.provide('uiWorkspace', uiWorkspace as never)
    },
  })
  await runtime.declare({ 'sidebar': { kind: 'single', scope: 'root' } })
  await runtime.mount({ inject: [...sidebarInject], apply: applySidebar })
  await runtime.mount({
    inject: ['slots'],
    apply(ctx: Context) {
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'plugins', order: 0, label: 'Plugins' },
        ({ size }: PropsRuntime<'sidebar.panellist'>) => <IconPluginPinwheelOutlineRegular size={size} />))
    },
  })
  const plugin = withPlugin ? await runtime.mount({ inject, apply }) : undefined
  return { runtime, plugin, uiWorkspace, hidden }
}

it.each([
  ['the wide sidebar', { collapsed: false, width: 300, drawer: false }],
  ['the collapsed rail', { collapsed: true, width: 56, drawer: false }],
  ['the phone drawer', { collapsed: false, width: 300, drawer: true }],
])('shows Mumbo above Plugins in %s, opens the Mumbo Session on a click, and highlights the row', async (_label, owner) => {
  const { runtime, uiWorkspace } = await page()
  const { view } = runtime.renderSlot('sidebar', owner)
  const navigation = await view.findByRole('navigation', { name: 'Global panels' })
  await waitFor(() => {
    expect(within(navigation).getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual(['Mumbo', 'Plugins'])
  })
  const mumbo = within(navigation).getByRole('button', { name: 'Mumbo' })
  expect(mumbo.querySelector('svg')?.getAttribute('data-icon')).toBe('dsw-icon-sparkle-regular')
  expect(mumbo.getAttribute('aria-current')).toBeNull()
  fireEvent.click(mumbo)
  expect(uiWorkspace.openSession).toHaveBeenCalledExactlyOnceWith(MUMBO_SESSION_ID)
  await waitFor(() => { expect(mumbo.getAttribute('aria-current')).toBe('page') })
})

it('hides Mumbo from the Workspace lists while loaded, and removes both contributions on unload', async () => {
  const { runtime, plugin, hidden } = await page()
  const { view } = runtime.renderSlot('sidebar', { collapsed: false, width: 300, drawer: false })
  await view.findByRole('button', { name: 'Mumbo' })
  expect(hidden).toEqual([MUMBO_SESSION_ID])
  await plugin!.dispose()
  await waitFor(() => { expect(view.queryByRole('button', { name: 'Mumbo' })).toBeNull() })
  expect(hidden).toEqual([])
  expect(view.getByRole('button', { name: 'Plugins' })).toBeTruthy()
})

it('shows no Mumbo row in a project box, which does not load the plugin', async () => {
  const { runtime, hidden } = await page(false)
  const { view } = runtime.renderSlot('sidebar', { collapsed: false, width: 300, drawer: false })
  const navigation = await view.findByRole('navigation', { name: 'Global panels' })
  expect(within(navigation).getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual(['Plugins'])
  expect(hidden).toEqual([])
})
