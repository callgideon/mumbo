/**
 * The K and K3 evals' inputs and measures: the DeepSeek key and options they read, and what they compute from one run's
 * Session events. Pure apart from reading the `.env` file it is given.
 * @module @mumbo/state/eval/measures
 */

import { existsSync, readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { foldRounds, initRounds, type Rounds, stalled, stallText } from '../src/stall.ts'

/** The DeepSeek route the eval's runtimes use. */
export interface DeepSeekEnv {
  readonly DEEPSEEK_API_KEY: string
  readonly DEEPSEEK_BASE_URL?: string
}

/**
 * Read the DeepSeek key, and the optional base URL, from the environment, else from an `.env` file.
 * @param env - the process environment; its values win over the file's.
 * @param envFile - the `.env` file to read when it exists.
 * @returns the key and the base URL when one is set.
 * @throws when neither the environment nor the file sets `DEEPSEEK_API_KEY`.
 */
export function resolveDeepSeekEnv(env: Readonly<Record<string, string | undefined>>, envFile: string): DeepSeekEnv {
  const file = existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {}
  const key = env.DEEPSEEK_API_KEY ?? file.DEEPSEEK_API_KEY
  if (key === undefined || key === '') {
    throw new Error(`The K eval needs DEEPSEEK_API_KEY, in the environment or in ${envFile}.`)
  }
  const baseUrl = env.DEEPSEEK_BASE_URL ?? file.DEEPSEEK_BASE_URL
  return { DEEPSEEK_API_KEY: key, ...baseUrl === undefined || baseUrl === '' ? {} : { DEEPSEEK_BASE_URL: baseUrl } }
}

/** The eval's arms: `control` mounts K and forces no boundary; `k-on` and `k-off` force both, with and without K. */
export const ARMS = ['control', 'k-on', 'k-off'] as const
/** One arm. */
export type Arm = typeof ARMS[number]

/** What the environment chose for one eval. */
export interface EvalOptions {
  /** Runs per arm (`K_EVAL_RUNS`, default 3). */
  readonly runs: number
  /** Arms to run, interleaved (`K_EVAL_ARMS`, default all three). */
  readonly arms: readonly Arm[]
  /** Model for every runtime (`K_EVAL_MODEL`); absent selects the sdk profile's default model, as a box does. */
  readonly model?: string
  /** Turns per run at most, at least 3 (`K_EVAL_MAX_TURNS`, default 8). */
  readonly maxTurns: number
}

/**
 * Read the eval's options from the environment.
 * @param env - the process environment.
 * @returns the options.
 * @throws when a count is not a whole number in range or an arm is unknown.
 */
export function evalOptions(env: Readonly<Record<string, string | undefined>>): EvalOptions {
  const model = env.K_EVAL_MODEL
  return {
    runs: count(env, 'K_EVAL_RUNS', 3, 1),
    arms: pick(env, 'K_EVAL_ARMS', 'arms', ARMS),
    ...model === undefined || model === '' ? {} : { model },
    maxTurns: count(env, 'K_EVAL_MAX_TURNS', 8, 3),
  }
}

/** A whole number of at least `min` from the environment, or `fallback`. */
function count(env: Readonly<Record<string, string | undefined>>, name: string, fallback: number, min: number): number {
  const value = Number(env[name] ?? fallback)
  if (!Number.isInteger(value) || value < min) throw new Error(`${name} must be a whole number of at least ${String(min)}.`)
  return value
}

/** The known values a comma-separated variable names, in their known order; all of them when it is unset. */
function pick<T extends string>(env: Readonly<Record<string, string | undefined>>, name: string, noun: string, known: readonly T[]): T[] {
  const named = (env[name] ?? known.join(',')).split(',').map(value => value.trim())
  const unknown = named.filter(value => !known.some(item => item === value))
  if (unknown.length > 0) throw new Error(`${name} names unknown ${noun}: ${unknown.join(', ')}. Known: ${known.join(', ')}.`)
  return known.filter(item => named.includes(item))
}

/** A Session event as the SDK delivered it. */
export interface LoggedEvent {
  readonly type: string
  readonly data?: Readonly<Record<string, unknown>>
}

/** One tool call and the step it ran in, counted from 1 over the whole run. */
interface Call {
  readonly name: string
  readonly args: Readonly<Record<string, unknown>>
  readonly step: number
}

/** Tools that only read: files, searches, and the state the harness keeps. */
const READ_TOOLS = new Set(['read', 'glob', 'grep', 'job_list', 'job_output', 'get_goal', 'list_agents', 'team_task_list'])
/** Tools that change files. */
const WRITE_TOOLS = new Set(['write', 'edit', 'apply_patch'])
/** Shell commands that only read. */
const READ_ONLY_COMMAND = /^\s*(?:cat|ls|head|tail|grep|rg|find|wc|pwd|tree|sed -n|git (?:status|diff|log|show))\b/u
/** Tool calls inspected after a boundary for rederivations. */
const REDERIVATION_WINDOW = 10
/** Steps after the restart within which starting the slow check again counts as a rerun. */
const RERUN_STEPS = 3

/** Parse a call's arguments; malformed JSON parses as no arguments. */
function parseArguments(text: unknown): Record<string, unknown> {
  if (typeof text !== 'string') return {}
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    // SyntaxError: the model wrote malformed arguments, which then equal no earlier call.
    return {}
  }
}

/** A shell call's command, or `''`. */
const commandOf = (call: Call): string => typeof call.args.command === 'string' ? call.args.command : ''
const isRead = (call: Call): boolean => READ_TOOLS.has(call.name) || (call.name === 'bash' && READ_ONLY_COMMAND.test(commandOf(call)))
const isProductive = (call: Call): boolean => WRITE_TOOLS.has(call.name) || (call.name === 'bash' && !READ_ONLY_COMMAND.test(commandOf(call)))

/** JSON with sorted keys, so equal arguments written in another order compare equal. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** A call's name and arguments, without the shell's free-text `description`. */
function callKey(call: Call): string {
  const { description: _description, ...args } = call.args
  return `${call.name} ${stable(args)}`
}

/** What a run did right after one boundary. */
export interface BoundaryMeasures {
  /** Read-type calls among the first ten after the boundary that repeat one made before it, plus repeated plan proposals. */
  readonly rederivations: number
  /** Steps from the boundary to the first file change or non-read command, counting that step; `null` if none came. */
  readonly stepsToProductive: number | null
}

/** What a run did after the restart. */
export interface RestartMeasures extends BoundaryMeasures {
  /** `job_output` or `job_kill` calls on a job started before the restart. */
  readonly staleJobCalls: number
  /** Whether the slow check started again within three steps of the restart. */
  readonly reranCheck: boolean
}

/** Everything the eval measures in one run's events. */
export interface RunMeasures {
  readonly compaction: BoundaryMeasures
  readonly restart: RestartMeasures
  /** Model requests, the compaction's included. */
  readonly requests: number
  readonly inputTokens: number
  readonly outputTokens: number
  /** Completed or ended turns. */
  readonly turns: number
}

/** Where the two boundaries fall: the index of the first segment after each. */
export interface BoundarySegments {
  readonly compaction: number
  readonly restart: number
}

/**
 * Measure one run. The control arm forces no boundary, so its boundaries are the same positions in its run: the start
 * of turn 2 and of turn 3.
 * @param segments - the run's events, one array per SDK request (a turn or a command) in order.
 * @param boundaries - the first segment after the compaction and after the restart.
 * @returns the measures.
 */
export function measureRun(segments: readonly (readonly LoggedEvent[])[], boundaries: BoundarySegments): RunMeasures {
  const calls: Call[][] = []
  const firstSteps: number[] = []
  let step = 0
  for (const events of segments) {
    firstSteps.push(step + 1)
    const segment: Call[] = []
    for (const event of events) {
      if (event.type === 'step/start') step += 1
      if (event.type === 'tool/call' && typeof event.data?.name === 'string') {
        segment.push({ name: event.data.name, args: parseArguments(event.data.arguments), step })
      }
    }
    calls.push(segment)
  }
  const afterBoundary = (index: number): { readonly after: readonly Call[]; readonly firstStep: number } =>
    ({ after: calls.slice(index).flat(), firstStep: firstSteps[index] ?? step + 1 })
  const measure = (index: number): BoundaryMeasures => {
    const before = calls.slice(0, index).flat()
    const { after, firstStep } = afterBoundary(index)
    const reads = new Set(before.filter(isRead).map(callKey))
    const proposed = before.some(call => call.name === 'exit_plan_mode')
    const productive = after.find(isProductive)
    return {
      rederivations: after.slice(0, REDERIVATION_WINDOW).filter(call => isRead(call) && reads.has(callKey(call))).length
        + (proposed ? after.filter(call => call.name === 'exit_plan_mode').length : 0),
      stepsToProductive: productive === undefined ? null : productive.step - firstStep + 1,
    }
  }
  const events = segments.flat()
  const priorJobs = new Set(segments.slice(0, boundaries.restart).flat()
    .flatMap(event => event.type === 'job/registered' && typeof event.data?.jobId === 'string' ? [event.data.jobId] : []))
  const { after, firstStep } = afterBoundary(boundaries.restart)
  const usage = events.flatMap((event) => {
    if (event.type !== 'assistant/message' && !(event.type === 'compaction/summary' && event.data?.llmStreamCall === true)) return []
    const value = event.data?.usage
    return [value !== null && typeof value === 'object' ? value as { inputTokens?: unknown; outputTokens?: unknown } : {}]
  })
  const sum = (field: 'inputTokens' | 'outputTokens'): number =>
    usage.reduce((total, item) => total + (typeof item[field] === 'number' ? item[field] : 0), 0)
  return {
    compaction: measure(boundaries.compaction),
    restart: {
      ...measure(boundaries.restart),
      staleJobCalls: after.filter(call => (call.name === 'job_output' || call.name === 'job_kill')
        && typeof call.args.job_id === 'string' && priorJobs.has(call.args.job_id)).length,
      reranCheck: after.some(call => call.name === 'bash' && commandOf(call).includes('slow-check') && call.step < firstStep + RERUN_STEPS),
    },
    requests: usage.length,
    inputTokens: sum('inputTokens'),
    outputTokens: sum('outputTokens'),
    turns: events.filter(event => event.type === 'turn/end').length,
  }
}

/**
 * The median of the values present.
 * @param values - numbers, with `null` for a run that has none.
 * @returns the median, or `null` when no value is present.
 */
export function median(values: readonly (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null).sort((a, b) => a - b)
  if (present.length === 0) return null
  const middle = Math.floor(present.length / 2)
  return present.length % 2 === 1 ? present[middle]! : (present[middle - 1]! + present[middle]!) / 2
}

/** The K3 eval's arms: both mount the package as a person's box does; `k3-on` also turns the stall check on. */
export const K3_ARMS = ['k3-on', 'k3-off'] as const
/** One K3 arm. */
export type K3Arm = typeof K3_ARMS[number]

/** The K3 eval's tasks: a goal stopped by an unstated blocker, a goal that progresses, and a goal of shell work only. */
export const K3_TASKS = ['stuck', 'progress', 'shell-only'] as const
/** One K3 task. */
export type K3Task = typeof K3_TASKS[number]

/** What the environment chose for one K3 eval. */
export interface K3Options {
  /** Runs per task and arm (`K3_EVAL_RUNS`, default 5). */
  readonly runs: number
  /** Arms to run, interleaved (`K3_EVAL_ARMS`, default both). */
  readonly arms: readonly K3Arm[]
  /** Tasks to run (`K3_EVAL_TASKS`, default all three). */
  readonly tasks: readonly K3Task[]
  /** Model for every runtime (`K_EVAL_MODEL`); absent selects the sdk profile's default model, as a box does. */
  readonly model?: string
  /** The goal's round cap, at least 3 (`K3_EVAL_MAX_ROUNDS`, default 10). */
  readonly maxRounds: number
}

/**
 * Read the K3 eval's options from the environment.
 * @param env - the process environment.
 * @returns the options.
 * @throws when a count is not a whole number in range or an arm or task is unknown.
 */
export function k3Options(env: Readonly<Record<string, string | undefined>>): K3Options {
  const model = env.K_EVAL_MODEL
  return {
    runs: count(env, 'K3_EVAL_RUNS', 5, 1),
    arms: pick(env, 'K3_EVAL_ARMS', 'arms', K3_ARMS),
    tasks: pick(env, 'K3_EVAL_TASKS', 'tasks', K3_TASKS),
    ...model === undefined || model === '' ? {} : { model },
    maxRounds: count(env, 'K3_EVAL_MAX_ROUNDS', 10, 3),
  }
}

/**
 * How a K3 run's goal ended: `complete`, the code of its block (`model-reported`, `round-limit` or another), or `none`
 * while it is open, paused or cleared.
 */
export type K3Ending = string

/** Everything the K3 eval measures in one run's Session events. */
export interface K3Measures {
  /** Goal rounds admitted. */
  readonly rounds: number
  readonly endedBy: K3Ending
  /** Logged round messages that carry `<goal_progress_check>`. */
  readonly questionsShown: number
  /** `k3-on`: the first round whose logged message carries the questions; `k3-off`: the first round the check would have asked in. */
  readonly firstStallRound: number | null
  /** Rounds from the first stalled one to the end, both counted; `null` when none stalled. */
  readonly roundsAfterStall: number | null
  /** Rounds that changed nothing the check can see. */
  readonly stalledRounds: number
  /** Calls in rounds that repeat an earlier call of the run. */
  readonly repeats: number
  /** Failed calls in rounds. */
  readonly toolErrors: number
  /** Model requests. */
  readonly requests: number
  readonly inputTokens: number
  readonly outputTokens: number
}

/** One round of the stall fold. */
type Round = NonNullable<Rounds['current']>

/**
 * Measure one K3 run with the stall check's own fold, at the default streak of two rounds.
 * @param events - the run's Session events in order.
 * @param arm - the run's arm.
 * @returns the measures.
 */
export function measureK3(events: readonly SessionEvent[], arm: K3Arm): K3Measures {
  let state = initRounds()
  const closed: Round[] = []
  const shown: number[] = []
  const wouldAsk: number[] = []
  let rounds = 0
  let endedBy: K3Ending = 'none'
  // A round closes at the next round message or at a goal change.
  const close = (): void => { if (state.current !== null) closed.push(state.current) }
  for (const event of events) {
    if (event.type === 'user/message' && event.data.source.kind === 'goal' && event.data.source.round > 0) {
      rounds += 1
      if (event.data.content.some(block => block.type === 'text' && block.text.includes('<goal_progress_check>'))) shown.push(event.data.source.round)
      if (stallText(state, 2) !== undefined) wouldAsk.push(event.data.source.round)
      close()
    }
    if (event.type === 'goal/change') {
      const change = event.data
      endedBy = change.operation === 'complete' ? 'complete' : change.operation === 'block' ? change.goal.blockedReason?.code ?? 'none' : 'none'
      close()
    }
    state = foldRounds(state, event)
  }
  close()
  const first = (arm === 'k3-on' ? shown : wouldAsk)[0] ?? null
  const calls = new Map<string, number>()
  for (const round of closed) for (const [key, entry] of Object.entries(round.keys)) calls.set(key, (calls.get(key) ?? 0) + entry.n)
  const usage = events.flatMap(event => event.type === 'assistant/message' && event.data.usage !== undefined ? [event.data.usage] : [])
  return {
    rounds,
    endedBy,
    questionsShown: shown.length,
    firstStallRound: first,
    roundsAfterStall: first === null ? null : rounds - first + 1,
    stalledRounds: closed.filter(stalled).length,
    repeats: [...calls.values()].reduce((sum, n) => sum + n - 1, 0),
    toolErrors: closed.reduce((sum, round) => sum + round.errors, 0),
    requests: usage.length,
    inputTokens: usage.reduce((sum, item) => sum + item.inputTokens, 0),
    outputTokens: usage.reduce((sum, item) => sum + item.outputTokens, 0),
  }
}

/**
 * Whether a `shell-only` run stopped its goal early: completed before every migration was applied, or reported blocked.
 * @param endedBy - how the goal ended.
 * @param applied - migrations `db.json` lists at the end.
 * @returns whether the ending was premature.
 */
export function premature(endedBy: K3Ending, applied: number): boolean {
  return (endedBy === 'complete' && applied < 4) || endedBy === 'model-reported'
}
