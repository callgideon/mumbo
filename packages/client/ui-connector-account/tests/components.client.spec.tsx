// @vitest-environment jsdom
/** The slot entries render each registrant's display from the Host with the shared copy, and buttons call the Host callbacks. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { PluginsSubject } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { LocalizedText } from '@deepseek-ai/dsh-package-manifest'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import {
  ConnectorAccountActivationEntry, ConnectorAccountBadgeEntry, ConnectorAccountSectionEntry, ConnectorAccountToastEntry,
} from '../src/client/components.tsx'
import { en } from '../src/client/locales.ts'
import type { ConnectorAccountFace, ConnectorAccountsState } from '../src/client/types.ts'
import type { ConnectorAccountDisplay, ConnectorAccountEntry, ConnectorOperationId } from '../src/types.ts'

afterEach(cleanup)

const KEY = '@acme/fixture'
const OP = 'op-1' as ConnectorOperationId
const STARTED: RemoteResult<ConnectorOperationId> = { ok: true, value: OP }
const REFUSED: RemoteResult<never> = { ok: false, error: new RemoteError('gateway/internal', 'offline', {}) }
const t = makeTranslate(en)
const resolveText = (text: LocalizedText): string => typeof text === 'string' ? text : text.fr ?? text.en
const button = (name: string) => screen.getByRole('button', { name })
const disabled = (): boolean[] => screen.getAllByRole('button').map(element => (element as HTMLButtonElement).disabled)
const click = async (name: string) => { await act(async () => { fireEvent.click(button(name)) }) }

const DISCONNECTED: ConnectorAccountDisplay = {
  phase: 'disconnected', status: { en: 'Not connected', fr: 'Non connecté' }, badge: 'Non connecté',
  buttons: [{ label: 'Connect demo', command: { kind: 'start', operation: 'connect' }, variant: 'primary' }], notes: [],
}

function entry(display: ConnectorAccountDisplay = DISCONNECTED, extra: Partial<ConnectorAccountEntry> = {}): ConnectorAccountEntry {
  return {
    key: KEY, packageName: KEY, display,
    copy: { title: { en: 'Fixture account', fr: 'Compte de démonstration' }, hint: 'Shared with the terminal.', activation: { title: 'Connect demo', body: 'The plugin is on.', connect: 'Connect demo' } },
    ...extra,
  }
}

function face(change: Partial<ConnectorAccountsState> = {}, accounts: readonly ConnectorAccountEntry[] = [entry()]) {
  const current: ConnectorAccountsState = {
    accounts: new Map(accounts.map(item => [item.key, item])), linked: true, notice: undefined, ...change,
  }
  return {
    useConnectorAccounts: <R,>(selector: (value: ConnectorAccountsState) => R): R => selector(current),
    start: vi.fn<ConnectorAccountFace['start']>(async () => STARTED),
    cancel: vi.fn<ConnectorAccountFace['cancel']>(async () => ({ ok: true, value: undefined })),
    account: KEY, resolveText, follow: vi.fn(), failed: vi.fn(), dismissNotice: vi.fn(), t,
  }
}

const sectionOf = (display: ConnectorAccountDisplay, change: Partial<ConnectorAccountsState> = {}) => face(change, [entry(display)])
const prompt = (props: ReturnType<typeof face>, onDismiss = vi.fn(), onOpenDetails = vi.fn()) =>
  <ConnectorAccountActivationEntry {...props} onDismiss={onDismiss} onOpenDetails={onOpenDetails} />

it('shows the registrant title, status, detail, notes, and hint, and starts each button\'s operation on the Host', async () => {
  const props = sectionOf({
    ...DISCONNECTED, detail: 'Link an app first.',
    notes: [{ text: 'App: cli_a', button: { label: 'Change', command: { kind: 'start', operation: 'link-app' }, variant: 'ghost' } }, { text: 'Plain note' }],
  })
  const { container } = render(<ConnectorAccountSectionEntry {...props} />)
  for (const text of ['Compte de démonstration', 'Non connecté', 'Link an app first.', 'Plain note', 'Shared with the terminal.']) expect(screen.getByText(text)).toBeTruthy()
  expect(container.querySelector('[data-connector-account="disconnected"][data-connector-account-key="@acme/fixture"]')).toBeTruthy()
  await click('Connect demo')
  await click('Change')
  expect(props.start.mock.calls).toEqual([[KEY, 'connect'], [KEY, 'link-app']])
  expect(props.follow.mock.calls).toEqual([[KEY, OP], [KEY, OP]])
})

it('disables the buttons while a call is pending or the Host stream is down', async () => {
  const props = face()
  const answer = Promise.withResolvers<RemoteResult<ConnectorOperationId>>()
  props.start.mockReturnValueOnce(answer.promise)
  render(<ConnectorAccountSectionEntry {...props} />)
  fireEvent.click(button('Connect demo'))
  expect(disabled()).toEqual([true])
  await act(async () => { answer.resolve(STARTED) })
  expect(disabled()).toEqual([false])
  expect(props.failed).not.toHaveBeenCalled()
  cleanup()
  render(<ConnectorAccountSectionEntry {...face({ linked: false })} />)
  expect(disabled()).toEqual([true])
})

it('asks before a button that changes the account outside DSH and starts it only after the user accepts', async () => {
  const props = sectionOf({
    phase: 'connected', status: 'Connected', notes: [],
    buttons: [{ label: 'Sign out', command: { kind: 'start', operation: 'sign-out' }, confirm: { title: 'Sign out of the demo?', body: 'The terminal signs out too.', label: 'Confirm sign-out' } }],
  })
  render(<ConnectorAccountSectionEntry {...props} />)
  fireEvent.click(button('Sign out'))
  expect(screen.getByRole('dialog', { name: 'Sign out of the demo?' })).toBeTruthy()
  expect(screen.getByText('The terminal signs out too.')).toBeTruthy()
  fireEvent.click(button(en['action.cancel']))
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(button('Sign out'))
  await click('Confirm sign-out')
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(props.start.mock.calls).toEqual([[KEY, 'sign-out']])
})

it('disables an open confirmation and the activation prompt\'s Connect while the Host stream is down', () => {
  const display: ConnectorAccountDisplay = {
    phase: 'connected', status: 'Connected', notes: [],
    buttons: [{ label: 'Sign out', command: { kind: 'start', operation: 'sign-out' }, confirm: { title: 'Sign out of the demo?', body: 'The terminal signs out too.', label: 'Confirm sign-out' } }],
  }
  const { rerender } = render(<ConnectorAccountSectionEntry {...sectionOf(display)} />)
  fireEvent.click(button('Sign out'))
  // The stream drops while the confirmation is open.
  const down = sectionOf(display, { linked: false })
  rerender(<ConnectorAccountSectionEntry {...down} />)
  fireEvent.click(button('Confirm sign-out'))
  expect((button('Confirm sign-out') as HTMLButtonElement).disabled).toBe(true)
  expect(down.start).not.toHaveBeenCalled()
  cleanup()
  const offline = sectionOf({ ...DISCONNECTED, connect: { kind: 'start', operation: 'connect' } }, { linked: false })
  render(prompt(offline))
  fireEvent.click(button('Connect demo'))
  expect((button('Connect demo') as HTMLButtonElement).disabled).toBe(true)
  expect(offline.start).not.toHaveBeenCalled()
})

it.each<[string, ConnectorAccountDisplay['failure'], string]>([
  ['the guidance, then its diagnostic items', { text: 'Failed.', details: ['login', 'exit 3', 'internal'] }, 'Failed. Diagnostic: login · exit 3 · internal'],
  ['the guidance alone without diagnostic items', { text: 'Failed.' }, 'Failed.'],
  ['the guidance alone for an empty diagnostic list', { text: 'Failed.', details: [] }, 'Failed.'],
])('reports %s', (_name, failure, expected) => {
  render(<ConnectorAccountSectionEntry {...sectionOf({ ...DISCONNECTED, ...failure === undefined ? {} : { failure } })} />)
  expect(screen.getByRole('alert').textContent).toBe(expected)
})

it('reports a start whose result is a failure or whose call rejected, without following it', async () => {
  const props = face()
  props.start.mockResolvedValueOnce(REFUSED).mockRejectedValueOnce(new Error('Remote method is no longer mounted'))
  render(<ConnectorAccountSectionEntry {...props} />)
  await click('Connect demo')
  expect(props.failed).toHaveBeenCalledOnce()
  expect(disabled()).toEqual([false])
  await click('Connect demo')
  expect(props.failed).toHaveBeenCalledTimes(2)
  expect(props.follow).not.toHaveBeenCalled()
})

it('cancels the operation in progress and opens its authorization page again on request', async () => {
  const windowOpen = vi.spyOn(window, 'open').mockReturnValue(null)
  onTestFinished(() => { windowOpen.mockRestore() })
  const display: ConnectorAccountDisplay = {
    phase: 'connecting', status: 'Waiting for the browser', notes: [],
    buttons: [{ label: 'Open authorization page', command: { kind: 'open' } }, { label: 'Cancel', command: { kind: 'cancel' }, variant: 'ghost' }],
  }
  const props = face({}, [entry(display, { operation: { id: OP, authorizationUrl: 'https://example.com/a' } })])
  render(<ConnectorAccountSectionEntry {...props} />)
  fireEvent.click(button('Open authorization page'))
  expect(windowOpen).toHaveBeenCalledWith('https://example.com/a', '_blank', 'noopener,noreferrer')
  await click('Cancel')
  expect(props.cancel).toHaveBeenCalledWith(KEY, OP)
  expect(props.failed).not.toHaveBeenCalled()
  props.cancel.mockResolvedValueOnce(REFUSED)
  await click('Cancel')
  expect(props.failed).toHaveBeenCalledOnce()
  // A cancel button with no operation in progress calls nothing.
  cleanup()
  const idle = sectionOf(display)
  render(<ConnectorAccountSectionEntry {...idle} />)
  await click('Cancel')
  expect(idle.cancel).not.toHaveBeenCalled()
})

it('renders nothing for a bundle whose account the Host has not listed', () => {
  render(<ConnectorAccountSectionEntry {...face({}, [])} />)
  render(prompt(face({}, [])))
  expect(document.body.textContent).toBe('')
})

it('tags only the enabled bundle that owns an account, with the display\'s tag', () => {
  const pkg = (name: string, enabled = true) => ({ name, installed: true, availability: 'profile', official: false, enabled, rows: [] } as const)
  const page = (name: string, enabled = true): PluginsSubject => ({ kind: 'bundle', pkg: pkg(name, enabled) })
  const row: PluginsSubject = { kind: 'row', pkg: pkg(KEY), row: { rowId: 'fixture', moduleName: '@acme/fixture-row', enabled: true } }
  const tag = (props: ReturnType<typeof face>, subject: PluginsSubject) => <ConnectorAccountBadgeEntry {...props} subject={subject} />
  const { rerender } = render(tag(face(), page(KEY)))
  expect(screen.getByText('Non connecté')).toBeTruthy()
  rerender(tag(face(), row))
  expect(screen.getByText('Non connecté')).toBeTruthy()
  for (const [props, subject] of [
    [face(), page(KEY, false)], [face(), page('@acme/other')], [face(), { kind: 'item', id: 'fixture-item' }],
    [sectionOf({ phase: 'checking', status: 'Checking', buttons: [], notes: [] }), page(KEY)],
  ] as const) {
    rerender(tag(props, subject))
    expect(document.body.textContent).toBe('')
  }
})

it('prompts to connect only while disconnected, waits while checking or connecting, and dismisses itself once settled', () => {
  const onDismiss = vi.fn()
  const at = (phase: ConnectorAccountDisplay['phase']) => prompt(sectionOf({ phase, status: phase, buttons: [], notes: [] }), onDismiss)
  const { rerender } = render(at('checking'))
  // An account still connecting after the bundle is switched on may end disconnected.
  rerender(at('connecting'))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(onDismiss).not.toHaveBeenCalled()
  rerender(at('disconnected'))
  expect(screen.getByRole('dialog', { name: 'Connect demo' })).toBeTruthy()
  expect(screen.getByText('The plugin is on.')).toBeTruthy()
  fireEvent.click(button(en['activation.later']))
  expect(onDismiss).toHaveBeenCalledOnce()
  rerender(at('connected'))
  rerender(at('unavailable'))
  expect(onDismiss).toHaveBeenCalledTimes(3)
})

it('connects from the prompt through the operation the display names, or only opens the page', async () => {
  const onOpenDetails = vi.fn()
  const named = sectionOf({ ...DISCONNECTED, connect: { kind: 'start', operation: 'link-app' } })
  const { rerender } = render(prompt(named, vi.fn(), onOpenDetails))
  await click('Connect demo')
  expect(onOpenDetails).toHaveBeenCalledOnce()
  expect(named.start).toHaveBeenCalledWith(KEY, 'link-app')
  const bare = face()
  rerender(prompt(bare, vi.fn(), onOpenDetails))
  fireEvent.click(button('Connect demo'))
  expect(onOpenDetails).toHaveBeenCalledTimes(2)
  expect(bare.start).not.toHaveBeenCalled()
})

it('starts once for a second click before the first call answers', async () => {
  const props = sectionOf({ ...DISCONNECTED, connect: { kind: 'start', operation: 'connect' } })
  const answer = Promise.withResolvers<RemoteResult<ConnectorOperationId>>()
  props.start.mockReturnValueOnce(answer.promise)
  render(prompt(props))
  fireEvent.click(button('Connect demo'))
  fireEvent.click(button('Connect demo'))
  await act(async () => { answer.resolve(STARTED) })
  expect(props.start).toHaveBeenCalledOnce()
  expect(props.follow).toHaveBeenCalledOnce()
})

it('shows the latest notice with the registrant text or the shared failure copy', () => {
  const toast = (notice: ConnectorAccountsState['notice']) => <ConnectorAccountToastEntry {...face({ notice })} />
  const { rerender } = render(toast(undefined))
  expect(document.body.textContent).toBe('')
  rerender(toast({ seq: 1, kind: 'succeeded', text: { en: 'Connected', fr: 'Démonstration connectée' } }))
  expect(screen.getByText('Démonstration connectée')).toBeTruthy()
  rerender(toast({ seq: 2, kind: 'action-failed' }))
  expect(screen.getByText(en['notice.action-failed'])).toBeTruthy()
})
