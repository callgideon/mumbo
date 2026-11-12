/**
 * The stall listener in a real agent loop with the real goal service and goal round driver, mounted before this plugin
 * as in production; only the model is scripted.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import GoalService from '@deepseek-ai/dsh-goal'
import type { GoalView } from '@deepseek-ai/dsh-goal'
import * as GoalRoundDriver from '@deepseek-ai/dsh-goal-round-driver'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import type { Config } from '../src/index.ts'
import { initRounds, roundsSchema } from '../src/stall.ts'
import { boot, type Harness, requestTexts, turn } from './harness.ts'

/** Mount the goal service and its round driver, which the base bundle mounts before this plugin. */
async function mountGoals(ctx: Context): Promise<void> {
  await ctx.plugin(GoalService)
  await ctx.plugin(GoalRoundDriver)
}

/** Three text-only rounds, then the round limit blocks the goal. */
async function runRounds(harness: Harness): Promise<Agent> {
  const { agent } = await harness.start('stall')
  harness.ctx.goals.create(agent, { objective: 'Ship it', maxGoalRounds: 3 })
  await vi.waitFor(() => { expect(harness.ctx.goals.get(agent)?.phase).toBe('blocked') })
  return agent
}

/** The logged goal round messages. */
function rounds(agent: Agent): UserMessage[] {
  return agent.session.snapshotEvents().flatMap(event => event.type === 'user/message' && event.data.source.kind === 'goal' ? [event.data] : [])
}

/** Whether the `mumboRounds` key is free: a unit at another state version cannot share it. */
async function roundsKeyFree(ctx: Context): Promise<boolean> {
  return ctx.sessionProjections.register({ key: 'mumboRounds', stateVersion: 2, stateSchema: roundsSchema, init: initRounds, apply: state => state })
    .then(() => true, () => false)
}

/** The plugin's defaults with the stall check on. */
const ON: Config = { maxChars: 1600, stallCheck: true, stallRounds: 2 }

const THIRD = 'The last 2 rounds of this goal (1 to 2) showed no progress that this check can see. In those two rounds you made no tool call.'

describe('the stall listener', () => {
  it('appends the questions to round 3 after two stalled rounds, keeping its id and source, and the request carries them', async () => {
    const harness = await boot([textResponse('one'), textResponse('two'), textResponse('three'), textResponse('ok')], mountGoals, ON)
    const queued: UserMessage[] = []
    harness.ctx.on('agent/inbox/inserted', ({ message }) => { if (message.source.kind === 'goal') queued.push(message) })
    const agent = await runRounds(harness)
    const logged = rounds(agent)
    expect(logged.map(message => message.content.length)).toEqual([1, 1, 2])
    expect(logged.map(({ id, source }) => ({ id, source }))).toEqual(queued.map(({ id, source }) => ({ id, source })))
    expect(logged.map(message => message.content[0])).toEqual(queued.map(message => message.content[0]))
    const block = logged[2]!.content[1]
    const text = block?.type === 'text' ? block.text : ''
    expect(text).toContain(`<goal_progress_check>\n${THIRD}\n`)
    expect(harness.ctx.goals.get(agent)).toMatchObject<Partial<GoalView>>({ roundsStarted: 3 })
    expect(requestTexts(harness.model, 1).join('\n')).not.toContain('<goal_progress_check>')
    expect(requestTexts(harness.model, 2)).toContain(text)
    await turn(agent, 'Thanks.')
    expect(rounds(agent).map(message => message.content.length)).toEqual([1, 1, 2])
    expect(requestTexts(harness.model, 3)).toContain('Thanks.')
  })

  it('leaves a step that a later listener rejects unlogged', async () => {
    const harness = await boot([textResponse('one'), textResponse('two')], mountGoals, ON)
    harness.ctx.on('agent/pre-step', ({ messages }, next) => messages.some(message => message.source.kind === 'goal' && message.source.round === 3)
      ? Promise.resolve({ kind: 'reject' as const })
      : next())
    const agent = await runRounds(harness)
    expect(rounds(agent).map(message => message.content.length)).toEqual([1, 1])
    expect(harness.ctx.goals.get(agent)?.blockedReason?.code).toBe('prompt-rejected')
    expect(harness.model.requests).toHaveLength(2)
  })

  it('registers neither the projection nor the listener by default, and removes both when unloaded', async () => {
    const off = await boot([textResponse('one'), textResponse('two'), textResponse('three')], mountGoals)
    expect(rounds(await runRounds(off)).map(message => message.content.length)).toEqual([1, 1, 1])
    expect(await roundsKeyFree(off.ctx)).toBe(true)
    const on = await boot([], mountGoals, ON)
    expect(await roundsKeyFree(on.ctx)).toBe(false)
    await on.unload()
    expect(await roundsKeyFree(on.ctx)).toBe(true)
  })
})
