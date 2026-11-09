// @vitest-environment jsdom
// The Execution status, a Ticket, and the Execution settings.
import { act } from 'react'
import { expect, it } from 'vitest'
import { en } from '../src/client/locales.ts'
import { usePanel, mount, remount, all, find, tab, click, type, text, field, at } from './fixtures/panel.tsx'
import { MEMBER, server, ticketSummary, threadSummary } from './fixtures/panel-server.tsx'

usePanel()
it('lists Tickets under Execution by who they wait on, with the Executor state and its pause as an action', async () => {
  server.tickets.open = [ticketSummary(), ticketSummary({ id: 't2', title: 'working tickets', threads: [{ key: 'github:7',
    source: 'github', title: '#7 x', facts: { number: { value: '#7' }, autoMerge: { label: 'Auto-merge',
      value: 'on' } } }] })]
  await mount()
  await click(en['tab.execution'])
  expect(document.querySelector('.dt-status-title')?.textContent).toBe(en.statusTitle)
  expect(server.requests.some(request => request.path === 'tickets?state=open&limit=20')).toBe(true)
  expect(text()).toContain(en.executorRunning)
  expect(all('.dt-chip').map(chip => chip.textContent)).toContain('GitHub#7Auto-mergeon')
  await click(en.idleLabel)
  expect(server.requests.some(request => request.path === 'tickets?state=idle&limit=20')).toBe(true)
  expect(text()).toContain('The Executor ended its turn')
  await click(en['ticketFilter.ended'])
  expect(text()).toContain('old ticket')
  expect(text()).toContain(en['outcome.stopped'])
  expect(all('.dt-status-line .dt-lv').map(item => item.textContent)).toEqual(['Executing 2 / 3', 'Queued 0'])
  // The pause is its own action: an Execution settings draft started before it still saves.
  await click(find(en['tab.settings'], '.dt-status-head button'))
  expect(tab(en['tab.settings']).getAttribute('aria-selected')).toBe('true')
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(en['promptPart.runtime/work'])
  await type(field<HTMLInputElement>(en.maxWorkers), '4')
  await click(tab(en['tab.execution']))
  await click(en.pauseProcessing)
  await click(en.confirm)
  expect(server.requests.find(request => request.path === 'executor/pause')).toMatchObject({ method: 'POST', body: { paused: true } })
  expect(text()).toContain(en.processingPaused)
  expect(find(en.resumeProcessing).textContent).toBe(en.resumeProcessing)
  await click(tab(en['tab.settings']))
  await click(en.save)
  expect(server.settings).toMatchObject({ paused: true, executor: { maxWorkers: 4 } })
})

it('stops an open Ticket from its page after confirmation', async () => {
  await mount()
  await click('fix regression')
  await click(en.stop)
  expect(server.requests.some(request => request.path.endsWith('/stop'))).toBe(false)
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Stop "fix regression"')
  await click(en.confirm)
  expect(server.requests.some(request => request.path === 'tickets/t1/stop' && request.method === 'POST')).toBe(true)
})

it('shows a Ticket with its stage, its Mandate details with the Trigger and Decision behind it, its Threads, and the rest behind disclosures', async () => {
  await mount()
  await click(all('.dt-open').find(button => button.textContent === 'fix regression')!)
  expect(document.querySelector('.dt-page-title h2')?.textContent).toBe('fix regression')
  // Progress is in the Channels and the Session, so the page has no report section.
  expect(all('.dt-section-title').map(title => title.querySelector('.dt-section-name')?.textContent)).toEqual(['Mandate details', 'Undelivered Inputs', 'Subscribed Threads'])
  expect(document.querySelector('.dt-status-line .dt-stage')?.textContent).toBe(en['stage.working'])
  expect(document.querySelector('.dt-status-line .dt-stage .dt-spinner')).not.toBeNull()
  // A Thread this Ticket follows reads as subscribed on its page, though no other Ticket follows it.
  expect(all('.dt-list .dt-ticket .dt-stage').map(stage => stage.textContent)).toContain(en.threadSubscribed)
  expect(all('.dt-list .dt-ticket .dt-stage').map(stage => stage.textContent)).not.toContain(en.threadUnsubscribed)
  expect(all('.dt-status-line .dt-lv').map(item => item.textContent)).toEqual(['Mandate Explicit', 'From Feishu · Alice', expect.stringMatching(/^Updated /)])
  for (const expected of ['fix the login page regression', 'Addressed byMention', 'Explicit request from someone on the list, accepted by the main Session', 'Undelivered: waiting for the Assignment to run',
    'Alice: change the title too']) expect(text()).toContain(expected)
  expect(all('.dt-chip').map(chip => chip.textContent)).toContain('Feishuteam chat')
  await click(en['term.channel'])
  expect(all('.dt-disclosure-body a').map(link => [link.textContent, link.getAttribute('href')])).toEqual([['Feishu message',
    'https://applink.feishu.cn/client/chat/open?openChatId=oc_1'], ['GitHub #42', 'https://github.com/acme/widgets/issues/42']])
  await click(en['term.environment'])
  expect(all('.dt-disclosure-body .dt-table tr').map(row => row.textContent)).toEqual(['DSH_SUPERAGENT_DIR/w/t1',
    'DSH_SUPERAGENT_GITHUB_NUMBER—'])
  await click(document.querySelector<HTMLElement>('.dt-trigger-link')!)
  expect(tab(en['tab.trigger']).getAttribute('aria-selected')).toBe('true')
})

it('reports a missing Ticket instead of rendering an empty page', async () => {
  at({ page: 'execution', id: 'missing' })
  await mount()
  expect(document.querySelector('.dt-hint')?.textContent).toBe(en.ticketNotFound)
})

it('links a question to its Channel, folds consecutive automated messages among Inputs, and shows field explanations in a hover tooltip',
  async () => {
  const ci = (id: string, at: string, failed: number) => ({ id, kind: 'trigger' as const, triggerId: `c${id}`, at, delivered: true,
    trigger: { id: `c${id}`, actor: { source: 'github', id: '' }, human: false,
      preview: `CI of PR #42 at abc1234: 10 checks, ${failed} failed, 0 running.`, thread: 'github:42' } })
  const t1 = server.ticketDetails.t1!
  server.ticketDetails.t1 = { ...t1, stage: 'person', action: 'answer', attention: { id: 'q1', question: 'need to confirm the button color' }, inputs: [ci('i3',
    '2026-09-22T00:06:00Z', 1), ci('i2', '2026-09-22T00:05:00Z', 0)] }
  await mount()
  await click(all('.dt-open').find(button => button.textContent === 'fix regression')!)
  expect(all('.dt-banner a').map(link => [link.textContent, link.getAttribute('href')])).toEqual([['Answer in Feishu',
    'https://applink.feishu.cn/client/chat/open?openChatId=oc_1']])
  await click('Delivered Inputs · 2')
  expect(all('.dt-disclosure-body .dt-row-title').map(title => title.textContent)).toEqual(['Automated notice: CI of PR #42 at abc1234: 10 checks, 1 failed, 0 running.'])
  await click('1 earlier automated messages from the same sender')
  expect(text()).toContain('CI of PR #42 at abc1234: 10 checks, 0 failed, 0 running.')
  await click(en['tab.eval'])
  await click(find(en['tab.settings'], '.dt-status-head button'))
  expect(text()).not.toContain('When time runs out the Eval is unavailable')
  const tip = field(en.evalTimeout).closest('.dt-field')!.querySelector<HTMLElement>('.dt-info')!
  await act(async () => { tip.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
  expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('When time runs out the Eval is unavailable')
  expect(tip.closest('.dt-field')!.textContent).not.toContain('When time runs out the Eval is unavailable')
  await act(async () => { tip.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })) })
  expect(document.querySelector('[role="tooltip"]')).toBeNull()
})

it('offers a Ticket awaiting review its review place and Session in the page head', async () => {
  const t1 = server.ticketDetails.t1!
  server.ticketDetails.t1 = { ...t1, stage: 'person', action: 'review', threads: [threadSummary(),
    { ...threadSummary({ key: 'github:42', source: 'github', title: '#42 Fix login' }), url: 'https://github.com/acme/widgets/pull/42' }] }
  at({ page: 'execution', id: 't1' })
  await mount()
  expect(document.querySelector('.dt-status-line .dt-stage')?.textContent).toBe(en['stage.review'])
  expect(all('.dt-page-head a').map(link => [link.textContent, link.getAttribute('href')])).toEqual([['Open on GitHub',
    'https://github.com/acme/widgets/pull/42']])
})

it('keeps what a person types in the Execution settings, converting it once on save', async () => {
  await mount()
  await click(en['tab.execution'])
  await click(find(en['tab.settings'], '.dt-status-head button'))
  const blocked = () => field<HTMLInputElement>(en.blockedCommands), root = () => field<HTMLInputElement>(en.executionDirectory),
    workers = () => field<HTMLInputElement>(en.maxWorkers)
  // A separator typed before the next command, a space inside a path and a cleared number stay as typed.
  await type(blocked(), 'gh-personal ')
  expect(blocked().value).toBe('gh-personal ')
  await type(blocked(), 'gh-personal, gh-other')
  await type(root(), '/srv/my work ')
  expect(root().value).toBe('/srv/my work ')
  await type(workers(), '')
  expect(workers().value).toBe('')
  await type(workers(), '2')
  await click(en.save)
  expect(server.requests.find(request => request.path === 'settings/executor')?.body).toMatchObject({ value: { blockedCommands: ['gh-personal', 'gh-other'], directory: '/srv/my work ', maxWorkers: 2 } })
  expect(server.settings.executor).toMatchObject({ blockedCommands: ['gh-personal', 'gh-other'], directory: '/srv/my work', maxWorkers: 2 })
})

it('says why an Input was not delivered on its Ticket\'s page', async () => {
  const t1 = server.ticketDetails.t1!
  server.ticketDetails.t1 = { ...t1, stage: 'person', action: 'delivery', deliveryError: 'feishu: message recalled' }
  at({ page: 'execution', id: 't1' })
  await mount()
  expect(document.querySelector('.dt-status-line .dt-stage')?.textContent).toBe(en['stage.delivery'])
  expect(document.querySelector('.dt-banner.dt-danger')?.textContent).toBe(`${en.deliveryFailedPrefix}feishu: message recalled`)
  expect(text()).toContain(en.inputRetryHint)
  expect(text()).not.toContain(en.inputWaitingHint)
  expect(document.querySelector('.dt-status-line')?.textContent).toMatch(/Sep \d+/)
})

it('tells a Ticket or Thread that does not exist from a dsh-superagent that is not answering', async () => {
  at({ page: 'execution', id: 't9' })
  await mount()
  expect(text()).toContain(en.ticketNotFound)
  // While dsh-superagent restarts, DSH's web server answers every route with an empty 404.
  at({ page: 'execution', id: 't1' })
  server.down = true
  await remount()
  expect(text()).not.toContain(en.ticketNotFound)
  expect(text()).toContain(en.hostNotRunning)
  at({ page: 'trigger', id: 'feishu:oc_1:om_root' })
  await remount()
  expect(text()).not.toContain(en.threadNotFound)
  expect(text()).toContain(en.hostNotRunning)
})

it('gives a Ticket a bot\'s message started its basis, marks a Thread it follows for context, and an Input it handed back', async () => {
  const t1 = server.ticketDetails.t1!
  server.ticketDetails.t1 = { ...t1, mandate: { ...t1.mandate, strength: 'inferred', basis: { via: 'bot', sender: 'review-bot',
    observation: { mode: 'auto' } } },
  basis: { facts: [{ name: 'sender', value: 'review-bot' }, { name: 'bot' }, { name: 'mode', value: 'auto' }], legacy: false },
  threads: [threadSummary(), { ...threadSummary({ key: 'github:7', title: '#7 related Issue' }), context: true }],
  inputs: [{ id: 'i1', kind: 'trigger', triggerId: 'e2', at: '2026-09-22T00:03:00Z', delivered: true, trigger: { id: 'e2',
    actor: { source: 'feishu', id: MEMBER, name: 'Alice' }, human: true, preview: 'and add a page',
    thread: 'feishu:oc_1:om_root', handback: { reason: 'Asks for a new page', at: '2026-09-22T00:05:00Z' } } }] }
  at({ page: 'execution', id: 't1' })
  await mount()
  const facts = () => all('.dt-kv > div').map(row => [row.querySelector('dt')?.textContent, row.querySelector('dd')?.textContent])
  expect(facts()).toEqual(expect.arrayContaining([[en['basis.sender'], 'review-bot'], [en['basis.bot'], en.yes], [en['basis.mode'], en['mode.auto']]]))
  expect(all('.dt-list .dt-ticket').map(row => row.querySelector('.dt-tag')?.textContent)).toEqual([undefined, en.contextOnly])
  await click(en.deliveredInputs.replace('{count}', '1'))
  expect(text()).toContain('Handed back for an Eval: Asks for a new page')
})

it('words an ended Ticket by its outcome, on its row and its page, with a person\'s reason after it', async () => {
  const fields = { id: 't3', title: 'merged ticket', state: 'ended' as const, actions: { retry: false, stop: false },
    ended: { at: '2026-09-21T00:00:00Z', by: 'executor' as const, outcome: 'merged' as const } }
  server.tickets.ended = [ticketSummary(fields, { stage: 'ended' }), ...server.tickets.ended]
  server.ticketDetails.t3 = { ...server.ticketDetails.t1!, ...fields, stage: 'ended' }
  await mount()
  await click(en['tab.execution'])
  await click(en['ticketFilter.ended'])
  expect(all('.dt-ticket-stage').map(stage => stage.textContent)).toEqual([en['outcome.merged'], en['outcome.stopped']])
  await click('merged ticket')
  expect(document.querySelector('.dt-status-line .dt-stage')?.textContent).toBe(en['outcome.merged'])
  expect(text()).toContain(en['outcome.merged'])
  expect(text()).not.toContain('The Executor ended')
  server.ticketDetails.t3 = { ...server.ticketDetails.t3, ended: { at: '2026-09-21T00:00:00Z', by: 'human', outcome: 'stopped',
    reason: 'no longer needed' } }
  await remount()
  expect(all('.dt-hint').map(hint => hint.textContent).find(line => line?.includes(en['outcome.stopped']))).toMatch(/Stopped by a person: no longer needed$/)
})

it('sends one stop for a double click on Confirm', async () => {
  at({ page: 'execution', id: 't1' })
  await mount()
  await click(en.stop)
  const confirm = find(en.confirm)
  await act(async () => { confirm.click(); confirm.click() })
  expect(server.requests.filter(request => request.path === 'tickets/t1/stop')).toHaveLength(1)
})
