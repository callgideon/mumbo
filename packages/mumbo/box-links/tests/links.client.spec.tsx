// @vitest-environment jsdom
/** The sidebar foot shows the configured box links only when the page bootstrap carries them. */
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '../src/client/index.ts'
import { BOX_LINKS_GLOBAL } from '../src/config.ts'

const HOME = 'https://boxes.example/home'
const DESKTOP = 'https://boxes.example/desktop/'

const runtimes = new Set<SlotTestRuntime>()
afterEach(async () => {
  try { for (const runtime of runtimes) await runtime.dispose() }
  finally { runtimes.clear(); cleanup(); vi.unstubAllGlobals() }
})

async function localized(embedded: unknown, language: string) {
  vi.stubGlobal(BOX_LINKS_GLOBAL, embedded)
  const runtime = await SlotTestRuntime.create()
  runtimes.add(runtime)
  await runtime.mount({
    inject: ['slots'],
    apply(ctx: Context) {
      const locale = new LocaleRuntime(ctx)
      locale.setLocale(language)
      ctx.provide('locale', locale)
      ctx.slots.installLocale(locale)
    },
  })
  await runtime.declare({ 'sidebar.footer.action': { kind: 'list', scope: 'root' } })
  return runtime
}

async function bench(embedded: unknown, language = 'en') {
  const runtime = await localized(embedded, language)
  const plugin = await runtime.mount({ inject, apply })
  return { runtime, plugin }
}

it('opens the home page and desktop in a new tab from the wide sidebar', async () => {
  const { runtime } = await bench({ home: HOME, desktop: DESKTOP })
  const { view } = runtime.renderSlot('sidebar.footer.action', { wide: true })
  const links = view.getAllByRole('link')
  expect(links.map(link => [link.textContent, link.getAttribute('href')])).toEqual([['Home', HOME], ['Desktop', DESKTOP]])
  for (const link of links) {
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
  }
})

it('omits the desktop link for a box without a desktop', async () => {
  const { runtime } = await bench({ home: HOME })
  const { view } = runtime.renderSlot('sidebar.footer.action', { wide: true })
  expect(view.getAllByRole('link').map(link => link.textContent)).toEqual(['Home'])
})

it('keeps localized accessible names on the icon-only rail links', async () => {
  const { runtime } = await bench({ home: HOME, desktop: DESKTOP }, 'en')
  const { view } = runtime.renderSlot('sidebar.footer.action', { wide: false })
  const links = view.getAllByRole('link')
  expect(links.map(link => link.getAttribute('aria-label'))).toEqual(['Home', 'Desktop'])
  expect(links.map(link => link.textContent)).toEqual(['', ''])
})

it('registers nothing when the page bootstrap carries no links', async () => {
  const { runtime } = await bench(undefined)
  expect(runtime.slots.entries('sidebar.footer.action')).toEqual([])
  expect(runtime.renderSlot('sidebar.footer.action', { wide: true }).view.queryByRole('link')).toBeNull()
})

it('removes the links when the plugin unloads', async () => {
  const { runtime, plugin } = await bench({ home: HOME })
  const { view } = runtime.renderSlot('sidebar.footer.action', { wide: true })
  expect(view.getByRole('link', { name: 'Home' })).toBeTruthy()
  await plugin.dispose()
  expect(runtime.slots.entries('sidebar.footer.action')).toEqual([])
  expect(view.queryByRole('link')).toBeNull()
})

it.each([
  ['a missing home link', { desktop: DESKTOP }],
  ['a script URL', { home: 'javascript:alert(1)' }],
  ['a relative URL', { home: '/home' }],
])('fails activation for %s', async (_case, embedded) => {
  const runtime = await localized(embedded, 'en')
  await expect(runtime.mount({ inject, apply })).rejects.toThrow(/home/)
  expect(runtime.slots.entries('sidebar.footer.action')).toEqual([])
})
