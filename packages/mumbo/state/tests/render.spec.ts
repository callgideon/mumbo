/** The state block's text and its character cap; plan headings. */

import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { describe, expect, it, onTestFinished } from 'vitest'
import { PLAN_READ, planHeadings, registerPlanRead } from '../src/plan.ts'
import { BLOCK_HEADER, render, type StateView } from '../src/render.ts'

const FULL: StateView = {
  goal: { phase: 'active', armed: false, roundsStarted: 3, maxGoalRounds: 256, objective: 'Make the inventory tests pass and ship the checksum report.' },
  plan: { title: 'Inventory fixes', steps: ['Fix parsing of quantities', 'Add the restock rule'], turn: 2 },
  todos: {
    items: [
      { content: 'Parse quantities', status: 'completed' }, { content: 'Restock rule for negative stock', status: 'in_progress' },
      { content: 'Write the checksum report', status: 'pending' },
    ],
    turn: 6,
  },
  team: [{ id: '4', status: 'in_progress', owner: 'reviewer', subject: 'Review the parser change' }, { id: '5', status: 'pending', owner: undefined, subject: 'Docs' }],
  subagents: [{ name: 'tester', label: 'run the slow suite' }, { name: 'fixer', label: undefined }, { name: 'one-shot', label: 'one-shot' }],
  jobs: [{ id: 'bash-1a2b', status: 'running', label: 'node scripts/slow-check.js' }],
}

describe('render', () => {
  it('renders nothing for an empty view or a todo list with nothing open', () => {
    expect(render({}, 1600)).toBe('')
    expect(render({ team: [], subagents: [], jobs: [], todos: { items: [{ content: 'Done', status: 'completed' }], turn: 1 } }, 1600)).toBe('')
  })

  it('renders every section in its fixed order', () => {
    expect(render(FULL, 1600)).toBe([
      BLOCK_HEADER,
      'Goal (active, automatic rounds stopped: a person must resume it with /goal resume; round 3 of 256): Make the inventory tests pass and ship the checksum report.',
      'Plan "Inventory fixes" (approved in turn 2; full text: plan_read):',
      '  1. Fix parsing of quantities',
      '  2. Add the restock rule',
      'Todo (2 of 3 open, written in turn 6):',
      '  [in_progress] Restock rule for negative stock',
      '  [pending] Write the checksum report',
      'Team tasks (2 open; team_task_list):',
      '  #4 [in_progress, reviewer] Review the parser change',
      '  #5 [pending] Docs',
      'Subagents running (list_agents):',
      '  tester: run the slow suite',
      '  fixer',
      '  one-shot',
      'Background jobs (job_list):',
      '  bash-1a2b [running] node scripts/slow-check.js',
    ].join('\n'))
  })

  it('names the goal phase, an armed goal, a blocked reason, and a plan without a title', () => {
    const goal = { roundsStarted: 1, maxGoalRounds: 8, objective: 'Ship' }
    expect(render({ goal: { ...goal, phase: 'active', armed: true } }, 1600)).toContain('Goal (active; round 1 of 8): Ship')
    expect(render({ goal: { ...goal, phase: 'paused', armed: false } }, 1600)).toContain('Goal (paused; round 1 of 8): Ship')
    expect(render({ goal: { ...goal, phase: 'blocked', armed: false, blockedReason: 'needs a key' } }, 1600))
      .toContain('Goal (blocked: needs a key; round 1 of 8): Ship')
    expect(render({ plan: { title: undefined, steps: [], turn: 1 } }, 1600)).toBe(`${BLOCK_HEADER}\nPlan (approved in turn 1; full text: plan_read):`)
  })

  it('puts a block reason and a plan title on one line, clipped, so their sections stay in the block', () => {
    const goal = { phase: 'blocked' as const, armed: false, roundsStarted: 3, maxGoalRounds: 8, objective: 'Ship it' }
    expect(render({ goal: { ...goal, blockedReason: 'Key missing.\nTried A.\n\tTried B.' } }, 1600))
      .toBe(`${BLOCK_HEADER}\nGoal (blocked: Key missing. Tried A. Tried B.; round 3 of 8): Ship it`)
    expect(render({ goal: { ...goal, blockedReason: 'r'.repeat(1500) } }, 1600))
      .toBe(`${BLOCK_HEADER}\nGoal (blocked: ${'r'.repeat(139)}…; round 3 of 8): Ship it`)
    expect(render({ plan: { title: `${'t'.repeat(1400)}\nmore`, steps: ['Build'], turn: 1 } }, 1600))
      .toBe(`${BLOCK_HEADER}\nPlan "${'t'.repeat(139)}…" (approved in turn 1; full text: plan_read):\n  1. Build`)
  })

  it('never clips inside a surrogate pair', () => {
    const text = render({ todos: { items: [{ content: `${'a'.repeat(120)}${'😀'.repeat(30)}`, status: 'pending' }], turn: 1 } }, 1600)
    const line = text.split('\n')[2]!
    expect(line.isWellFormed()).toBe(true)
    expect(line).toBe(`  [pending] ${'a'.repeat(120)}${'😀'.repeat(3)}…`)
  })

  it('keeps the cap with a long objective, 40 todos and 30 headings, pointing at what does not fit', () => {
    const view: StateView = {
      ...FULL,
      goal: { ...FULL.goal!, objective: 'x'.repeat(2000) },
      plan: { title: 'Big', steps: Array.from({ length: 30 }, (_, index) => `Step ${String(index)} ${'y'.repeat(200)}`), turn: 1 },
      todos: { items: Array.from({ length: 40 }, (_, index) => ({ content: `Todo ${String(index)}`, status: 'pending' as const })), turn: 1 },
    }
    const text = render(view, 1600)
    expect(text.length).toBeLessThanOrEqual(1600)
    const lines = text.split('\n')
    expect(lines[1]).toHaveLength(OBJECTIVE_LINE_MAX)
    expect(lines[1]!.endsWith('…')).toBe(true)
    expect(lines.filter(line => line.startsWith('  ')).every(line => line.length <= 140)).toBe(true)
    expect(lines).toContainEqual(expect.stringMatching(/^ {2}… \d+ more \(plan_read\)$/u))
    expect(lines.at(-1)).toBe('Not shown: todo (your last todo_write), team tasks (team_task_list), subagents (list_agents), background jobs (job_list).')
  })

  it('cuts a section\'s items short with a pointer and never exceeds a small cap', () => {
    const view: StateView = { jobs: Array.from({ length: 10 }, (_, index) => ({ id: `bash-${String(index)}`, status: 'running', label: 'sleep 100' })) }
    const text = render(view, 400)
    expect(text.length).toBeLessThanOrEqual(400)
    expect(text).toMatch(/\n {2}… \d+ more \(job_list\)$/u)
    const long = render({ goal: { ...FULL.goal!, objective: 'z'.repeat(400) } }, 400)
    expect(long).toBe(`${BLOCK_HEADER}\nNot shown: goal (get_goal).`)
  })
})

/** The goal heading's length with an objective clipped to 300 characters. */
const OBJECTIVE_LINE_MAX = 'Goal (active, automatic rounds stopped: a person must resume it with /goal resume; round 3 of 256): '.length + 300

describe('planHeadings', () => {
  it('reads the title and the second- and third-level headings', () => {
    expect(planHeadings('Intro\n# Fix it\n\n## Parse\ntext\n### Test  \n#### Deep\n# Second title\n- not a step')).toEqual({
      title: 'Fix it', steps: ['Parse', 'Test'],
    })
  })

  it('falls back to column-0 list items, and has no title without a top heading', () => {
    expect(planHeadings('1. One\n2) Two\n- Three\n* Four\n  - nested\n10. Ten')).toEqual({
      title: undefined, steps: ['One', 'Two', 'Three', 'Four', 'Ten'],
    })
  })
})

describe('plan_read', () => {
  it('presents itself as a read, and refuses a call with no approved plan or no calling Agent', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await mountAgentLoopTestDependencies(ctx)
    registerPlanRead(ctx, () => null)
    const tool = ctx.tools.get(PLAN_READ)!
    expect(tool.presentCall?.({})).toEqual({ card: 'generic', title: 'Read approved plan', kind: 'read' })
    expect(tool.isConcurrencySafe?.({})).toBe(true)
    await expect(tool.execute({}, { agent: undefined } as never)).rejects.toThrow('No plan has been approved in this Session.')
    await expect(tool.execute({}, { agent: {} } as never)).rejects.toThrow('No plan has been approved in this Session.')
  })
})
