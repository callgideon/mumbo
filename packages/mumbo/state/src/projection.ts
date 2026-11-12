/**
 * The host-only `mumboState` Session projection: the boundary counter that decides when the state block may change, the
 * last todo list, the approved plan, and the jobs, workflow runs and resume facts the resume notice compares.
 * @module @mumbo/state/projection
 */

import type {} from '@deepseek-ai/dsh-compaction'
import type {} from '@deepseek-ai/dsh-goal'
import type {} from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-plan-mode'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { type SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tool-todo'
import type {} from '@deepseek-ai/dsh-tool-workflow/types'
import { z } from 'zod'

/** Source kind of the resume notice; its `user/message` clears {@link MumboState.resume}. */
export const RESUME_SOURCE = 'mumbo-resume'

const seqSchema = z.number().int().nonnegative().transform(SessionSeq)
const todoSchema = z.object({ content: z.string(), status: z.enum(['pending', 'in_progress', 'completed']) })
const planSchema = z.object({ callId: z.string().min(1).transform(ToolCallId), text: z.string(), turn: z.number() })
const jobSchema = z.object({
  kind: z.string(),
  label: z.string(),
  seq: seqSchema,
  settled: z.object({
    status: z.enum(['completed', 'killed', 'failed']), cause: z.enum(['producer', 'kill', 'teardown']), detail: z.string().optional(), seq: seqSchema,
  }).optional(),
})
const runSchema = z.object({
  name: z.string(),
  seq: seqSchema,
  running: z.number(),
  end: z.object({ stopReason: z.enum(['completed', 'cancelled', 'error']), seq: seqSchema }).optional(),
})

/** Validates a persisted `mumboState` checkpoint. */
export const stateSchema = z.object({
  /** Successful compactions, end-seeds, and goal changes other than edits; the block renders anew when it moves. */
  boundary: z.number(),
  /** The current turn. */
  turn: z.number(),
  /** The last `todo_write` list and the turn that wrote it, kept across turns. */
  todos: z.object({ items: z.array(todoSchema), turn: z.number() }).nullable(),
  /** The plan an `exit_plan_mode` call presented, until its result. */
  proposed: planSchema.nullable(),
  /** The plan whose review succeeded, until plan mode exits (approved) or the turn ends (dismissed). */
  reviewed: planSchema.nullable(),
  /** The latest approved plan. */
  plan: planSchema.nullable(),
  /** Jobs other than workflow runs, by id, until a step starts after their settlement or the resume notice reports them. */
  jobs: z.record(z.string(), jobSchema),
  /** Workflow runs, by run id, until a step starts after their end or the resume notice reports them. */
  runs: z.record(z.string(), runSchema),
  /** Time of the last message logged, which a restart's end-seed keeps as the time the Session went down. */
  lastActivity: z.number(),
  /** Time of the last end-seed, when this Session was last loaded from its log; 0 before any. */
  loadedAt: z.number(),
  /**
   * The restart's end-seed, the time the Session went down, and the time it was loaded before that restart (an earlier
   * restart whose notice is still pending keeps its own), until the resume notice is logged.
   */
  resume: z.object({ seedSeq: seqSchema, downAt: z.number(), upSince: z.number() }).nullable(),
})

/** The `mumboState` projection state. */
export type MumboState = z.output<typeof stateSchema>

/** One `exit_plan_mode` plan: its call, its markdown, and the turn that presented it. */
export type PlanRecord = z.output<typeof planSchema>

/**
 * The state of an empty log.
 * @returns a state with boundary 0 and nothing recorded.
 */
export function initState(): MumboState {
  return {
    boundary: 0, turn: 0, todos: null, proposed: null, reviewed: null, plan: null, jobs: {}, runs: {}, lastActivity: 0, loadedAt: 0,
    resume: null,
  }
}

/** A copy of `record` without the entries `drop` selects; `record` itself when it selects none. */
function without<T>(record: Record<string, T>, drop: (entry: T) => boolean): Record<string, T> {
  const kept = Object.entries(record).filter(([, entry]) => !drop(entry))
  return kept.length === Object.keys(record).length ? record : Object.fromEntries(kept)
}

/** The plan text of an `exit_plan_mode` call's raw arguments, or `undefined` when they hold none. */
function planText(args: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(args)
    const plan = typeof parsed === 'object' && parsed !== null && 'plan' in parsed ? parsed.plan : undefined
    return typeof plan === 'string' ? plan : undefined
  } catch {
    // The model wrote arguments that are not JSON; plan mode rejects that call, so no plan was presented.
    return undefined
  }
}

/** Fold the plan-review events: a presented plan, its review result, and plan mode's exit or the turn's end. */
function foldPlan(state: MumboState, event: SessionEvent): MumboState {
  switch (event.type) {
    case 'tool/call': {
      const text = event.data.name === 'exit_plan_mode' ? planText(event.data.arguments) : undefined
      return text === undefined ? state : { ...state, proposed: { callId: event.data.callId, text, turn: event.data.turn } }
    }
    case 'tool/result':
      if (state.proposed?.callId !== event.data.message.toolCallId) return state
      return { ...state, proposed: null, reviewed: event.data.message.isError === true ? null : state.proposed }
    // Plan mode appends its exit at the next in-turn step only when the review approved the plan.
    case 'plan/mode':
      return state.reviewed === null || event.data.active ? state : { ...state, plan: state.reviewed, reviewed: null }
    // A dismissed review ends the turn before any step, so the plan was not approved.
    case 'turn/end':
      return state.reviewed === null ? state : { ...state, reviewed: null }
    default:
      return state
  }
}

/** Fold the job and workflow-run events. */
function foldWork(state: MumboState, event: SessionEvent): MumboState {
  switch (event.type) {
    // A background workflow run is also a job; its run events report it.
    case 'job/registered':
      if (event.data.kind === 'workflow') return state
      return { ...state, jobs: { ...state.jobs, [event.data.jobId]: { kind: event.data.kind, label: event.data.label, seq: event.seq } } }
    case 'job/settled': {
      const job = state.jobs[event.data.jobId]
      if (job === undefined) return state
      const { status, cause, detail } = event.data
      const settled = { status, cause, ...detail === undefined ? {} : { detail }, seq: event.seq }
      return { ...state, jobs: { ...state.jobs, [event.data.jobId]: { ...job, settled } } }
    }
    case 'tool-workflow/run-start':
      return { ...state, runs: { ...state.runs, [event.data.runId]: { name: event.data.name, seq: event.seq, running: 0 } } }
    case 'tool-workflow/agent-start':
    case 'tool-workflow/agent-end': {
      const run = state.runs[event.data.runId]
      if (run === undefined) return state
      const running = run.running + (event.type === 'tool-workflow/agent-start' ? 1 : -1)
      return { ...state, runs: { ...state.runs, [event.data.runId]: { ...run, running } } }
    }
    case 'tool-workflow/run-end': {
      const run = state.runs[event.data.runId]
      if (run === undefined) return state
      const end = { stopReason: event.data.stopReason, seq: event.seq }
      return { ...state, runs: { ...state.runs, [event.data.runId]: { ...run, end } } }
    }
    // A step that starts after a settlement claims its notice from the inbox, so the model was told of it; a settlement
    // during that step's own pre-step reaches the next step. Work from before a restart stays for the resume notice.
    case 'step/start': {
      const pending = (seq: number): boolean => state.resume !== null && seq < state.resume.seedSeq
      const jobs = without(state.jobs, job => job.settled !== undefined && !pending(job.seq))
      const runs = without(state.runs, run => run.end !== undefined && !pending(run.seq))
      return jobs === state.jobs && runs === state.runs ? state : { ...state, jobs, runs }
    }
    default:
      return state
  }
}

/**
 * Fold one committed event. Pure and synchronous; an event the unit does not read returns `state` itself.
 * @param state - the state before the event.
 * @param event - the next committed event.
 * @returns the state after the event.
 */
export function foldState(state: MumboState, event: SessionEvent): MumboState {
  switch (event.type) {
    case 'compaction/end':
      return event.data.error === undefined ? { ...state, boundary: state.boundary + 1 } : state
    case 'session/end-seed': {
      const loaded = { ...state, boundary: state.boundary + 1, loadedAt: event.time }
      // Copied fork history owns no executions and was not restarted.
      if (event.data.inherited === true) return { ...loaded, jobs: {}, runs: {}, resume: null }
      const upSince = state.resume?.upSince ?? state.loadedAt
      return { ...loaded, resume: { seedSeq: event.seq, downAt: state.lastActivity, upSince } }
    }
    case 'goal/change':
      return event.data.operation === 'edit' ? state : { ...state, boundary: state.boundary + 1 }
    case 'turn/start':
      return { ...state, turn: event.data.turn }
    case 'todo/write':
      return { ...state, todos: { items: event.data.todos, turn: state.turn } }
    case 'user/message': {
      const resume = state.resume
      if (event.data.source.kind !== RESUME_SOURCE || resume === null) return { ...state, lastActivity: event.time }
      // The notice reported every job and run started before the restart.
      return {
        ...state,
        lastActivity: event.time,
        resume: null,
        jobs: without(state.jobs, job => job.seq < resume.seedSeq),
        runs: without(state.runs, run => run.seq < resume.seedSeq),
      }
    }
    case 'assistant/message':
      return { ...state, lastActivity: event.time }
    case 'tool/result': {
      const next = foldPlan(state, event)
      return { ...next, lastActivity: event.time }
    }
    default:
      return foldWork(foldPlan(state, event), event)
  }
}
