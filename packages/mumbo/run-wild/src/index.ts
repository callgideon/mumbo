/**
 * Run Wild: the permission preset in which the assistant never waits for the person. In a Session whose root is in
 * Run Wild, a tool call that asks for approval runs, a plan review is approved, and a question is answered with a fixed
 * reply that tells the model to decide for itself; each is logged as a `runwild/decision` record. The preset itself is a
 * `permission` row entry that a person-box overlay lists; this plugin reads the recorded preset name.
 * @module @mumbo/run-wild
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subagent'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import type { AskUserQuestionAnswerItem, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import { assertNever } from '@deepseek-ai/dsh-util-values'

/** What a Run Wild decision stood in for: a tool approval, a plan review, or a question. */
export type RunWildDecisionKind = 'approval' | 'plan-review' | 'question'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * One ask that Run Wild decided instead of the person, appended inside the turn of the tool call that asked;
     * log-only audit, never model-visible (the model sees the tool result the decision caused). `target` is the tool
     * name, the plan's tool call id, the approval's subject, or the question id; `summary` is the ask's own text;
     * `reason` is why it was decided this way, and for a question it is the reply the model received.
     */
    'runwild/decision': { kind: RunWildDecisionKind; target: string; summary: string; reason: string }
  }
}

/** The `permission` row preset name that turns Run Wild on. */
export const RUN_WILD_PRESET = 'run-wild'

/** The answer every question receives in Run Wild. */
export const RUN_WILD_REPLY = "Run Wild: decide from context and the person's rules, state your assumption in one line, and continue."

export const name = 'mumbo-run-wild'
export const inject = ['permissionPresets']

/**
 * Whether an Agent acts in Run Wild: a delegated child follows its live root Session, so switching the root out of
 * Run Wild reaches its running children at once.
 * @param ctx - a context with the `permissionPresets` service.
 * @param agent - the live Agent that asks.
 * @returns whether the root Session's current preset is Run Wild.
 * @throws when the Agent is a delegated child whose root is no longer live.
 */
export function inRunWild(ctx: Context, agent: Agent): boolean {
  const root = ctx.get('subagents')?.rootOf(agent) ?? agent
  return ctx.permissionPresets.current(root.session) === RUN_WILD_PRESET
}

/** Answer one question in Run Wild and log the decision; the summary is the question and its detail, such as a plan. */
function decide(session: Session, item: AskUserQuestionItem): AskUserQuestionAnswerItem {
  const intent = item.intent
  const summary = item.detail === undefined ? item.question : `${item.question}\n\n${item.detail}`
  switch (intent?.kind) {
    case undefined:
      session.append('runwild/decision', { kind: 'question', target: item.id, summary, reason: RUN_WILD_REPLY })
      return { id: item.id, selected: [], custom: RUN_WILD_REPLY }
    case 'plan-review':
      session.append('runwild/decision', {
        kind: 'plan-review', target: intent.callId ?? item.id, summary, reason: 'Run Wild approves plans without review.',
      })
      return { id: item.id, selected: [intent.approve] }
    case 'approval':
      // Once, never `always`: a later ask in Run Wild is decided again and logged again.
      session.append('runwild/decision', {
        kind: 'approval', target: intent.subject?.name ?? item.id, summary, reason: 'Run Wild grants approvals once.',
      })
      return { id: item.id, selected: [intent.approve] }
    /* v8 ignore next -- closed-union exhaustiveness guard */
    default:
      return assertNever(intent, 'AskUserQuestionIntent')
  }
}

/**
 * Register the two Run Wild listeners, each prepended so it decides before the person's answerers are reached.
 * @param ctx - plugin context; the listeners end with it.
 */
export function apply(ctx: Context): void {
  // Turns only an `ask` into `allow`; a policy that allows, denies or asks the person itself is unchanged, and a guard
  // can still refuse the call after this.
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const decision = await next()
    const agent = exec.agent
    if (decision.kind !== 'ask' || agent === undefined || !inRunWild(ctx, agent)) return decision
    agent.session.append('runwild/decision', {
      kind: 'approval', target: exec.name, summary: decision.reason ?? exec.name, reason: 'Run Wild allows tool approvals.',
    })
    return { kind: 'allow' }
  }, { prepend: true })
  // A delegated child cannot ask questions, so only root Agents reach this waterfall.
  ctx.on('user-questions/request', (request, next) => {
    const agent = request.agent
    if (agent === undefined || !inRunWild(ctx, agent)) return next()
    return Promise.resolve({ answers: request.questions.map(item => decide(agent.session, item)) })
  }, { prepend: true })
}
