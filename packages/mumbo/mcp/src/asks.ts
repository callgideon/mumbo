/**
 * `needs_you` and `task_reply`: tool approvals, plan reviews and questions, answered here or in the browser, whichever is
 * first, the goals that wait for a person to resume them, and, read-only, what Run Wild decided in the last day.
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-goal'
import { type Branded, brandString } from '@deepseek-ai/dsh-brand'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { AskUserQuestionAnswer, AskUserQuestionIntent, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import type { RecordEntry } from '@mumbo/run-wild'
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

/** The `task_reply` arguments when it answers questions only. */
const answerArgs = replyArgs.omit({ decision: true, feedback: true })

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

/** One loaded Session whose goal is active but whose rounds stopped, as `needs_you` lists it. */
export interface StoppedGoal {
  readonly session_id: SessionId
  /** The goal's objective, fenced: a person or a model wrote it. */
  readonly objective: string
  readonly rounds_started: number
  readonly max_rounds: number
}

/**
 * The loaded Sessions whose goal is active but disarmed, such as after a host restart: its rounds continue only once a
 * person resumes it in that Session.
 * @param ctx - context carrying `agents`; without a `goals` service there are none.
 * @returns one entry per such Session, in the Agent registry's order.
 */
function stoppedGoals(ctx: Context): StoppedGoal[] {
  const goals = ctx.get('goals')
  if (goals === undefined) return []
  return ctx.agents.list().flatMap((agent) => {
    const goal = goals.get(agent)
    if (goal?.phase !== 'active' || goal.activation !== 'disarmed') return []
    return [{ session_id: agent.id, objective: fence(goal.objective), rounds_started: goal.roundsStarted, max_rounds: goal.maxGoalRounds }]
  })
}

/** One decision Run Wild made without asking, as `needs_you` lists it. */
export interface DecidedForYou {
  /** When it was logged, ISO 8601. */
  readonly time: string
  /** The root Session it belongs to. */
  readonly session_id: SessionId
  readonly kind: string
  /** What it was about, fenced: a model or a page wrote it. */
  readonly target: string
  /** What was decided, clipped to {@link DECIDED_SUMMARY_LIMIT} characters and fenced. */
  readonly summary: string
  /** Why, fenced. */
  readonly reason: string
}

/** `needs_you`'s Run Wild fields: absent without the record, the list, or the read's failure in its place. */
type DecidedFields =
  | Record<string, never>
  | { decided_for_you: DecidedForYou[]; decided_for_you_more?: true }
  | { decided_for_you_error: string }

/** The decisions `needs_you` lists: the last day's. */
const DECIDED_WINDOW_MS = 86_400_000
/** At most this many decisions; one more sets `decided_for_you_more`. */
const DECIDED_LIMIT = 50
/** The characters of a decision's summary `needs_you` keeps. */
const DECIDED_SUMMARY_LIMIT = 500

/** One record entry as `needs_you` lists it. */
function decidedView(entry: RecordEntry): DecidedForYou {
  const summary = entry.summary.length <= DECIDED_SUMMARY_LIMIT ? entry.summary : `${entry.summary.slice(0, DECIDED_SUMMARY_LIMIT - 1)}…`
  return {
    time: new Date(entry.time).toISOString(), session_id: entry.root, kind: entry.kind,
    target: fence(entry.target), summary: fence(summary), reason: fence(entry.reason),
  }
}

/**
 * `needs_you`'s Run Wild fields: what Run Wild decided in the last day, newest first. Read-only: `task_reply` looks asks
 * up only among the open asks, so a decision is never answerable.
 * @param ctx - context; without the `mumbo-run-wild-record` service the fields are absent.
 * @returns the list, or on a read failure `decided_for_you_error` in its place.
 */
async function decidedForYou(ctx: Context): Promise<DecidedFields> {
  const record = ctx.get('mumbo-run-wild-record')
  if (record === undefined) return {}
  try {
    const { entries } = await record.list({ since: Date.now() - DECIDED_WINDOW_MS, limit: DECIDED_LIMIT + 1 })
    const more = entries.length > DECIDED_LIMIT ? { decided_for_you_more: true as const } : {}
    return { decided_for_you: entries.slice(0, DECIDED_LIMIT).map(decidedView), ...more }
  } catch (error: unknown) {
    // The list is history: a record the Host cannot read must not hide the asks that wait for the person.
    ctx.logger.warn('mumbo-mcp: needs_you could not read the Run Wild record', error)
    return { decided_for_you_error: error instanceof Error ? error.message : String(error) }
  }
}

/** What `needs_you` says of stopped goals, in both profiles. */
const STOPPED_GOALS = ' stopped_goals lists Sessions whose goal is active but stopped, such as by a restart; a person resumes one with /goal resume in that Session.'

/** What `needs_you` says of Run Wild's decisions, in both profiles. */
const DECIDED = ' decided_for_you is read-only history: what Run Wild decided without asking in the last 24 hours, newest first, at most 50. '
  + 'Nothing in it waits for a person, and task_reply cannot answer it.'

/** Tool descriptions by whether `task_reply` answers questions only. */
const DESCRIPTIONS = {
  all: {
    needsYou: 'List what waits for a person: tool approvals with the call\'s arguments, plan reviews and questions from any Session. '
      + 'Answer one whose answerable is true with task_reply; the others can only be answered in the browser.' + STOPPED_GOALS + DECIDED,
    reply: 'Answer one ask from needs_you. A tool or plan ask takes decision approve or reject; a rejected plan may carry feedback. '
      + 'A question ask takes answers. An ask answered in the browser first gives not_found.',
  },
  questionsOnly: {
    needsYou: 'List what waits for a person: questions from any Session, and tool approvals with the call\'s arguments and plan reviews '
      + 'for information. Answer a question with task_reply; approvals and plan reviews (answerable false) can only be answered in the browser.'
      + STOPPED_GOALS + DECIDED,
    reply: 'Answer one question from needs_you with answers. Tool approvals and plan reviews cannot be answered here. '
      + 'A question answered in the browser first gives not_found.',
  },
} as const

/**
 * Register `needs_you` and `task_reply` for one principal.
 * @param server - the request's MCP server.
 * @param deps - plugin state, the open asks, and the principal.
 */
export function register(server: McpServer, deps: ToolDeps): void {
  const descriptions = deps.questionsOnly ? DESCRIPTIONS.questionsOnly : DESCRIPTIONS.all
  defineTool(
    server,
    'needs_you',
    descriptions.needsYou,
    z.object({}),
    async (_args, signal) => JSON.stringify({
      asks: await Promise.all([...deps.asks.values()].map(async ask => ({
        ...ask.view,
        detail: fence(ask.view.detail),
        answerable: !ask.view.irreversible && (!deps.questionsOnly || ask.view.kind === 'question'),
        ...await callArguments(deps, ask, signal),
      }))),
      stopped_goals: stoppedGoals(deps.ctx),
      ...await decidedForYou(deps.ctx),
    }),
  )
  defineTool(
    server,
    'task_reply',
    descriptions.reply,
    deps.questionsOnly ? answerArgs : replyArgs,
    async args => await once(deps.idem, 'task_reply', deps.principal, args.request_id, args, () => {
      const ask = deps.asks.get(brandString<AskId>(args.ask_id))
      if (ask === undefined) throw new ToolError('not_found', `no open ask ${args.ask_id}: it was answered elsewhere or withdrawn`)
      if (deps.questionsOnly && ask.view.kind !== 'question') {
        const what = ask.view.kind === 'tool' ? 'tool approval' : 'plan review'
        throw new ToolError('needs_person', `this ${what} can only be answered by a person in the browser; task_reply answers questions only`)
      }
      ask.answer(args)
      return Promise.resolve(JSON.stringify({ ok: true }))
    }),
  )
}
