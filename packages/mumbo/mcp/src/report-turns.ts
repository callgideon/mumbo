/**
 * Report-started turns: in a turn that a project's report opened, only reading tools and `todo_write` run unasked;
 * every other tool asks the person first, and under Run Wild it is refused and the refusal logged as a `runwild/decision`
 * of kind `refusal`. The predicate is the `mumbo-report-turns` service, so other consent can gate its own tools the same
 * way.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-goal'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-schedule'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-subagent'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import { classify } from '@mumbo/browser-consent'
import { inRunWild } from '@mumbo/run-wild'
import { z } from 'zod'
import type {} from './conversation.ts'

/** The longest refusal summary this gate logs, in characters: the Run Wild record keeps summaries to the same length. */
const REFUSAL_SUMMARY_LIMIT = 2000

/**
 * Clip a refused call's arguments for its `runwild/decision` summary.
 * @param json - the arguments as JSON.
 * @returns the JSON, or its first characters followed by `…`.
 */
function clipArguments(json: string): string {
  return json.length <= REFUSAL_SUMMARY_LIMIT ? json : `${json.slice(0, REFUSAL_SUMMARY_LIMIT - 1)}…`
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Whether an Agent acts in a report-started turn; `@mumbo/mcp` provides it while it is loaded. */
    'mumbo-report-turns': ReportTurns
  }
}

/** Whether an Agent acts in a report-started turn: `@mumbo/mcp` provides it while loaded and gates tools with it. */
export interface ReportTurns {
  /**
   * Whether a project's report opened the current turn of the Agent's root Session. The turn's origin is the source of
   * the first message logged in the turn's first step that names one: `report`; `user`, such as a browser prompt, or
   * `mcp`, through the door, for a person; `schedule`; or `goal`. A report claimed in that step with a person's message
   * still makes the turn report-started. Every later message of the turn, such as a runtime-context snapshot or a
   * compaction checkpoint, a message whose source declares a context form, such as a schedule change notice, and a
   * message of any other source, leave the origin unchanged, so a turn that no such message opened keeps the previous
   * turn's. A delegated child follows its live root Session.
   * @param agent - the live Agent that acts.
   * @returns whether the turn's origin is a report; `false` before any origin.
   * @throws when the Agent is a delegated child whose root is no longer live.
   */
  reportStarted(agent: Agent): boolean
}

/**
 * Tools that run unasked in a report-started turn: the file tools' reads and searches, which `fs-local` confines to
 * the model roots where a box configures them; the status reads of goals and jobs; `@mumbo/state`'s read of the
 * approved plan; and the todo list.
 */
const UNASKED: ReadonlySet<string> = new Set(['read', 'read_image', 'glob', 'grep', 'get_goal', 'job_list', 'plan_read', 'todo_write'])

/** Public tool-name prefix of the Playwright MCP browser tools that `@mumbo/browser-consent` mounts. */
const BROWSER = 'mcp__playwright-mcp__'

/**
 * Whether a call runs unasked in a report-started turn: a tool that only reads, as listed in {@link UNASKED}, or a
 * browser call that `@mumbo/browser-consent` classifies as a read. Every other call asks, whatever its tool.
 * @param name - the called tool's name.
 * @param args - the call's parsed arguments.
 * @returns whether the call runs without the person's approval in a report-started turn.
 */
export function runsUnasked(name: string, args: unknown): boolean {
  return UNASKED.has(name) || (name.startsWith(BROWSER) && classify(name.slice(BROWSER.length), args) === 'read')
}

/** Why a tool asks in a report-started turn, shown to the person on the approval card. */
const REPORT_ASK = "This turn started with a project's report, so every action but reading asks first: it runs with your box's sign-ins, such as GitHub."

/**
 * Why a tool does not run in a report-started turn under Run Wild; the model reads it as the call's error.
 * @param tool - the refused tool's name.
 * @returns the refusal note.
 */
function reportRefusal(tool: string): string {
  return `${tool} did not run: this turn started with a project's report, and in Run Wild such a turn runs only reading tools and todo_write. Say what you would do and why, so the person can reply to let it run.`
}

/** The current turn's origin as the Session log records it. */
interface Origin {
  /** Whether the origin is a project's report. */
  readonly report: boolean
  /** `open` until a message in the turn's first step names an origin, `named` after it, `closed` once that step ends. */
  readonly phase: 'open' | 'named' | 'closed'
}

/**
 * Fold one event into the current turn's origin.
 * @param state - the origin before the event.
 * @param event - the next committed event.
 * @returns the origin after the event.
 */
function foldOrigin(state: Origin, event: SessionEvent): Origin {
  if (event.type === 'turn/start') return { report: state.report, phase: 'open' }
  if (event.type === 'step/end') return { report: state.report, phase: 'closed' }
  // A replacement, such as a compaction checkpoint, re-surfaces earlier messages and opens nothing.
  if (event.type !== 'user/message' || event.surfaceOp !== 'append' || state.phase === 'closed') return state
  const source = event.data.source
  // A source that declares a context form, such as a schedule change notice, is context and names no origin.
  if ('form' in source && source.form !== undefined) return state
  switch (source.kind) {
    case 'report':
      return { report: true, phase: 'named' }
    case 'user':
    case 'mcp':
    case 'schedule':
      return state.phase === 'open' ? { report: false, phase: 'named' } : state
    // A goal round continues what was going on and adds no authority, so it keeps the origin, as a retry does: a report
    // taints the rounds after it until the person's own message or a schedule delivery. Context the harness adds, a
    // hook's message, and every unknown source leave the origin as it was too.
    case 'goal':
    default:
      return state
  }
}

/**
 * Provide `mumbo-report-turns` and gate tools: in a report-started turn, a call that {@link runsUnasked} rejects asks
 * the person, and under Run Wild it is refused without asking, with a `runwild/decision` of kind `refusal` appended to
 * the calling Agent's own Session: `target` the tool, `summary` the clipped arguments as JSON, `reason` the refusal the
 * model receives. The gate decides before Run Wild can allow it, in either
 * listener order; a policy after it that denies still denies. The listener, the service and the host-only projection
 * behind it release with the calling fiber.
 * @param ctx - plugin context carrying `sessionProjections` and `permissionPresets`.
 * @throws when the projection registration fails.
 */
export async function gateReportTurns(ctx: Context): Promise<void> {
  const origin = await ctx.sessionProjections.register({
    key: 'mumboReportTurn',
    stateVersion: 4,
    stateSchema: z.object({ report: z.boolean(), phase: z.enum(['open', 'named', 'closed']) }),
    init: (): Origin => ({ report: false, phase: 'open' }),
    apply: foldOrigin,
  })
  const turns: ReportTurns = {
    reportStarted: agent => origin.stateOf((ctx.get('subagents')?.rootOf(agent) ?? agent).session).report,
  }
  ctx.provide('mumbo-report-turns', turns)
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const agent = exec.agent
    if (agent === undefined || runsUnasked(exec.name, exec.arguments) || !turns.reportStarted(agent)) return next()
    if (inRunWild(ctx, agent)) {
      const reason = reportRefusal(exec.name)
      agent.session.append('runwild/decision', { kind: 'refusal', target: exec.name, summary: clipArguments(JSON.stringify(exec.arguments)), reason })
      return { kind: 'deny', reason }
    }
    const decision = await next()
    return decision.kind === 'allow' ? { kind: 'ask', reason: REPORT_ASK } : decision
  }, { prepend: true })
}
