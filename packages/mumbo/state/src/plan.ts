/**
 * The approved plan's title and step headings for the state block, and the `plan_read` tool that returns its full text.
 * @module @mumbo/state/plan
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { PlanRecord } from './projection.ts'

/** Name of the tool that returns the approved plan. */
export const PLAN_READ = 'plan_read'

/** A plan's title and its step headings, in order. */
export interface PlanHeadings {
  /** The text of the plan's first `# ` heading, when it has one. */
  readonly title: string | undefined
  /** The `##` and `###` headings; without any, the column-0 list items (`1.`, `1)`, `-`, `*`). */
  readonly steps: readonly string[]
}

/**
 * Extract a plan's title and step headings.
 * @param text - the plan's markdown.
 * @returns the title and steps.
 */
export function planHeadings(text: string): PlanHeadings {
  const lines = text.split('\n')
  const match = (pattern: RegExp): string[] => lines.flatMap(line => pattern.exec(line)?.[1]?.trim() ?? [])
  const headings = match(/^#{2,3} (.+)$/u)
  return { title: match(/^# (.+)$/u)[0], steps: headings.length > 0 ? headings : match(/^(?:\d+[.)]|[-*]) (.+)$/u) }
}

/**
 * Register `plan_read`, offered only to an Agent whose Session holds an approved plan.
 * @param ctx - plugin context carrying `tools`; the tool ends with it.
 * @param planOf - the latest approved plan of the calling Agent's Session, or `null`.
 */
export function registerPlanRead(ctx: Context, planOf: (agent: Agent) => PlanRecord | null): void {
  ctx.tools.register(defineTool({
    name: PLAN_READ,
    description: 'Read the full text of the latest approved plan. Use it when the step headings in the runtime context are not enough.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, text) => [{ type: 'text', text }],
    },
    execute(_args, exec) {
      const plan = exec.agent === undefined ? null : planOf(exec.agent)
      if (plan === null) throw new Error('No plan has been approved in this Session.')
      return Promise.resolve(`Approved in turn ${String(plan.turn)}.\n\n${plan.text}`)
    },
    isConcurrencySafe: () => true,
    presentCall: () => ({ card: 'generic', title: 'Read approved plan', kind: 'read' }),
  }), { when: ({ agent }) => planOf(agent) !== null })
}
