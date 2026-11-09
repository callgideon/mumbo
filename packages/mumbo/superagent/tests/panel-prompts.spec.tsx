// @vitest-environment jsdom
// The Prompts settings.
import { act } from 'react'
import { builtInBase, builtInParts, defaultPrompts } from '../src/app/prompts.ts'
import { expect, it } from 'vitest'
import { en } from '../src/client/locales.ts'
import { usePanel, mount, settle, all, tab, click, type, text, field, at } from './fixtures/panel.tsx'
import { server, promptVersion } from './fixtures/panel-server.tsx'

usePanel()
it('lists the team sections, then the built-in parts, edits and saves them separately from settings, and resets one section', async () => {
  at({ page: 'settings', query: { group: 'prompts' } })
  await mount()
  const names = all('.dt-prompt-nav .dt-nav-item > span').map(item => item.textContent)
  expect(names.slice(0, 3)).toEqual(['Communication', 'Ticket scope', 'Delivery requirements'])
  expect(names.slice(3)).toEqual(Object.keys(builtInParts()).map(key => en[`promptPart.${key}` as keyof typeof en]))
  await type(field<HTMLTextAreaElement>(en.promptBody), 'Custom communication rule')
  expect(text()).toContain('1 changes')
  await click(tab(en.promptViewFull))
  // The full prompt shows every part, team or built in, as editable, in the order the Session reads them.
  const parts = all('.dt-preview-part').map(part => [part.querySelector('b')?.textContent, part.hasAttribute('data-editable')])
  expect(parts.slice(0, 5)).toEqual([['Shared rules', true], ['Main Session role', true], ['Communication', true], ['Ticket scope', true], ['Delivery requirements', true]])
  expect(text()).toContain('Custom communication rule')
  await click(all('.dt-preview-part').find(part => part.querySelector('b')?.textContent === 'Communication')!.querySelector('button')!)
  await click(en.promptResetSection)
  expect(text()).not.toContain('changed elsewhere')
  await type(field<HTMLTextAreaElement>(en.promptBody), 'Second rule')
  await click(en.save)
  expect(server.prompts.current.config.communication).toBe('Second rule')
  expect(server.requests.some(request => request.path.startsWith('settings/'))).toBe(false)
})

it('keeps a conflicting prompt draft, rebases it onto the newer version and saves on retry', async () => {
  at({ page: 'settings', query: { group: 'prompts' } })
  await mount()
  await type(field<HTMLTextAreaElement>(en.promptBody), 'Mine')
  server.prompts.revision = 1; server.prompts.current = promptVersion(1, { ...defaultPrompts(), scope: 'Theirs' })
  await click(en.save)
  expect(document.querySelector('.dt-savebar')?.textContent).toContain('Prompts changed to version 1. Your draft is kept')
  await click(en.save)
  // The other save's section stays: the draft moved onto version 1 section by section, not as a whole.
  expect(server.prompts.current.config).toMatchObject({ communication: 'Mine', scope: 'Theirs' })
})

it('shows a built-in skill with the CLI notes in the full prompt, editable as a built-in part, and adds a team skill but no skill under a built-in name', async () => {
  at({ page: 'settings', query: { group: 'prompts' } })
  await mount()
  await click(tab(en.promptViewFull))
  await act(async () => { const select = field<HTMLSelectElement>(en.promptPreviewTarget); select.value = 'skill/github'; select.dispatchEvent(new Event('change', { bubbles: true })) }); await settle()
  expect(text()).toContain('## CLI usage')
  expect(all('.dt-preview-part[data-editable] b').map(name => name.textContent)).toEqual([en['promptPart.skill/github']])
  await click(tab(en.promptViewEdit))
  for (const name of ['Bad Name', 'github']) {
    await type(field<HTMLInputElement>(en.promptAddSkill), name)
    await click(en.promptAddSkillAction)
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(en.promptSkillNameInvalid)
  }
  await type(field<HTMLInputElement>(en.promptAddSkill), 'testing')
  await click(en.promptAddSkillAction)
  expect(all('.dt-nav-item').map(item => item.textContent)).toContain('dsh-superagent-testing')
})

it('loads all defaults into the draft from the history without saving them', async () => {
  server.prompts.current = promptVersion(0, { ...defaultPrompts(), scope: 'Old scope' })
  at({ page: 'settings', query: { group: 'prompts' } })
  await mount()
  await click(tab(en.promptViewHistory))
  const first = `Version 0 · ${en.promptHistoryInitial} · ${en['historySource.defaults']}`
  expect(all('.dt-row-title').map(title => title.textContent)).toContain(first)
  await click(en.promptDefaults)
  expect(text()).toContain(en.promptDraftFromDefaults)
  expect(server.requests.some(request => request.path === 'prompts' && request.method === 'PUT')).toBe(false)
})

it('keeps the Prompts save bar hidden while a preview loads for an unchanged draft', async () => {
  at({ page: 'settings', query: { group: 'prompts' } })
  await mount()
  let shown = false
  const watch = new MutationObserver(() => { if (document.querySelector('.dt-savebar')) shown = true })
  watch.observe(document.body, { childList: true, subtree: true })
  await click(tab(en.promptViewFull))
  await settle()
  watch.disconnect()
  expect(shown).toBe(false)
})

it('marks team sections that differ from the defaults, and shows a draft as a diff against the saved version or the defaults', async () => {
  server.prompts.current = promptVersion(1, { ...defaultPrompts(), delivery: `${defaultPrompts().delivery}\nCommit as the bot account.` })
  server.prompts.revision = 1
  at({ page: 'settings', query: { group: 'prompts' } })
  await mount()
  expect(all('.dt-prompt-nav .dt-nav-item').filter(item => item.querySelector('.dt-changed-tag')).map(item => item.querySelector('span')!.firstChild?.textContent)).toEqual(['Delivery requirements'])
  await type(field<HTMLTextAreaElement>(en.promptBody), `${defaultPrompts().communication}\nSign as the agent.`)
  await click(tab(en.promptViewFull))
  // A draft opens against the saved version: only its change shows, and the parts it leaves as they were fold.
  expect(all('.dt-preview-part ins').map(line => line.textContent)).toEqual(['Sign as the agent.\n'])
  expect(all('.dt-preview-part del')).toHaveLength(0)
  expect(text()).toContain(en.promptSameAsSaved)
  await click(en.promptCompareDefault)
  expect(all('.dt-preview-part ins').map(line => line.textContent)).toEqual(['Sign as the agent.\n', 'Commit as the bot account.\n'])
})

it('discards a prompt draft by reading the saved version again', async () => {
  at({ page: 'settings', query: { group: 'prompts' } })
  await mount()
  await type(field<HTMLTextAreaElement>(en.promptBody), 'Mine')
  server.prompts.revision = 1; server.prompts.current = promptVersion(1, { ...defaultPrompts(), communication: 'Theirs' })
  await click(en.discard)
  expect(field<HTMLTextAreaElement>(en.promptBody).value).toBe('Theirs')
  expect(all('.dt-savebar')).toHaveLength(0)
})

const builtInItem = (name: string) => all('.dt-prompt-nav .dt-nav-item').find(item => item.querySelector('span')!.firstChild?.textContent === name)!
it('edits a built-in part as an override of its built-in text, marks it changed, and resets it to the built-in text', async () => {
  at({ page: 'settings', query: { group: 'prompts' } })
  await mount()
  const shared = builtInParts()['runtime/shared']!
  await click(builtInItem(en['promptPart.runtime/shared']))
  expect(field<HTMLTextAreaElement>(en.promptBody).value).toBe(shared.text)
  expect(text()).toContain(en['promptReadBy.both'])
  await type(field<HTMLTextAreaElement>(en.promptBody), 'Shared, the team way.')
  expect(builtInItem(en['promptPart.runtime/shared']).querySelector('.dt-changed-tag')?.textContent).toBe(en.promptChanged)
  await click(en.save)
  // The override records the built-in text it was edited from.
  expect(server.prompts.current.config.overrides).toEqual({ 'runtime/shared': { text: 'Shared, the team way.', base: builtInBase(shared.text) } })
  // The full prompt reads the override in place of the built-in text, compared with the defaults.
  await click(tab(en.promptViewFull))
  expect(all('.dt-preview-part ins').map(line => line.textContent)).toContain('Shared, the team way.\n')
  await click(all('.dt-preview-part[data-editable] button')[0]!)
  await click(en.promptResetSection)
  expect(field<HTMLTextAreaElement>(en.promptBody).value).toBe(shared.text)
  await click(en.save)
  expect(server.prompts.current.config).not.toHaveProperty('overrides')
})

it('says which placeholders a template keeps', async () => {
  at({ page: 'settings', query: { group: 'prompts' } })
  await mount()
  await click(builtInItem(en['promptPart.runtime/policy']))
  expect(text()).toContain('A template: keep the placeholders {version}, {mode}, {rules}, which the system fills in.')
  expect(text()).toContain(en['promptReadBy.orchestrator'])
})

it('marks an override whose built-in text an upgrade changed, shows how it changed, and keeps the team\'s text or takes the new one', async () => {
  const dispatch = builtInParts()['runtime/dispatch']!
  const overrides = { 'runtime/dispatch': { text: '## dispatch\nOur routing.', base: builtInBase('## dispatch\nThe old routing.') } }
  server.prompts.revision = 1; server.prompts.current = promptVersion(1, { ...defaultPrompts(), overrides })
  server.prompts.defaultChanged = [{ part: 'runtime/dispatch', base: overrides['runtime/dispatch'].base, previous: '## dispatch\nThe old routing.' }]
  at({ page: 'settings', query: { group: 'prompts' } })
  await mount()
  expect(all('.dt-prompt-nav .dt-updated-tag').map(tag => tag.closest('.dt-nav-item')!.querySelector('span')!.firstChild?.textContent))
    .toEqual([en['promptPart.runtime/dispatch']])
  await click(builtInItem(en['promptPart.runtime/dispatch']))
  // The change of the built-in text, beside the team's text, which stays, in a region named by the mark.
  const box = () => document.querySelector(`section[aria-label="${en.promptDefaultUpdated}"]`)
  expect(box()!.textContent).toContain('Below is how the default changed.')
  expect([...box()!.querySelectorAll('del')].map(line => line.textContent)).toEqual(['The old routing.\n'])
  expect(box()!.querySelectorAll('ins').length).toBeGreaterThan(0)
  expect(field<HTMLTextAreaElement>(en.promptBody).value).toBe('## dispatch\nOur routing.')
  // Taking the new built-in text drops the override.
  await click(en.promptTakeDefault)
  expect(field<HTMLTextAreaElement>(en.promptBody).value).toBe(dispatch.text)
  expect(all('.dt-default-updated')).toHaveLength(0)
  await click(en.discard)
  await click(builtInItem(en['promptPart.runtime/dispatch']))
  // Keeping the team's text records the new built-in text as the one it was edited from.
  await click(en.promptKeepMine)
  expect(all('.dt-default-updated')).toHaveLength(0)
  await click(en.save)
  expect(server.prompts.current.config.overrides).toEqual({ 'runtime/dispatch': { text: '## dispatch\nOur routing.', base: builtInBase(dispatch.text) } })
})

it('shows the team\'s text against the new default when the default it was edited from is not known, or is another one', async () => {
  const dispatch = builtInParts()['runtime/dispatch']!
  // The override was restored from an older version: its base is not the one the changed default was found for.
  const overrides = { 'runtime/dispatch': { text: '## dispatch\nOur routing.', base: 'restored' } }
  server.prompts.revision = 1; server.prompts.current = promptVersion(1, { ...defaultPrompts(), overrides })
  server.prompts.defaultChanged = [{ part: 'runtime/dispatch', base: 'another', previous: '## dispatch\nThe old routing.' }]
  at({ page: 'settings', query: { group: 'prompts' } })
  await mount()
  await click(builtInItem(en['promptPart.runtime/dispatch']))
  const box = document.querySelector(`section[aria-label="${en.promptDefaultUpdated}"]`)!
  // It says the lines are the team's text against the new default, not how the default changed.
  expect(box.textContent).toContain('The default you edited from was not recorded; below, your text against the new default.')
  expect(box.textContent).not.toContain('Below is how the default changed.')
  expect([...box.querySelectorAll('del')].map(line => line.textContent)).toEqual(['Our routing.\n'])
  expect([...box.querySelectorAll('ins')].map(line => line.textContent).join('')).toBe(`${dispatch.text.split('\n').slice(1).join('\n')}\n`)
})

it('keeps both sides\' first overrides when a draft moves onto a version saved meanwhile', async () => {
  at({ page: 'settings', query: { group: 'prompts' } })
  await mount()
  await click(builtInItem(en['promptPart.runtime/shared']))
  await type(field<HTMLTextAreaElement>(en.promptBody), 'Shared, ours.')
  const theirs = { 'runtime/dispatch': { text: '## dispatch\nTheirs.', base: builtInBase(builtInParts()['runtime/dispatch'].text) } }
  server.prompts.revision = 1; server.prompts.current = promptVersion(1, { ...defaultPrompts(), overrides: theirs })
  await click(en.save)
  expect(document.querySelector('.dt-savebar')?.textContent).not.toContain('undefined')
  await click(en.save)
  expect(server.prompts.current.config.overrides).toEqual({ ...theirs,
    'runtime/shared': { text: 'Shared, ours.', base: builtInBase(builtInParts()['runtime/shared'].text) } })
})

it('shows a draft\'s template of a generated part filled, and names a part by its label when a save is refused', async () => {
  at({ page: 'settings', query: { group: 'prompts' } })
  await mount()
  await click(builtInItem(en['promptPart.runtime/environment']))
  await type(field<HTMLTextAreaElement>(en.promptBody), 'Where you work:\n{variables}')
  await click(tab(en.promptViewFull))
  const environment = all('.dt-preview-part').find(part => part.querySelector('b')?.textContent === en['promptPart.runtime/environment'])!
  expect(environment.querySelector('pre')?.textContent).toBe('Where you work:\n')
  await click(tab(en.promptViewEdit))
  await click(builtInItem(en['promptPart.runtime/policy']))
  await type(field<HTMLTextAreaElement>(en.promptBody), '## Policy\n{version} {mode}')
  await click(en.save)
  expect(text()).toContain(`The “${en['promptPart.runtime/policy']}” template must keep {rules}`)
})

it('lists the overrides of parts this version no longer has, which the next save drops', async () => {
  server.prompts.defaultChanged = [{ part: 'runtime/retired', base: 'b', removed: true }]
  at({ page: 'settings', query: { group: 'prompts' } })
  await mount()
  expect(text()).toContain(en.promptRemovedParts.replace('{parts}', 'runtime/retired'))
})

it('loads a version from the history without its overrides of parts this version no longer has, so it saves', async () => {
  const dispatch = { text: '## dispatch\nOurs.', base: builtInBase(builtInParts()['runtime/dispatch'].text) }
  at({ page: 'settings', query: { group: 'prompts' } })
  await mount()
  await click(tab(en.promptViewHistory))
  // The version restored overrides a part a later version removed.
  const saved = server.prompts.current
  server.prompts.current = promptVersion(0, { ...defaultPrompts(), overrides: { 'runtime/dispatch': dispatch, 'runtime/retired': { text: 'Old.', base: 'b' } } })
  await click(en.promptRestore)
  server.prompts.current = saved
  await click(en.save)
  expect(server.prompts.current.config.overrides).toEqual({ 'runtime/dispatch': dispatch })
})
