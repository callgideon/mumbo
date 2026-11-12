/**
 * The plugin booted through the Loader from the project overlay's row and from the person-box overlay, with the real
 * loop, plan mode, todo list and job registry; only the model and the person are stand-ins.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Agents from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import Llm from '@deepseek-ai/dsh-llm'
import PlanModeController from '@deepseek-ai/dsh-plan-mode'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import * as ToolTodo from '@deepseek-ai/dsh-tool-todo'
import Tools from '@deepseek-ai/dsh-tools'
import UserQuestions from '@deepseek-ai/dsh-user-questions'
import { afterEach, describe, expect, it } from 'vitest'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as MumboState from '../src/index.ts'
import { BLOCK_HEADER } from '../src/render.ts'
import { notices, OPTIONS, startJob, stateSections, turn } from './harness.ts'

const repo = resolve(import.meta.dirname, '../../../..')
const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const PLAN = '# Deploy plan\n\n## Build the image\n\n## Ship it\n\nRoll back if the health check fails.'

/** The overlay rows that mount the plugin: the project overlay's insert of `@mumbo/state`, or the whole person-box overlay. */
function patches(composition: 'project' | 'person'): ReturnType<typeof loadOverlayPatches> {
  if (composition === 'person') return loadOverlayPatches('dsh', join(repo, 'packages/mumbo/state/examples/person.overlay.yml'))
  const rows = loadOverlayPatches('dsh', join(repo, 'deploy/mumbo-project.overlay.yml'))
  return rows.filter(row => 'insert' in row && JSON.stringify(row.insert).includes('"@mumbo/state"'))
}

describe('real Loader composition', () => {
  it.each(['project', 'person'] as const)('mounts from the %s overlay: the block, plan_read once a plan is approved, and the resume notice', { timeout: 60_000 }, async (composition) => {
    const root = await mkdtemp(join(tmpdir(), 'mumbo-state-'))
    roots.push(root)
    const model = new MockAdapter([
      toolCallResponse('call-plan', 'exit_plan_mode', { plan: PLAN }),
      toolCallResponse('call-todo', 'todo_write', { todos: [{ content: 'Build the image', status: 'in_progress' }] }),
      textResponse('Planned.'),
      toolCallResponse('call-read', 'plan_read', {}),
      textResponse('Read.'),
    ])
    const modules = new Map<string, unknown>([
      ['llm', Llm], ['sessions', Sessions], ['projections', Projections], ['prompt', SystemPrompt], ['tools', Tools],
      ['toolExecutor', NativeToolExecutor], ['agents', Agents], ['loop', AgentLoop], ['userQuestions', UserQuestions],
      ['planMode', PlanModeController], ['todo', ToolTodo], ['jobs', LocalJobRegistry], ['@mumbo/state', MumboState],
      // The person in the browser approves every plan.
      ['person', { apply(ctx: Context) {
        ctx.on('user-questions/request', request => Promise.resolve({
          answers: request.questions.map(item => ({ id: item.id, selected: [item.intent?.approve ?? ''] })),
        }))
      } }],
      ['model', { inject: ['llm'], apply(ctx: Context) { ctx.effect(() => ctx.llm.registerAdapter(['fixture'], model)) } }],
    ])
    const configs: Record<string, unknown> = { loop: { agents: [] }, planMode: { section: 'Plan before you act.' }, todo: { allowParallelInProgress: true } }
    const base = join(root, 'cordis.yml')
    await writeFile(base, JSON.stringify([...modules.keys()].filter(id => id !== '@mumbo/state').map(id => ({ id, name: id, config: configs[id] ?? {} }))))

    const ctx = new Context()
    contexts.push(ctx)
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = class FixtureInclude extends Include {
      override import(specifier: string, getOuterStack?: () => string[]): unknown {
        if (specifier.startsWith('cordis:')) return super.import(specifier, getOuterStack)
        if (!modules.has(specifier)) throw new Error(`unexpected fixture module ${specifier}`)
        return modules.get(specifier)
      }
    }
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(base).href, patches: patches(composition) } })
    await ctx.loader.await()
    const entries = [...ctx.loader.entries()]
    expect(entries.filter(entry => entry.fiber === undefined).map(entry => entry.options.id)).toEqual([])
    expect(entries.filter(entry => entry.options.name === '@mumbo/state').map(entry => entry.options.id)).toEqual(['mumbo-state'])
    ctx.jobs.attachController('test')

    const handle = await ctx.agents.create({ sessionId: SessionId('mumbo'), agentOptions: OPTIONS })
    ctx.planMode.set(handle.agent, true)
    await turn(handle.agent, 'Plan the deploy.')
    const job = startJob(ctx, handle.agent, 'docker build .')
    const before = handle.agent.session.snapshotEvents()
    await handle.dispose()
    const { agent } = await ctx.agents.create({ sessionId: handle.agent.id, seed: before, agentOptions: OPTIONS })
    await turn(agent, 'Continue.')

    const tools = model.requests.map(request => (request.tools ?? []).map(tool => tool.name))
    expect(tools[0]).not.toContain('plan_read')
    expect(tools[3]).toContain('plan_read')
    expect(stateSections(agent).at(-1)).toBe([
      BLOCK_HEADER,
      'Plan "Deploy plan" (approved in turn 1; full text: plan_read):', '  1. Build the image', '  2. Ship it',
      'Todo (1 of 1 open, written in turn 1):', '  [in_progress] Build the image',
    ].join('\n'))
    expect(notices(agent).map(notice => notice.text)).toEqual([
      `This Session was restarted. What changed while it was down:\n- Stopped by the restart, output not kept: background job ${job.id} (bash: docker build .).`,
    ])
    const read = agent.session.snapshotEvents().flatMap(event => event.type === 'tool/result' && event.data.message.toolCallId === 'call-read'
      ? event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : [])
      : [])
    expect(read).toEqual([`Approved in turn 1.\n\n${PLAN}`])
  })
})
