/**
 * Live DeepSeek eval of the state block and the resume notice (K1, K2): does the agent re-derive less and get back to
 * work sooner after a compaction and a restart when `@mumbo/state` is mounted? On demand only, never in CI:
 * `pnpm --filter @mumbo/state run eval`. It spends real API quota and runs the model's commands with full access in a
 * temporary workspace.
 * @module @mumbo/state/eval/k
 */

import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { DeepSeekHarness, type HarnessSession, type RunResult, type SdkUserQuestionRequest, type SdkUserQuestionResult } from '@deepseek-ai/dsh-sdk-client'
import { it } from 'vitest'
import {
  type Arm, type BoundarySegments, type LoggedEvent, type RunMeasures, evalOptions, measureRun, median, resolveDeepSeekEnv,
} from './measures.ts'

const FIXTURE = fileURLToPath(new URL('./fixture/', import.meta.url))
const RESULTS = fileURLToPath(new URL('./results/', import.meta.url))
const STATE_OVERLAY = fileURLToPath(new URL('../examples/person.overlay.yml', import.meta.url))
const ROOT_ENV = fileURLToPath(new URL('../../../../.env', import.meta.url))

const TASK = 'Fix the inventory project in this directory until `node --test` passes. Track the work with todo_write and '
  + 'keep it current. Feature four needs the checksum that `node scripts/slow-check.mjs` prints after about two minutes: '
  + 'once the plan is approved, start it early in the background (bash with run_in_background), work on the other '
  + 'features meanwhile, and write the checksum it prints to checksum.txt. Do not change the tests.'
const CONTINUE = 'Continue with the plan.'

// Fails here, before any run, without a key.
const deepseek = resolveDeepSeekEnv(process.env, ROOT_ENV)
const options = evalOptions(process.env)
const execFileAsync = promisify(execFile)

/** Approve every plan review; refuse any other question, since the eval plays a person who only approves. */
async function approvePlans(request: SdkUserQuestionRequest): Promise<SdkUserQuestionResult> {
  const question = request.questions[0]
  if (request.questions.length !== 1 || question?.intent?.kind !== 'plan-review') return { cancelled: true }
  return { answers: [{ id: question.id, selected: ['Approve'] }] }
}

/** Whether the workspace passes the fixture's own tests, which the model may have changed. */
async function accepted(cwd: string): Promise<boolean> {
  const check = join(cwd, '.k-eval-check')
  await cp(join(FIXTURE, 'test'), check, { recursive: true })
  // A failing or hung test makes execFile reject: that is the answer, not an eval error.
  const passed = await execFileAsync(process.execPath, ['--test', join(check, 'inventory.test.mjs')], { cwd, timeout: 60_000 }).then(() => true, () => false)
  await rm(check, { recursive: true, force: true })
  return passed
}

/** One run's measures and the facts around them. */
interface RunSummary extends RunMeasures {
  readonly arm: Arm
  readonly run: number
  readonly accepted: boolean
  readonly wallMs: number
}

/**
 * Play one run: plan, compaction, a turn, restart, then turns until the tests pass or the turn budget ends.
 * @param arm - which boundaries to force and whether K is mounted.
 * @param run - the run's index within its arm.
 * @param out - the directory that keeps this run's events and Session files.
 * @returns the run's summary.
 */
async function playRun(arm: Arm, run: number, out: string): Promise<RunSummary> {
  const root = await mkdtemp(join(tmpdir(), `k-eval-${arm}-`))
  const cwd = join(root, 'workspace')
  const dshHome = join(root, '.dsh')
  await cp(FIXTURE, cwd, { recursive: true })
  const create = (): DeepSeekHarness => new DeepSeekHarness({
    cwd, processCwd: cwd, dshHome, profile: 'sdk',
    env: { ...process.env, ...deepseek, DSH_PERMISSION_MODE: 'danger-full-access', DSH_TELEMETRY_DISABLED: '1' },
    patches: arm === 'k-off' ? [] : [STATE_OVERLAY],
    ...options.model === undefined ? {} : { model: options.model },
    onUserQuestion: approvePlans,
    initializeTimeoutMs: 120_000,
    requestTimeoutMs: 30 * 60_000,
  })
  const forced = arm !== 'control'
  const segments: LoggedEvent[][] = []
  const started = Date.now()
  let harness = create()
  try {
    await harness.start()
    let session: HarnessSession = harness.session(`k-eval-${arm}-${String(run)}`)
    const send = async (input: string): Promise<RunResult> => {
      const result = await session.run(input)
      // A JSON copy reads the SDK's typed events as plain records.
      segments.push(JSON.parse(JSON.stringify(result.events)) as LoggedEvent[])
      return result
    }
    await send(`/plan ${TASK}`)
    if (forced) await send('/compact')
    const compaction = segments.length
    await send(CONTINUE)
    if (forced) {
      await harness.close()
      harness = create()
      await harness.start()
      session = await harness.resumeSession(session.id)
    }
    const boundaries: BoundarySegments = { compaction, restart: segments.length }
    let done = false
    for (let turn = 3; turn <= options.maxTurns && !done; turn++) {
      await send(CONTINUE)
      done = await accepted(cwd)
    }
    await harness.close()
    await writeFile(join(out, 'events.jsonl'), segments.flat().map(event => JSON.stringify(event)).join('\n') + '\n')
    await cp(join(dshHome, 'sessions'), join(out, 'sessions'), { recursive: true })
    return { arm, run, ...measureRun(segments, boundaries), accepted: done, wallMs: Date.now() - started }
  } finally {
    await harness.close()
    await rm(root, { recursive: true, force: true })
  }
}

/** The numbers the eval compares across arms. */
const METRICS: Readonly<Record<string, (run: RunSummary) => number | null>> = {
  'compaction rederivations': run => run.compaction.rederivations,
  'compaction steps to productive': run => run.compaction.stepsToProductive,
  'restart rederivations': run => run.restart.rederivations,
  'restart steps to productive': run => run.restart.stepsToProductive,
  'restart stale job calls': run => run.restart.staleJobCalls,
  'restart reran the check': run => Number(run.restart.reranCheck),
  accepted: run => Number(run.accepted),
  requests: run => run.requests,
  'input tokens': run => run.inputTokens,
  'output tokens': run => run.outputTokens,
  turns: run => run.turns,
  'wall ms': run => run.wallMs,
}

it('compares K on, K off and a control across a compaction and a restart', async () => {
  const out = join(RESULTS, new Date().toISOString().replaceAll(':', '-'))
  const runs: RunSummary[] = []
  for (let run = 0; run < options.runs; run++) {
    for (const arm of options.arms) {
      const dir = join(out, `${arm}-${String(run)}`)
      await mkdir(dir, { recursive: true })
      runs.push(await playRun(arm, run, dir))
    }
  }
  const medians = Object.fromEntries(options.arms.map(arm => [arm, Object.fromEntries(Object.entries(METRICS)
    .map(([name, metric]) => [name, median(runs.filter(run => run.arm === arm).map(metric))]))]))
  const delta = (from: Arm, to: Arm): Record<string, number | null> => Object.fromEntries(Object.keys(METRICS).map((name) => {
    const a = medians[from]?.[name]
    const b = medians[to]?.[name]
    return [name, a === undefined || a === null || b === undefined || b === null ? null : a - b]
  }))
  const summary = { options, medians, deltas: { 'k-on - k-off': delta('k-on', 'k-off'), 'k-on - control': delta('k-on', 'control') }, runs }
  await writeFile(join(out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
  console.log(`K eval results: ${out}`)
  console.table(medians)
  console.table(summary.deltas)
})
