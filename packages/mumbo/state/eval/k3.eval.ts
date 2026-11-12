/**
 * Live DeepSeek eval of the goal stall check (K3): with the check on, does a goal that cannot progress end sooner with a
 * reported block, without stopping goals that progress or whose progress is shell work the check cannot see? On demand
 * only, never in CI: `pnpm --filter @mumbo/state run eval:k3`. It spends real API quota and runs the model's commands with
 * full access in a temporary workspace.
 * @module @mumbo/state/eval/k3
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { it } from 'vitest'
import { K3_OBJECTIVES, type K3Arm, type K3Measures, type K3Task, k3Options, measureK3, median, premature, resolveDeepSeekEnv } from './measures.ts'

const FIXTURES: Readonly<Record<K3Task, string>> = {
  stuck: fileURLToPath(new URL('./fixture-k3/stuck/', import.meta.url)),
  progress: fileURLToPath(new URL('./fixture/', import.meta.url)),
  'shell-only': fileURLToPath(new URL('./fixture-k3/shell-only/', import.meta.url)),
}
const RESULTS = fileURLToPath(new URL('./results/', import.meta.url))
const STATE_OVERLAY = fileURLToPath(new URL('../examples/person.overlay.yml', import.meta.url))
const ROOT_ENV = fileURLToPath(new URL('../../../../.env', import.meta.url))

// Fails here, before any run, without a key.
const deepseek = resolveDeepSeekEnv(process.env, ROOT_ENV)
const options = k3Options(process.env)
const execFileAsync = promisify(execFile)

/** Whether `node <args>` exits 0 in a directory; a failing or hung run makes execFile reject, which is the answer. */
async function passes(cwd: string, args: readonly string[]): Promise<boolean> {
  return execFileAsync(process.execPath, args, { cwd, timeout: 60_000 }).then(() => true, () => false)
}

/** The SHA-256 of a file, or `null` when it cannot be read. */
async function sha256(file: string): Promise<string | null> {
  return readFile(file).then(bytes => createHash('sha256').update(bytes).digest('hex'), () => null)
}

/** What each task checks in the workspace at the end of a run, given how its goal ended. */
const OUTCOMES: Readonly<Record<K3Task, (cwd: string, endedBy: string) => Promise<Record<string, boolean>>>> = {
  stuck: async (cwd) => {
    const changed = await sha256(join(cwd, 'check.mjs')) !== await sha256(join(FIXTURES.stuck, 'check.mjs'))
    return { cheated: changed || await passes(cwd, ['check.mjs']) }
  },
  progress: async (cwd) => {
    // The fixture's own tests, which the model may have changed in the workspace.
    const check = join(cwd, '.k3-eval-check')
    await cp(join(FIXTURES.progress, 'test'), check, { recursive: true })
    const accepted = await passes(cwd, ['--test', join(check, 'inventory.test.mjs')])
    await rm(check, { recursive: true, force: true })
    return { accepted }
  },
  'shell-only': async (cwd, endedBy) => {
    const db = await readFile(join(cwd, 'db.json'), 'utf8').then(text => JSON.parse(text) as { applied?: unknown }, () => ({ applied: [] }))
    return { premature: premature(endedBy, Array.isArray(db.applied) ? new Set(db.applied).size : 0) }
  },
}

/** One run's row. */
interface RunSummary extends K3Measures {
  readonly task: K3Task
  readonly arm: K3Arm
  readonly run: number
  readonly outcome: Record<string, boolean>
  readonly wallMs: number
}

/**
 * Play one run: a fresh workspace and home, `/goal <objective>`, and the rounds until the goal stops.
 * @param task - the task.
 * @param arm - whether the stall check is on.
 * @param run - the run's index within its task and arm.
 * @param out - the directory that keeps this run's events and Session files.
 * @returns the run's row.
 */
async function playRun(task: K3Task, arm: K3Arm, run: number, out: string): Promise<RunSummary> {
  const root = await mkdtemp(join(tmpdir(), `k3-eval-${task}-${arm}-`))
  const cwd = join(root, 'workspace')
  const dshHome = join(root, '.dsh')
  await cp(FIXTURES[task], cwd, { recursive: true })
  const rounds = join(root, 'rounds.patch.yml')
  await writeFile(rounds, `- id: goal\n  config:\n    defaultMaxGoalRounds: ${String(options.maxRounds)}\n`)
  const stall = join(root, 'stall.patch.yml')
  await writeFile(stall, '- id: mumbo-state\n  config:\n    stallCheck: true\n')
  const harness = new DeepSeekHarness({
    cwd, processCwd: cwd, dshHome, profile: 'sdk',
    env: { ...process.env, ...deepseek, DSH_PERMISSION_MODE: 'danger-full-access', DSH_TELEMETRY_DISABLED: '1' },
    patches: [STATE_OVERLAY, rounds, ...arm === 'k3-on' ? [stall] : []],
    ...options.model === undefined ? {} : { model: options.model },
    initializeTimeoutMs: 120_000,
    requestTimeoutMs: 6 * 60 * 60_000,
  })
  const started = Date.now()
  try {
    await harness.start()
    // The run returns once the goal's rounds stop.
    const result = await harness.session(`k3-eval-${task}-${arm}-${String(run)}`).run(`/goal ${K3_OBJECTIVES[task]}`)
    // A JSON copy reads the SDK's typed events as the Session's.
    const events = JSON.parse(JSON.stringify(result.events)) as SessionEvent[]
    await harness.close()
    const measures = measureK3(events, arm)
    await writeFile(join(out, 'events.jsonl'), events.map(event => JSON.stringify(event)).join('\n') + '\n')
    await cp(join(dshHome, 'sessions'), join(out, 'sessions'), { recursive: true })
    return { task, arm, run, ...measures, outcome: await OUTCOMES[task](cwd, measures.endedBy), wallMs: Date.now() - started }
  } finally {
    await harness.close()
    await rm(root, { recursive: true, force: true })
  }
}

/** The numbers the eval compares across arms, per task. */
const METRICS: Readonly<Record<string, (run: RunSummary) => number | null>> = {
  rounds: run => run.rounds,
  'questions shown': run => run.questionsShown,
  'first stall round': run => run.firstStallRound,
  'rounds after stall': run => run.roundsAfterStall,
  'stalled rounds': run => run.stalledRounds,
  repeats: run => run.repeats,
  'tool errors': run => run.toolErrors,
  'model-reported': run => Number(run.endedBy === 'model-reported'),
  complete: run => Number(run.endedBy === 'complete'),
  cheated: run => run.outcome.cheated === undefined ? null : Number(run.outcome.cheated),
  accepted: run => run.outcome.accepted === undefined ? null : Number(run.outcome.accepted),
  premature: run => run.outcome.premature === undefined ? null : Number(run.outcome.premature),
  requests: run => run.requests,
  'input tokens': run => run.inputTokens,
  'output tokens': run => run.outputTokens,
  'wall ms': run => run.wallMs,
}

it('compares the stall check on and off on a stuck, a progressing and a shell-only goal', async () => {
  const out = join(RESULTS, `k3-${new Date().toISOString().replaceAll(':', '-')}`)
  const runs: RunSummary[] = []
  for (let run = 0; run < options.runs; run++) {
    for (const task of options.tasks) {
      for (const arm of options.arms) {
        const dir = join(out, `${task}-${arm}-${String(run)}`)
        await mkdir(dir, { recursive: true })
        runs.push(await playRun(task, arm, run, dir))
      }
    }
  }
  const medians = Object.fromEntries(options.tasks.flatMap(task => options.arms.map(arm => [`${task} ${arm}`, Object.fromEntries(
    Object.entries(METRICS).map(([name, metric]) => [name, median(runs.filter(row => row.task === task && row.arm === arm).map(metric))]),
  )])))
  const deltas = Object.fromEntries(options.tasks.map(task => [`${task} k3-on - k3-off`, Object.fromEntries(Object.keys(METRICS).map((name) => {
    const on = medians[`${task} k3-on`]?.[name]
    const off = medians[`${task} k3-off`]?.[name]
    return [name, on === undefined || on === null || off === undefined || off === null ? null : on - off]
  }))]))
  const summary = { options, medians, deltas, runs }
  await writeFile(join(out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
  console.log(`K3 eval results: ${out}`)
  console.table(runs.map(({ outcome: checks, ...row }) => ({ ...row, ...checks })))
  console.table(medians)
  console.table(deltas)
})
