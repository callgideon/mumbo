// @vitest-environment jsdom
// The overview.
import { expect, it } from 'vitest'
import { en } from '../src/client/locales.ts'
import { usePanel, mount, remount, all, find, tab, click, text } from './fixtures/panel.tsx'
import { server, droppedReply, threadSummary } from './fixtures/panel-server.tsx'

usePanel()
it('leads the overview with the pending Tickets, then problems, the last day and the Executor, each linking to its stage', async () => {
  await mount()
  expect(tab(en['tab.overview']).getAttribute('aria-selected')).toBe('true')
  expect(all('[role="tab"]').map(tab => tab.textContent)).toEqual(['Overview', 'Source', 'Trigger', 'Eval', 'Execution', 'Settings'])
  expect(all('.dt-section-title').map(title => title.textContent)).toEqual(['Pending Tickets2', 'System problems2', 'Last 24 hoursDetails ›', 'ExecutorDetails ›'])
  expect(all('.dt-cards .dt-ticket-stage').map(item => item.textContent)).toEqual(['Awaiting answer', 'Failed'])
  expect(all('.dt-cards .dt-att-what').map(item => item.textContent)).toEqual(['Feishu Source failing', 'Eval unavailable: this wording is odd'])
  // Actions sit below the title and Threads, apart from the stage, each with its icon.
  expect(all('.dt-ticket').every(row => row.querySelector('.dt-ticket-stage button, .dt-ticket-stage a') === null
    && [...row.querySelectorAll('.dt-ticket-actions button, .dt-ticket-actions a')].every(action => action.querySelector('svg')))).toBe(true)
  expect(text()).toContain('The Source retries on every poll')
  expect(text()).toContain('need to confirm the button color')
  expect(all('.dt-stat').map(stat => stat.textContent)).toEqual(['Arrived12', 'Filtered2', 'Evaluated5', 'Accepted or continued1', 'Executing2 / 3', 'Queued0', 'Waiting for a Trigger1'])
  expect(all('.dt-chip').map(chip => chip.textContent)[0]).toBe('GitHub#42CI failed1')
  expect(document.querySelector('.dt-chip-problem')?.textContent).toBe('CI failed1')
  expect(document.querySelector<HTMLAnchorElement>('a.dt-chip-link')?.href).toBe('https://github.com/acme/widgets/pull/42')
  await click(all('.dt-more-link').at(-1)!)
  expect(tab(en['tab.execution']).getAttribute('aria-selected')).toBe('true')
})

it('re-evaluates or dismisses an unjudged Eval from the problem list', async () => {
  await mount()
  await click(en.requeue)
  expect(server.requests.some(request => request.path === 'triggers/e3/requeue' && request.method === 'POST')).toBe(true)
  await click(en.dismiss)
  expect(server.requests.some(request => request.path === 'decisions/u1/dismiss' && request.method === 'POST')).toBe(true)
  expect(server.requests.filter(request => request.path === 'overview').length).toBeGreaterThan(2)
})

it('opens the Thread of an unjudged Eval at its Trigger from the problem list', async () => {
  await mount()
  await click('Eval unavailable: this wording is odd')
  expect(server.requests.some(request => request.path.startsWith('threads/feishu:oc_1:om_root'))).toBe(true)
  expect(document.querySelector('.dt-highlight')?.textContent).toContain('message e3')
})

it('follows the last day\'s counts to the status of each stage', async () => {
  await mount()
  // Arrived Triggers include filtered ones, which have no Thread, so no list has that count to link to.
  expect(all('.dt-stat button').map(button => button.textContent)).toEqual(['2', '1'])
  await click(all('.dt-stat button')[0]!)
  expect(tab(en['tab.source']).getAttribute('aria-selected')).toBe('true')
  await click(en.sourceFilteredTitle)
  expect(text()).toContain('looks wrong')
  expect(text()).toContain(en['reason.source_disabled'])
})

it('offers each Ticket that needs a person its actions on the overview: answer in its Channel, retry or open a failed worker, and stop',
  async () => {
  await mount()
  expect(all('.dt-ticket-actions a').map(link => [link.textContent, link.getAttribute('href')])).toEqual([['Answer in Feishu',
    'https://applink.feishu.cn/client/chat/open?openChatId=oc_1']])
  expect(all('.dt-ticket-note').map(note => note.textContent)).toContain('LlmError: no adapter registered for provider "provider-a"')
  await click(en.retry)
  await click(en.confirm)
  expect(server.requests.some(request => request.path === 'tickets/t4/retry' && request.method === 'POST')).toBe(true)
  await click(all('.dt-ticket-actions button').find(button => button.textContent === 'Open Session')!)
  expect(server.opened).toEqual(['worker-t4'])
  await click(all('.dt-ticket-actions button').filter(button => button.textContent === 'Stop').at(-1)!)
  await click(en.confirm)
  expect(server.requests.some(request => request.path === 'tickets/t4/stop' && request.method === 'POST')).toBe(true)
  expect(text()).not.toContain('screenshot tool')
})

it('shows paused processing as a system problem with its resume action, and says so on the Policy records', async () => {
  server.settings = { ...server.settings, paused: true }
  await mount()
  expect(text()).toContain(en.problemPaused)
  await click(en['tab.eval'])
  expect(text()).toContain(en.evalRecordsPaused)
  await click(en.resumeWhere)
  expect(tab(en['tab.execution']).getAttribute('aria-selected')).toBe('true')
  await click(en['tab.overview'])
  await click(find(en.resumeProcessing, '.dt-att button'))
  await click(en.confirm)
  expect(server.requests.find(request => request.path === 'executor/pause')).toMatchObject({ method: 'POST', body: { paused: false } })
})

it('offers the step that fixes a settings problem as a button on the overview', async () => {
  server.settings = { ...server.settings, policy: { ...server.settings.policy, sources: { feishu: { allowed: [], admission: {} },
    github: { allowed: [], admission: {} } } } }
  await mount()
  expect(text()).toContain(en.problemNoAllowed)
  await click(en.actionAddAllowed)
  expect(tab(en['tab.settings']).getAttribute('aria-selected')).toBe('true')
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(en['term.eval'])
})

it('counts the messages not sent in the last day, linking to the Source status, and shows nothing when there are none', async () => {
  await mount()
  expect(all('.dt-stat-label').map(label => label.textContent)).not.toContain(en.flowDroppedLabel)
  server.dropped = [droppedReply('m2', 1, 'feishu', 'channelGone'), droppedReply('m1', 2, 'github', 'channelIgnored'), droppedReply('m0',
    30, 'feishu', 'channelGone')]
  await remount()
  const stat = all('.dt-stat').find(item => item.querySelector('.dt-stat-label')?.textContent === en.flowDroppedLabel)!
  expect(stat.textContent).toBe(`${en.flowDroppedLabel}2`)
  await click(stat.querySelector('button')!)
  expect(tab(en['tab.source'])?.getAttribute('aria-selected')).toBe('true')
})

it('names a failing part of dsh-superagent itself by its label', async () => {
  server.health = { launch: { state: 'error', detail: 'spawn failed' }, relay: { state: 'ready', detail: 'Nothing waiting' } }
  await mount()
  expect(all('.dt-cards .dt-att-what').map(item => item.textContent)).toContain(en.problemRuntime.replace('{name}', en['health.launch']))
  expect(text()).toContain('spawn failed')
})

it('words a refused retry by its code', async () => {
  await mount()
  // Simulate another user retrying the ticket after the overview loaded.
  server.person = server.person.map(ticket => ticket.id === 't4' ? { ...ticket, actions: { ...ticket.actions, retry: false } } : ticket)
  await click(find(en.retry, '.dt-ticket-actions button'))
  await click(en.confirm)
  expect(document.querySelector('.dt-toast')?.textContent).toBe(en['userError.notRetryable'])
})

it('titles the overview sections, stages and flow counts from the dictionary', async () => {
  await mount()
  expect(all('.dt-section-title').map(title => title.textContent)).toEqual([`${en.pendingTickets}2`, `${en.problems}2`,
    `${en.lastDay}${en.details}`, `${en['term.executor']}${en.details}`])
  expect(all('.dt-cards .dt-ticket-stage').map(item => item.textContent)).toEqual([en['stage.answer'], en['stage.failed']])
  expect(all('.dt-stat-label').map(label => label.textContent)).toEqual([en.flowReceivedLabel, en.flowFilteredLabel, en.flowJudgedLabel,
    en.flowAcceptedLabel, en.executingLabel, en.queuedLabel, en.idleLabel])
})

it('lists the unavailable Evals one by one, without the health entry that counts them as a failure of dsh-superagent', async () => {
  server.health.evals = { state: 'error', detail: '1 Eval(s) unavailable in the last hour without a later judgement' }
  await mount()
  expect(all('.dt-cards .dt-att-what').map(item => item.textContent)).toEqual(['Feishu Source failing', 'Eval unavailable: this wording is odd'])
  expect(text()).not.toContain(en['health.evals'])
})

it('says when no Source is on, an Eval is past its deadline or a message keeps failing, each with the way to it', async () => {
  for (const kind of ['feishu', 'github']) server.settings.sources[kind] = { ...server.settings.sources[kind]!, enabled: false }
  server.threads = [threadSummary({ key: 'github:9', title: '#9 long undecided', stage: 'evaluating',
    evaluating: { id: 'v9', triggers: 1, strength: 'inferred', startedAt: '2026-08-31T23:58:00Z', deadline: '2026-09-01T00:00:00Z' } })]
  server.failing = [{ id: 'm1', channel: { source: 'github', thread: 'github:42', address: { number: '42' } },
    text: 'fixed', attempts: 4,
    error: 'HTTP 502 from GitHub' }]
  await mount()
  const titles = () => all('.dt-cards .dt-att-what').map(item => item.textContent)
  // The Feishu Source is off, so its error is no problem any more.
  expect(titles()).toEqual([en.problemNoSource, 'Eval overdue: #9 long undecided', 'Eval unavailable: this wording is odd', 'GitHub reply failing (retried 4 times)'])
  expect(text()).toContain('HTTP 502 from GitHub')
  await click(en.actionOpenSources)
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(en['settingsGroup.source'])
  await click(tab(en['tab.overview']))
  await click('Eval overdue: #9 long undecided')
  expect(server.requests.some(request => request.path.startsWith('threads/github:9'))).toBe(true)
})
