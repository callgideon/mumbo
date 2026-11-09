// @vitest-environment jsdom
// The Eval status and settings.
import { act } from 'react'
import { expect, it } from 'vitest'
import { en } from '../src/client/locales.ts'
import { usePanel, mount, remount, settle, all, find, tab, click, type, text, field } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.tsx'

usePanel()
it('opens the Decisions under Policy from the flow line with their reasons, Decisions that start work first, filterable by kind',
  async () => {
  await mount()
  await click(all('.dt-stat button')[1]!)
  expect(tab(en['tab.eval']).getAttribute('aria-selected')).toBe('true')
  expect(server.requests.some(request => request.path === 'decisions?limit=30&kind=accept,reopen&window=24h')).toBe(true)
  expect(text()).toContain(en['reason.explicitRouted'])
  await click(en['decisionFilter.stop'])
  expect(server.requests.some(request => request.path === 'decisions?limit=30&kind=stop&window=24h')).toBe(true)
  expect(text()).toContain('@bot fix it')
  await click(en['decisionFilter.ignore'])
  expect(server.requests.some(request => request.path === 'decisions?limit=30&kind=ignore&window=24h')).toBe(true)
  expect(text()).toContain(en.none)
  await click(en.lastDayOnly)
  expect(server.requests.some(request => request.path === 'decisions?limit=30&kind=ignore')).toBe(true)
})

it('keeps a Policy draft across remounts, and merges another save into it sender by sender and rule by rule', async () => {
  const addUser = async () => {
    await click(all('.dt-part button').find(button => button.textContent === 'Add')!)
    const row = all('.dt-part .dt-rows-item').at(-1)!
    await type(row.querySelector<HTMLInputElement>('input[aria-label="open_id"]')!,
      'ou_newperson'); await type(row.querySelector<HTMLInputElement>('input[aria-label="Name"]')!, 'newcomer')
  }
  await mount()
  await click(en['tab.eval'])
  await click(find(en['tab.settings'], '.dt-status-head button'))
  expect(all('.dt-subtab').map(tab => tab.textContent)).toEqual(['Feishu', 'GitHub'])
  await addUser()
  expect(text()).toContain(en.draftKept)
  await remount()
  expect(text()).toContain(en.draftRestored)
  expect(all('.dt-part .dt-rows-item')).toHaveLength(2)
  // Someone else renames a rule and allows another sender meanwhile: the draft keeps its own sender and takes both of theirs.
  const { policy } = server.settings
  server.settings = { ...server.settings, policy: { ...policy, rules: [{ ...policy.rules[0]!, name: 'wording' }],
    sources: { ...policy.sources, feishu: { ...policy.sources.feishu!, allowed: [...policy.sources.feishu!.allowed, { id: 'ou_bob',
      name: 'Bob' }] } } } }
  server.revisions.policy = 4
  await click(en.save)
  expect(text()).toContain(en.saveMerged)
  await type(all('.dt-part input[aria-label="Name"]').at(-2) as HTMLInputElement, 'new colleague')
  expect(text()).not.toContain(en.saveMerged)
  await click(en.save)
  expect(server.settings.policy.sources.feishu!.allowed).toEqual([{ id: 'ou_alice', name: 'Alice' }, { id: 'ou_newperson', name: 'new colleague' },
    { id: 'ou_bob', name: 'Bob' }])
  expect(server.settings.policy.rules.map(rule => rule.name)).toEqual(['wording'])
  expect(sessionStorage.getItem('dsh-superagent/draft/master/policy')).toBeNull()
})

it('keeps the Policy to its rules and each Source\'s part, in that Source\'s own identities', async () => {
  await mount()
  await click(tab(en['tab.settings']))
  await click(find(en['term.eval'], '.dt-settings-link'))
  // Auto-merge and its threshold are prompt text, and no Source's settings sit in the Policy core.
  for (const gone of ['Auto-merge', 'Line threshold', 'Members', 'Part of the Policy version']) expect(text()).not.toContain(gone)
  expect(all('.dt-lv').map(item => item.textContent)[0]).toBe('Policy version abcdef12')
  expect(text()).toContain('Someone on the list who mentions the bot or messages it directly always makes an explicit request')
  await click(find(en['source.github'], '.dt-subtab'))
  expect(text()).toContain('GitHub accounts that may originate work')
  expect(text()).toContain('An account on the list mentions the agent\'s account in an Issue or a comment.')
  // A saved account shows as its id; only a row being added is a field.
  expect(all('.dt-part .dt-rows-item .dt-row-label').map(label => label.textContent)).toEqual(['alice'])
})

it('opens the rule list for an invalid field inside it only', async () => {
  await mount()
  await click(en['tab.eval'])
  await click(find(en['tab.settings'], '.dt-status-head button'))
  const openRows = () => all('.dt-disclosure[data-open]').length
  await act(async () => { field(en.evalTimeout).dispatchEvent(new Event('invalid', { bubbles: false })) })
  expect(openRows()).toBe(0)
  await click(all('.dt-rule [data-disclosure-row]')[0]!)
  await act(async () => { all('.dt-rule input')[0]!.dispatchEvent(new Event('invalid')) })
  expect(openRows()).toBe(all('.dt-rule').length)
})

it('syncs a Source\'s list from where the Source keeps it, but not while a Policy draft is unsaved', async () => {
  await mount()
  await click(en['tab.eval'])
  await click(find(en['tab.settings'], '.dt-status-head button'))
  expect([...all('.dt-part select')[0]!.querySelectorAll('option')].map(option => option.textContent)).toEqual(['Do not sync', 'another chat', 'team chat'])
  await click(find('Sync now', '.dt-part button'))
  expect(server.requests.some(request => request.path === 'policy-sync/feishu' && request.method === 'POST')).toBe(true)
  await type(all('.dt-part select')[0] as HTMLSelectElement, 'oc_other')
  const before = server.requests.length
  await click(find('Sync now', '.dt-part button'))
  expect(document.querySelector('.dt-toast')?.textContent).toBe(en.syncNeedsSave)
  expect(server.requests.slice(before).some(request => request.path.startsWith('policy-sync'))).toBe(false)
})

it('adds, copies, renames, disables and deletes rules in Policy without touching Eval', async () => {
  await mount()
  await click(en['tab.eval'])
  await click(find(en['tab.settings'], '.dt-status-head button'))
  await click(en.addRule)
  await type(field<HTMLInputElement>(en.ruleName), 'Docs')
  await type(field<HTMLTextAreaElement>(en.ruleInstruction), 'fix the broken link')
  await click(en.duplicate)
  expect(all('.dt-rule').map(rule => rule.querySelector('[data-disclosure-row]')!.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('Docs copy')]))
  await click('Enable rule: wording change')
  const removeButtons = all('button').filter(button => button.textContent === 'Delete')
  await click(removeButtons.at(-1)!)
  await click(en.save)
  expect(server.settings.policy.rules.map(rule => [rule.name, rule.enabled])).toEqual([['wording change', false], ['Docs', true]])
  expect(server.requests.filter(request => request.method === 'PUT').map(request => request.path)).toEqual(['settings/policy'])
})

it('shows the current Policy version once, explains what makes it up, and opens a Mandate\'s version in the Policy history', async () => {
  await mount()
  await click(en['tab.eval'])
  await click(find(en['tab.settings'], '.dt-status-head button'))
  await settle()
  expect(all('.dt-lv')[0]!.textContent).toBe('Policy version abcdef12')
  expect(all('.dt-info').map(tip => tip.getAttribute('aria-label')).join('\n')).toContain('The rules, the Policy on each Source and the accept mode of Eval make up the Policy version')
  expect(all('.dt-tag').filter(tag => tag.textContent === 'Part of the Policy version')).toHaveLength(0)
  await click(tab(en['tab.execution']))
  await click('fix regression')
  await click('abcdef12')
  expect(tab(en['tab.settings']).getAttribute('aria-selected')).toBe('true')
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(en['term.eval'])
  await settle()
  // The history opens at the save that made the version, and lists versions that Source saves made too.
  expect(document.querySelector('.dt-highlight')?.textContent).toContain('New Policy version abcdef12')
  expect(text()).toContain('New Policy version 98765432')
})

it('sets the Feishu admission table per receiving scope, offering only the cells a scope can receive, and warns when anyone may originate work', async () => {
  server.settings = { ...server.settings, sources: { ...server.settings.sources, feishu: { enabled: true, config: { cli: 'lark-bot',
    chats: [{ chatId: 'oc_team', listen: 'all' }, { chatId: 'oc_other', listen: 'mentions' }], directMessages: true,
      otherChats: 'none' } } } }
  await mount()
  await click(tab(en['tab.settings']))
  await click(find(en['term.eval'], '.dt-settings-link'))
  const rows = all('.dt-admission tbody tr').map(row => [row.querySelector('.dt-admission-scope')!.firstChild?.textContent,
    row.querySelectorAll('select').length])
  // Chats receiving every message have all three cells; @-only chats only the mention cell; other chats nothing while not received.
  expect(rows).toEqual([['team chat', 3], ['another chat', 1], ['Other chats', 0], ['Direct messages', 1]])
  const cell = field<HTMLSelectElement>('team chat · Not on the list · addresses the agent')
  expect(cell.value).toBe('ignore')
  await type(cell, 'explicit')
  // The warning is an icon in a slot every cell reserves, with the text on hover, so the table does not move.
  expect(document.querySelector('.dt-admission .dt-info-warn')?.getAttribute('aria-label')).toBe(en.admissionAnyoneWarning)
  expect(all('.dt-admission-slot')).toHaveLength(5)
  // A message not addressed to the bot cannot be an explicit request.
  expect([...field<HTMLSelectElement>('team chat · Not on the list · no mention').options].map(option => option.value)).toEqual(['inferred', 'ignore'])
  await click(en.save)
  expect(server.settings.policy.sources.feishu!.admission).toEqual({ oc_team: { unlistedAddressed: 'explicit' } })
})

it('lists each Source\'s bots next to its people and saves them, and sets the GitHub admission table by its receiving scopes', async () => {
  await mount()
  await click(tab(en['tab.settings']))
  // The GitHub Source receives only what is addressed to the agent until a switch opens a scope of the repository.
  const github = all('.dt-card').find(card => card.querySelector('.dt-card-title')?.textContent === 'GitHub')!
  expect([...github.querySelectorAll('.dt-switch-row')].map(row => row.textContent)).toEqual(['Receive new Issues in the repository', 'Receive new pull requests in the repository',
    'Receive comments in the repository', 'Receive the default branch\'s CI'])
  expect([...github.querySelectorAll('[role="switch"]')].slice(1).map(item => item.getAttribute('aria-checked'))).toEqual(['false', 'false',
    'false', 'false'])
  await click(find(en['term.eval'], '.dt-settings-link'))
  const lists = () => all('.dt-part > .dt-field .dt-subhead .dt-field-head').map(head => head.firstChild?.textContent)
  const list = (label: string) => all('.dt-part > .dt-field').find(item => item.textContent?.startsWith(label))!
  const add = async (label: string) => {
    await click([...list(label).querySelectorAll('button')].find(button => button.textContent === en.addRow)!)
    return [...list(label).querySelectorAll('.dt-rows-item')].at(-1)!
  }
  expect(lists()).toEqual(['Feishu users who may originate work', 'Bots whose messages may become candidates'])
  const bot = await add('Bots whose messages may become candidates')
  await type(bot.querySelector<HTMLInputElement>('input[aria-label="App ID or open_id"]')!, 'cli_reviewer')
  await type(bot.querySelector<HTMLInputElement>('input[aria-label="Name"]')!, 'review-bot')
  await click(find(en['source.github'], '.dt-subtab'))
  expect(lists()).toEqual(['GitHub accounts that may originate work', 'Bots whose comments may become candidates'])
  await type((await add('Bots whose comments may become candidates')).querySelector<HTMLInputElement>('input[aria-label="Account"]')!, 'dependabot[bot]')
  // Until the GitHub Source receives the repository's Issues, pull requests, comments or CI, only messages that mention the agent arrive.
  const rows = () => all('.dt-admission tbody tr').map(row => [row.querySelector('.dt-admission-scope')!.firstChild?.textContent,
    row.querySelector('.dt-admission-scope small')?.textContent, row.querySelectorAll('select').length])
  expect(rows()).toEqual([['New Issues', '@ only', 1], ['New pull requests', '@ only', 1], ['Comments', '@ only', 1], ['Default branch CI', 'Not received', 0]])
  expect(field<HTMLSelectElement>('New Issues · Not on the list · addresses the agent').value).toBe('ignore')
  await click(en.save)
  expect(server.settings.policy.sources.feishu!.bots).toEqual([{ id: 'cli_reviewer', name: 'review-bot' }])
  expect(server.settings.policy.sources.github!.bots).toEqual([{ id: 'dependabot[bot]' }])
})

it('shows the GitHub Source\'s switches for what it receives across the repository, and the admission rows they open, in English', async () => {
  server.settings.sources.github = { ...server.settings.sources.github!, config: { ...server.settings.sources.github!.config,
    observeIssues: true, observeCi: true } }
  await mount(en)
  await click(tab(en['tab.settings']))
  const github = all('.dt-card').find(card => card.querySelector('.dt-card-title')?.textContent === 'GitHub')!
  expect([...github.querySelectorAll('.dt-switch-row')].map(row => [row.textContent, row.querySelector('[role="switch"]')
    ?.getAttribute('aria-checked')])).toEqual([['Receive new Issues in the repository', 'true'],
    ['Receive new pull requests in the repository', 'false'], ['Receive comments in the repository', 'false'],
    ['Receive the default branch\'s CI', 'true']])
  await click(find('Receive comments in the repository', '[role="switch"]'))
  await act(async () => { github.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) }); await settle()
  expect(server.settings.sources.github!.config).toMatchObject({ observeIssues: true, observeComments: true, observeCi: true })
  await click(find(en['term.eval'], '.dt-settings-link'))
  await click(find(en['source.github'], '.dt-subtab'))
  const rows = all('.dt-admission tbody tr').map(row => [row.querySelector('.dt-admission-scope')!.firstChild?.textContent,
    row.querySelectorAll('select').length])
  expect(rows).toEqual([['New Issues', 3], ['New pull requests', 1], ['Comments', 3], ['Default branch CI', 1]])
  // CI has no sender: its one cell is that of a message off the list that does not mention the agent.
  expect(field('Default branch CI · Not on the list · no mention')).toBeTruthy()
  expect(all('.dt-admission thead th').map(cell => cell.textContent)).toContain(en.admissionAddressed)
})
