/** The `mumboState` fold over hand-built logs. */

import { describe, expect, it } from 'vitest'
import { foldState, initState, type MumboState, stateSchema } from '../src/projection.ts'
import { Log } from './events.ts'

/** Fold a log from the empty state. */
function fold(log: Log): MumboState {
  return log.events.reduce(foldState, initState())
}

describe('boundary', () => {
  it('moves on a successful compaction, every end-seed, and every goal change but an edit', () => {
    expect(fold(new Log().compaction()).boundary).toBe(1)
    expect(fold(new Log().compaction('model failed')).boundary).toBe(0)
    expect(fold(new Log().add('session/end-seed', {})).boundary).toBe(1)
    expect(fold(new Log().add('session/end-seed', { inherited: true })).boundary).toBe(1)
    for (const operation of ['create', 'pause', 'resume', 'complete', 'block', 'clear'] as const) {
      expect(fold(new Log().goal(operation)).boundary, operation).toBe(1)
    }
    expect(fold(new Log().goal('edit')).boundary).toBe(0)
  })

  it('keeps the state itself for an event it does not read', () => {
    const state = fold(new Log().todos([{ content: 'a', status: 'pending' }]))
    const [event] = new Log().add('step/end', { turn: 1, step: 1 }).events
    expect(foldState(state, event!)).toBe(state)
    const [edit] = new Log().goal('edit').events
    expect(foldState(state, edit!)).toBe(state)
  })
})

describe('todos', () => {
  it('keeps the last list across turns, labelled with the turn that wrote it', () => {
    const items = [{ content: 'Parse', status: 'in_progress' as const }, { content: 'Ship', status: 'pending' as const }]
    const log = new Log().add('turn/start', { turn: 2 }).todos([{ content: 'Old', status: 'pending' }]).todos(items)
      .add('turn/end', { turn: 2, reason: { kind: 'completed' } }).add('turn/start', { turn: 3 })
    expect(fold(log)).toMatchObject({ turn: 3, todos: { items, turn: 2 } })
  })
})

describe('plan', () => {
  const PLAN = '# Fix\n\n## Parse'
  const approve = (log: Log): Log => log.add('step/end', { turn: 1, step: 1 }).add('plan/mode', { active: false })

  it('records an approved plan once plan mode exits in the same turn', () => {
    const state = fold(approve(new Log().add('turn/start', { turn: 4 }).plan('p1', PLAN, false, 4)))
    expect(state).toMatchObject({ plan: { callId: 'p1', text: PLAN, turn: 4 }, proposed: null, reviewed: null })
  })

  it('drops a plan the person kept planning on', () => {
    expect(fold(approve(new Log().plan('p1', PLAN, true)))).toMatchObject({ plan: null, proposed: null, reviewed: null })
  })

  it('drops a dismissed plan, also when the person turns plan mode off after the turn', () => {
    const dismissed = new Log().plan('p1', PLAN).add('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(fold(dismissed)).toMatchObject({ plan: null, reviewed: null })
    expect(fold(dismissed.add('plan/mode', { active: false })).plan).toBeNull()
  })

  it('does not record an approval whose turn was cancelled before the next step', () => {
    const log = new Log().plan('p1', PLAN).add('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
    expect(fold(approve(log)).plan).toBeNull()
  })

  it('keeps the earlier approved plan when a later one is not approved, and replaces it when one is', () => {
    const first = approve(new Log().plan('p1', PLAN))
    expect(fold(first.plan('p2', '# Other', true)).plan?.callId).toBe('p1')
    expect(fold(approve(first.plan('p3', '# Third'))).plan?.text).toBe('# Third')
  })

  it('ignores other calls, unparsable arguments, unrelated results, and plan mode turning on', () => {
    const log = new Log().call('x', 'exit_plan_mode', '{"plan":').call('y', 'exit_plan_mode', '{"plan":3}').call('z', 'exit_plan_mode', 'null')
      .call('r', 'read', '{"plan":"# No"}').result('r').add('plan/mode', { active: true })
    expect(fold(log)).toMatchObject({ plan: null, proposed: null, reviewed: null })
    const pending = fold(new Log().plan('p1', PLAN))
    const [on] = new Log().add('plan/mode', { active: true }).events
    expect(foldState(pending, on!)).toBe(pending)
  })
})

describe('jobs and workflow runs', () => {
  it('records jobs other than workflow runs and their settlements, and drops settled ones at the next step', () => {
    const log = new Log().job('bash-1').job('bash-2').job('workflow-1', 'workflow').settle('bash-1', 'producer', 'failed', 'exit code: 3')
      .settle('bash-9', 'kill')
    expect(fold(log).jobs).toEqual({
      'bash-1': { kind: 'bash', label: 'node slow.js', seq: 0, settled: { status: 'failed', cause: 'producer', detail: 'exit code: 3', seq: 3 } },
      'bash-2': { kind: 'bash', label: 'node slow.js', seq: 1 },
    })
    expect(Object.keys(fold(log.step()).jobs)).toEqual(['bash-2'])
  })

  it('counts a run\'s running agents, records its end, and drops ended runs at the next step', () => {
    const log = new Log().run('r1').runAgent('r1').runAgent('r1').runAgent('r1', true).run('r2').runEnd('r2').runAgent('r9').runEnd('r9')
    expect(fold(log).runs).toEqual({
      r1: { name: 'review', seq: 0, running: 1 },
      r2: { name: 'review', seq: 4, running: 0, end: { stopReason: 'completed', seq: 5 } },
    })
    expect(Object.keys(fold(log.step()).runs)).toEqual(['r1'])
  })

  it('drops settled work at a step that logs no request header, as most steps do', () => {
    const log = new Log().step(true).job('bash-1').run('r1').step().settle('bash-1', 'producer').runEnd('r1').step().step()
    expect(fold(log).jobs).toEqual({})
    expect(fold(log).runs).toEqual({})
  })

  it('keeps work from before a restart through later steps until the resume notice', () => {
    const log = new Log().job('bash-1').settle('bash-1', 'teardown', 'killed').run('r1').runEnd('r1').add('session/end-seed', {})
      .job('bash-2').settle('bash-2', 'producer').step()
    expect(Object.keys(fold(log).jobs)).toEqual(['bash-1'])
    expect(Object.keys(fold(log).runs)).toEqual(['r1'])
    const reported = fold(log.user('notice', { kind: 'mumbo-resume', form: 'notice', summary: 'x' }))
    expect([reported.jobs, reported.runs]).toEqual([{}, {}])
  })

  it('keeps the state itself at a step that drops nothing', () => {
    const state = fold(new Log().job('bash-1'))
    const [step] = new Log().step().events
    expect(foldState(state, step!)).toBe(state)
  })
})

describe('resume', () => {
  it('records the end-seed and the last activity before it, and a fork drops copied work', () => {
    const log = new Log().user('hi').assistant('hello').job('bash-1').run('r1')
    const restored = fold(log.add('session/end-seed', {}))
    expect(restored.resume).toEqual({ seedSeq: 4, downAt: 2000 })
    const forked = fold(new Log().user('hi').job('bash-1').run('r1').add('session/end-seed', { inherited: true }))
    expect(forked).toMatchObject({ jobs: {}, runs: {}, resume: null })
  })

  it('clears the resume and the work started before it at the notice', () => {
    const log = new Log().job('bash-1').run('r1').result('t').add('session/end-seed', {}).job('bash-2').run('r2')
      .user('This Session was restarted.', { kind: 'mumbo-resume', form: 'notice', summary: 'Restart: 2 stopped.' })
    const state = fold(log)
    expect(state).toMatchObject({ resume: null, lastActivity: 7000 })
    expect(Object.keys(state.jobs)).toEqual(['bash-2'])
    expect(Object.keys(state.runs)).toEqual(['r2'])
  })

  it('treats a notice without a pending resume as activity only', () => {
    const state = fold(new Log().job('bash-1').user('late', { kind: 'mumbo-resume', form: 'notice', summary: 'x' }))
    expect(state).toMatchObject({ resume: null, lastActivity: 2000, jobs: { 'bash-1': { seq: 0 } } })
  })
})

it('validates its own states as checkpoints, and a restored checkpoint plus its suffix folds to the full replay', () => {
  const log = new Log().job('bash-1').settle('bash-1', 'teardown', 'killed').run('r1').runEnd('r1').plan('p', '# P')
    .add('plan/mode', { active: false }).todos([{ content: 'a', status: 'completed' }]).add('session/end-seed', {})
    .job('bash-2').user('notice', { kind: 'mumbo-resume', form: 'notice', summary: 'x' }).compaction()
  const full = fold(log)
  expect(stateSchema.parse(full)).toEqual(full)
  expect(stateSchema.parse(initState())).toEqual(initState())
  for (let cut = 0; cut <= log.events.length; cut += 1) {
    const checkpoint = stateSchema.parse(JSON.parse(JSON.stringify(log.events.slice(0, cut).reduce(foldState, initState()))))
    expect(log.events.slice(cut).reduce(foldState, checkpoint), String(cut)).toEqual(full)
  }
})
