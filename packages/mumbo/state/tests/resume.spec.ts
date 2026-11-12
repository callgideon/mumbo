/** The resume notice in a real agent loop, after a crash and after a graceful stop. */

import type { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent, type PreStepDecision } from '@deepseek-ai/dsh-agent'
import GoalService from '@deepseek-ai/dsh-goal'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import { createAssistantMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { interruptedTurnClosers, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subagent'
import { WorkflowRunId } from '@deepseek-ai/dsh-workflow'
import { describe, expect, it, vi } from 'vitest'
import { textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as GoalRoundDriver from '../../../goal/goal-round-driver/src/index.ts'
import { subagentCatalogProjectionDefinition } from '../../../subagent/subagent/src/catalog.ts'
import * as MumboState from '../src/index.ts'
import { PLAN_READ, STATE_CONTEXT } from '../src/index.ts'
import { Log } from './events.ts'
import { boot, notices, OPTIONS, requestTexts, startJob, turn } from './harness.ts'

const HEADER = 'This Session was restarted. What changed while it was down:'
const CHECK = 'node scripts/slow-check.js'

async function mountJobs(ctx: Context): Promise<void> {
  await ctx.plugin(LocalJobRegistry)
  ctx.jobs.attachController('test')
}

const replies = (count: number) => Array.from({ length: count }, (_, index) => textResponse(`reply ${String(index)}`))

/** Mount the subagent catalog and a session query that reads `logs`, an empty log for any other child. */
const children = (logs: Record<string, SessionEvent[]>) => async (ctx: Context) => {
  await ctx.sessionProjections.register(subagentCatalogProjectionDefinition)
  ctx.provide('sessionQuery', { observeSession: (id: string) => Promise.resolve({ events: logs[id] ?? [], [Symbol.dispose]() {} }) } as never)
}

/** Time of a Session's first event, when its first run began. */
const firstAt = (agent: Agent): number => agent.session.snapshotEvents()[0]!.time

describe('background jobs', () => {
  it.each([['a crash', true], ['a graceful stop', false]])('after %s, reports a job that was running exactly once, at the first step', { timeout: 60_000 }, async (_name, crash) => {
    const harness = await boot(replies(3), mountJobs)
    const handle = await harness.start(`job-${String(crash)}`)
    await turn(handle.agent, 'Start the slow check.')
    const job = startJob(harness.ctx, handle.agent, CHECK)
    const settled = handle.agent.session.snapshotEvents().filter(event => event.type === 'job/settled')
    expect(settled).toEqual([])
    const { agent } = await harness.restart(handle, crash)
    expect(agent.session.snapshotEvents().some(event => event.type === 'job/settled' && event.data.cause === 'teardown')).toBe(!crash)
    await turn(agent, 'Back.')
    await turn(agent, 'Again.')
    const text = `${HEADER}\n- Stopped by the restart, output not kept: background job ${job.id} (bash: ${CHECK}).`
    expect(notices(agent)).toEqual([{ turn: 2, text, summary: 'Restart: 1 stopped.' }])
    expect(requestTexts(harness.model, 1)).toContain(text)
    expect(requestTexts(harness.model, 2).filter(entry => entry === text)).toHaveLength(1)
  })

  it('reports jobs that finished after the last step began with their outcome', { timeout: 60_000 }, async () => {
    const harness = await boot(replies(2), mountJobs)
    const handle = await harness.start('finished')
    await turn(handle.agent, 'Start.')
    const job = startJob(harness.ctx, handle.agent, CHECK)
    job.finish()
    const killed = startJob(harness.ctx, handle.agent, 'sleep 100')
    harness.ctx.jobs.kill(killed.id, handle.agent.session.id)
    await vi.waitFor(() => { expect(handle.agent.session.snapshotEvents().filter(event => event.type === 'job/settled')).toHaveLength(2) })
    const { agent } = await harness.restart(handle, true)
    // A job started after the restart is not one the restart stopped.
    startJob(harness.ctx, agent, 'sleep 1000')
    await turn(agent, 'Back.')
    expect(notices(agent).map(notice => notice.text)).toEqual([
      [
        HEADER, `- Finished after the last step began (completed, exit code: 0), output not kept: background job ${job.id} (bash: ${CHECK}).`,
        `- Finished after the last step began (killed), output not kept: background job ${killed.id} (bash: sleep 100).`,
      ].join('\n'),
    ])
    expect(notices(agent)[0]?.summary).toBe('Restart: 2 finished.')
  })

  it('does not report a job that settled before later requests that logged no request header', { timeout: 60_000 }, async () => {
    const harness = await boot(replies(5), mountJobs)
    const handle = await harness.start('told')
    await turn(handle.agent, 'Start.')
    startJob(harness.ctx, handle.agent, 'node quick.js').finish()
    await vi.waitFor(() => { expect(handle.agent.session.snapshotEvents().some(event => event.type === 'job/settled')).toBe(true) })
    for (const text of ['Two.', 'Three.', 'Four.']) await turn(handle.agent, text)
    const events = handle.agent.session.snapshotEvents()
    const settledAt = events.find(event => event.type === 'job/settled')!.seq
    expect(events.filter(event => event.type === 'request/header' && event.seq > settledAt)).toEqual([])
    const { agent } = await harness.restart(handle, true)
    await turn(agent, 'Back.')
    expect(notices(agent)).toEqual([])
  })

  it('logs nothing when nothing stopped or finished, at the first step or any later one', { timeout: 60_000 }, async () => {
    const harness = await boot(replies(3), mountJobs)
    const handle = await harness.start('quiet')
    await turn(handle.agent, 'Start.')
    const { agent } = await harness.restart(handle)
    await turn(agent, 'Back.')
    await turn(agent, 'Again.')
    expect(notices(agent)).toEqual([])
  })
})

describe('the step the notice joins', () => {
  /** Run the pre-step chain of a resumed Agent once, ending in `decision`. */
  const preStep = (ctx: Context, agent: Agent, decision: PreStepDecision, signal = new AbortController().signal) => agentEvents(ctx, agent)
    .waterfall('agent/pre-step', { messages: [], turn: 2, step: 1, signal, modelSelection: { provider: 'fixture', model: 'fixture' } }, () => Promise.resolve(decision))

  it('adds nothing to a rejected or aborted step, and joins the next admitted one', { timeout: 60_000 }, async () => {
    const harness = await boot([], mountJobs)
    const handle = await harness.start('rejected')
    startJob(harness.ctx, handle.agent, CHECK)
    const { agent } = await harness.restart(handle, true)
    expect(await preStep(harness.ctx, agent, { kind: 'reject' })).toEqual({ kind: 'reject' })
    const aborted = new AbortController()
    aborted.abort()
    expect(await preStep(harness.ctx, agent, { kind: 'enter', messages: [] }, aborted.signal)).toEqual({ kind: 'enter', messages: [] })
    const admitted = await preStep(harness.ctx, agent, { kind: 'enter', messages: [] })
    expect(admitted.kind === 'enter' ? admitted.messages.map(message => message.source.kind) : []).toEqual(['mumbo-resume'])
  })

  it('reconciles again at the next step when the step is aborted while it reads a child\'s log', { timeout: 60_000 }, async () => {
    const reads: (() => void)[] = []
    let child: SessionEvent[] = []
    const harness = await boot([], async (ctx) => {
      await ctx.sessionProjections.register(subagentCatalogProjectionDefinition)
      // As session-query's reader does, the read checks the signal before and after it waits.
      ctx.provide('sessionQuery', {
        observeSession: async (_id: string, { signal }: { signal: AbortSignal }) => {
          signal.throwIfAborted()
          await new Promise<void>((resolve) => { reads.push(resolve) })
          signal.throwIfAborted()
          return { events: child, [Symbol.dispose]() {} }
        },
      } as never)
    })
    const warn = vi.spyOn(harness.ctx.logger, 'warn')
    const handle = await harness.start('aborted-read')
    handle.agent.session.append('subagent/catalog', { childId: SessionId('tester'), childCreatedAt: 0, version: 3, mode: 'continuable', label: 'run the slow suite', name: 'tester' } as never)
    child = new Log(firstAt(handle.agent), 0).add('turn/start', { turn: 1 }).assistant('Running the suite.').events
    const { agent } = await harness.restart(handle, true)
    const aborted = new AbortController()
    const first = preStep(harness.ctx, agent, { kind: 'enter', messages: [] }, aborted.signal)
    await vi.waitFor(() => { expect(reads).toHaveLength(1) })
    aborted.abort()
    reads[0]!()
    expect(await first).toEqual({ kind: 'enter', messages: [] })
    const second = preStep(harness.ctx, agent, { kind: 'enter', messages: [] })
    await vi.waitFor(() => { expect(reads).toHaveLength(2) })
    reads[1]!()
    const admitted = await second
    expect(admitted.kind === 'enter' ? admitted.messages.map(message => message.source.kind) : []).toEqual(['mumbo-resume'])
    expect(warn).not.toHaveBeenCalled()
  })

  it('adds no second notice to a step that claims one an outer listener returned to the inbox unlogged', { timeout: 60_000 }, async () => {
    const harness = await boot([], mountJobs)
    const handle = await harness.start('requeued')
    startJob(harness.ctx, handle.agent, CHECK)
    const { agent } = await harness.restart(handle, true)
    const first = await preStep(harness.ctx, agent, { kind: 'enter', messages: [] })
    const claimed = first.kind === 'enter' ? first.messages : []
    expect(claimed.map(message => message.source.kind)).toEqual(['mumbo-resume'])
    // A goal round's driver, outside this listener, rejected that step and put its messages back in the inbox.
    expect(await preStep(harness.ctx, agent, { kind: 'enter', messages: claimed })).toEqual({ kind: 'enter', messages: claimed })
  })
})

it('removes the block, plan_read and the notice when the plugin unloads', { timeout: 60_000 }, async () => {
  const harness = await boot(replies(1), mountJobs)
  const handle = await harness.start('unloaded')
  startJob(harness.ctx, handle.agent, CHECK)
  const { agent } = await harness.restart(handle, true)
  const contexts = async () => (await harness.ctx.systemPrompt.assemble({})).contexts.map(context => context.name)
  expect(harness.ctx.tools.get(PLAN_READ)).toBeDefined()
  expect(await contexts()).toContain(STATE_CONTEXT)
  await harness.unload()
  expect(harness.ctx.tools.get(PLAN_READ)).toBeUndefined()
  expect(await contexts()).not.toContain(STATE_CONTEXT)
  await turn(agent, 'Back.')
  expect(notices(agent)).toEqual([])
})

describe('restarts already checked', () => {
  it('compares nothing again after a plugin reload when the restart had nothing to report', { timeout: 60_000 }, async () => {
    const logs: Record<string, SessionEvent[]> = {}
    const harness = await boot(replies(4), children(logs))
    const handle = await harness.start('reloaded')
    await turn(handle.agent, 'Start.')
    const { agent } = await harness.restart(handle)
    await turn(agent, 'Back.')
    // While loaded, a one-shot child runs and finishes, and the parent gets its result.
    logs.tester = new Log(Date.now()).add('turn/start', { turn: 1 }).assistant('All green.')
      .add('turn/end', { turn: 1, reason: { kind: 'completed' } }).events
    agent.session.append('subagent/catalog', { childId: SessionId('tester'), childCreatedAt: 0, version: 1, mode: 'one-shot', label: 'run tests' } as never)
    await turn(agent, 'The tester reported: all green.')
    await harness.unload()
    await harness.ctx.plugin(MumboState)
    await turn(agent, 'Next.')
    expect(notices(agent)).toEqual([])
  })

  it('compares nothing again in this process when the first step after a quiet restart fails before its reply', { timeout: 60_000 }, async () => {
    const harness = await boot([
      textResponse('started'),
      // The goal round's request fails, as during a provider outage, so no assistant message is logged.
      () => { throw new Error('provider unavailable') },
      textResponse('answer'),
    ], async (ctx) => {
      await ctx.plugin(GoalService)
      await ctx.plugin(GoalRoundDriver)
    })
    const { ctx, model } = harness
    const handle = await harness.start('goal-outage')
    await turn(handle.agent, 'Start.')
    const { agent } = await harness.restart(handle)
    // Before any person's message, a person sets a goal and the driver starts round 1, which the restart did not stop.
    ctx.goals.create(agent, { objective: 'Ship the report', maxGoalRounds: 3 })
    await expect.poll(() => model.requests.length).toBe(2)
    await agent.whenIdle()
    // The driver disarms the goal after the failed round, and the log holds no reply after the restart.
    await expect.poll(() => ctx.goals.get(agent)?.activation).toBe('disarmed')
    expect(agent.session.snapshotEvents().filter(event => event.type === 'assistant/message')).toHaveLength(1)
    await turn(agent, 'What happened?')
    expect(notices(agent)).toEqual([])
  })

  it('reports only the latest restart on a Session that ran past earlier ones before the plugin was mounted', { timeout: 60_000 }, async () => {
    // A child an earlier restart disposed mid-turn, a day ago.
    const old = new Log(Date.now() - 86_400_000).add('turn/start', { turn: 1 })
      .add('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'disposed' } } }).events
    const harness = await boot(replies(4), async (ctx) => {
      await mountJobs(ctx)
      await children({ old })(ctx)
    })
    await harness.unload()
    const handle = await harness.start('history')
    handle.agent.session.append('subagent/catalog', { childId: SessionId('old'), childCreatedAt: 0, version: 3, mode: 'continuable', label: 'old', name: 'old' } as never)
    await turn(handle.agent, 'Start a dev server.')
    startJob(harness.ctx, handle.agent, 'npm run dev')
    const first = await harness.restart(handle)
    await turn(first.agent, 'Hello again.')
    await turn(first.agent, 'More work.')
    await harness.ctx.plugin(MumboState)
    const { agent } = await harness.restart(first, true)
    await turn(agent, 'Back.')
    expect(notices(agent)).toEqual([])
  })
})

describe('workflow runs', () => {
  it('reports runs the restart stopped and runs that finished after the last step began', { timeout: 60_000 }, async () => {
    // Session queries without a subagent catalog report no children.
    const harness = await boot(replies(2), (ctx) => {
      ctx.provide('sessionQuery', { observeSession: () => Promise.reject(new Error('no child to read')) } as never)
      return Promise.resolve()
    })
    const handle = await harness.start('runs')
    await turn(handle.agent, 'Start.')
    const session = handle.agent.session
    const runId = (id: string) => WorkflowRunId(id)
    session.append('tool-workflow/run-start', { runId: runId('r1'), name: 'review' })
    session.append('tool-workflow/agent-start', { runId: runId('r1'), seq: 1, label: 'reader', childId: SessionId('reader') })
    session.append('tool-workflow/run-start', { runId: runId('r2'), name: 'lint' })
    session.append('tool-workflow/run-end', { runId: runId('r2'), stopReason: 'error' })
    session.append('tool-workflow/run-start', { runId: runId('r3'), name: 'triage' })
    const { agent } = await harness.restart(handle, true)
    agent.session.append('tool-workflow/run-start', { runId: runId('r4'), name: 'after the restart' })
    await turn(agent, 'Back.')
    expect(notices(agent)).toEqual([{
      turn: 2,
      text: [
        HEADER, '- Stopped by the restart: workflow review, with 1 of its agents running.', '- Workflow lint finished (error) after the last step began.',
        '- Stopped by the restart: workflow triage.',
      ].join('\n'),
      summary: 'Restart: 2 stopped, 1 finished.',
    }])
  })
})

describe('subagents', () => {
  it('reads each unloaded direct child\'s log and reports the ones the restart stopped or that ended meanwhile', { timeout: 60_000 }, async () => {
    const later = Date.now() + 3_600_000
    const logs: Record<string, SessionEvent[]> = {
      // A child whose log moved after this Session's load, as when another process ran it, was not stopped by the restart.
      moved: new Log(later).add('turn/start', { turn: 1 }).assistant('Running elsewhere.').events,
      reviewer: new Log(later).add('turn/start', { turn: 1 }).assistant('Looks right.').assistant('Approved: the parser change is safe.')
        .add('turn/end', { turn: 1, reason: { kind: 'completed' } }).events,
      quiet: new Log(later).add('turn/start', { turn: 1 }).user('Only a question.').add('assistant/message', {
        turn: 1, step: 1, stream: [], message: createAssistantMessage({
          content: [{ type: 'tool-call', id: ToolCallId('c'), name: 'read', arguments: '{}' }], source: { provider: 'mock', model: 'mock' },
        }),
      }).add('turn/end', { turn: 1, reason: { kind: 'completed' } }).events,
      verbose: new Log(later).add('turn/start', { turn: 1 }).assistant('v'.repeat(500)).add('turn/end', { turn: 1, reason: { kind: 'completed' } }).events,
      failed: new Log(later).add('turn/start', { turn: 1 }).add('turn/end', { turn: 1, reason: { kind: 'blocked' } }).events,
      cancelled: new Log(later).add('turn/start', { turn: 1 }).add('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } }).events,
      earlier: new Log(0).add('turn/start', { turn: 1 }).add('turn/end', { turn: 1, reason: { kind: 'completed' } }).events,
    }
    const read: string[] = []
    const harness = await boot(replies(2), async (ctx) => {
      await ctx.sessionProjections.register(subagentCatalogProjectionDefinition)
      ctx.provide('sessionQuery', {
        observeSession: (id: string) => {
          read.push(id)
          const events = logs[id]
          return events === undefined ? Promise.reject(new Error(`session ${id} not found`)) : Promise.resolve({ events, [Symbol.dispose]() {} })
        },
      } as never)
    })
    const warn = vi.spyOn(harness.ctx.logger, 'warn')
    const live = await harness.start('live')
    const handle = await harness.start('parent')
    await turn(handle.agent, 'Start.')
    // Children the restart stopped, in the run it ended.
    const run = () => new Log(firstAt(handle.agent), 0).add('turn/start', { turn: 1 })
    logs.tester = run().assistant('Running the suite.').events
    logs.crashed = run().add('turn/end', { turn: 1, reason: { kind: 'interrupted' } }).events
    const catalog = (childId: string, entry: object) => {
      handle.agent.session.append('subagent/catalog', { childId: SessionId(childId), childCreatedAt: 0, ...entry } as never)
    }
    catalog('tester', { version: 3, mode: 'continuable', label: 'run the slow suite', name: 'tester' })
    catalog('reviewer', { version: 3, mode: 'continuable', label: 'review the parser', name: 'reviewer' })
    catalog('quiet', { version: 1, mode: 'one-shot' })
    catalog('verbose', { version: 1, mode: 'one-shot', label: 'talk' })
    catalog('crashed', { version: 1, mode: 'one-shot', label: 'scan' })
    catalog('failed', { version: 1, mode: 'one-shot', label: 'fail' })
    catalog('cancelled', { version: 1, mode: 'one-shot', label: 'stop' })
    catalog('earlier', { version: 1, mode: 'one-shot', label: 'old' })
    catalog('missing', { version: 1, mode: 'one-shot', label: 'gone' })
    catalog('moved', { version: 3, mode: 'continuable', label: 'elsewhere', name: 'moved' })
    catalog(String(live.agent.id), { version: 3, mode: 'continuable', label: 'still here', name: 'live' })
    catalog('remote', { version: 3, mode: 'external', name: 'remote' })
    const { agent } = await harness.restart(handle, true)
    await turn(agent, 'Back.')
    expect(read).toEqual(['tester', 'reviewer', 'quiet', 'verbose', 'crashed', 'failed', 'cancelled', 'earlier', 'missing', 'moved'])
    expect(notices(agent)).toEqual([{
      turn: 2,
      text: [
        HEADER,
        '- Subagent tester stopped mid-task by the restart. Use send_message to tester to continue it.',
        '- Subagent reviewer finished while this Session was not loaded. Its last message: "Approved: the parser change is safe."',
        '- Subagent quiet finished while this Session was not loaded.',
        `- Subagent talk finished while this Session was not loaded. Its last message: "${'v'.repeat(399)}…"`,
        '- Subagent scan stopped mid-task by the restart.',
        '- Subagent fail ended (blocked) while this Session was not loaded.',
        '- Subagent stop ended (aborted) while this Session was not loaded.',
      ].join('\n'),
      summary: 'Restart: 2 stopped, 5 finished.',
    }])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('subagent missing of parent is left out of the resume notice'))
  })

  it('reports a child stopped in the run a restart ended once, at that restart and not after the next, also when it stopped before the last message', { timeout: 60_000 }, async () => {
    // The parent's log from an hour ago: it started two children, waited for them, and its last message is at base + 5000.
    const base = Date.now() - 3_600_000
    const seed = new Log(base)
    for (const name of ['disposed', 'crashed']) {
      seed.add('subagent/catalog', { childId: SessionId(name), childCreatedAt: 0, version: 3, mode: 'continuable', label: name, name } as never)
    }
    seed.add('turn/start', { turn: 1 }).user('Wait for them.').assistant('Waiting.').add('turn/end', { turn: 1, reason: { kind: 'completed' } })
    // The child's last event was a long tool call.
    const running = new Log(base + 1000).add('turn/start', { turn: 1 }).assistant('Running the suite.').call('c1', 'bash', '{"command":"npm test"}').events
    const harness = await boot(replies(2), children({
      // A shutdown that disposes every Agent at once can end the child's turn before the parent logs its last message.
      disposed: new Log(base + 1000).add('turn/start', { turn: 1 }).add('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'disposed' } } }).events,
      // After a crash, session-query's read closes the open turn at the child's last event.
      crashed: [...running, ...interruptedTurnClosers(running)],
    }))
    // The first restart: the host loads the parent from its log.
    const first = await harness.ctx.agents.create({ sessionId: SessionId('waiting'), seed: seed.events, agentOptions: OPTIONS })
    await turn(first.agent, 'Back.')
    const { agent } = await harness.restart(first, true)
    await turn(agent, 'Back again.')
    expect(notices(agent)).toEqual([{
      turn: 2,
      text: [
        HEADER, '- Subagent disposed stopped mid-task by the restart. Use send_message to disposed to continue it.',
        '- Subagent crashed stopped mid-task by the restart. Use send_message to crashed to continue it.',
      ].join('\n'),
      summary: 'Restart: 2 stopped.',
    }])
  })

  it('never reports a child idle since before this Session\'s first event', { timeout: 60_000 }, async () => {
    const harness = await boot(replies(3), children({
      old: new Log(Date.now() - 86_400_000).add('turn/start', { turn: 1 })
        .add('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'disposed' } } }).events,
    }))
    const handle = await harness.start('idle')
    handle.agent.session.append('subagent/catalog', { childId: SessionId('old'), childCreatedAt: 0, version: 3, mode: 'continuable', label: 'old', name: 'old' } as never)
    await turn(handle.agent, 'Start.')
    const first = await harness.restart(handle, true)
    await turn(first.agent, 'Back.')
    const { agent } = await harness.restart(first, true)
    await turn(agent, 'Back again.')
    expect(notices(agent)).toEqual([])
  })
})
