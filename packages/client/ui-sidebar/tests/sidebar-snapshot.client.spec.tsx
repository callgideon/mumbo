// @vitest-environment jsdom
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
/**
 * Local DOM snapshots of the sidebar shell through the real assembly path:
 * SlotTestRuntime mounts the package apply on its own fiber, the auto frame
 * supplies the layout's owner share at the render site, and the snapshot
 * captures exactly the 'sidebar' slot's output (CSS-module class names
 * folded to their semantic locals by the runtime's serializer). The child
 * holes (sidebar.workspaces / sidebar.settings) have no registrant here, so
 * the snapshots pin the shell chrome itself.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, waitFor } from '@testing-library/react'
import { SlotTestRuntime, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { IconPluginPinwheelOutlineRegular, IconSparkleRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { de } from '../src/client/locales.ts'

// The service reads its initial locale from the browser; these specs assert
// the shipped English copy, so they state the browser they assume.
usePinnedBrowserLanguages('en-US')

beforeEach(() => {
  vi.stubEnv('DSH_CLIENT_COMMIT_HASH', 'abc1234')
  vi.stubEnv('DSH_CLIENT_GIT_DIRTY', 'true')
  vi.stubEnv('DSH_CLIENT_VERSION', '1.2.3-rc.4')
})

afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
})

/**
 * Boot the package over the slot test runtime with the English copy the
 * installed face backs the entry's standard `t` seat with.
 */
async function bench() {
  const runtime = await SlotTestRuntime.create()
  runtime.ctx.provide('shortcuts', { catalog: createSnapshotStore([]) } as never)
  runtime.ctx.provide('layout', { toggleSidebar: vi.fn() })
  runtime.ctx.provide('uiWorkspace', { startSession: vi.fn(), openSession: vi.fn(), newSessionAccess: createSnapshotStore(true) } as never)
  const locale = new LocaleRuntime(runtime.ctx)
  locale.register('common', { en: commonEn })
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  await runtime.declare({ 'sidebar': { kind: 'single', scope: 'root' } })
  await runtime.mount({ inject: [...inject], apply })
  return { runtime, locale }
}

describe('sidebar shell snapshots', () => {
  it('renders the expanded column (wordmark, capsule, empty holes)', async () => {
    const { runtime } = await bench()
    const slot = runtime.renderSlot('sidebar', { collapsed: false, width: 300, drawer: false })
    // Wordmark + capsule both start a session in the expanded state.
    expect(slot.view.getAllByRole('button', { name: 'New session' })).toHaveLength(2)
    expect(slot.container).toMatchSnapshot()
    await runtime.dispose()
  })

  it('renders the collapsed rail after the crossfade settles, in place', async () => {
    const { runtime } = await bench()
    const slot = runtime.renderSlot('sidebar', { collapsed: false, width: 300, drawer: false })
    const shell = slot.container.firstElementChild
    slot.update({ collapsed: true, width: 56, drawer: false })
    // The wide content (wordmark shortcut) unmounts at the 150ms settle;
    // only the rail's capsule remains a New-session button.
    await waitFor(() => {
      expect(slot.view.getAllByRole('button', { name: 'New session' })).toHaveLength(1)
    })
    expect(slot.container).toMatchSnapshot()
    // Same tree position: the owner flip re-rendered the shell in place.
    expect(slot.container.firstElementChild).toBe(shell)
    await runtime.dispose()
  })

  it('a locale switch refreshes mounted copy without re-registration', async () => {
    const { runtime, locale } = await bench()
    locale.addLanguage({ id: 'de', label: 'Deutsch', fallback: 'en' })
    locale.setLocale('de')
    const slot = runtime.renderSlot('sidebar', { collapsed: false, width: 300, drawer: false })
    expect(slot.view.getAllByRole('button', { name: de['session.new.label'] })).toHaveLength(2)
    // Same fiber, same registration: setLocale alone re-renders the outlet.
    act(() => { locale.setLocale('en') })
    expect(slot.view.getAllByRole('button', { name: 'New session' })).toHaveLength(2)
    expect(slot.view.queryByRole('button', { name: de['session.new.label'] })).toBeNull()
    await runtime.dispose()
  })

  it('renders Windows caption controls in expanded and collapsed states', async () => {
    document.documentElement.setAttribute('data-windows-titlebar', '')
    const { runtime } = await bench()
    try {
      const slot = runtime.renderSlot('sidebar', { collapsed: false, width: 300, drawer: false })
      expect(slot.container).toMatchSnapshot('windows expanded')
      slot.update({ collapsed: true, width: 0, drawer: false })
      expect(slot.view.getAllByRole('button', { name: 'New session' })).toHaveLength(1)
      expect(slot.container).toMatchSnapshot('windows collapsed')
    } finally {
      await runtime.dispose()
      document.documentElement.removeAttribute('data-windows-titlebar')
    }
  })

  it('renders a Session row above Plugins, selected while its Session is open, in the column, the rail, and the drawer', async () => {
    const { runtime } = await bench()
    const mumbo = await runtime.sessions.add({ id: 'mumbo' })
    runtime.sessions.retain(mumbo, { source: 'mainView' })
    await runtime.mount({
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', function* () {
          yield ctx.slots.register({ name: 'sidebar.panellist', id: 'plugins', order: 0, label: 'Plugins' },
            ({ size }: PropsRuntime<'sidebar.panellist'>) => <IconPluginPinwheelOutlineRegular size={size} />)
          yield ctx.slots.register({ name: 'sidebar.panellist', id: 'mumbo', order: -10, label: 'Mumbo', session: mumbo },
            ({ size }: PropsRuntime<'sidebar.panellist'>) => <IconSparkleRegular size={size} />)
        })
      },
    })
    const slot = runtime.renderSlot('sidebar', { collapsed: false, width: 300, drawer: false })
    expect(slot.view.getByRole('button', { name: 'Mumbo' }).getAttribute('aria-current')).toBe('page')
    expect(slot.view.getByRole('navigation')).toMatchSnapshot('session row expanded')
    slot.update({ collapsed: true, width: 56, drawer: false })
    await waitFor(() => { expect(slot.view.getByRole('button', { name: 'Mumbo' }).textContent).toBe('') })
    expect(slot.view.getByRole('navigation')).toMatchSnapshot('session row rail')
    slot.update({ collapsed: false, width: 300, drawer: true })
    expect(slot.view.getByRole('button', { name: 'Mumbo' }).textContent).toBe('Mumbo')
    expect(slot.view.getByRole('navigation')).toMatchSnapshot('session row drawer')
    await runtime.dispose()
  })
})
