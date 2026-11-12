/**
 * The resume notice: at the first step after a resume, one logged message naming the background jobs, workflow runs and
 * subagents that stopped or finished while the Session was down, and a goal that needs a person.
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
 * Jobs registered before the restart that it stopped or that finished after the last request. A job's owner cancels it
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
    return [{ line: `Ended after your last request (${job.settled.status}${detail}), output not kept: ${what}.`, kind: 'finished' }]
  })
}

/** Workflow runs started before the restart that it stopped or that ended after the last request. */
function runFindings(state: MumboState, resume: Resume): Finding[] {
  return Object.values(state.runs).flatMap((run): Finding[] => {
    if (run.seq >= resume.seedSeq) return []
    if (run.end !== undefined) return [{ line: `Workflow ${run.name} ended (${run.end.stopReason}) after your last request.`, kind: 'finished' }]
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
  for (const event of observed.events) {
    if (event.type === 'turn/start') end = undefined
    else if (event.type === 'turn/end') end = event
    else if (event.type === 'assistant/message') {
      text = event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    }
  }
  return { end, text, lastAt: observed.events.at(-1)?.time ?? 0 }
}

/** Direct children whose last turn the restart cut off, or that ended while this Session was not loaded. */
async function childFindings(ctx: Context, agent: Agent, resume: Resume, signal: AbortSignal): Promise<Finding[]> {
  const query = ctx.get('sessionQuery')
  if (query === undefined) return []
  const catalog = ctx.sessionProjections.snapshot(agent.session, ['subagentCatalog']).values.subagentCatalog ?? []
  const findings: Finding[] = []
  for (const child of catalog) {
    // A loaded child is still running in this process; external and unknown children keep no log here.
    if ((child.mode !== 'one-shot' && child.mode !== 'continuable') || ctx.agents.get(child.id) !== undefined) continue
    const name = childName(child)
    let log: ChildLog
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
    // child's last event, so a stopped child is not compared with `downAt`. One that stopped before this Session's
    // previous load was in that restart's notice.
    if (end === undefined || stopped(end.data.reason)) {
      if (log.lastAt < resume.upSince) continue
      const resumeHint = child.mode === 'continuable' ? ` Use send_message to ${name} to continue it.` : ''
      findings.push({ line: `Subagent ${name} stopped mid-task by the restart.${resumeHint}`, kind: 'stopped' })
      continue
    }
    // A child that ended while this Session was loaded already reported to it.
    if (end.time <= resume.downAt) continue
    const kind = end.data.reason.kind
    if (kind === 'completed') {
      const said = log.text === '' ? '' : ` Its last message: "${clip(log.text, LAST_MESSAGE_CHARS)}"`
      findings.push({ line: `Subagent ${name} finished while this Session was not loaded.${said}`, kind: 'finished' })
    } else {
      findings.push({ line: `Subagent ${name} ended (${kind}) while this Session was not loaded.`, kind: 'finished' })
    }
  }
  return findings
}

/**
 * Compare what the log says ran before the restart with what runs now.
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
  const findings = [
    ...jobFindings(state, resume),
    ...runFindings(state, resume),
    ...await childFindings(ctx, agent, resume, signal),
  ]
  const goal = ctx.get('goals')?.get(agent)
  if (goal?.phase === 'active' && goal.activation === 'disarmed') {
    findings.push({ line: 'The goal is still active, but the restart stopped its rounds: a person must resume it with /goal resume.', kind: 'goal' })
  }
  if (findings.length === 0) return undefined
  const count = (kind: Finding['kind']): number => findings.filter(finding => finding.kind === kind).length
  const parts = [
    ...count('stopped') > 0 ? [`${String(count('stopped'))} stopped`] : [],
    ...count('finished') > 0 ? [`${String(count('finished'))} finished`] : [],
    ...count('goal') > 0 ? ['goal needs a person'] : [],
  ]
  const text = ['This Session was restarted. What changed while it was down:', ...findings.map(finding => `- ${finding.line}`)].join('\n')
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: RESUME_SOURCE, form: 'notice', summary: boundContextSummary(`Restart: ${parts.join(', ')}.`) },
  })
}

/**
 * Add the resume notice to the first step after a resume that the rest of the chain admits. A step aborted before it is
 * logged leaves the resume pending, so the next step reconciles again; a step that already carries a notice, which an
 * outer listener returned to the inbox unlogged, gets no second one. Nothing to report is remembered per Session for
 * this process, and logs nothing.
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
