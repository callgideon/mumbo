/** A real agent loop with the plugin mounted, a scripted model, and helpers to run turns and restart a Session. */

import { Context } from '@deepseek-ai/cordis'
import type { AgentHandle, AgentOptions } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { JobId, JobOutcome } from '@deepseek-ai/dsh-jobs'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { onTestFinished } from 'vitest'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as MumboState from '../src/index.ts'
import { RESUME_SOURCE, STATE_CONTEXT } from '../src/index.ts'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    /** The shell's background commands, which the tests stand in for. */
    bash: 'bash'
  }
}

/** The scripted model's route. */
export const OPTIONS: AgentOptions = { provider: 'fixture', model: 'fixture' }

/** A booted composition. */
export interface Harness {
  readonly ctx: Context
  readonly model: MockAdapter
  /** Unload this plugin. */
  unload(): Promise<void>
  /** Start an Agent on a fresh Session. */
  start(id: string): Promise<AgentHandle>
  /**
   * Stop an Agent and resume its Session from its log, as a host restart does.
   * @param crash - resume from the log as it was before the stop, as after a crash, without the stop's own records.
   */
  restart(handle: AgentHandle, crash?: boolean): Promise<AgentHandle>
}

/**
 * Boot the loop's services, `mount`'s plugins, this plugin, and the loop, with a model that answers from `script`.
 * @param script - the model's responses, in order.
 * @param mount - mounts the services the test needs before this plugin.
 * @param config - this plugin's configuration.
 * @returns the composition.
 */
export async function boot(
  script: ConstructorParameters<typeof MockAdapter>[0], mount: (ctx: Context) => Promise<void> = () => Promise.resolve(),
  config: MumboState.Config = MumboState.Config(),
): Promise<Harness> {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  await mount(ctx)
  const plugin = await ctx.plugin(MumboState, config)
  await mountAgentLoopTestHarness(ctx)
  const model = new MockAdapter(script)
  ctx.effect(() => ctx.llm.registerAdapter(['fixture'], model))
  return {
    ctx,
    model,
    unload: () => plugin.dispose(),
    start: id => ctx.agents.create({ sessionId: SessionId(id), agentOptions: OPTIONS }),
    restart: async (handle, crash = false) => {
      const before = handle.agent.session.snapshotEvents()
      await handle.dispose()
      const seed = crash ? before : handle.agent.session.snapshotEvents()
      return await ctx.agents.create({ sessionId: handle.agent.id, seed, agentOptions: OPTIONS })
    },
  }
}

/** Queue a person's message and wait until the Agent is idle again. */
export async function turn(agent: Agent, text: string): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

/** The `mumbo:state` text of every logged runtime-context snapshot that carries one, in log order. */
export function stateSections(agent: Agent): string[] {
  return agent.session.snapshotEvents().flatMap((event) => {
    if (event.type !== 'user/message' || event.data.source.kind !== 'runtime-context' || event.data.source.form !== 'snapshot') return []
    return event.data.source.sections.filter(section => section.name === STATE_CONTEXT).map(section => section.text)
  })
}

/** The text of every logged resume notice, with the turn it was logged in. */
export function notices(agent: Agent): { turn: number; text: string; summary: string }[] {
  let turn = 0
  return agent.session.snapshotEvents().flatMap((event) => {
    if (event.type === 'turn/start') turn = event.data.turn
    if (event.type !== 'user/message' || event.data.source.kind !== RESUME_SOURCE || event.data.source.form !== 'notice') return []
    const [block] = event.data.content
    return [{ turn, text: block?.type === 'text' ? block.text : '', summary: event.data.source.summary }]
  })
}

/** The text of every user-role message in a captured model request. */
export function requestTexts(model: MockAdapter, index: number): string[] {
  return (model.requests[index]?.messages ?? []).flatMap(message => message.role === 'user'
    ? message.content.flatMap(block => block.type === 'text' ? [block.text] : [])
    : [])
}

/** A background job a test started: its id, and how to end it as its command would. */
export interface TestJob {
  readonly id: JobId
  /** End the job as a command that exited normally. */
  finish(): void
}

/**
 * Start a background shell job owned by an Agent's Session that runs until it is finished or killed.
 * @param ctx - a context with `jobs` and a job controller attached.
 * @param agent - the owning Agent.
 * @param label - the command.
 * @returns the job.
 */
export function startJob(ctx: Context, agent: Agent, label: string): TestJob {
  const done = Promise.withResolvers<JobOutcome>()
  const id = ctx.jobs.start({
    kind: 'bash', label, owner: agent.session.id,
    run: () => ({ cancel: () => { done.resolve({ status: 'killed' }) }, done: done.promise }),
  })
  return { id, finish: () => { done.resolve({ status: 'completed', detail: 'exit code: 0' }) } }
}
