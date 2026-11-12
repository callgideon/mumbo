/** The K and K3 evals' key resolution, options and measures; the evals themselves only run on demand against the live API. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GoalId } from '@deepseek-ai/dsh-goal'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { evalOptions, k3Options, type LoggedEvent, measureK3, measureRun, median, premature, resolveDeepSeekEnv } from '../eval/measures.ts'
import { Log } from './events.ts'

describe('resolveDeepSeekEnv', () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'k-eval-env-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('fails before any run without a key in the environment or the file', () => {
    expect(() => resolveDeepSeekEnv({}, join(dir, '.env'))).toThrow(/needs DEEPSEEK_API_KEY/u)
  })

  it('reads the file when the environment sets nothing, and the environment wins', async () => {
    const file = join(dir, '.env')
    await writeFile(file, 'DEEPSEEK_API_KEY=from-file\nDEEPSEEK_BASE_URL=http://127.0.0.1:9\n')
    expect(resolveDeepSeekEnv({}, file)).toEqual({ DEEPSEEK_API_KEY: 'from-file', DEEPSEEK_BASE_URL: 'http://127.0.0.1:9' })
    expect(resolveDeepSeekEnv({ DEEPSEEK_API_KEY: 'from-env' }, file)).toMatchObject({ DEEPSEEK_API_KEY: 'from-env' })
  })
})

describe('evalOptions', () => {
  it('defaults to three runs of every arm and eight turns, on the profile model', () => {
    expect(evalOptions({})).toEqual({ runs: 3, arms: ['control', 'k-on', 'k-off'], maxTurns: 8 })
  })

  it('rejects an unknown arm and a turn budget below three', () => {
    expect(() => evalOptions({ K_EVAL_ARMS: 'k-on,k-maybe' })).toThrow(/k-maybe/u)
    expect(() => evalOptions({ K_EVAL_MAX_TURNS: '2' })).toThrow(/K_EVAL_MAX_TURNS/u)
  })
})

const call = (name: string, args: Record<string, unknown>): LoggedEvent => ({ type: 'tool/call', data: { name, arguments: JSON.stringify(args) } })
const step: LoggedEvent = { type: 'step/start' }

describe('measureRun', () => {
  it('counts repeated reads, steps to a change, stale job calls and a rerun check after each boundary', () => {
    const measures = measureRun([
      [step, call('exit_plan_mode', { plan: '# Plan' }), step, call('read', { path: 'src/inventory.mjs' }),
        call('bash', { command: 'node scripts/slow-check.mjs', run_in_background: true }),
        { type: 'job/registered', data: { jobId: 'job-1' } },
        { type: 'assistant/message', data: { usage: { inputTokens: 10, outputTokens: 2 } } }, { type: 'turn/end' }],
      [{ type: 'compaction/summary', data: { llmStreamCall: true, usage: { inputTokens: 5, outputTokens: 1 } } }],
      [step, call('read', { path: 'src/inventory.mjs' }), step, call('edit', { path: 'src/inventory.mjs' }), { type: 'turn/end' }],
      [step, call('job_output', { job_id: 'job-1' }), call('bash', { description: 'again', command: 'cat data/stock.csv' }),
        step, call('bash', { command: 'node scripts/slow-check.mjs' }), { type: 'turn/end' }],
    ], { compaction: 2, restart: 3 })
    expect(measures).toEqual({
      compaction: { rederivations: 1, stepsToProductive: 2 },
      restart: { rederivations: 0, stepsToProductive: 2, staleJobCalls: 1, reranCheck: true },
      requests: 2, inputTokens: 15, outputTokens: 3, turns: 3,
    })
  })

  it('takes the median of the runs that have a value', () => {
    expect(median([3, null, 1, 2])).toBe(2)
    expect(median([4, 1])).toBe(2.5)
    expect(median([null])).toBeNull()
  })
})

describe('k3Options', () => {
  it('defaults to five runs of both arms on all three tasks, with ten rounds, on the profile model', () => {
    expect(k3Options({})).toEqual({ runs: 5, arms: ['k3-on', 'k3-off'], tasks: ['stuck', 'progress', 'shell-only'], maxRounds: 10 })
    expect(k3Options({ K3_EVAL_TASKS: 'shell-only, stuck', K3_EVAL_ARMS: 'k3-on', K_EVAL_MODEL: 'deepseek-v4-pro', K3_EVAL_RUNS: '1' }))
      .toEqual({ runs: 1, arms: ['k3-on'], tasks: ['stuck', 'shell-only'], model: 'deepseek-v4-pro', maxRounds: 10 })
  })

  it('rejects an unknown task and a round cap below three', () => {
    expect(() => k3Options({ K3_EVAL_TASKS: 'stuck,idle' })).toThrow(/K3_EVAL_TASKS names unknown tasks: idle/u)
    expect(() => k3Options({ K3_EVAL_MAX_ROUNDS: '2' })).toThrow(/K3_EVAL_MAX_ROUNDS/u)
  })
})

describe('measureK3', () => {
  const source = (round: number) => ({ kind: 'goal', goalId: GoalId('g'), revision: 1, round }) as const
  /** Rounds 1 and 2 repeat a failing `cat` and a failed `read`; round 3, carrying `blocks`, writes a file. */
  const run = (blocks: string[]): Log => {
    const stuck = (log: Log, id: string): Log => log.ran(`${id}c`, 'bash', { command: 'cat key' }, 'missing')
      .call(`${id}r`, 'read', '{"file_path":"key"}').result(`${id}r`, true)
    const log = stuck(stuck(new Log().goal('create').round(1), '1').round(2), '2')
      .add('user/message', createUserMessage({ content: ['<goal_round>', ...blocks].map(text => ({ type: 'text', text })), source: source(3) }))
      .ran('w', 'write', { file_path: 'key', content: 'x' })
    log.add('assistant/message', {
      turn: 1, step: 1, stream: [], usage: { inputTokens: 100, outputTokens: 7 },
      message: createAssistantMessage({ content: [{ type: 'text', text: 'Blocked.' }], source: { provider: 'mock', model: 'mock' } }),
    })
    const goal = { id: GoalId('g'), revision: 2, objective: 'Ship it', phase: 'blocked' as const, maxGoalRounds: 8, blockedReason: { code: 'model-reported', message: 'No key.' } }
    return log.add('goal/change', { kind: 'goal/change', version: 1, operation: 'block', goal, roundsStarted: 3, createdAt: 0, updatedAt: 0 })
  }

  it('counts the rounds, the questions shown, the stalled rounds, repeats and errors, and how the goal ended', () => {
    expect(measureK3(run(['<goal_progress_check>\n…']).events, 'k3-on')).toEqual({
      rounds: 3, endedBy: 'model-reported', questionsShown: 1, firstStallRound: 3, roundsAfterStall: 1, stalledRounds: 2, repeats: 2,
      toolErrors: 2, requests: 1, inputTokens: 100, outputTokens: 7,
    })
  })

  it('takes the first stalled round from the logged questions with the check on, and from the fold with it off', () => {
    const quiet = run([]).events
    expect(measureK3(quiet, 'k3-on')).toMatchObject({ questionsShown: 0, firstStallRound: null, roundsAfterStall: null })
    expect(measureK3(quiet, 'k3-off')).toMatchObject({ questionsShown: 0, firstStallRound: 3, roundsAfterStall: 1 })
  })

  it('reads a completed goal, and an open one as not ended', () => {
    expect(measureK3(new Log().goal('create').round(1).goal('complete').events, 'k3-on')).toMatchObject({ rounds: 1, endedBy: 'complete', stalledRounds: 1 })
    expect(measureK3(new Log().goal('block').goal('resume').round(1).events, 'k3-on')).toMatchObject({ endedBy: 'none', stalledRounds: 1 })
    expect(measureK3(new Log().goal('block').events, 'k3-on').endedBy).toBe('none')
  })

  it('calls a shell-only run premature when it completed before all four migrations, or reported a block', () => {
    expect(premature('complete', 3)).toBe(true)
    expect(premature('complete', 4)).toBe(false)
    expect(premature('model-reported', 4)).toBe(true)
    expect(premature('round-limit', 2)).toBe(false)
  })
})
