/**
 * The state block in a real agent loop: its text changes only at a compaction, a restart or a goal phase change, and
 * what the model receives is the logged text.
 */

import type { Context } from '@deepseek-ai/cordis'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import GoalService from '@deepseek-ai/dsh-goal'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as ToolTodo from '@deepseek-ai/dsh-tool-todo'
import { expect, it, vi } from 'vitest'
import { textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { subagentCatalogProjectionDefinition } from '../../../subagent/subagent/src/catalog.ts'
import { STATE_CONTEXT } from '../src/index.ts'
import { BLOCK_HEADER } from '../src/render.ts'
import { boot, notices, requestTexts, startJob, stateSections, turn } from './harness.ts'

const TODOS = [{ content: 'Parse quantities', status: 'in_progress' }, { content: 'Ship the report', status: 'pending' }]
const TODO_MESSAGE = createUserMessage({ content: [{ type: 'text', text: 'Run the slow suite.' }], source: { kind: 'user' } })
const EDITED = [{ content: 'Parse quantities', status: 'completed' }, { content: 'Ship the report', status: 'in_progress' }]

async function mount(ctx: Context): Promise<void> {
  await ctx.plugin(ToolTodo, { allowParallelInProgress: true })
  await ctx.plugin(GoalService)
}

it('changes the block once at each compaction, restart and goal phase change, and never for todo edits or a goal edit', { timeout: 60_000 }, async () => {
  const harness = await boot([
    toolCallResponse('t1', 'todo_write', { todos: TODOS }), textResponse('one'),
    textResponse('two'),
    toolCallResponse('t2', 'todo_write', { todos: EDITED }), textResponse('three'),
    textResponse('four'),
    textResponse('five'),
    textResponse('six'),
    textResponse('seven'),
  ], mount)
  const { ctx, model } = harness
  const handle = await harness.start('freeze')
  const agent = handle.agent

  // Nothing to show at the first render; the todo list that turn writes waits for a boundary.
  await turn(agent, 'Start.')
  expect(stateSections(agent)).toEqual([])

  agent.session.append('compaction/end', { compactionId: CompactionId('c1'), turn: null })
  await turn(agent, 'Status?')
  const afterCompaction = [
    BLOCK_HEADER, 'Todo (2 of 2 open, written in turn 1):', '  [in_progress] Parse quantities', '  [pending] Ship the report',
  ].join('\n')
  expect(stateSections(agent)).toEqual([afterCompaction])

  // Todo edits and a failed compaction leave the block as it was.
  agent.session.append('compaction/end', { compactionId: CompactionId('c2'), turn: null, error: 'model failed' })
  await turn(agent, 'Edit the list.')
  expect(stateSections(agent)).toEqual([afterCompaction])

  const goal = ctx.goals.create(agent, { objective: 'Ship the checksum report', maxGoalRounds: 8 })
  await turn(agent, 'Go on.')
  const withGoal = afterCompaction.replace(BLOCK_HEADER, `${BLOCK_HEADER}\nGoal (active; round 0 of 8): Ship the checksum report`)
    .replace('2 of 2 open, written in turn 1', '1 of 2 open, written in turn 3').replace('  [in_progress] Parse quantities\n  [pending]', '  [in_progress]')
  expect(stateSections(agent)).toEqual([afterCompaction, withGoal])

  ctx.goals.edit(agent, goal, { objective: 'Ship something else' })
  await turn(agent, 'Go on.')
  expect(stateSections(agent)).toEqual([afterCompaction, withGoal])

  // Every request since the last boundary carried the last logged block.
  const carried = (index: number): string | undefined => requestTexts(model, index).filter(text => text.includes(BLOCK_HEADER)).at(-1)
  for (const index of [2, 3, 4]) expect(carried(index), String(index)).toContain(afterCompaction)
  for (const index of [5, 6]) expect(carried(index), String(index)).toContain(withGoal)

  const restarted = await harness.restart(handle)
  await turn(restarted.agent, 'Back.')
  const sections = stateSections(restarted.agent)
  expect(sections).toHaveLength(3)
  expect(sections[2]).toContain('Goal (active, stopped by a restart: a person must resume it with /goal resume; round 0 of 8): Ship something else')
  expect(carried(7)).toContain(sections[2])
  expect(notices(restarted.agent).map(notice => notice.summary)).toEqual(['Restart: goal needs a person.'])

  const current = ctx.goals.get(restarted.agent)!
  ctx.goals.block(restarted.agent, current, { code: 'needs-key', message: 'the deploy key is missing' })
  await turn(restarted.agent, 'Blocked?')
  expect(stateSections(restarted.agent).at(-1)).toContain('Goal (blocked: the deploy key is missing; round 0 of 8): Ship something else')
})

it('shows open team tasks, running direct children and live jobs as they are at the boundary', { timeout: 60_000 }, async () => {
  const harness = await boot(['hang', textResponse('parent')], async (ctx) => {
    await ctx.plugin(LocalJobRegistry)
    ctx.jobs.attachController('test')
    await ctx.sessionProjections.register(subagentCatalogProjectionDefinition)
    ctx.provide('agentTeams', {
      isEnabled: () => true,
      listTasks: () => [
        { id: 4, status: 'in_progress', ownerName: 'reviewer', subject: 'Review the parser change' },
        { id: 5, status: 'completed', subject: 'Done already' },
      ],
    } as never)
  })
  const child = (await harness.start('child')).agent
  child.followup(TODO_MESSAGE)
  await vi.waitFor(() => { expect(child.status).toBe('running') })
  const parent = (await harness.start('parent')).agent
  const add = (childId: string, entry: object) => {
    parent.session.append('subagent/catalog', { childId: SessionId(childId), childCreatedAt: 0, ...entry } as never)
  }
  add(String(child.id), { version: 3, mode: 'continuable', label: 'run the slow suite', name: 'tester' })
  add('idle', { version: 1, mode: 'one-shot', label: 'done' })
  const job = startJob(harness.ctx, parent, 'node scripts/slow-check.js')
  const finished = startJob(harness.ctx, parent, 'true')
  finished.finish()
  await vi.waitFor(() => { expect(harness.ctx.jobs.get(finished.id, parent.session.id).status).toBe('completed') })
  await turn(parent, 'Status?')
  expect(stateSections(parent)).toEqual([[
    BLOCK_HEADER,
    'Team tasks (1 open; team_task_list):', '  #4 [in_progress, reviewer] Review the parser change',
    'Subagents running (list_agents):', '  tester: run the slow suite',
    'Background jobs (job_list):', `  ${job.id} [running] node scripts/slow-check.js`,
  ].join('\n')])
  // An assembly for no Agent, such as a diagnostic one, shows no block.
  const assembly = await harness.ctx.systemPrompt.assemble({})
  expect(assembly.contexts.find(context => context.name === STATE_CONTEXT)?.text).toBe('')
})
