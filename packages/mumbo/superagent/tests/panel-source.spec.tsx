// @vitest-environment jsdom
// The Source status and settings.
import { act } from 'react'
import { expect, it, onTestFinished, vi } from 'vitest'
import { en } from '../src/client/locales.ts'
import { usePanel, mount, remount, settle, all, find, tab, click, type, text, field, at } from './fixtures/panel.tsx'
import { server, problemOf, droppedReply } from './fixtures/panel-server.tsx'

usePanel()
it('shows each Source\'s state on the Source status and opens its settings from a setup problem', async () => {
  await mount()
  await click(en['tab.source'])
  expect(document.querySelector('.dt-status-title')?.textContent).toBe(en.statusTitle)
  expect(all('.dt-form > .dt-list > .dt-row .dt-row-name').map(title => title.textContent)).toEqual(['Feishu', 'GitHub'])
  expect(all('.dt-form > .dt-list > .dt-row')[0]!.querySelector('.dt-row-meta')?.textContent).toBe('Arrived in 24 h 12Filtered 2Latest ' + document.querySelector('.dt-row-meta time, .dt-row-meta .dt-lv:last-child .dt-lv-value')?.textContent)
  expect(text()).toContain(en['sourceState.error'])
  expect(text()).toContain('socket closed')
  expect(all('.dt-card')).toHaveLength(0)
  server.setup = { ...server.setup, problem: problemOf('agentCliUnset') }
  await remount()
  await click(en['tab.source'])
  await click(en.sourceOpenSettings)
  expect(tab(en['tab.settings']).getAttribute('aria-selected')).toBe('true')
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(en['settingsGroup.source'])
  expect(all('.dt-card')[1]!.textContent).toContain('Deployment check failed: The agent GitHub CLI is not set.')
})

it('folds more than six chats into a line of their names', async () => {
  const chats = Array.from({ length: 7 }, (_, n) => ({ chatId: n ? `oc_c${n}` : 'oc_team', listen: 'all' as const }))
  server.settings.sources.feishu = { ...server.settings.sources.feishu!, config: { ...server.settings.sources.feishu!.config, chats } }
  await mount()
  await click(en['tab.source'])
  await click(find(en['tab.settings'], '.dt-status-head button'))
  const summary = all('.dt-card')[0]!.querySelector('.dt-rows-summary')!
  expect(summary.textContent).toBe(['team chat', 'oc_c1', 'oc_c2', 'oc_c3', 'oc_c4', 'oc_c5', 'oc_c6'].join(', '))
})

it('rereads the chats the bot has joined on request and says which are new, keeping unsaved edits', async () => {
  await mount()
  await click(en['tab.source'])
  await click(find(en['tab.settings'], '.dt-status-head button'))
  const feishu = () => all('.dt-card')[0]!
  const button = () => [...feishu().querySelectorAll('button')].find(item => item.textContent === 'Refresh chats')!
  await click([...feishu().querySelectorAll('button')].find(item => item.textContent === 'Add')!)
  server.joining = { oc_new: 'new chat' }
  await click(button())
  expect(server.requests.find(request => request.path === 'sources/feishu/labels')).toMatchObject({ method: 'POST' })
  expect(document.querySelector('.dt-toast')?.textContent).toBe('List updated, added: new chat')
  // The row being added stays, and now offers the new chat.
  const pick = feishu().querySelectorAll('.dt-rows-item')[1]!.querySelector<HTMLSelectElement>('select[aria-label="Choose a chat the bot has joined"]')!
  expect([...pick.options].map(option => option.textContent)).toEqual(['Choose a chat the bot has joined', 'another chat', 'new chat'])
  await click(button())
  expect([...document.querySelectorAll('.dt-toast')].at(-1)?.textContent).toBe(en.labelsCurrent)
  server.joinError = 'lark-cli: token expired'
  await click(button())
  expect([...document.querySelectorAll('.dt-toast')].at(-1)?.textContent).toBe('Could not read the list; it stays as it was: lark-cli: token expired')
  expect(button().disabled).toBe(false)
  // Only a field whose key column offers a refresh shows the button.
  expect([...all('.dt-card')[1]!.querySelectorAll('button')].some(item => item.textContent === 'Refresh chats')).toBe(false)
})

it('renders each Source\'s settings from its kind\'s fields and saves one Source against its own revision', async () => {
  await mount()
  await click(en['tab.source'])
  await click(find(en['tab.settings'], '.dt-status-head button'))
  const cards = all('.dt-card')
  expect(cards.map(card => card.querySelector('.dt-row-title')?.firstChild?.textContent)).toEqual(['Feishu', 'GitHub'])
  const feishu = cards[0]!
  expect(feishu.textContent).toContain('Chats')
  await click([...feishu.querySelectorAll('button')].find(button => button.textContent === 'Add')!)
  const rows = feishu.querySelectorAll('.dt-rows-item')
  // A saved chat shows its name; a row being added picks from the joined chats not yet configured.
  expect(rows[0]!.querySelector('.dt-row-label')?.textContent).toBe('team chat')
  expect(rows[0]!.querySelector('select[aria-label="Choose a chat the bot has joined"]')).toBeNull()
  const pick = rows[1]!.querySelector<HTMLSelectElement>('select[aria-label="Choose a chat the bot has joined"]')!
  expect([...pick.options].map(option => option.textContent)).toEqual(['Choose a chat the bot has joined', 'another chat'])
  await type(pick, 'oc_other')
  await type(rows[1]!.querySelector('select[aria-label="Receive"]')!, 'all')
  await click('Direct messages')
  await act(async () => { feishu.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) }); await settle()
  expect(server.requests.find(request => request.path === 'settings/source:feishu')).toMatchObject({ method: 'PUT', body: { revision: 0,
    value: { enabled: true, config: { chats: [{ chatId: 'oc_team', listen: 'mentions' }, { chatId: 'oc_other', listen: 'all' }],
      directMessages: false } } } })
  expect(server.settings.sources.feishu!.config).toMatchObject({ directMessages: false })
  const github = all('.dt-card')[1]!
  await click('Run Source: GitHub')
  server.revisions['source:github'] = 5
  await act(async () => { github.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) }); await settle()
  // Another save changed nothing this draft changed, so the draft moves onto the newer revision and saves from there.
  expect(github.querySelector('.dt-savebar')?.textContent).toContain('Settings changed elsewhere; your changes are merged onto the latest version')
  await act(async () => { github.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) }); await settle()
  expect(server.settings.sources.github).toMatchObject({ enabled: false })
  expect(server.revisions['source:github']).toBe(6)
})

it('shows the account each CLI signs in as, and keeps a saved CLI on screen while dsh-superagent restarts', async () => {
  await mount()
  await click(tab(en['tab.settings']))
  const github = all('.dt-card')[1]!
  expect(github.textContent).toContain('Current account @agent-bot')
  const labels = () => [...github.querySelectorAll('label')].map(label => label.textContent)
  expect(labels()).toEqual(['Repository', 'Agent GitHub CLI'])
  expect(field<HTMLInputElement>('Repository').value).toBe('acme/widgets')
  // A fact describes the saved value, so an edited CLI shows none until it is saved.
  await type(field<HTMLInputElement>('Agent GitHub CLI'), 'gh-other')
  expect(github.textContent).not.toContain('Current account @agent-bot')
  await click(en.discard)
  expect(github.textContent).toContain('Current account @agent-bot')
  await click([...github.querySelectorAll<HTMLElement>('[data-disclosure-row]')].find(row => row.textContent?.includes('Advanced'))!)
  expect(labels()).toEqual(['Repository', 'Agent GitHub CLI', 'Polling interval / seconds', 'Failed polls before reporting an error'])
  expect(all('.dt-card')[0]!.textContent).toContain('Current bot Widgets Bot')
  await type(field<HTMLInputElement>('Agent GitHub CLI'), '/opt/bin/gh-agent')
  expect(github.textContent).toContain('Saving restarts dsh-superagent: 2 running Assignments stop and start again with a recovery note.')
  await act(async () => { github.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) }); await settle()
  expect(server.settings.sources.github!.config).toMatchObject({ cli: '/opt/bin/gh-agent' })
  expect(text()).toContain(en.savedRestarting)
  // The saved value stays, and the card's fields are disabled, until the saved revision returns with the restarted dsh-superagent.
  expect(field<HTMLInputElement>('Agent GitHub CLI').value).toBe('/opt/bin/gh-agent')
  expect(field('Agent GitHub CLI').matches(':disabled')).toBe(true)
  expect(sessionStorage.getItem('dsh-superagent/draft/master/source:github')).toBeNull()
})

it('points a setup problem at the settings that fix it', async () => {
  server.setup = { ...server.setup, problem: problemOf('agentCliUnset'), accounts: null }
  // jsdom has no scrolling; mock scrollIntoView to record which card the link brings into view.
  const scroll = vi.fn()
  Element.prototype.scrollIntoView = scroll
  await mount()
  expect(text()).toContain(en.problemSetup)
  expect(text()).toContain(en['setup.agentCliUnset'])
  // Nothing runs while setup waits, so the Executor says so instead of counting.
  expect(text()).toContain(en.executorWaitingSetup)
  expect(all('.dt-stat').map(stat => stat.textContent)).not.toContain('Executing2 / 3')
  expect(text()).toContain('Fix it on the GitHub card of the Source settings and save to check again')
  await click(find(en.problemSetup, 'button, a, [role="button"]'))
  expect(tab(en['tab.settings']).getAttribute('aria-selected')).toBe('true')
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(en['settingsGroup.source'])
  expect(all('.dt-card')[1]!.textContent).toContain('Deployment check failed: The agent GitHub CLI is not set.')
  expect(scroll.mock.contexts).toContain(all('.dt-card')[1])
  delete (Element.prototype as Partial<Element>).scrollIntoView
  await click(find(en['settingsGroup.deployment'], '.dt-settings-link'))
  expect(text()).toContain('Deployment check failed: The agent GitHub CLI is not set.')
  // After a fix outside dsh-superagent, a check runs setup again.
  await click(en.setupCheck)
  expect(server.requests.filter(request => request.path === 'setup/check')).toEqual([{ path: 'setup/check', method: 'POST' }])
  expect(text()).toContain(en.setupChecking)
  server.setup = { ...server.setup, problem: problemOf('gitTooOld') }
  await remount()
  await click(en['tab.overview'])
  await click(find(en.problemSetup, 'button, a, [role="button"]'))
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(en['settingsGroup.deployment'])
  expect(text()).toContain('Deployment check failed: git does not read the github.com credential configuration dsh-superagent writes')
})

it('shows a failed Feishu bot check as a problem of the Feishu Source only, with a check after a fix outside dsh-superagent', async () => {
  server.setup = { ...server.setup, feishuProblem: problemOf('feishuBotNotReady', { app: 'cli_bot', status: 'missing' }),
    accounts: { ...server.setup.accounts!, feishu: null } }
  await mount()
  expect(text()).toContain(en.problemSetupFeishu)
  expect(text()).not.toContain('Feishu Source failing')
  await click(find(en.problemSetupFeishu, 'button, a, [role="button"]'))
  const feishu = all('.dt-card')[0]!
  expect(feishu.textContent).toContain('Deployment check failed: The bot identity of app cli_bot is missing; configure the app secret with lark-cli.')
  // dsh-superagent runs meanwhile, so checking again asks first: the restart interrupts running Executor Sessions.
  await click([...feishu.querySelectorAll('button')].find(button => button.textContent === 'Check again')!)
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Checking again restarts dsh-superagent: 2 running Assignments stop')
  expect(server.requests.some(request => request.path === 'setup/check')).toBe(false)
  await click(en.confirm)
  expect(server.requests.some(request => request.path === 'setup/check')).toBe(true)
  await click(tab(en['tab.source']))
  // The Source's state carries the problem once, not again as its health.
  expect(all('.dt-form > .dt-list > .dt-row')[0]!.textContent?.match(/app cli_bot is missing/g)).toHaveLength(1)
})

it('leaves Feishu out of a GitHub-only deployment', async () => {
  server.setup = { ...server.setup, accounts: { ...server.setup.accounts!, feishu: null } }
  server.settings = { ...server.settings, sources: { ...server.settings.sources, feishu: { enabled: false, config: {} } } }
  at({ page: 'settings', query: { group: 'prompts' } })
  await mount()
  await click(tab(en.promptViewFull))
  expect([...field<HTMLSelectElement>(en.promptPreviewTarget).options].map(option => option.textContent)).toEqual(['Main Session',
    'Executor Session', 'dsh-superagent-github'])
})

it('shows the Sources waiting for the deployment check, and the problem on the Source that fixes it, with its link', async () => {
  server.setup = { ...server.setup, problem: problemOf('repositoryUnset'), accounts: null }
  await mount()
  await click(en['tab.source'])
  const rows = all('.dt-form > .dt-list > .dt-row')
  // The GitHub Source is where the problem is fixed, so it shows the error; Feishu waits.
  expect(rows.map(row => row.querySelector('.dt-status-text')?.textContent)).toEqual(['Waiting for the deployment check', 'Failing'])
  expect(text()).not.toContain('Waiting for setup')
  expect(rows[1]!.textContent).toContain('Deployment check failed: The GitHub Source names no repository.')
  await click(find(en.sourceOpenSettings, '.dt-row button'))
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(en['settingsGroup.source'])
})

it('shows a Source\'s health by its code, and a diagnostic as reported', async () => {
  server.health = { github: { state: 'error', detail: '3 consecutive failed polls; last: EOF', code: 'pollFailures', values: { count: '3',
    error: 'EOF' } } }
  await mount()
  await click(en['tab.source'])
  const github = all('.dt-form > .dt-list > .dt-row').find(row => row.querySelector('.dt-row-name')?.textContent === 'GitHub')!
  expect(github.textContent).toContain('GitHub Source: 3 consecutive failed polls; last: EOF')
  const feishu = all('.dt-form > .dt-list > .dt-row').find(row => row.querySelector('.dt-row-name')?.textContent === 'Feishu')!
  expect(feishu.querySelector('.dt-mono')?.textContent).toBe('socket closed')
})

it('shows a refused Source save with the output of the tool that failed on its own line', async () => {
  await mount()
  await click(en['tab.source'])
  await click(find(en['tab.settings'], '.dt-status-head button'))
  const feishu = all('.dt-card')[0]!
  await type(field<HTMLInputElement>('Bot lark-cli'), 'lark-broken')
  await act(async () => { feishu.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) }); await settle()
  expect(feishu.querySelector('.dt-savebar [role="alert"]')?.textContent).toBe('The bot lark-cli does not work.\nlark-cli: app secret missing')
})

it('shows a setup problem on its Source card within one read of the settings, which the settings groups share', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  onTestFinished(() => { vi.useRealTimers() })
  at({ page: 'settings', query: { group: 'source' } })
  await mount()
  const card = () => document.getElementById('dt-source-github')!
  expect(card().textContent).not.toContain(en['setup.agentCliUnset'])
  server.setup = { ...server.setup, problem: problemOf('agentCliUnset') }
  // The settings are read every five seconds, as the state is; the Source settings do not read the Source status.
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) }); await settle()
  expect(server.requests.filter(request => request.path === 'settings')).toHaveLength(2)
  expect(server.requests.some(request => request.path === 'sources')).toBe(false)
  expect(card().textContent).toContain(en['setup.agentCliUnset'])
})

it('lists the messages a Source did not send in the last day under it, newest first, with why and where they belong', async () => {
  // Include a drop older than 24h (m0) and one with a missing thread (m1).
  server.dropped = [droppedReply('m3', 1, 'feishu', 'channelGone', { ticket: { id: 't1', title: 'fix regression' } }),
    droppedReply('m2', 3, 'feishu', 'channelIgnored'), droppedReply('m1', 4, 'feishu', 'channelGone', { thread: false }),
    droppedReply('m0', 30, 'feishu', 'channelGone'), droppedReply('g0', 2, 'github', 'channelGone')]
  await mount()
  await click(en['tab.source'])
  const [feishu, github] = all('.dt-form > .dt-list > .dt-row')
  const disclosure = (scope: Element) =>
    [...scope.querySelectorAll<HTMLElement>('[data-disclosure-row]')].find(row => row.textContent?.includes(en.sourceDroppedTitle))!
  await click(disclosure(feishu!))
  const rows = [...feishu!.querySelectorAll('.dt-disclosure-body .dt-row')].map(row => [row.querySelector('.dt-row-title')?.textContent,
    row.querySelector('.dt-tag')?.textContent, row.querySelector('button')?.textContent])
  expect(rows).toEqual([['Reply m3', en['reason.channelGone'], 'fix regression'],
    ['Reply m2', en['reason.channelIgnored'], en['term.thread']], ['Reply m1', en['reason.channelGone'], undefined]])
  expect(github!.textContent).toContain(`${en.sourceDroppedTitle} 1`)
  await click(find('fix regression', '.dt-disclosure-body button'))
  expect(tab(en['tab.execution']).getAttribute('aria-selected')).toBe('true')
  await remount()
  await click(en['tab.source'])
  await click(disclosure(document.body))
  // A Feishu Channel names its chat; the link opens the Thread of the message it answers, which the host found.
  await click(find(en['term.thread'], '.dt-disclosure-body button'))
  expect(server.requests.some(request => request.path.startsWith('threads/feishu:oc_1:om_root'))).toBe(true)
  expect(text()).not.toContain(en.threadNotFound)
})

it('takes no space for messages that were all sent', async () => {
  await mount()
  await click(en['tab.source'])
  expect(text()).not.toContain(en.sourceDroppedTitle)
})

it('reads the settings again as soon as dsh-superagent answers after a save restarted it', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  onTestFinished(() => { vi.useRealTimers() })
  at({ page: 'settings', query: { group: 'source' } })
  await mount()
  await type(field<HTMLInputElement>('Agent GitHub CLI'), '/opt/bin/gh-agent')
  const github = all('.dt-card')[1]!
  await act(async () => { github.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) }); await settle()
  expect(field('Agent GitHub CLI').matches(':disabled')).toBe(true)
  // dsh-superagent restarts: DSH answers with empty 404s, then it answers again.
  server.down = true
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) }); await settle()
  server.down = false
  const reads = server.requests.filter(request => request.path === 'settings').length
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) }); await settle()
  expect(server.requests.filter(request => request.path === 'settings').length).toBeGreaterThan(reads)
  expect(field('Agent GitHub CLI').matches(':disabled')).toBe(false)
  expect(field<HTMLInputElement>('Agent GitHub CLI').value).toBe('/opt/bin/gh-agent')
})
