/**
 * Mumbo state: the `mumbo:state` runtime context, a short block of the goal, the approved plan's steps, open todos, team
 * tasks, running subagents and background jobs that changes only at a compaction, a restart or a goal phase change; the
 * `plan_read` tool; and the notice at the first step after a restart that lists what stopped or finished meanwhile.
 * @module @mumbo/state
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-team'
import type {} from '@deepseek-ai/dsh-goal'
import type {} from '@deepseek-ai/dsh-jobs'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import z from '@deepseek-ai/schemastery'
import { planHeadings, registerPlanRead } from './plan.ts'
import { foldState, initState, type MumboState, stateSchema } from './projection.ts'
import { render, type StateView } from './render.ts'
import { childName, listenForResume } from './resume.ts'

export { PLAN_READ } from './plan.ts'
export { RESUME_SOURCE } from './projection.ts'

/** Name of the runtime-context section the block contributes. */
export const STATE_CONTEXT = 'mumbo:state'

/** Cordis function-plugin name. */
export const name = 'mumbo-state'
/** Required services; goals, jobs, agent teams, subagents and session queries are read when present. */
export const inject = ['systemPrompt', 'sessionProjections', 'tools', 'agents']

/** Mumbo state configuration. */
export interface Config {
  /** Cap on the block's characters, at least 400 (default 1600); what does not fit is named with the tool that reads it. */
  readonly maxChars: number
}

export const Config: z<Config> = z.object({
  maxChars: z.number().step(1).min(400).default(1600),
})

/**
 * The facts the block shows for one Agent, read now.
 * @param ctx - plugin context; optional services absent from it contribute nothing.
 * @param agent - the Agent whose request carries the block.
 * @param state - its Session's `mumboState`.
 * @returns the view to render.
 */
function collect(ctx: Context, agent: Agent, state: MumboState): StateView {
  const goal = ctx.get('goals')?.get(agent)
  const teams = ctx.get('agentTeams')
  const catalog = ctx.sessionProjections.snapshot(agent.session, ['subagentCatalog']).values.subagentCatalog ?? []
  return {
    ...goal === undefined ? {} : {
      goal: {
        phase: goal.phase, armed: goal.activation === 'armed', roundsStarted: goal.roundsStarted, maxGoalRounds: goal.maxGoalRounds,
        objective: goal.objective, ...goal.blockedReason === undefined ? {} : { blockedReason: goal.blockedReason.message },
      },
    },
    ...state.plan === null ? {} : { plan: { ...planHeadings(state.plan.text), turn: state.plan.turn } },
    ...state.todos === null ? {} : { todos: state.todos },
    team: teams?.isEnabled(agent) === true
      ? teams.listTasks(agent).filter(task => task.status === 'pending' || task.status === 'in_progress')
        .map(task => ({ id: String(task.id), status: task.status, owner: task.ownerName, subject: task.subject }))
      : [],
    subagents: catalog.filter(child => ctx.agents.get(child.id)?.status === 'running')
      .map(child => ({ name: childName(child), label: child.label })),
    jobs: (ctx.get('jobs')?.list(agent.session.id) ?? []).filter(job => job.status === 'running' || job.status === 'stopping')
      .map(job => ({ id: job.id, status: job.status, label: job.label })),
  }
}

/**
 * Register the `mumboState` projection, the `mumbo:state` context, `plan_read`, and the resume listener. The context
 * renders on the first request after its Session's boundary counter moves, and every other request in this process
 * reuses that text, so the model sees a new block only after a compaction, a restart or a goal phase change.
 * @param ctx - plugin context; every registration ends with it.
 * @param config - validated configuration.
 * @throws when the projection does not register.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const handle = await ctx.sessionProjections.register({
    key: 'mumboState', stateVersion: 1, stateSchema, init: initState, apply: foldState,
  })
  const stateOf = (session: Session): MumboState => handle.stateOf(session)
  const memos = new WeakMap<Session, { readonly boundary: number; readonly text: string }>()
  ctx.systemPrompt.context({
    name: STATE_CONTEXT,
    // After the harness's own contexts (`WEB_SURFACE` is 210).
    order: 300,
    // Objectives and todos are the model's or a person's text and may contain `{{…}}`.
    interpolate: false,
    text: ({ agent }) => {
      if (agent === undefined) return ''
      const state = stateOf(agent.session)
      const memo = memos.get(agent.session)
      if (memo?.boundary === state.boundary) return memo.text
      const text = render(collect(ctx, agent, state), config.maxChars)
      memos.set(agent.session, { boundary: state.boundary, text })
      return text
    },
  })
  registerPlanRead(ctx, agent => stateOf(agent.session).plan)
  listenForResume(ctx, stateOf)
}
