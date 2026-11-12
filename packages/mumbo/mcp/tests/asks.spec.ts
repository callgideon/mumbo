import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as McpDoor from '../src/index.ts'
import { call, type FakeAgent, type Host, listTools, message, startHost, stopHosts } from './door-fixture.ts'

afterEach(stopHosts)

interface Listed {
  readonly ask_id: string
  readonly kind: string
  readonly detail: string
  readonly answerable: boolean
}

const PLAN: AskUserQuestionItem = {
  id: 'plan-review',
  header: 'Plan review',
  question: 'Approve this plan and leave plan mode?',
  detail: '# Plan\n\nShip it.',
  options: [{ label: 'Approve' }, { label: 'Keep planning' }],
  intent: { kind: 'plan-review', approve: 'Approve' },
}

/** A host with the plugin loaded with `profile`. */
async function door(profile: McpDoor.Config['profile'] = 'full'): Promise<Host> {
  const host = await startHost()
  await host.ctx.plugin(McpDoor, { ...host.config, profile })
  return host
}

/** Ask for a tool approval that the browser never answers unless `browser` settles. */
function askTool(
  host: Host,
  toolName: string,
  options: { reason?: string; browser?: Promise<ApprovalOutcome>; signal?: AbortSignal; agent?: FakeAgent; callId?: string } = {},
): Promise<ApprovalOutcome> {
  const browser = options.browser ?? new Promise<ApprovalOutcome>(() => {})
  return host.ctx.waterfall('approval/request', {
    agent: options.agent ?? { id: 's1' },
    toolName,
    ...(options.callId === undefined ? {} : { callId: options.callId }),
    ...(options.reason === undefined ? {} : { reason: options.reason }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  } as never, () => browser)
}

/** Ask questions that the browser never answers. */
function askQuestions(host: Host, questions: AskUserQuestionItem[], agent?: { id: string }): Promise<AskUserQuestionAnswer> {
  return host.ctx.waterfall('user-questions/request', {
    questions,
    ...(agent === undefined ? {} : { agent }),
  } as never, () => new Promise<AskUserQuestionAnswer>(() => {}))
}

/** The open asks `needs_you` lists. */
async function needsYou(host: Host): Promise<Listed[]> {
  const reply = await call(host.url, 'needs_you', {})
  expect(reply.isError).toBe(false)
  return (reply.value as { asks: Listed[] }).asks
}

/** The single open ask. */
async function only(host: Host): Promise<Listed> {
  const asks = await needsYou(host)
  expect(asks).toHaveLength(1)
  return asks[0] as Listed
}

/** Matches `text` fenced in an untrusted tag; `text` is a regular expression source. */
const fenced = (text: string): string => expect.stringMatching(new RegExp(`^<(untrusted-[0-9a-f]{16})>\\n${text}\\n</\\1>$`)) as string

describe('tool approvals', () => {
  it('lists each tool ask with its own id and answers approve with allowed-once', async () => {
    const host = await door()
    const outcome = askTool(host, 'shell', { reason: 'run shell' })
    void askTool(host, 'edit')
    const asks = await needsYou(host)
    expect(asks).toEqual([
      { ask_id: expect.any(String) as string, kind: 'tool', session_id: 's1', tool: 'shell', detail: fenced('run shell'), irreversible: false, answerable: true },
      { ask_id: expect.any(String) as string, kind: 'tool', session_id: 's1', tool: 'edit', detail: fenced(''), irreversible: false, answerable: true },
    ])
    expect(asks[0]?.ask_id).not.toBe(asks[1]?.ask_id)
    const reply = await call(host.url, 'task_reply', { ask_id: asks[0]?.ask_id, request_id: 'r1', decision: 'approve' })
    expect(reply).toEqual({ isError: false, value: { ok: true } })
    expect(await outcome).toBe('allowed-once')
    expect((await needsYou(host)).map(ask => ask.ask_id)).toEqual([asks[1]?.ask_id])
  })

  it('lists the call id of a tool ask and the call\'s arguments as the asking Session logged them', async () => {
    const host = await door()
    const agent = host.addAgent('s1')
    message(agent, 'user', { kind: 'user' }, [{ type: 'text', text: 'clean up' }])
    message(agent, 'assistant', { kind: 'model' }, [{ type: 'text', text: 'looking' }])
    message(agent, 'assistant', { kind: 'model' }, [
      { type: 'text', text: 'removing it' },
      { type: 'tool-call', id: 'c1', name: 'shell', arguments: '{"command":"rm -r /srv/example"}' },
    ])
    void askTool(host, 'shell', { agent, callId: 'c1', reason: 'run shell' })
    void askTool(host, 'shell', { agent, callId: 'c9' })
    const tool = { ask_id: expect.any(String) as string, kind: 'tool', session_id: 's1', tool: 'shell', irreversible: false, answerable: true }
    expect(await needsYou(host)).toEqual([
      { ...tool, call_id: 'c1', detail: fenced('run shell'), arguments: fenced('\\{"command":"rm -r /srv/example"\\}') },
      { ...tool, call_id: 'c9', detail: fenced('') },
    ])
  })

  it('answers reject with rejected', async () => {
    const host = await door()
    const outcome = askTool(host, 'shell')
    const { ask_id } = await only(host)
    await call(host.url, 'task_reply', { ask_id, request_id: 'r1', decision: 'reject' })
    expect(await outcome).toBe('rejected')
  })

  it('returns ok for a retried reply without answering twice', async () => {
    const host = await door()
    const outcome = askTool(host, 'shell')
    const { ask_id } = await only(host)
    const args = { ask_id, request_id: 'r1', decision: 'approve' }
    expect(await call(host.url, 'task_reply', args)).toEqual({ isError: false, value: { ok: true } })
    expect(await call(host.url, 'task_reply', args)).toEqual({ isError: false, value: { ok: true } })
    expect(await outcome).toBe('allowed-once')
  })

  it('leaves an irreversible tool to a person in the browser', async () => {
    const host = await door()
    let answer: (outcome: ApprovalOutcome) => void = () => {}
    const outcome = askTool(host, 'deploy', { browser: new Promise((resolve) => { answer = resolve }) })
    const ask = await only(host)
    expect(ask).toMatchObject({ kind: 'tool', tool: 'deploy', irreversible: true, answerable: false })
    const reply = await call(host.url, 'task_reply', { ask_id: ask.ask_id, request_id: 'r1', decision: 'approve' })
    expect(reply).toMatchObject({ isError: true, value: { code: 'needs_person' } })
    expect(await needsYou(host)).toHaveLength(1)
    answer('rejected')
    expect(await outcome).toBe('rejected')
  })

  it('answers not_found once the browser answered first', async () => {
    const host = await door()
    let answer: (outcome: ApprovalOutcome) => void = () => {}
    const outcome = askTool(host, 'shell', { browser: new Promise((resolve) => { answer = resolve }) })
    const { ask_id } = await only(host)
    answer('allowed-once')
    expect(await outcome).toBe('allowed-once')
    const reply = await call(host.url, 'task_reply', { ask_id, request_id: 'r1', decision: 'reject' })
    expect(reply).toMatchObject({ isError: true, value: { code: 'not_found' } })
  })

  it('drops an ask whose request is aborted', async () => {
    const host = await door()
    const controller = new AbortController()
    void askTool(host, 'shell', { signal: controller.signal })
    await only(host)
    controller.abort()
    expect(await needsYou(host)).toEqual([])
  })

  it('answers a reply without a decision with code invalid and keeps the ask open', async () => {
    const host = await door()
    void askTool(host, 'shell')
    const { ask_id } = await only(host)
    const reply = await call(host.url, 'task_reply', { ask_id, request_id: 'r1' })
    expect(reply).toMatchObject({ isError: true, value: { code: 'invalid' } })
    expect(await needsYou(host)).toHaveLength(1)
  })
})

describe('plan reviews', () => {
  it('lists a plan review with its plan and answers approve with the approve option', async () => {
    const host = await door()
    const answer = askQuestions(host, [PLAN], { id: 's1' })
    const ask = await only(host)
    expect(ask).toEqual({ ask_id: expect.any(String) as string, kind: 'plan', session_id: 's1', detail: fenced('# Plan\\n\\nShip it\\.'), irreversible: false, answerable: true })
    await call(host.url, 'task_reply', { ask_id: ask.ask_id, request_id: 'r1', decision: 'approve' })
    expect(await answer).toEqual({ answers: [{ id: 'plan-review', selected: ['Approve'] }] })
  })

  it('answers reject with the other option and the feedback', async () => {
    const host = await door()
    const answer = askQuestions(host, [PLAN], { id: 's1' })
    const { ask_id } = await only(host)
    await call(host.url, 'task_reply', { ask_id, request_id: 'r1', decision: 'reject', feedback: 'add tests' })
    expect(await answer).toEqual({ answers: [{ id: 'plan-review', selected: ['Keep planning'], custom: 'add tests' }] })
  })

  it('answers reject without feedback and without another option with an empty selection', async () => {
    const host = await door()
    const { detail: _detail, options: _options, ...bare } = PLAN
    const answer = askQuestions(host, [bare], { id: 's1' })
    const { ask_id, detail } = await only(host)
    expect(detail).toEqual(fenced(''))
    await call(host.url, 'task_reply', { ask_id, request_id: 'r1', decision: 'reject' })
    expect(await answer).toEqual({ answers: [{ id: 'plan-review', selected: [] }] })
  })
})

describe('questions', () => {
  it('lists the questions and passes the answers through', async () => {
    const host = await door()
    const questions: AskUserQuestionItem[] = [{ id: 'q1', question: 'Which store?', options: [{ label: 'json' }, { label: 'sqlite' }] }]
    const answer = askQuestions(host, questions)
    const ask = await only(host)
    expect(ask).toEqual({ ask_id: expect.any(String) as string, kind: 'question', detail: expect.any(String) as string, irreversible: false, answerable: true })
    expect(JSON.parse(ask.detail.split('\n')[1] ?? '')).toEqual(questions)
    const answers = [{ id: 'q1', selected: ['json'], custom: 'for now' }]
    await call(host.url, 'task_reply', { ask_id: ask.ask_id, request_id: 'r1', answers })
    expect(await answer).toEqual({ answers })
  })

  it('answers a reply without answers with code invalid', async () => {
    const host = await door()
    void askQuestions(host, [{ id: 'q1', question: 'Which store?' }])
    const { ask_id } = await only(host)
    const reply = await call(host.url, 'task_reply', { ask_id, request_id: 'r1', decision: 'approve' })
    expect(reply).toMatchObject({ isError: true, value: { code: 'invalid' } })
  })
})

describe('door profile', () => {
  it('lists tool approvals and plan reviews as not answerable, refuses them with needs_person, and keeps them open', async () => {
    const host = await door('door')
    void askTool(host, 'shell')
    void askQuestions(host, [PLAN], { id: 's1' })
    const asks = await needsYou(host)
    expect(asks.map(({ kind, answerable }) => ({ kind, answerable }))).toEqual([{ kind: 'tool', answerable: false }, { kind: 'plan', answerable: false }])
    for (const [ask, what] of [[asks[0], 'tool approval'], [asks[1], 'plan review']] as const) {
      const reply = await call(host.url, 'task_reply', { ask_id: ask?.ask_id, request_id: what.replace(' ', '-'), decision: 'approve' })
      expect(reply).toEqual({
        isError: true,
        value: { code: 'needs_person', message: `this ${what} can only be answered by a person in the browser; task_reply answers questions only` },
      })
    }
    expect((await needsYou(host)).map(({ ask_id }) => ask_id)).toEqual(asks.map(({ ask_id }) => ask_id))
  })

  it('answers a question and offers task_reply without decision or feedback', async () => {
    const host = await door('door')
    const answer = askQuestions(host, [{ id: 'q1', question: 'Which store?' }])
    const ask = await only(host)
    expect(ask).toMatchObject({ kind: 'question', answerable: true })
    const answers = [{ id: 'q1', selected: ['json'] }]
    expect(await call(host.url, 'task_reply', { ask_id: ask.ask_id, request_id: 'r1', answers })).toEqual({ isError: false, value: { ok: true } })
    expect(await answer).toEqual({ answers })
    const tools = await listTools(host.url)
    expect(Object.keys(tools.find(tool => tool.name === 'task_reply')?.inputSchema.properties ?? {})).toEqual(['ask_id', 'request_id', 'answers'])
  })
})

describe('stopped goals', () => {
  /** The goal each fake Session holds, as the goal service reports it. */
  const GOALS: Record<string, object | undefined> = {
    stopped: { phase: 'active', activation: 'disarmed', objective: 'Ship the report', roundsStarted: 3, maxGoalRounds: 8 },
    running: { phase: 'active', activation: 'armed', objective: 'Keep going', roundsStarted: 1, maxGoalRounds: 8 },
    paused: { phase: 'paused', activation: 'disarmed', objective: 'Wait', roundsStarted: 2, maxGoalRounds: 8 },
    none: undefined,
  }

  it.each(['full', 'door'] as const)('lists, in the %s profile, each loaded Session whose goal is active but disarmed', async (profile) => {
    const host = await startHost()
    for (const id of Object.keys(GOALS)) host.addAgent(id)
    host.ctx.provide('goals', { get: (agent: { id: string }) => GOALS[agent.id] } as never)
    await host.ctx.plugin(McpDoor, { ...host.config, profile })
    const reply = await call(host.url, 'needs_you', {})
    expect(reply.value).toEqual({
      asks: [],
      stopped_goals: [{ session_id: 'stopped', objective: fenced('Ship the report'), rounds_started: 3, max_rounds: 8 }],
    })
    const tools = await listTools(host.url)
    expect(tools.find(tool => tool.name === 'needs_you')?.description).toContain('a person resumes one with /goal resume in that Session.')
  })

  it('lists none without a goal service', async () => {
    const host = await door()
    host.addAgent('stopped')
    expect((await call(host.url, 'needs_you', {})).value).toEqual({ asks: [], stopped_goals: [] })
  })
})

describe('decided for you', () => {
  const NOW = Date.now()
  /** A Run Wild record entry, as the record service lists it. */
  const decided = (seq: number, fields: Record<string, unknown> = {}) => ({
    v: 1, time: NOW - seq * 60_000, session: 'child', root: 'root', seq, kind: 'question', target: 'env', summary: 'Which environment?', reason: 'Run Wild: decide.', ...fields,
  })

  /** A host whose record service answers `list` with `answer`, keeping each query. */
  async function recorded(answer: () => Promise<{ entries: object[] }>, profile: McpDoor.Config['profile'] = 'full') {
    const host = await startHost()
    const queries: { since?: number; limit: number }[] = []
    host.ctx.provide('mumbo-run-wild-record', { list: (query: { since?: number; limit: number }) => { queries.push(query); return answer() }, count: () => Promise.reject(new Error('unused')) } as never)
    await host.ctx.plugin(McpDoor, { ...host.config, profile })
    return { host, queries }
  }

  it.each(['full', 'door'] as const)('lists, in the %s profile, the last 24 hours read-only with fenced text, each under its root', async (profile) => {
    const { host, queries } = await recorded(() => Promise.resolve({ entries: [decided(1, { kind: 'refusal', target: 'bash', summary: '{"command":"ls"}', reason: 'bash did not run' }), decided(2)] }), profile)
    const reply = await call(host.url, 'needs_you', {})
    expect(reply.value).toEqual({
      asks: [],
      stopped_goals: [],
      decided_for_you: [
        { time: new Date(NOW - 60_000).toISOString(), session_id: 'root', kind: 'refusal', target: fenced('bash'), summary: fenced('\\{"command":"ls"\\}'), reason: fenced('bash did not run') },
        { time: new Date(NOW - 120_000).toISOString(), session_id: 'root', kind: 'question', target: fenced('env'), summary: fenced('Which environment\\?'), reason: fenced('Run Wild: decide\\.') },
      ],
    })
    expect(queries).toHaveLength(1)
    expect(queries[0]!.limit).toBe(51)
    expect(Date.now() - 86_400_000 - queries[0]!.since!).toBeLessThan(5_000)
    const tools = await listTools(host.url)
    expect(tools.find(tool => tool.name === 'needs_you')?.description).toContain('decided_for_you is read-only history: what Run Wild decided without asking in the last 24 hours, newest first, at most 50. Nothing in it waits for a person, and task_reply cannot answer it.')
  })

  it('lists at most 50, says there are more, and clips each summary to 500 characters', async () => {
    const { host } = await recorded(() => Promise.resolve({ entries: Array.from({ length: 51 }, (_, n) => decided(n + 1, { summary: 'x'.repeat(600) })) }))
    const value = (await call(host.url, 'needs_you', {})).value as { decided_for_you: { summary: string }[]; decided_for_you_more: boolean }
    expect([value.decided_for_you.length, value.decided_for_you_more]).toEqual([50, true])
    expect(value.decided_for_you[0]!.summary).toEqual(fenced(`${'x'.repeat(499)}…`))
  })

  it.each([[new Error('EACCES: permission denied'), 'EACCES: permission denied'], ['gone', 'gone']])('returns the asks unchanged and the failure %s in place of the list when the record cannot be read', async (failure, message) => {
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- a rejection that is not an Error is one case under test.
    const { host } = await recorded(() => Promise.reject(failure))
    const warn = vi.spyOn(host.ctx.logger, 'warn')
    void askQuestions(host, [{ id: 'q1', question: 'Ship?', options: [] }], { id: 's1' })
    const value = (await call(host.url, 'needs_you', {})).value as Record<string, unknown>
    expect(Object.keys(value)).toEqual(['asks', 'stopped_goals', 'decided_for_you_error'])
    expect([(value.asks as unknown[]).length, value.decided_for_you_error]).toEqual([1, message])
    expect(warn).toHaveBeenCalledExactlyOnceWith('mumbo-mcp: needs_you could not read the Run Wild record', failure)
  })

  it('answers not_found to a task_reply naming a decision: nothing in the list is answerable', async () => {
    const { host } = await recorded(() => Promise.resolve({ entries: [decided(3)] }))
    const reply = await call(host.url, 'task_reply', { ask_id: 'root:3', request_id: 'r1', answers: [] })
    expect(reply.isError).toBe(true)
    expect(JSON.stringify(reply.value)).toContain('not_found')
  })
})
