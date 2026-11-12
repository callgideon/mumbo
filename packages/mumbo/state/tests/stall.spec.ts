/** The `mumboRounds` fold, the stall predicate and the progress questions' text, over hand-built logs. */

import { GoalId } from '@deepseek-ai/dsh-goal'
import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { callKey, foldRounds, initRounds, type Rounds, roundsSchema, stallText } from '../src/stall.ts'
import { Log } from './events.ts'

/** Fold a log from the empty state. */
function fold(log: Log): Rounds {
  return log.events.reduce(foldRounds, initRounds())
}

const CAT = { command: 'cat config/token.txt' }
const MISSING = 'cat: config/token.txt: No such file or directory\n[exit code: 1]'
const TODO = { todos: [{ content: 'Get the token', status: 'pending' }] }

/** One stalled round of goal B in the snapshot: a failing `cat`, a failed `read`, and the same todo list. */
function stuck(log: Log, id: string): Log {
  return log.ran(`${id}-cat`, 'bash', CAT, MISSING)
    .call(`${id}-read`, 'read', JSON.stringify({ file_path: 'config/token.txt' })).result(`${id}-read`, true, 'ENOENT')
    .call(`${id}-todo`, 'todo_write', JSON.stringify(TODO)).todos([{ content: 'Get the token', status: 'pending' }])
    .result(`${id}-todo`, false, 'Updated todo list: 1 pending, 0 in progress, 0 completed.')
}

/** The block's fixed lines after the evidence line. */
const QUESTIONS = [
  'Before you continue, answer these in your reply:',
  '1. Done? If the whole objective is achieved, gather the evidence and mark the goal complete.',
  '2. Looping? Name any call or approach you keep repeating, and stop repeating it.',
  '3. Progressing? If you made progress this check cannot see, such as shell commands, browser or MCP work, or work by subagents, say what changed and continue.',
  '4. What next? Name the one step that moves the objective forward, and take it.',
  'If one condition outside your control has stopped progress in each of these rounds, follow the goal policy for blocked: call update_goal with action blocked and name that condition in blocked_reason.',
  '</goal_progress_check>',
].join('\n')

/** The streak the fold records when the next round's message is logged after round 1 and `activity`. */
function streakAfter(activity: (log: Log) => Log, before: (log: Log) => Log = log => log): number {
  return fold(activity(before(new Log()).round(1)).round(2)).streak
}

describe('rounds', () => {
  it('run from one goal round message to the next, a person\'s turn in between included', () => {
    const log = new Log().round(1).user('Write it.').ran('w', 'write', { file_path: 'a.txt', content: 'a' }).round(2)
    expect(fold(log)).toMatchObject({
      streak: 0, previous: { round: 1, changed: true, pending: {} }, current: { round: 2, changed: false },
    })
  })

  it('reset at every goal change', () => {
    for (const operation of ['create', 'edit', 'pause', 'resume', 'complete', 'block', 'clear'] as const) {
      const log = new Log().round(1).round(2).round(3).goal(operation)
      expect(fold(log), operation).toEqual({ todoDone: [], streak: 0, previous: null, current: null })
      expect(fold(log.round(1)), operation).toMatchObject({ streak: 0, previous: null, current: { round: 1 } })
    }
  })

  it('keep the state itself for events they do not read', () => {
    const log = new Log().round(1)
    const state = fold(log)
    const [, person, round0, step, reply] = log.user('hi')
      .user('x', { kind: 'goal', goalId: GoalId('g'), revision: 1, round: 0 }).step().assistant('ok').events
    for (const event of [person!, round0!, step!, reply!]) expect(foldRounds(state, event)).toBe(state)
    const idle = initRounds()
    for (const event of new Log().ran('r', 'read', { file_path: 'a' }).dispatch('d', 'write', { file_path: 'a' }).events) {
      expect(foldRounds(idle, event)).toBe(idle)
    }
  })
})

describe('the stall predicate', () => {
  it('reads a round with only reads, errors, the same todo list, or an identical write that succeeded before as stalled', () => {
    expect(streakAfter(log => log.ran('r', 'read', { file_path: 'a.txt' }))).toBe(1)
    expect(streakAfter(log => log.call('w', 'write', JSON.stringify({ file_path: 'a', content: 'a' })).result('w', true))).toBe(1)
    const done = (log: Log): Log => log.todos([{ content: 'a', status: 'completed' }, { content: 'b', status: 'pending' }])
    expect(streakAfter(done, done)).toBe(1)
    const write = (log: Log): Log => log.ran('w', 'write', { file_path: 'a.txt', content: 'a' })
    const twice = fold(write(write(new Log().round(1)).round(2)).round(3))
    expect(twice).toMatchObject({ streak: 1, previous: { round: 2, changed: false } })
    expect(streakAfter(log => log.ran('v', 'str_replace_editor', { command: 'view', path: 'a.txt' }))).toBe(1)
    expect(streakAfter(log => log.call('x', 'bash', '{not json').result('x', false, 'error'))).toBe(1)
  })

  it('reads a new write, a failed write that succeeds on retry, a PTC write and a newly completed item as a change', () => {
    expect(streakAfter(log => log.ran('w', 'write', { file_path: 'a.txt', content: 'a' }))).toBe(0)
    const args = JSON.stringify({ file_path: 'a.txt', old_string: 'x', new_string: 'y' })
    expect(streakAfter(log => log.call('e1', 'edit', args).result('e1', true).call('e2', 'edit', args).result('e2'))).toBe(0)
    expect(streakAfter(log => log.ran('c', 'str_replace_editor', { command: 'create', path: 'a.txt', file_text: 'a' }))).toBe(0)
    expect(streakAfter(log => log.ran('p', 'apply_patch', { patch: '*** Begin Patch' }))).toBe(0)
    expect(streakAfter(log => log.dispatch('d', 'write', { file_path: 'a.txt', content: 'a' }))).toBe(0)
    expect(streakAfter(log => log.dispatch('d', 'write', { file_path: 'a.txt', content: 'a' }, true))).toBe(1)
    expect(streakAfter(log => log.todos([{ content: 'a', status: 'completed' }]), log => log.todos([{ content: 'a', status: 'pending' }]))).toBe(0)
  })

  it('reads the same command with new output as a change, and with the same output as none', () => {
    const migrate = (output: string) => (log: Log): Log => log.ran(`m-${output}`, 'bash', { command: 'node migrate.mjs' }, output)
    const progress = fold(migrate('applied 2')(migrate('applied 1')(new Log().round(1)).round(2)).round(3))
    expect(progress).toMatchObject({ streak: 0, previous: { round: 2, changed: true } })
    const same = new Log().round(1)
    migrate('failed: no key')(same).round(2)
    migrate('failed: no key')(same).round(3)
    expect(fold(same)).toMatchObject({ streak: 2, previous: { round: 2, changed: false } })
  })

  it('compares a successful output with the last successful one of each round, and never a new call\'s first output', () => {
    const job = (id: string, output: string, isError = false): (log: Log) => Log =>
      log => log.call(id, 'job_output', '{"job_id":"bash-1"}').result(id, isError, output)
    expect(streakAfter(job('a', 'line 1'))).toBe(1)
    expect(streakAfter(log => job('b', 'line 1')(job('a', 'line 1')(log)))).toBe(1)
    expect(streakAfter(log => job('b', 'line 2')(job('a', 'line 1')(log)))).toBe(0)
    expect(streakAfter(log => job('c', 'line 1')(job('b', 'failed', true)(job('a', 'line 1')(log))))).toBe(1)
    expect(streakAfter(log => job('b', 'line 1')(job('a', 'failed', true)(log)))).toBe(1)
    const rounds = (second: string): Rounds => fold(job('b', second)(job('a', 'line 1')(new Log().round(1)).round(2)).round(3))
    expect(rounds('line 1').previous?.changed).toBe(false)
    expect(rounds('line 2').previous?.changed).toBe(true)
  })

  it('compares only the text of a result', () => {
    const shot = (id: string, text: string) => (log: Log): Log => log.call(id, 'browser_snapshot', '{}').add('tool/result', {
      turn: 1, step: 1, message: createToolResultMessage({ callId: ToolCallId(id), isError: false, content: [{ type: 'reasoning', text }, { type: 'text', text: 'page' }] }),
    })
    expect(streakAfter(log => shot('b', 'other')(shot('a', 'one')(log)))).toBe(1)
  })

  it('does not read get_goal\'s round count as a change', () => {
    const read = (round: number) => (log: Log): Log => log.ran(`g${String(round)}`, 'get_goal', {}, `{"roundsStarted":${String(round)}}`)
    expect(fold(read(2)(read(1)(new Log().round(1)).round(2)).round(3))).toMatchObject({ streak: 2, previous: { calls: 1 } })
  })

  it('counts a result that session repair synthesized for an unlogged call, and an orphaned call is dropped at the close', () => {
    const state = fold(new Log().round(1).result('repaired', true).call('lost', 'read', '{"file_path":"a"}'))
    expect(state.current).toMatchObject({ calls: 1, errors: 1 })
    expect(Object.keys(state.current?.pending ?? {})).toEqual(['lost'])
    expect(foldRounds(state, new Log().round(2).events[0]!).previous?.pending).toEqual({})
  })
})

describe('call keys', () => {
  it('ignore free-text and null fields and key order, and key unparsable arguments by their trimmed text', () => {
    const base = callKey('bash', { command: 'ls', timeout: 5 }, '')
    expect(callKey('bash', { timeout: 5, description: 'list', justification: 'why', command: 'ls', run_in_background: null }, '')).toEqual(base)
    expect(callKey('bash', { command: 'ls', timeout: 6 }, '').key).not.toBe(base.key)
    expect(callKey('pwsh', { command: 'ls', timeout: 5 }, '').key).not.toBe(base.key)
    expect(callKey('bash', undefined, '  {not json \n ')).toEqual(callKey('bash', undefined, '{not json'))
    expect(callKey('bash', ['a'], '["a"]').label).toBe('bash ["a"]')
    expect(callKey('bash', undefined, 'a\n  b').label).toBe('bash a b')
    expect(callKey('edit', { b: [{ z: 1, a: null }], a: true }, '').label).toBe('edit {"a":true,"b":[{"a":null,"z":1}]}')
  })

  it('label a call with its path first, clipped to 80 characters', () => {
    const { label, key } = callKey('edit', { old_string: 'x', new_string: 'y', file_path: `src/${'deep/'.repeat(20)}file.ts` }, '')
    expect(label).toBe(`edit {"file_path":"src/${'deep/'.repeat(20)}`.slice(0, 79) + '…')
    expect(label).toHaveLength(80)
    expect(key).toMatch(/^[\w-]{16}$/u)
  })
})

describe('the progress questions', () => {
  const twoStuck = (): Log => stuck(stuck(new Log().round(1), 'b1').round(2), 'b2')

  it('ask in round 3 after two stalled rounds, with the window\'s calls, repeats and failures', () => {
    expect(stallText(fold(stuck(new Log().round(1), 'b1')), 2)).toBeUndefined()
    expect(stallText(fold(twoStuck()), 2)).toBe([
      '<goal_progress_check>',
      'The last 2 rounds of this goal (1 to 2) showed no progress that this check can see. In those two rounds you made 6 tool calls, '
      + '3 of them repeating an earlier call (for example bash {"command":"cat config/token.txt"}, 2 times), and 2 failed.',
      QUESTIONS,
    ].join('\n'))
  })

  it('do not ask after a round that changed something, nor before any round, nor before the configured streak', () => {
    expect(stallText(initRounds(), 2)).toBeUndefined()
    const changed = stuck(stuck(new Log().round(1), 'b1').round(2).ran('w', 'write', { file_path: 'a', content: 'a' }), 'b2')
    expect(stallText(fold(changed), 2)).toBeUndefined()
    expect(stallText(fold(stuck(changed.round(3), 'b3')), 2)).toBeUndefined()
    expect(stallText(fold(twoStuck()), 3)).toBeUndefined()
  })

  it('count the streak in later rounds and describe the last two', () => {
    const three = fold(stuck(twoStuck().round(3), 'b3'))
    expect(stallText(three, 3)).toContain('The last 3 rounds of this goal (1 to 3) showed no progress that this check can see. In the last two of them you made 6 tool calls,')
    expect(stallText(fold(new Log().round(1).ran('w', 'write', { file_path: 'a', content: 'a' }).round(2).round(3)), 2))
      .toContain('The last 2 rounds of this goal (2 to 3) showed no progress that this check can see. In those two rounds you made no tool call.\n')
  })

  it('say most often for one most repeated call, and leave out the clauses that have no count', () => {
    const reads = (log: Log, id: string): Log => log.ran(`${id}a`, 'read', { file_path: 'a' }).ran(`${id}b`, 'read', { file_path: 'b' })
    const once = fold(reads(reads(new Log().round(1), '1').round(2).ran('2c', 'read', { file_path: 'a' }), '3'))
    expect(stallText(once, 2)).toContain(
      'In those two rounds you made 5 tool calls, 3 of them repeating an earlier call (most often read {"file_path":"a"}, 3 times).\n')
    const single = fold(new Log().round(1).round(2).call('f', 'read', '{"file_path":"a"}').result('f', true))
    expect(stallText(single, 2)).toContain('In those two rounds you made 1 tool call, and 1 failed.\n')
  })

  it('validate as checkpoints, and a restored checkpoint plus its suffix folds to the full replay', () => {
    const log = stuck(new Log().todos([{ content: 'a', status: 'completed' }]).round(1), 'b1')
      .dispatch('d', 'write', { file_path: 'a', content: 'a' }).round(2).ran('m1', 'bash', { command: 'node m.mjs' }, '1')
      .call('open', 'read', '{"file_path":"x"}').round(3).ran('m2', 'bash', { command: 'node m.mjs' }, '2').goal('edit').round(1)
    const full = fold(log)
    expect(roundsSchema.parse(full)).toEqual(full)
    expect(roundsSchema.parse(initRounds())).toEqual(initRounds())
    for (let cut = 0; cut <= log.events.length; cut += 1) {
      const checkpoint = roundsSchema.parse(JSON.parse(JSON.stringify(log.events.slice(0, cut).reduce(foldRounds, initRounds()))))
      expect(log.events.slice(cut).reduce(foldRounds, checkpoint), String(cut)).toEqual(full)
    }
  })
})
