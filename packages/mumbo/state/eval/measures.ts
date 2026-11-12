/**
 * The K eval's inputs and measures: the DeepSeek key and options it reads, and what it computes from one run's Session
 * events. Pure apart from reading the `.env` file it is given.
 * @module @mumbo/state/eval/measures
 */

import { existsSync, readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'

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
  const count = (name: string, fallback: number, min: number): number => {
    const value = Number(env[name] ?? fallback)
    if (!Number.isInteger(value) || value < min) throw new Error(`${name} must be a whole number of at least ${String(min)}.`)
    return value
  }
  const arms = (env.K_EVAL_ARMS ?? ARMS.join(',')).split(',').map(arm => arm.trim())
  const unknown = arms.filter(arm => !ARMS.some(known => known === arm))
  if (unknown.length > 0) throw new Error(`K_EVAL_ARMS names unknown arms: ${unknown.join(', ')}. Known: ${ARMS.join(', ')}.`)
  const model = env.K_EVAL_MODEL
  return {
    runs: count('K_EVAL_RUNS', 3, 1),
    arms: ARMS.filter(arm => arms.includes(arm)),
    ...model === undefined || model === '' ? {} : { model },
    maxTurns: count('K_EVAL_MAX_TURNS', 8, 3),
  }
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
