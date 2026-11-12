/**
 * The resume notice: at the first step after a resume, one logged message naming the background jobs, workflow runs and
 * subagents that the restart stopped or whose end the Session may not have been told about, and a goal that needs a person.
 * @module @mumbo/state/resume
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-goal'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionSeq, TurnEndReason, UserMessage } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import type { SubagentCatalogEntry } from '@deepseek-ai/dsh-subagent'
import { type MumboState, RESUME_SOURCE } from './projection.ts'
import { clip } from './render.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** The notice at the first step after a resume that lists what the restart stopped or what finished meanwhile. */
    'mumbo-resume': { kind: 'mumbo-resume' } & ContextFormed
  }
}

/** Longest quoted last message of a subagent that finished. */
const LAST_MESSAGE_CHARS = 400

/** The message of the host log line each comparison writes; its fields follow as one object. */
const RECONCILE_LOG = 'mumbo-state: resume reconcile'

/** The resume facts the projection recorded at the end-seed. */
type Resume = NonNullable<MumboState['resume']>

/** One line of the notice, and what it counts toward in the summary. */
interface Finding {
  readonly line: string
  readonly kind: 'stopped' | 'finished' | 'goal'
}

/**
 * The name a parent knows a direct child by: its catalog name, else its label, else its Session id.
 * @param child - the parent's catalog entry.
 * @returns the name.
 */
export function childName(child: SubagentCatalogEntry): string {
  return ('name' in child ? child.name : undefined) ?? child.label ?? child.id
}

/**
 * Jobs registered before the restart that it stopped or that finished after the last step began. A job's owner cancels it
 * when the owner's Agent goes, so none of them still runs.
 */
function jobFindings(state: MumboState, resume: Resume): Finding[] {
  return Object.entries(state.jobs).flatMap(([id, job]): Finding[] => {
    if (job.seq >= resume.seedSeq) return []
    const what = `background job ${id} (${job.kind}: ${job.label})`
    // Disposal at shutdown settles a job with cause `teardown`; a crash leaves none. Both stopped with the process.
    if (job.settled === undefined || job.settled.cause === 'teardown') {
      return [{ line: `Stopped by the restart, output not kept: ${what}.`, kind: 'stopped' }]
    }
    const detail = job.settled.detail === undefined ? '' : `, ${job.settled.detail}`
    return [{ line: `Finished after the last step began (${job.settled.status}${detail}), output not kept: ${what}.`, kind: 'finished' }]
  })
}

/** Workflow runs started before the restart that it stopped or that finished after the last step began. */
function runFindings(state: MumboState, resume: Resume): Finding[] {
  return Object.values(state.runs).flatMap((run): Finding[] => {
    if (run.seq >= resume.seedSeq) return []
    if (run.end !== undefined) return [{ line: `Workflow ${run.name} finished (${run.end.stopReason}) after the last step began.`, kind: 'finished' }]
    const agents = run.running > 0 ? `, with ${String(run.running)} of its agents running` : ''
    return [{ line: `Stopped by the restart: workflow ${run.name}${agents}.`, kind: 'stopped' }]
  })
}

/** How a child's log ends: its last turn's end (none while that turn is open), its last assistant text, its last event's time. */
interface ChildLog {
  readonly end: SessionEvent<'turn/end'> | undefined
  readonly text: string
  readonly lastAt: number
}

/** Whether a turn ended because its process stopped: a shutdown disposed its Agent, or a read closed it after a crash. */
function stopped(reason: TurnEndReason): boolean {
  return reason.kind === 'interrupted' || (reason.kind === 'aborted' && reason.reason.kind === 'disposed')
}

/** Read how a child's log ends. */
async function childLog(query: SessionQueryEngine, child: SubagentCatalogEntry, signal: AbortSignal): Promise<ChildLog> {
  using observed = await query.observeSession(child.id, { signal, projectionMode: 'none' })
  let end: SessionEvent<'turn/end'> | undefined
  let text = ''
  let lastAt = 0
  for (const event of observed.events) {
    lastAt = event.time
    if (event.type === 'turn/start') end = undefined
    else if (event.type === 'turn/end') end = event
    else if (event.type === 'assistant/message') {
      text = event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    }
  }
  return { end, text, lastAt }
}

/** The direct children's findings, the count of children in the catalog, and the count of child logs read, failed reads included. */
interface ChildScan {
  readonly findings: Finding[]
  readonly children: number
  readonly read: number
}

/** Direct children whose last turn the restart cut off, or that ended after this Session's last activity. */
async function childFindings(
  ctx: Context, agent: Agent, state: MumboState, resume: Resume, signal: AbortSignal,
): Promise<ChildScan> {
  const catalog = ctx.sessionProjections.snapshot(agent.session, ['subagentCatalog']).values.subagentCatalog ?? []
  const findings: Finding[] = []
  let read = 0
  const query = ctx.get('sessionQuery')
  if (query === undefined) return { findings, children: catalog.length, read }
  for (const child of catalog) {
    // A loaded child is still running in this process; external and unknown children keep no log here.
    if ((child.mode !== 'one-shot' && child.mode !== 'continuable') || ctx.agents.get(child.id) !== undefined) continue
    const name = childName(child)
    let log: ChildLog
    read += 1
    try {
      log = await childLog(query, child, signal)
    } catch (error: unknown) {
      // An aborted step's read fails with the abort; the listener drops this step's findings.
      if (signal.aborted) break
      ctx.logger.warn(`mumbo-state: subagent ${child.id} of ${agent.session.id} is left out of the resume notice; its log could not be read: ${String(error)}`)
      continue
    }
    const { end } = log
    // A shutdown can end a child's turn at or before the parent's last message, and a crash read closes it at the
    // child's last event, so a stopped child is not compared with `downAt` but with the run the restart ended. One idle
    // since before that run belongs to an earlier restart, which is checked, and one whose log moved after the
    // end-seed was not stopped by this restart.
    if (end === undefined || stopped(end.data.reason)) {
      if (log.lastAt < resume.upSince || log.lastAt > state.loadedAt) continue
      const resumeHint = child.mode === 'continuable' ? ` Use send_message to ${name} to continue it.` : ''
      findings.push({ line: `Subagent ${name} stopped mid-task by the restart.${resumeHint}`, kind: 'stopped' })
      continue
    }
    // A child that ended at or before this Session's last activity is taken to have reported to it. One that ended later
    // while this Session was loaded but idle may still have its own notice queued, and the model then reads both.
    if (end.time <= resume.downAt) continue
    const kind = end.data.reason.kind
    if (kind === 'completed') {
      const said = log.text === '' ? '' : ` Its last message: "${clip(log.text, LAST_MESSAGE_CHARS)}"`
      findings.push({ line: `Subagent ${name} finished after this Session's last activity.${said}`, kind: 'finished' })
    } else {
      findings.push({ line: `Subagent ${name} ended (${kind}) after this Session's last activity.`, kind: 'finished' })
    }
  }
  return { findings, children: catalog.length, read }
}

/**
 * Compare what the log says ran before the restart with what runs now. Writes one host log line, never to the Session
 * log: {@link RECONCILE_LOG} with the Session id, the catalog's child count, the child logs read, and the milliseconds
 * the comparison took.
 * @param ctx - plugin context; `sessionQuery` and `goals` are read when present.
 * @param agent - the resumed Agent.
 * @param state - its `mumboState`.
 * @param resume - the resume facts in `state`.
 * @param signal - the step's cancellation.
 * @returns the notice, or `undefined` when nothing stopped, finished or needs a person.
 */
async function reconcile(
  ctx: Context, agent: Agent, state: MumboState, resume: Resume, signal: AbortSignal,
): Promise<UserMessage | undefined> {
  const started = performance.now()
  const { findings: childLines, children, read } = await childFindings(ctx, agent, state, resume, signal)
  const findings = [...jobFindings(state, resume), ...runFindings(state, resume), ...childLines]
  const goal = ctx.get('goals')?.get(agent)
  if (goal?.phase === 'active' && goal.activation === 'disarmed') {
    findings.push({ line: 'The goal is still active, but its automatic rounds are stopped: a person must resume it with /goal resume.', kind: 'goal' })
  }
  ctx.logger.info(RECONCILE_LOG, { session: agent.session.id, children, read, ms: Math.round(performance.now() - started) })
  if (findings.length === 0) return undefined
  const count = (kind: Finding['kind']): number => findings.filter(finding => finding.kind === kind).length
  const parts = [
    ...count('stopped') > 0 ? [`${String(count('stopped'))} stopped`] : [],
    ...count('finished') > 0 ? [`${String(count('finished'))} finished`] : [],
    ...count('goal') > 0 ? ['goal needs a person'] : [],
  ]
  const text = ['This Session was restarted. Changes it may not have been told about:', ...findings.map(finding => `- ${finding.line}`)].join('\n')
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: RESUME_SOURCE, form: 'notice', summary: boundContextSummary(`Restart: ${parts.join(', ')}.`) },
  })
}

/**
 * Add the resume notice to the first step after a resume that the rest of the chain admits. The notice, or with nothing
 * to report the step's assistant message, checks the restart in the log. Nothing to report is also remembered per
 * Session for this process, so a step whose request fails before its reply does not compare again. A step aborted
 * before it is logged leaves the resume pending; a step that already carries a notice, which an outer listener returned
 * to the inbox unlogged, gets no second one.
 * @param ctx - plugin context; the listener ends with it.
 * @param stateOf - the `mumboState` of a Session.
 */
export function listenForResume(ctx: Context, stateOf: (session: Session) => MumboState): void {
  const quiet = new WeakMap<Session, SessionSeq>()
  ctx.on('agent/pre-step', async (step, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const session = step.agent.session
    const state = stateOf(session)
    const resume = state.resume
    if (resume === null || quiet.get(session) === resume.seedSeq) return decision
    if (decision.messages.some(message => message.source.kind === RESUME_SOURCE)) return decision
    const notice = await reconcile(ctx, step.agent, state, resume, step.signal)
    // An aborted step, also one aborted before this listener ran, logs nothing, so the restart stays for the next one.
    if (step.signal.aborted) return decision
    if (notice === undefined) {
      quiet.set(session, resume.seedSeq)
      return decision
    }
    return { ...decision, messages: [...decision.messages, notice] }
  })
}
