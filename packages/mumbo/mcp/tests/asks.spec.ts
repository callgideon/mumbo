import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import { afterEach, describe, expect, it } from 'vitest'
import * as McpDoor from '../src/index.ts'
import { call, type Host, startHost, stopHosts } from './door-fixture.ts'

afterEach(stopHosts)

interface Listed {
  readonly ask_id: string
  readonly kind: string
  readonly detail: string
}

const PLAN: AskUserQuestionItem = {
  id: 'plan-review',
  header: 'Plan review',
  question: 'Approve this plan and leave plan mode?',
  detail: '# Plan\n\nShip it.',
  options: [{ label: 'Approve' }, { label: 'Keep planning' }],
  intent: { kind: 'plan-review', approve: 'Approve' },
}

/** A host with the plugin loaded. */
async function door(): Promise<Host> {
  const host = await startHost()
  await host.ctx.plugin(McpDoor, host.config)
  return host
}

/** Ask for a tool approval that the browser never answers unless `browser` settles. */
function askTool(
  host: Host,
  toolName: string,
  options: { reason?: string; browser?: Promise<ApprovalOutcome>; signal?: AbortSignal } = {},
): Promise<ApprovalOutcome> {
  const browser = options.browser ?? new Promise<ApprovalOutcome>(() => {})
  return host.ctx.waterfall('approval/request', {
    agent: { id: 's1' },
    toolName,
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
      { ask_id: expect.any(String) as string, kind: 'tool', session_id: 's1', tool: 'shell', detail: fenced('run shell'), irreversible: false },
      { ask_id: expect.any(String) as string, kind: 'tool', session_id: 's1', tool: 'edit', detail: fenced(''), irreversible: false },
    ])
    expect(asks[0]?.ask_id).not.toBe(asks[1]?.ask_id)
    const reply = await call(host.url, 'task_reply', { ask_id: asks[0]?.ask_id, request_id: 'r1', decision: 'approve' })
    expect(reply).toEqual({ isError: false, value: { ok: true } })
    expect(await outcome).toBe('allowed-once')
    expect((await needsYou(host)).map(ask => ask.ask_id)).toEqual([asks[1]?.ask_id])
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
    expect(ask).toMatchObject({ kind: 'tool', tool: 'deploy', irreversible: true })
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
    expect(ask).toEqual({ ask_id: expect.any(String) as string, kind: 'plan', session_id: 's1', detail: fenced('# Plan\\n\\nShip it\\.'), irreversible: false })
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
    expect(ask).toEqual({ ask_id: expect.any(String) as string, kind: 'question', detail: expect.any(String) as string, irreversible: false })
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
