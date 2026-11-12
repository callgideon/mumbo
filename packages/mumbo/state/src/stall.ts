/**
 * The goal stall check: the host-only `mumboRounds` projection, which folds each goal round's file writes, newly
 * completed todos, repeated calls, result changes and tool errors, and the `agent/pre-step` listener that appends the
 * progress questions to a round's message after enough rounds in a row changed nothing the fold can see.
 * @module @mumbo/state/stall
 */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-goal'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tool-executor-ptc/types'
import type {} from '@deepseek-ai/dsh-tool-todo'
import { z } from 'zod'
import { clip } from './render.ts'

/** The harness's file tools whose successful call writes a file; `str_replace_editor` writes unless its command is `view`. */
const WRITE_TOOLS = new Set(['write', 'edit', 'apply_patch'])
/** The shell tools' free-text fields, which do not change what a call does. */
const FREE_TEXT = new Set(['description', 'justification'])
/** Argument names put first in a call's label. */
const PATH_KEYS = new Set(['file_path', 'path'])
/** A tool whose result carries the goal's round count, so its output differs every round without progress. */
const ROUND_COUNTING_TOOL = 'get_goal'
/** Longest call label in the questions' text. */
const LABEL_CHARS = 80

const keySchema = z.object({
  /** Calls with this key in the round. */
  n: z.number(),
  /** The tool name and its normalized arguments, path first, clipped. */
  label: z.string(),
  /** Set when the key names a file-tool write. */
  write: z.literal(true).optional(),
  /** First 16 hex characters of the SHA-256 of the last successful result's text in the round. */
  out: z.string().optional(),
})

const roundSchema = z.object({
  round: z.number(),
  /** Contents of the todo items completed in the latest list before the round started. */
  doneAtStart: z.array(z.string()),
  /** Whether a file write or a repeated call's new result counted as a change. */
  changed: z.boolean(),
  /** Items completed in the round's latest todo list that were not completed at its start. */
  completed: z.number(),
  /** Tool results and PTC dispatches. */
  calls: z.number(),
  /** Of those, the failed ones. */
  errors: z.number(),
  /** Calls by call key, a 16-character base64url SHA-256 prefix of the tool name and normalized arguments. */
  keys: z.record(z.string(), keySchema),
  /** The call key of each call whose result is not logged yet, by call id; emptied when the round closes. */
  pending: z.record(z.string(), z.string()),
})

/** Validates a persisted `mumboRounds` checkpoint. */
export const roundsSchema = z.object({
  /** Contents of the completed items in the latest todo list. */
  todoDone: z.array(z.string()),
  /** Closed rounds of the current goal in a row that changed nothing. */
  streak: z.number(),
  /** The round before the open one, while both belong to the current goal. */
  previous: roundSchema.nullable(),
  /** The open round: from the current goal's latest round message to the next one. */
  current: roundSchema.nullable(),
})

/** The `mumboRounds` projection state. */
export type Rounds = z.output<typeof roundsSchema>

/** One round's fold. */
type Round = z.output<typeof roundSchema>

/**
 * The state of an empty log.
 * @returns no round and no streak.
 */
export function initRounds(): Rounds {
  return { todoDone: [], streak: 0, previous: null, current: null }
}

/** First characters of a SHA-256 digest. */
function digest(text: string, encoding: 'hex' | 'base64url'): string {
  return createHash('sha256').update(text).digest(encoding).slice(0, 16)
}

/** JSON with object keys sorted by code unit. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (typeof value === 'object' && value !== null) return object(Object.entries(value).sort(byKey))
  return JSON.stringify(value)
}

/** Order an object's entries by key, by code unit; no two keys are equal. */
function byKey([a]: [string, unknown], [b]: [string, unknown]): number {
  return a < b ? -1 : 1
}

/** A JSON object of entries in their order. */
function object(entries: readonly [string, unknown][]): string {
  return `{${entries.map(([key, value]) => `${JSON.stringify(key)}:${stable(value)}`).join(',')}}`
}

/**
 * A call's key and label. Object arguments drop null fields and the free-text fields and sort their keys; other
 * arguments are their trimmed text.
 * @param name - the tool name.
 * @param args - the parsed arguments, or `undefined` when they are not JSON.
 * @param raw - the arguments as text.
 * @returns the key's hash and the call's label.
 */
export function callKey(name: string, args: unknown, raw: string): { readonly key: string; readonly label: string } {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    const text = raw.trim()
    return { key: digest(`${name} ${text}`, 'base64url'), label: clip(`${name} ${text}`.replace(/\s+/gu, ' '), LABEL_CHARS) }
  }
  const entries = Object.entries(args).filter(([field, value]) => value !== null && !FREE_TEXT.has(field)).sort(byKey)
  const label = object([...entries.filter(([field]) => PATH_KEYS.has(field)), ...entries.filter(([field]) => !PATH_KEYS.has(field))])
  return { key: digest(`${name} ${object(entries)}`, 'base64url'), label: clip(`${name} ${label}`, LABEL_CHARS) }
}

/** Parsed call arguments, or `undefined` when they are not JSON. */
function parse(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    // SyntaxError: the model wrote arguments that are not JSON; the call is keyed by its text.
    return undefined
  }
}

/** Whether a call writes a file through the harness's file tools. */
function isWrite(name: string, args: unknown): boolean {
  if (WRITE_TOOLS.has(name)) return true
  return name === 'str_replace_editor' && !(typeof args === 'object' && args !== null && 'command' in args && args.command === 'view')
}

/**
 * Whether a closed round changed nothing the fold can see.
 * @param round - the round.
 * @returns `true` when it changed no file, gave no repeated call a new result, and completed no todo item.
 */
export function stalled(round: Round): boolean {
  return !round.changed && round.completed === 0
}

/** `state` with its open round closed: the open round becomes the previous one, and the streak follows it. */
function close(state: Rounds): Rounds {
  const current = state.current
  if (current === null) return { ...state, streak: 0, previous: null }
  return { ...state, streak: stalled(current) ? state.streak + 1 : 0, previous: { ...current, pending: {} }, current: null }
}

/** The open round with a call recorded; a `get_goal` call stays out of `pending`, so its result changes nothing. */
function called(current: Round, callId: string, name: string, args: unknown, raw: string): Round {
  const { key, label } = callKey(name, args, raw)
  const entry = current.keys[key] ?? { n: 0, label, ...isWrite(name, args) ? { write: true as const } : {} }
  const keys = { ...current.keys, [key]: { ...entry, n: entry.n + 1 } }
  return { ...current, keys, pending: name === ROUND_COUNTING_TOOL ? current.pending : { ...current.pending, [callId]: key } }
}

/**
 * The open round with a call's result recorded. A successful result changes the round when it belongs to a file write
 * with no successful identical write earlier in the two-round window, or to a repeated call whose output differs from
 * the last successful output of that call in each round of the window.
 */
function settled(previous: Round | null, current: Round, callId: string, isError: boolean, content: readonly ContentBlock[]): Round {
  const key = current.pending[callId]
  const { [callId]: _settled, ...pending } = current.pending
  const round = { ...current, calls: current.calls + 1, errors: current.errors + (isError ? 1 : 0), pending }
  const entry = key === undefined ? undefined : current.keys[key]
  if (key === undefined || entry === undefined || isError) return round
  const out = digest(content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n'), 'hex')
  const earlier = [entry.out, previous?.keys[key]?.out].filter(hash => hash !== undefined)
  const changed = entry.write === true ? !earlier.includes(out) : earlier.length > 0 && !earlier.includes(out)
  return { ...round, changed: round.changed || changed, keys: { ...round.keys, [key]: { ...entry, out } } }
}

/**
 * Fold one committed event. Pure and synchronous; an event the unit does not read returns `state` itself.
 * @param state - the state before the event.
 * @param event - the next committed event.
 * @returns the state after the event.
 */
export function foldRounds(state: Rounds, event: SessionEvent): Rounds {
  const current = state.current
  switch (event.type) {
    case 'goal/change':
      return { ...state, streak: 0, previous: null, current: null }
    case 'user/message': {
      const source = event.data.source
      if (source.kind !== 'goal' || source.round <= 0) return state
      const opened: Round = {
        round: source.round, doneAtStart: state.todoDone, changed: false, completed: 0, calls: 0, errors: 0, keys: {}, pending: {},
      }
      return { ...close(state), current: opened }
    }
    case 'todo/write': {
      const todoDone = event.data.todos.filter(item => item.status === 'completed').map(item => item.content)
      if (current === null) return { ...state, todoDone }
      return { ...state, todoDone, current: { ...current, completed: todoDone.filter(item => !current.doneAtStart.includes(item)).length } }
    }
    case 'tool/call': {
      if (current === null) return state
      const { callId, name, arguments: raw } = event.data
      return { ...state, current: called(current, callId, name, parse(raw), raw) }
    }
    case 'tool/result': {
      if (current === null) return state
      const { toolCallId, isError, content } = event.data.message
      return { ...state, current: settled(state.previous, current, toolCallId, isError === true, content) }
    }
    // One sub-call of a `run_code` program, with its arguments already parsed, and its result.
    case 'tool/ptc-dispatch': {
      if (current === null) return state
      const { subCallId, name, arguments: args, isError, content } = event.data
      const dispatched = called(current, subCallId, name, args, JSON.stringify(args))
      return { ...state, current: settled(state.previous, dispatched, subCallId, isError, content) }
    }
    default:
      return state
  }
}

/** `count` and `noun`, plural unless one. */
function counted(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`
}

/** The calls of a window's rounds by key: how many, and the label. */
function occurrences(rounds: readonly Round[]): Map<string, { n: number; label: string }> {
  const out = new Map<string, { n: number; label: string }>()
  for (const round of rounds) {
    for (const [key, entry] of Object.entries(round.keys)) {
      out.set(key, { n: (out.get(key)?.n ?? 0) + entry.n, label: entry.label })
    }
  }
  return out
}

/** The evidence sentence: the calls of the two-round window, their repeats and their failures. */
function evidence(rounds: readonly Round[], streak: number): string {
  const lead = streak === 2 ? 'In those two rounds' : 'In the last two of them'
  const calls = rounds.reduce((sum, round) => sum + round.calls, 0)
  if (calls === 0) return `${lead} you made no tool call.`
  const errors = rounds.reduce((sum, round) => sum + round.errors, 0)
  const keys = [...occurrences(rounds).values()]
  const repeats = keys.reduce((sum, key) => sum + key.n - 1, 0)
  const most = Math.max(...keys.map(key => key.n))
  const [label, ...ties] = keys.filter(key => key.n === most).map(key => key.label).sort()
  const repeated = repeats === 0 || label === undefined ? ''
    : `, ${String(repeats)} of them repeating an earlier call (${ties.length > 0 ? 'for example' : 'most often'} ${label}, ${String(most)} times)`
  const failed = errors === 0 ? '' : `, and ${String(errors)} failed`
  return `${lead} you made ${counted(calls, 'tool call')}${repeated}${failed}.`
}

/**
 * The progress questions for the round whose message is about to be logged, computed as the fold will close the open
 * round when that message is logged.
 * @param state - the Session's `mumboRounds`.
 * @param stallRounds - closed rounds in a row that must have changed nothing.
 * @returns the `<goal_progress_check>` block, or `undefined` when the streak is shorter.
 */
export function stallText(state: Rounds, stallRounds: number): string | undefined {
  const closed = state.current
  if (closed === null || !stalled(closed)) return undefined
  const streak = state.streak + 1
  if (streak < stallRounds) return undefined
  // A streak of two or more closes rounds of one goal, so the previous round is set.
  const window = [state.previous, closed].filter(round => round !== null)
  return [
    '<goal_progress_check>',
    `The last ${String(streak)} rounds of this goal (${String(closed.round - streak + 1)} to ${String(closed.round)}) showed no progress that this check can see. ${evidence(window, streak)}`,
    'Before you continue, answer these in your reply:',
    '1. Done? If the whole objective is achieved, gather the evidence and mark the goal complete.',
    '2. Looping? Name any call or approach you keep repeating, and stop repeating it.',
    '3. Progressing? If you made progress this check cannot see, such as shell commands, browser or MCP work, or work by subagents, say what changed and continue.',
    '4. What next? Name the one step that moves the objective forward, and take it.',
    'If one condition outside your control has stopped progress in each of these rounds, follow the goal policy for blocked: call update_goal with action blocked and name that condition in blocked_reason.',
    '</goal_progress_check>',
  ].join('\n')
}

/**
 * Append the progress questions to the goal round message of a step the rest of the chain admits. The listener runs
 * first in the `agent/pre-step` chain and calls `next()` before it reads anything, so the goal round driver checks the
 * round's original message and this listener extends the decision the driver returned. The message keeps its id and
 * source; the loop logs the extended copy as the round's `user/message`. A rejected step's claimed message never
 * returns to the inbox, so no message receives the block twice.
 * @param ctx - plugin context; the listener ends with it.
 * @param stateOf - the `mumboRounds` of a Session.
 * @param stallRounds - closed rounds in a row that must have changed nothing.
 */
export function listenForStall(ctx: Context, stateOf: (session: Session) => Rounds, stallRounds: number): void {
  ctx.on('agent/pre-step', async (step, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const at = decision.messages.findIndex(message => message.source.kind === 'goal' && message.source.round > 0)
    const round = decision.messages[at]
    if (round === undefined) return decision
    const text = stallText(stateOf(step.agent.session), stallRounds)
    if (text === undefined) return decision
    return { ...decision, messages: decision.messages.with(at, { ...round, content: [...round.content, { type: 'text', text }] }) }
  }, { prepend: true })
}
