/** Host half: keeps the person's always-present assistant Session, Mumbo, present, pinned, unarchivable, and instructed. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-workspace'
import z from '@deepseek-ai/schemastery'
import { MUMBO_SESSION_ID } from './session.ts'

export { MUMBO_SESSION_ID } from './session.ts'

/** Cordis function-plugin name. */
export const name = 'mumbo-assistant'

/** `sessionController` keeps the plugin to Web profiles; `agents` reaches an already resumed Mumbo. */
export const inject = ['sessionController', 'workspaceRegistry', 'agents']

/** Title a new Mumbo Session gets; the person may rename it afterwards. */
export const MUMBO_TITLE = 'Mumbo'

/** Name of Mumbo's system prompt section. */
export const MUMBO_SECTION = 'mumbo:assistant'

/** Why an archive request naming Mumbo is refused; the Web shows it as the failed archive's message. */
export const ARCHIVE_REFUSAL = 'Mumbo is your always-present assistant and cannot be archived.'

/** Mumbo's instructions and the Workspace its Session is created in. */
export interface Config {
  /** Text of the system prompt section every Mumbo Agent receives; the box edge writes it. */
  readonly instructions: string
  /** Absolute directory of the Workspace a newly created Mumbo Session joins; it must exist. */
  readonly workspace: string
}

/** Validate the instructions as non-blank and the Workspace as an absolute path; a failure fails plugin load. */
export const Config: z<Config> = z.object({
  instructions: z.string().pattern(/\S/).required().description('System prompt section text for the Mumbo Session.'),
  workspace: z.string().pattern(/^\//).default('/root/projects').description('Absolute directory of the Workspace a new Mumbo Session joins.'),
})

/**
 * Register the archive veto and the prompt section, then ensure Mumbo's Session: create it on `session/not-found` in the
 * configured Workspace with the deployment's default preset and title it, then unarchive and pin it as needed. The ensure
 * runs inside plugin start, which Cordis never overlaps for one plugin instance, so one ensure runs at a time.
 * @param ctx - plugin context carrying the injected services.
 * @param config - validated configuration.
 * @throws the session controller's or Workspace registry's error when the Session cannot be resolved, created, titled,
 *   unarchived, or pinned; the plugin then fails to start and its veto and prompt section go with it.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  ctx.on('workspace/archive-veto', ({ sessionId }) => sessionId === MUMBO_SESSION_ID ? ARCHIVE_REFUSAL : undefined)

  // Only one Agent per Session id is live; a new one replaces the released section of its predecessor.
  let release: (() => void) | undefined
  const instruct = (agent: Agent): void => {
    if (agent.id !== MUMBO_SESSION_ID) return
    release?.()
    release = agent.ctx.systemPrompt.section({
      name: MUMBO_SECTION,
      order: agent.ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX'),
      text: config.instructions,
      interpolate: false,
    })
  }
  ctx.on('agent/created', ({ agent }) => { instruct(agent); return undefined })
  ctx.effect(() => () => release?.(), 'mumbo-assistant: prompt section')
  // A schedule may resume Mumbo before this plugin starts.
  const live = ctx.agents.get(MUMBO_SESSION_ID)
  if (live !== undefined) instruct(live)

  const resolved = await ctx.sessionController.resolveAgent(MUMBO_SESSION_ID)
  if ('error' in resolved) {
    if (resolved.error.code !== 'session/not-found') throw resolved.error
    const workspace = await ctx.workspaceRegistry.create(config.workspace)
    const { sessionId } = await ctx.sessionController.create({ sessionId: MUMBO_SESSION_ID, workspaceId: workspace.id })
    await ctx.sessionController.rename({ sessionId, title: MUMBO_TITLE })
  }
  if (ctx.workspaceRegistry.archivedSessionIds.includes(MUMBO_SESSION_ID)) {
    await ctx.workspaceRegistry.unarchiveSession(MUMBO_SESSION_ID)
  }
  if (!ctx.workspaceRegistry.pinnedSessionIds.includes(MUMBO_SESSION_ID)) {
    await ctx.workspaceRegistry.pinSession(MUMBO_SESSION_ID)
  }
}
