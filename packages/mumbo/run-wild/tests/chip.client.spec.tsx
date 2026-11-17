// @vitest-environment jsdom
/** The Run Wild chip: shown only in Run Wild, its menu opens the view or switches to Full access while still in Run Wild. */
import type { Context } from '@deepseek-ai/cordis'
import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { FixtureSession, SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { afterEach, expect, it, vi } from 'vitest'
import { apply, inject, PANEL_ID } from '../src/client/index.ts'
import { RECORD_GLOBAL } from '../src/record-types.ts'

const runtimes = new Set<SlotTestRuntime>()
afterEach(async () => {
  try { for (const runtime of runtimes) await runtime.dispose() }
  finally { runtimes.clear(); cleanup(); vi.unstubAllGlobals() }
})

/** The answer the Host gives a `/permission` command line. */
type Answer = { ok: true; value: { matched: boolean } } | { ok: false; error: { code: string; message: string } } | Error

/** Mount the Client half and render the header actions of Session `s1`, whose preset reads `preset`. */
async function bench(preset: string | undefined, answer: Answer = { ok: true, value: { matched: true } }) {
  vi.stubGlobal(RECORD_GLOBAL, { record: true })
  const runtime = await SlotTestRuntime.create()
  runtimes.add(runtime)
  const selected: unknown[] = []
  const commands: string[] = []
  await runtime.mount({
    inject: ['slots'],
    apply(ctx: Context) {
      const locale = new LocaleRuntime(ctx)
      locale.setLocale('en')
      ctx.provide('locale', locale)
      ctx.slots.installLocale(locale)
      ctx.provide('layout', { selectPanel: (id: unknown) => { selected.push(id) } } as never)
      ctx.provide('uiWorkspace', { openSession: () => {} } as never)
    },
  })
  const id = await runtime.sessions.add({
    id: 's1',
    session: {
      command: (line: string) => {
        commands.push(line)
        // The fixture face's command answers the Host's RemoteResult; this Answer is its two arms or a transport failure.
        return (answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)) as never
      },
    },
  })
  const reference = runtime.sessions.retain(id)
  await reference.ready
  const set = async (value: string | undefined) => { await runtime.sessions.setProjection('s1', 'permissions', value === undefined ? undefined : { currentValue: value }) }
  await set(preset)
  await runtime.declare({ 'conversation.session.header.actions': { kind: 'list', scope: 'session' } })
  await runtime.mount({ inject, apply })
  const { view } = runtime.renderSlot('conversation.session.header.actions', {}, { session: reference })
  return { runtime, view, selected, commands, set }
}

const chip = () => screen.queryByRole('button', { name: 'Run Wild: Mumbo acts without asking in this session. Options' })

it('shows only while the Session is in Run Wild, and hides at once on a switch', async () => {
  const { runtime, set } = await bench('run-wild')
  expect(chip()?.textContent).toBe('Run Wild')
  expect(runtime.slots.entries('conversation.session.header.actions').map(entry => [entry.options.id, entry.options.order])).toEqual([['run-wild', -9]])
  await set('danger-full-access')
  expect(chip()).toBeNull()
  await set('run-wild')
  expect(chip()).not.toBeNull()
  await set(undefined)
  expect(chip()).toBeNull()
})

it('opens the view from its menu', async () => {
  const { selected, commands } = await bench('run-wild')
  fireEvent.click(chip()!)
  expect(chip()!.getAttribute('aria-expanded')).toBe('true')
  fireEvent.click(screen.getByRole('menuitem', { name: 'What ran without asking' }))
  expect([selected, commands, chip()!.getAttribute('aria-expanded')]).toEqual([[PANEL_ID], [], 'false'])
})

it('switches to Full access from its menu, which hides it', async () => {
  const { commands, set } = await bench('run-wild')
  fireEvent.click(chip()!)
  await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'Switch to Full access' })) })
  expect(commands).toEqual(['/permission danger-full-access'])
  await set('danger-full-access')
  expect(chip()).toBeNull()
})

it('sends nothing when the Session left Run Wild after the menu opened', async () => {
  const { runtime, commands } = await bench('run-wild')
  fireEvent.click(chip()!)
  // Another tab moved the Session; this page's render has not caught up, but the click re-reads the projection.
  const face = runtime.sessions.binding('s1')!.session
  if (!(face instanceof FixtureSession)) throw new Error('the test runtime binds fixture Sessions')
  face.projections.set('permissions', { currentValue: 'read-only' })
  await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'Switch to Full access' })) })
  expect(commands).toEqual([])
  expect(screen.queryByText('Could not switch to Full access. Try again.')).toBeNull()
})

it.each([
  ['an error answer', { ok: false, error: { code: 'gateway/internal', message: 'boom' } }],
  ['no /permission command', { ok: true, value: { matched: false } }],
  ['a lost connection', new Error('offline')],
] as const)('shows a toast and keeps the chip on %s', async (_name, answer) => {
  const { commands } = await bench('run-wild', answer)
  fireEvent.click(chip()!)
  await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'Switch to Full access' })) })
  expect(commands).toEqual(['/permission danger-full-access'])
  expect(screen.getByText('Could not switch to Full access. Try again.')).toBeTruthy()
  expect(chip()).not.toBeNull()
})

it('removes the failure toast once it has faded', { timeout: 15_000 }, async () => {
  await bench('run-wild', new Error('offline'))
  fireEvent.click(chip()!)
  await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'Switch to Full access' })) })
  expect(screen.getByText('Could not switch to Full access. Try again.')).toBeTruthy()
  // The Toast primitive holds for 3 s and fades for 1 s.
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 4_200)) })
  expect(screen.queryByText('Could not switch to Full access. Try again.')).toBeNull()
})

it('closes its menu on Escape and on an outside click', async () => {
  await bench('run-wild')
  fireEvent.click(chip()!)
  fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
  expect(screen.queryByRole('menu')).toBeNull()
  fireEvent.click(chip()!)
  expect(screen.getByRole('menu')).toBeTruthy()
  fireEvent.pointerDown(document.body)
  expect(screen.queryByRole('menu')).toBeNull()
})
