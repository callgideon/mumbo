/** The assistant Session the tools talk to: found by its stored id, or created once in the configured workspace. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-workspace'
import type { Config } from './index.ts'
import type { StateRecord } from './store.ts'

/**
 * Resolve the stored assistant Session, or create one when none is stored or the stored one is gone.
 * A new Session joins the `assistantCwd` workspace; its id is stored before it is titled `assistantTitle`,
 * so a failed rename leaves a stored, untitled Session rather than an orphan.
 * Callers serialize calls; two concurrent calls on an empty state create two Sessions.
 * @param ctx - context carrying `sessionController` and `workspaceRegistry`.
 * @param config - the workspace directory and title.
 * @param state - the plugin's `state` table.
 * @returns the assistant Session's live Agent.
 * @throws the session controller's error when the stored Session exists but cannot be resolved, or creation fails.
 */
export async function ensureAssistant(
  ctx: Context,
  config: Pick<Config, 'assistantCwd' | 'assistantTitle'>,
  state: KvTable<'main', StateRecord>,
): Promise<Agent> {
  const stored = state.get('main')
  if (stored?.assistantSessionId !== undefined) {
    const resolved = await ctx.sessionController.resolveAgent(SessionId(stored.assistantSessionId))
    if ('agent' in resolved) return resolved.agent
    if (resolved.error.code !== 'session/not-found') throw resolved.error
  }
  const workspace = await ctx.workspaceRegistry.create(config.assistantCwd)
  const { sessionId } = await ctx.sessionController.create({ workspaceId: workspace.id })
  await state.put('main', { halted: stored?.halted ?? false, assistantSessionId: sessionId })
  await ctx.sessionController.rename({ sessionId, title: config.assistantTitle })
  const created = await ctx.sessionController.resolveAgent(sessionId)
  if ('error' in created) throw created.error
  return created.agent
}
