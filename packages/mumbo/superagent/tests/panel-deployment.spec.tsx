// @vitest-environment jsdom
// The Deployment settings and the Plugin Manager page.
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { PluginConfig } from '../src/client/deployment.tsx'
import { expect, it, onTestFinished, vi } from 'vitest'
import { en } from '../src/client/locales.ts'
import { usePanel, mount, remount, settle, all, find, tab, click, type, text, field, at, translator } from './fixtures/panel.tsx'
import { server, problemOf, fakeForm } from './fixtures/panel-server.tsx'

usePanel()
it('saves this machine\'s settings in the Deployment settings through DSH\'s configuration form, without a restart', async () => {
  const { form: editable, mutations } = fakeForm()
  server.form = editable
  await mount()
  await click(tab(en['tab.settings']))
  await click(find(en['settingsGroup.deployment'], '.dt-settings-link'))
  expect(text()).toContain('/srv/dsh-superagent')
  // Accounts are on the Source settings; the Plugin Manager page, where those are not at hand, shows them here.
  expect(text()).not.toContain('@agent-bot')
  for (const moved of ['repository clone', 'ticket worktree directory', 'blocked commands']) expect(text()).not.toContain(moved)
  expect(text()).toContain(en.deploymentIntro)
  // A limit applies at once, so a draft of one says only that it is unsaved, even while Assignments run.
  await type(field<HTMLInputElement>(en.deploymentContextTimeout), '20000')
  expect(document.querySelector('.dt-savebar')?.textContent).toBe(`${en.draftKept}${en.discard}${en.save}`)
  await click(en.save)
  expect(mutations).toEqual([{ revision: 1, ops: [{ op: 'set', path: ['admissionContextTimeoutMs'], value: 20000 }] }])
  expect(document.querySelector('.dt-toast')?.textContent).toBe(en.saved)
  expect(text()).not.toContain(en.savedRestarting)
  expect(field<HTMLInputElement>(en.deploymentContextTimeout).value).toBe('20000')
})

it('keeps a refused Deployment change as a draft, and shows the settings read-only without a writable form', async () => {
  const refusing = fakeForm(true, false)
  server.form = refusing.form
  at({ page: 'settings', query: { group: 'deployment' } })
  await mount()
  await type(field<HTMLInputElement>(en.deploymentPromptMaxChars), '200000')
  await click(en.save)
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(en.deploymentRefused)
  expect(field<HTMLInputElement>(en.deploymentPromptMaxChars).value).toBe('200000')
  server.form = fakeForm(false).form
  await remount()
  expect(text()).toContain(en.deploymentReadOnly)
  server.form = undefined
  await remount()
  expect(text()).toContain('This DSH version has no configuration forms')
  expect(field<HTMLInputElement>(en.deploymentPromptMaxChars)).toMatchObject({ disabled: true, value: '100000' })
  expect(all('button').some(button => button.textContent === 'Save')).toBe(false)
})

it('merges a Deployment draft into the values another page saved meanwhile, and writes only what it changed', async () => {
  const { form: shared, mutations } = fakeForm()
  server.form = shared
  at({ page: 'settings', query: { group: 'deployment' } })
  await mount()
  await type(field<HTMLInputElement>(en.deploymentContextPages), '20')
  // The Plugin Manager page saves another field of the same entry meanwhile.
  await act(async () => { await shared.mutate([{ op: 'set', path: ['promptMaxChars'], value: 50000 }], 1) })
  expect(text()).toContain('Settings changed elsewhere; your changes are merged onto the latest version')
  expect(field<HTMLInputElement>(en.deploymentPromptMaxChars).value).toBe('50000')
  await click(en.save)
  expect(mutations.at(-1)).toEqual({ revision: 2, ops: [{ op: 'set', path: ['admissionContextMaxPages'], value: 20 }] })
  expect(shared.getSnapshot().value).toMatchObject({ admissionContextMaxPages: 20, promptMaxChars: 50000 })
})

it('renders the Deployment page with the derived accounts in the Plugin Manager, and no summary', async () => {
  let container = document.createElement('div')
  let root = createRoot(container)
  onTestFinished(() => { act(() => { root.unmount() }); container.remove() })
  // Remount from scratch on each render to match Plugin Manager page navigation.
  const render = async (view: 'page' | 'summary') => {
    act(() => { root.unmount() }); container.remove()
    container = document.createElement('div'); document.body.append(container)
    root = createRoot(container)
    const form = server.form
    await act(async () => { root.render(<PluginConfig t={translator(en)} view={view} form={form && { state: form.getSnapshot(),
      mutate: form.mutate }} />) })
    await settle()
  }
  await render('summary')
  expect(container.textContent).toBe('')
  server.form = fakeForm().form
  await render('page')
  for (const fact of ['acme/widgets', '@agent-bot', 'Widgets Bot', 'Accounts are changed in the Source settings of the dsh-superagent panel.']) expect(text()).toContain(fact)
  server.setup = { ...server.setup, problem: problemOf('repositoryUnset'), accounts: null }
  await render('page')
  expect(text()).toContain('Deployment check failed: The GitHub Source names no repository.')
  expect(field<HTMLInputElement>(en.deploymentPromptMaxChars).disabled).toBe(false)
  server.down = true
  await render('page')
  expect(text()).toContain(en.hostNotRunning)
})

it('tells a dsh-superagent that is starting from a browser that cannot write on the Deployment page', async () => {
  const { form: shared, publish } = fakeForm()
  server.form = shared
  at({ page: 'settings', query: { group: 'deployment' } })
  await mount()
  const limit = () => field<HTMLInputElement>(en.deploymentPromptMaxChars)
  expect(limit().disabled).toBe(false)
  // While dsh-superagent restarts, DSH stops serving its entry; the values come back editable once it is served again.
  await act(async () => { publish({ status: 'unavailable' }) })
  expect(text()).toContain(en.deploymentUnavailable)
  expect(limit().disabled).toBe(true)
  await act(async () => { publish({ status: 'ready' }) })
  expect(limit().disabled).toBe(false)
  await act(async () => { publish({ status: 'unavailable', writable: false }) })
  expect(text()).toContain(en.deploymentReadOnly)
})

it('reads the state every second after a setup check, until dsh-superagent stopped answering and answers again', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  onTestFinished(() => { vi.useRealTimers() })
  server.setup = { ...server.setup, problem: problemOf('agentCliUnset'), accounts: null }
  at({ page: 'settings', query: { group: 'deployment' } })
  await mount()
  await click(en.setupCheck)
  const second = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(1000) }); await settle() }
  server.down = true
  await second()
  expect(text()).toContain(en['setup.agentCliUnset'])
  server.down = false
  server.setup = { ...server.setup, problem: null }
  await second()
  expect(text()).not.toContain(en['setup.agentCliUnset'])
  // Once it answers, the state is read every five seconds again.
  const reads = server.requests.filter(request => request.path === 'state').length
  await act(async () => { await vi.advanceTimersByTimeAsync(3000) }); await settle()
  expect(server.requests.filter(request => request.path === 'state')).toHaveLength(reads)
})

it('ends a restart that never stopped answering after half a minute, and reads the state every five seconds again', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  onTestFinished(() => { vi.useRealTimers() })
  server.setup = { ...server.setup, problem: problemOf('agentCliUnset'), accounts: null }
  at({ page: 'settings', query: { group: 'deployment' } })
  await mount()
  await click(en.setupCheck)
  const reads = () => server.requests.filter(request => request.path === 'state').length
  const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }); await settle() }
  const before = reads()
  await advance(10_000)
  expect(reads() - before).toBeGreaterThanOrEqual(8)
  // The restart ends at 30 s; the state is read at once, then every five seconds.
  await advance(21_000)
  const ended = reads()
  await advance(3_000)
  expect(reads()).toBe(ended)
  await advance(2_000)
  expect(reads()).toBe(ended + 1)
})
