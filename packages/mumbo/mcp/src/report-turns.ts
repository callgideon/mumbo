/**
 * Report-started turns: while the newest message that a person or a project sent to a Session is a project's report,
 * the shell asks the person before each command, and under Run Wild it is refused. The predicate is the
 * `mumbo-report-turns` service, so other consent can gate its own tools the same way.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-subagent'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import { inRunWild } from '@mumbo/run-wild'
import { z } from 'zod'
import type {} from './conversation.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Whether an Agent acts in a report-started turn; `@mumbo/mcp` provides it while it is loaded. */
    'mumbo-report-turns': ReportTurns
  }
}

/** Whether an Agent acts in a report-started turn: `@mumbo/mcp` provides it while loaded and gates the shell with it. */
export interface ReportTurns {
  /**
   * Whether the newest message that a person or a project sent to the Agent's root Session is a project's report. A
   * person's message is one with the `user` source, such as a browser prompt, or the `mcp` source of the MCP door.
   * Context the harness adds, a schedule's message and every other source leave the answer unchanged. A delegated
   * child follows its live root Session.
   * @param agent - the live Agent that acts.
   * @returns whether that message is a report; `false` before any such message.
   * @throws when the Agent is a delegated child whose root is no longer live.
   */
  reportStarted(agent: Agent): boolean
}

/** The shell tool, gated whole. */
const SHELL = 'bash'

/** Why the shell asks in a report-started turn, shown to the person on the approval card. */
const REPORT_SHELL_ASK = "The newest message in this Session is a project's report, so the shell asks before each command: it runs with your box's sign-ins, such as GitHub."

/** Why the shell does not run in a report-started turn under Run Wild; the model reads it as the call's error. */
const REPORT_SHELL_REFUSAL = "bash did not run: the newest message in this Session is a project's report, and in Run Wild the shell runs only after a message from the person. Say what you would run and why, so the person can reply to let it run."

/**
 * Fold one event into whether the newest message from a person or a project is a report.
 * @param state - whether it was a report before the event.
 * @param event - the next committed event.
 * @returns the same state unless the event appends a report or a person's message.
 */
function foldNewest(state: boolean, event: SessionEvent): boolean {
  if (event.type !== 'user/message' || event.surfaceOp !== 'append') return state
  switch (event.data.source.kind) {
    case 'report':
      return true
    case 'user':
    case 'mcp':
      return false
    // Context the harness adds, a schedule's or a hook's message, and late answers are nobody's new request.
    default:
      return state
  }
}

/**
 * Provide `mumbo-report-turns` and gate the shell: in a report-started turn, a `bash` call asks the person, and under
 * Run Wild it is refused without asking. The gate decides before Run Wild can allow it, in either listener order; a
 * policy after it that denies still denies. The listener, the service and the host-only projection behind it release
 * with the calling fiber.
 * @param ctx - plugin context carrying `sessionProjections` and `permissionPresets`.
 * @throws when the projection registration fails.
 */
export async function gateReportTurns(ctx: Context): Promise<void> {
  const newest = await ctx.sessionProjections.register({
    key: 'mumboReportTurn',
    stateVersion: 1,
    stateSchema: z.boolean(),
    init: () => false,
    apply: foldNewest,
  })
  const turns: ReportTurns = {
    reportStarted: agent => newest.stateOf((ctx.get('subagents')?.rootOf(agent) ?? agent).session),
  }
  ctx.provide('mumbo-report-turns', turns)
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const agent = exec.agent
    if (exec.name !== SHELL || agent === undefined || !turns.reportStarted(agent)) return next()
    if (inRunWild(ctx, agent)) return { kind: 'deny', reason: REPORT_SHELL_REFUSAL }
    const decision = await next()
    return decision.kind === 'allow' ? { kind: 'ask', reason: REPORT_SHELL_ASK } : decision
  }, { prepend: true })
}
