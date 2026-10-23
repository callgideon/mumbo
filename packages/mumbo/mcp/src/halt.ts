/** `runs_halt` and `runs_resume`: stop every run on the host, and keep model steps from starting until a resume. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type { JobId } from '@deepseek-ai/dsh-jobs'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { once, type HaltRecord } from './store.ts'
import { defineTool, requestId, type ToolDeps } from './tool.ts'

/** Cause and kill reason every halt records. */
const REASON = 'runs_halt'

/**
 * Whether runs are halted.
 * @param halt - the plugin's `halt` table.
 * @returns `true` from a halt until the next resume.
 */
export function isHalted(halt: KvTable<'main', HaltRecord>): boolean {
  return halt.get('main')?.halted === true
}

/**
 * Reject every proposed model step of every Session while runs are halted. The gate runs first in the
 * `agent/pre-step` chain, so no other step listener runs for a rejected step.
 * @param ctx - plugin context.
 * @param halt - the plugin's `halt` table, which must stay readable until the gate is removed.
 * @returns the disposer that removes the gate.
 */
export function gateWhileHalted(ctx: Context, halt: KvTable<'main', HaltRecord>): () => void {
  return ctx.on('agent/pre-step', (_payload, next) => isHalted(halt) ? Promise.resolve({ kind: 'reject' as const }) : next(), { prepend: true })
}

/** A job whose kill threw, with the error. */
interface FailedKill {
  readonly job: JobId
  readonly message: string
}

/**
 * Kill every running job, unowned or owned by a live Session. A kill that throws is reported and the rest still run.
 * @param ctx - context carrying `jobs`.
 * @param owners - the live Sessions.
 * @returns the jobs asked to stop, and the ones whose kill threw.
 */
function killJobs(ctx: Context, owners: readonly SessionId[]): { killed: JobId[]; failed: FailedKill[] } {
  const killed: JobId[] = []
  const failed: FailedKill[] = []
  for (const owner of [undefined, ...owners]) {
    for (const job of ctx.jobs.list(owner)) {
      if (job.owner !== owner || job.status !== 'running') continue
      try {
        ctx.jobs.kill(job.id, owner, REASON)
        killed.push(job.id)
      } catch (error: unknown) {
        failed.push({ job: job.id, message: String(error) })
      }
    }
  }
  return { killed, failed }
}

/**
 * Register `runs_halt` and `runs_resume` for one principal.
 * @param server - the request's MCP server.
 * @param deps - plugin state and the principal.
 */
export function register(server: McpServer, deps: ToolDeps): void {
  defineTool(
    server,
    'runs_halt',
    'Stop all work on the host now: the halt is stored, every running Session turn is cancelled with its queued messages kept, '
    + 'every running background job is killed, and no Session starts a model step until runs_resume. '
    + 'Returns what was cancelled and any job whose kill failed.',
    z.object({ request_id: requestId('halt') }),
    async args => await once(deps.idem, 'runs_halt', deps.principal, args.request_id, args, async () => {
      // Close the gate first, so a cancelled turn cannot start another step.
      await deps.halt.put('main', { halted: true })
      const agents = deps.ctx.agents.list()
      const sessions = agents.filter(agent => agent.status === 'running').map(agent => agent.id)
      for (const agent of agents) agent.cancel({ kind: 'hook', reason: REASON }, { keepInbox: true })
      const { killed, failed } = killJobs(deps.ctx, agents.map(agent => agent.id))
      return JSON.stringify({ halted: true, cancelled: { sessions, jobs: killed }, failed })
    }),
  )
  defineTool(
    server,
    'runs_resume',
    'End a halt: Sessions may start model steps again. Cancelled turns do not restart by themselves.',
    z.object({ request_id: requestId('resume') }),
    async args => await once(deps.idem, 'runs_resume', deps.principal, args.request_id, args, async () => {
      await deps.halt.put('main', { halted: false })
      return JSON.stringify({ halted: false })
    }),
  )
}
