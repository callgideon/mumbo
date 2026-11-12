/** The K eval's key resolution, options and measures; the eval itself only runs on demand against the live API. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { evalOptions, type LoggedEvent, measureRun, median, resolveDeepSeekEnv } from '../eval/measures.ts'

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
