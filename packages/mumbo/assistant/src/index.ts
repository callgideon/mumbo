/** Host half: keeps the person's always-present assistant Session, Mumbo, present, unarchivable, and instructed. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { defineDomain, domainTable, type KvTable } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-workspace'
import z from '@deepseek-ai/schemastery'
import * as zod from 'zod'
import { MUMBO_SESSION_ID } from './session.ts'

export { MUMBO_SESSION_ID } from './session.ts'

/** Cordis function-plugin name. */
export const name = 'mumbo-assistant'

/** `sessionController` keeps the plugin to Web profiles; `agents` reaches an already resumed Mumbo. */
export const inject = ['sessionController', 'workspaceRegistry', 'agents', 'storageDomain']

/** Title a new Mumbo Session gets; the person may rename it afterwards. */
export const MUMBO_TITLE = 'Mumbo'

/** Name of Mumbo's system prompt section. */
export const MUMBO_SECTION = 'mumbo:assistant'

/** Why an archive request naming Mumbo is refused; the Web shows it as the failed archive's message. */
export const ARCHIVE_REFUSAL = 'Mumbo is your always-present assistant and cannot be archived.'

/** Key of the record that Mumbo's pin was removed, after which the plugin leaves its pin state to the person. */
const UNPINNED = 'unpinned'

const stepRecord = zod.object({
  /** Epoch milliseconds when the step finished. */
  at: zod.number(),
}).strict()

/** A finished one-time start step. */
type StepRecord = zod.infer<typeof stepRecord>

/** Storage domain `mumbo_assistant`: table `steps` holds one record per finished one-time start step, keyed by its name. */
const assistantDomain = defineDomain({
  name: 'mumbo_assistant',
  version: 1,
  tables: {
    steps: domainTable<typeof UNPINNED, StepRecord>(stepRecord),
  },
})

/** Mumbo's instructions, the Workspace its Session is created in, and how a failed ensure is retried. */
export interface Config {
  /** Text of the system prompt section every Mumbo Agent receives; the box edge writes it. */
  readonly instructions: string
  /** Absolute directory of the Workspace a newly created Mumbo Session joins; it must exist. */
  readonly workspace: string
  /** Delays before each retry of a failed ensure, in milliseconds; their count bounds the retries. */
  readonly retryDelaysMs: number[]
}

/** Validate the instructions as non-blank, the Workspace as an absolute path, and each delay as positive. */
export const Config: z<Config> = z.object({
  instructions: z.string().pattern(/\S/).required().description('System prompt section text for the Mumbo Session.'),
  workspace: z.string().pattern(/^\//).default('/root/projects').description('Absolute directory of the Workspace a new Mumbo Session joins.'),
  // A restarted box's new process waits for its predecessor to release Mumbo's writer lease; these cover a slow exit.
  retryDelaysMs: z.array(z.natural().min(1)).default([1000, 2000, 5000, 10000, 30000])
    .description('Delays in milliseconds before each retry of a failed ensure.'),
})

/**
 * Resolve Mumbo's Session, creating and titling it only on `session/not-found`, then unarchive it as needed, and unpin it
 * once: the sidebar entry replaces the pin an earlier version of this plugin set, and a pin the person sets later stays.
 * @param ctx - plugin context carrying the injected services.
 * @param config - validated configuration.
 * @param steps - the finished one-time start steps.
 * @throws the session controller's, Workspace registry's, or storage domain's error from any step.
 */
async function ensure(ctx: Context, config: Config, steps: KvTable<typeof UNPINNED, StepRecord>): Promise<void> {
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
  if (steps.get(UNPINNED) !== undefined) return
  if (ctx.workspaceRegistry.pinnedSessionIds.includes(MUMBO_SESSION_ID)) {
    await ctx.workspaceRegistry.unpinSession(MUMBO_SESSION_ID)
  }
  await steps.put(UNPINNED, { at: Date.now() })
}

/**
 * Open the `mumbo_assistant` domain, register the archive veto and the prompt section, then ensure Mumbo's Session:
 * create it on `session/not-found` in the configured Workspace with the deployment's default preset and title it,
 * unarchive it as needed, and unpin it once. Start awaits the first ensure. A failed ensure is logged as an error and
 * retried after each of `retryDelaysMs` in turn, while the veto and the prompt section stay registered. Attempts never
 * overlap, and unload cancels a pending retry and waits for a running one before the domain closes.
 * @param ctx - plugin context carrying the injected services.
 * @param config - validated configuration.
 * @throws when the domain does not open; the veto and the section go with the failed start.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
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
  // A failed ensure must not take the veto and the section down with the plugin, so it is reported and retried.
  const lifetime = new AbortController()
  let ensuring = Promise.resolve()
  const opening = ctx.storageDomain.open(assistantDomain)
  // One composite effect tears down in reverse order: a running ensure drains before the section, the veto, and the
  // domain go, so a restart never leaves Mumbo archivable while an old attempt finishes.
  ctx.effect(function* () {
    // A failed open rejects the start below, which reports it.
    yield () => opening.then(domain => domain.close(), () => undefined)
    yield ctx.on('workspace/archive-veto', ({ sessionId }) => sessionId === MUMBO_SESSION_ID ? ARCHIVE_REFUSAL : undefined)
    yield ctx.on('agent/created', ({ agent }) => { instruct(agent); return undefined })
    yield () => release?.()
    yield async () => {
      lifetime.abort()
      await ensuring
    }
  }, 'mumbo-assistant')
  // A schedule may resume Mumbo before this plugin starts.
  const live = ctx.agents.get(MUMBO_SESSION_ID)
  if (live !== undefined) instruct(live)

  const steps = (await opening).table('steps')
  const attempt = async (retry: number): Promise<void> => {
    try {
      await ensure(ctx, config, steps)
    } catch (error: unknown) {
      const delay = config.retryDelaysMs[retry]
      const next = delay === undefined ? 'no retry is left until the next start' : `retrying in ${String(delay)} ms`
      ctx.logger.error(`mumbo-assistant: could not ensure Session '${MUMBO_SESSION_ID}'; ${next}: ${String(error)}`)
      if (delay === undefined || lifetime.signal.aborted) return
      const timer = setTimeout(() => { ensuring = attempt(retry + 1) }, delay)
      lifetime.signal.addEventListener('abort', () => { clearTimeout(timer) }, { once: true })
    }
  }
  ensuring = attempt(0)
  await ensuring
}
