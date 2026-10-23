/** `needs_you` and `task_reply`: tool approvals, plan reviews and questions, answered here or in the browser, whichever is first. */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { type Branded, brandString } from '@deepseek-ai/dsh-brand'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { AskUserQuestionAnswer, AskUserQuestionIntent, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { ToolError } from './errors.ts'
import { fence } from './fence.ts'
import { once } from './store.ts'
import { defineTool, requestId, type ToolDeps } from './tool.ts'

const replyArgs = z.object({
  ask_id: z.string().describe('The ask_id from needs_you.'),
  request_id: requestId('reply'),
  decision: z.enum(['approve', 'reject']).exactOptional().describe('For a tool or plan ask.'),
  answers: z.array(z.object({
    id: z.string(),
    selected: z.array(z.string()),
    custom: z.string().exactOptional(),
  })).exactOptional().describe('For a question ask: per question id, the chosen option labels and optional free text.'),
  feedback: z.string().exactOptional().describe('For a rejected plan: what to change.'),
})

/** One `task_reply`. */
type Reply = z.output<typeof replyArgs>

/** Id of one open ask, fresh per ask. */
export type AskId = Branded<'McpAskId'>

/** One open ask as `needs_you` lists it, before its `detail` is fenced. */
export interface AskView {
  readonly ask_id: AskId
  readonly kind: 'plan' | 'tool' | 'question'
  /** Session that asked; absent for a question asked outside a Session. */
  readonly session_id?: SessionId
  /** The tool awaiting approval, for a `tool` ask. */
  readonly tool?: string
  /** The tool call awaiting approval, when the asker named it. */
  readonly call_id?: ToolCallId
  /** The asker's reason, the plan, or the questions as JSON. */
  readonly detail: string
  /** Whether only a person in the browser may answer. */
  readonly irreversible: boolean
}

/** One open ask: its listing, the asking Agent of a tool ask, and the answer a reply gives it. */
export interface PendingAsk {
  readonly view: AskView
  /** The Agent whose log holds the tool call `view.call_id`. */
  readonly agent?: Agent
  /**
   * Answer the ask and close it.
   * @param reply - the `task_reply` arguments.
   * @throws {ToolError} `needs_person` for an irreversible ask, `invalid` when the reply does not fit the ask; the ask stays open.
   */
  answer(reply: Reply): void
}

/** The decision a tool or plan ask needs. */
function decisionOf(reply: Reply): 'approve' | 'reject' {
  if (reply.decision === undefined) throw new ToolError('invalid', 'this ask needs decision approve or reject')
  return reply.decision
}

/**
 * Hold one ask open until the browser chain or a `task_reply` answers it, whichever is first; an aborted request drops it.
 * The losing side's answer is ignored, and the browser card of an ask answered here stays until its request ends.
 */
async function race<T>(
  asks: Map<AskId, PendingAsk>,
  ask: { readonly view: Omit<AskView, 'ask_id'>; readonly agent?: Agent },
  signal: AbortSignal | undefined,
  next: () => Promise<T>,
  settle: (reply: Reply) => T,
): Promise<T> {
  const askId = brandString<AskId>(randomUUID())
  const replied = Promise.withResolvers<T>()
  const drop = (): void => { asks.delete(askId) }
  asks.set(askId, {
    ...ask,
    view: { ask_id: askId, ...ask.view },
    answer: (reply) => {
      const value = settle(reply)
      drop()
      replied.resolve(value)
    },
  })
  signal?.addEventListener('abort', drop, { once: true })
  try {
    return await Promise.race([next(), replied.promise])
  } finally {
    drop()
    signal?.removeEventListener('abort', drop)
  }
}

/** A question carrying a plan-review intent. */
type PlanReview = AskUserQuestionItem & { intent: AskUserQuestionIntent }

/** The answer to a plan review: the approve option alone, or the other options with the feedback. */
function planAnswer(plan: PlanReview, reply: Reply): AskUserQuestionAnswer {
  if (decisionOf(reply) === 'approve') return { answers: [{ id: plan.id, selected: [plan.intent.approve] }] }
  const selected = (plan.options ?? []).map(option => option.label).filter(label => label !== plan.intent.approve)
  return { answers: [{ id: plan.id, selected, ...(reply.feedback === undefined ? {} : { custom: reply.feedback }) }] }
}

/**
 * Answer every tool approval and user question from the front of its chain, racing the rest of the chain
 * (the browser) against `task_reply`.
 * @param ctx - plugin context; the listeners end with it.
 * @param irreversibleTools - tools whose approval `task_reply` refuses with `needs_person`.
 * @returns the open asks by `ask_id`, which the tools read and answer.
 */
export function listenForAsks(ctx: Context, irreversibleTools: readonly string[]): Map<AskId, PendingAsk> {
  const asks = new Map<AskId, PendingAsk>()
  ctx.on('approval/request', async (request, next) => {
    const irreversible = irreversibleTools.includes(request.toolName)
    const view = {
      kind: 'tool',
      session_id: request.agent.id,
      tool: request.toolName,
      ...(request.callId === undefined ? {} : { call_id: request.callId }),
      detail: request.reason ?? '',
      irreversible,
    } as const
    return await race(asks, { view, agent: request.agent }, request.signal, next, (reply): ApprovalOutcome => {
      if (irreversible) throw new ToolError('needs_person', `approving ${request.toolName} needs a person in the browser`)
      return decisionOf(reply) === 'approve' ? 'allowed-once' : 'rejected'
    })
  }, { prepend: true })
  ctx.on('user-questions/request', async (request, next) => {
    const sessionId = request.agent === undefined ? {} : { session_id: request.agent.id }
    const plan = request.questions.find((item): item is PlanReview => item.intent !== undefined)
    if (plan !== undefined) {
      const view = { kind: 'plan', ...sessionId, detail: plan.detail ?? '', irreversible: false } as const
      return await race(asks, { view }, request.signal, next, reply => planAnswer(plan, reply))
    }
    const view = { kind: 'question', ...sessionId, detail: JSON.stringify(request.questions), irreversible: false } as const
    return await race(asks, { view }, request.signal, next, (reply): AskUserQuestionAnswer => {
      if (reply.answers === undefined) throw new ToolError('invalid', 'this ask needs answers')
      return { answers: reply.answers }
    })
  }, { prepend: true })
  return asks
}

/** The logged tool-call fields `needs_you` reads; an `assistant/message` event logs its message under `message`. */
const toolCalls = z.object({ message: z.object({
  content: z.array(z.object({ type: z.string(), id: z.unknown().optional(), arguments: z.unknown().optional() })),
}) })

/**
 * The raw JSON arguments of a tool ask's call, as the asking Session logged them.
 * @returns `{arguments}` fenced, or nothing when the ask names no call or the log holds none with its id.
 */
async function callArguments(deps: ToolDeps, ask: PendingAsk, signal: AbortSignal): Promise<{ arguments?: string }> {
  const { agent, view: { call_id: callId } } = ask
  if (agent === undefined || callId === undefined) return {}
  // ponytail: one page of the whole log per tool ask, as `agent_read` reads it; page back from the cursor once that does.
  const page = await deps.ctx.sessionController.page({
    address: { kind: 'session', sessionId: agent.id },
    throughSeq: agent.session.seq - 1,
    maxMessages: Number.MAX_SAFE_INTEGER,
  }, signal)
  for (const { event } of page.records) {
    if (event.type !== 'assistant/message') continue
    const call = toolCalls.parse(event.data).message.content.find(block => block.type === 'tool-call' && block.id === callId)
    if (typeof call?.arguments === 'string') return { arguments: fence(call.arguments) }
  }
  return {}
}

/**
 * Register `needs_you` and `task_reply` for one principal.
 * @param server - the request's MCP server.
 * @param deps - plugin state, the open asks, and the principal.
 */
export function register(server: McpServer, deps: ToolDeps): void {
  defineTool(
    server,
    'needs_you',
    'List what waits for a person: tool approvals with the call\'s arguments, plan reviews and questions from any Session. '
    + 'Answer one with task_reply; an irreversible ask can only be answered in the browser.',
    z.object({}),
    async (_args, signal) => JSON.stringify({
      asks: await Promise.all([...deps.asks.values()].map(async ask => ({
        ...ask.view,
        detail: fence(ask.view.detail),
        ...await callArguments(deps, ask, signal),
      }))),
    }),
  )
  defineTool(
    server,
    'task_reply',
    'Answer one ask from needs_you. A tool or plan ask takes decision approve or reject; a rejected plan may carry feedback. '
    + 'A question ask takes answers. An ask answered in the browser first gives not_found.',
    replyArgs,
    async args => await once(deps.idem, 'task_reply', deps.principal, args.request_id, args, () => {
      const ask = deps.asks.get(brandString<AskId>(args.ask_id))
      if (ask === undefined) throw new ToolError('not_found', `no open ask ${args.ask_id}: it was answered elsewhere or withdrawn`)
      ask.answer(args)
      return Promise.resolve(JSON.stringify({ ok: true }))
    }),
  )
}
