/**
 * Run Wild booted through the Loader with the real loop, plan mode, question tool and permission presets; only the
 * model, the shell and the person are stand-ins.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Agents from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Llm, { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import PermissionPresetService from '@deepseek-ai/dsh-permission-presets'
import PlanModeController from '@deepseek-ai/dsh-plan-mode'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as AskUser from '@deepseek-ai/dsh-tool-ask-user'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import Tools from '@deepseek-ai/dsh-tools'
import Approval from '@deepseek-ai/dsh-user-approval'
import UserQuestions from '@deepseek-ai/dsh-user-questions'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as RunWild from '../src/index.ts'
import { RUN_WILD_CONTEXT, RUN_WILD_INSTRUCTIONS, RUN_WILD_PRESET, RUN_WILD_REPLY } from '../src/index.ts'

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const PRESETS = {
  'read-only': { sandbox: 'read-only', approval: 'ask' },
  'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
  'danger-full-access': { sandbox: 'danger-full-access', approval: 'ask' },
  'run-wild': { sandbox: 'danger-full-access', approval: 'ask' },
}

const PLAN_APPROVED = 'Plan approved — plan mode exited; carry out the plan starting with your next step.'

/** What the person was asked: plan reviews and questions by id, and tool approvals by tool name. */
interface Asked { questions: string[]; approvals: string[] }

/** The turn in which the model presents a plan, asks a question, and calls `deploy`, which a policy row asks approval for. */
const DECIDING_TURN = (): StreamChunk[][] => [
  toolCallResponse('call-plan', 'exit_plan_mode', { plan: '# Deploy plan\n\nShip the build.' }),
  toolCallResponse('call-ask', 'ask_user_question', { questions: [{ id: 'env', question: 'Which environment?' }] }),
  toolCallResponse('call-deploy', 'deploy', {}),
  textResponse('Done.'),
]

/**
 * Boot the composition with `defaultPreset`, then run one turn of `script`, in plan mode when `planMode` is set. The
 * person approves plans, answers `Production`, and allows tools.
 * @returns the Session's Agent, the model, and what the person was asked.
 */
async function runTurn(
  defaultPreset: string, script: StreamChunk[][] = DECIDING_TURN(), planMode = true,
): Promise<{ ctx: Context; agent: Agent; model: MockAdapter; asked: Asked }> {
  const root = await mkdtemp(join(tmpdir(), 'mumbo-run-wild-'))
  roots.push(root)
  const asked: Asked = { questions: [], approvals: [] }
  const model = new MockAdapter(script)
  const modules = new Map<string, unknown>([
    ['llm', Llm], ['sessions', Sessions], ['projections', Projections], ['prompt', SystemPrompt], ['tools', Tools],
    ['toolExecutor', NativeToolExecutor], ['agents', Agents], ['loop', AgentLoop], ['approval', Approval],
    ['userQuestions', UserQuestions], ['askUser', AskUser], ['planMode', PlanModeController], ['permission', PermissionPresetService],
    ['runWild', RunWild],
    // A tool whose policy asks the person first, as a PreToolUse hook does.
    ['deploy', { inject: ['tools'], apply(ctx: Context) {
      ctx.tools.register(defineContentToolFixture({
        name: 'deploy', description: 'Deploy the build.', parameters: {}, execute: () => Promise.resolve([{ type: 'text', text: 'deployed' }]),
      }))
      ctx.on('tools/pre-execute', (exec, next) => exec.name === 'deploy' ? Promise.resolve({ kind: 'ask', reason: 'Deploy to production?' }) : next())
    } }],
    // The person's switch to Run Wild while the turn runs, as the selector makes it.
    ['switch', { inject: ['tools', 'permissionPresets'], apply(ctx: Context) {
      ctx.tools.register(defineContentToolFixture({
        name: 'switch', description: 'Switch to Run Wild.', parameters: {}, execute: (_args, exec) => {
          ctx.permissionPresets.set(exec.agent!.session, RUN_WILD_PRESET)
          return Promise.resolve([{ type: 'text', text: 'switched' }])
        },
      }))
    } }],
    // The person in the browser, an external input.
    ['person', { apply(ctx: Context) {
      ctx.on('user-questions/request', (request) => {
        asked.questions.push(...request.questions.map(item => item.id))
        return Promise.resolve({ answers: request.questions.map(item => ({ id: item.id, selected: [item.intent?.approve ?? 'Production'] })) })
      })
      ctx.on('approval/request', (request) => {
        asked.approvals.push(request.toolName)
        return Promise.resolve('allowed-once')
      })
    } }],
    ['model', { inject: ['llm'], apply(ctx: Context) { ctx.effect(() => ctx.llm.registerAdapter(['fixture'], model)) } }],
  ])
  const configs: Record<string, unknown> = {
    loop: { agents: [] },
    approval: { policy: 'ask' },
    planMode: { section: 'Plan before you act.' },
    permission: { presets: PRESETS, defaultPreset },
    runWild: { root: join(root, 'runwild') },
  }
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, JSON.stringify([...modules.keys()].map(id => ({ id, name: id, config: configs[id] ?? {} }))))

  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(root).href + '/'
  // The executor that would run commands is outside this test; presets only read its sandbox mode.
  ctx.provide('shell', {
    sandboxMode: 'danger-full-access',
    resolve() { throw new Error('the composition runs no commands') },
    run() { throw new Error('the composition runs no commands') },
    start() { throw new Error('the composition runs no commands') },
  })
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = class FixtureInclude extends Include {
    override import(specifier: string, getOuterStack?: () => string[]): unknown {
      if (specifier.startsWith('cordis:')) return super.import(specifier, getOuterStack)
      if (!modules.has(specifier)) throw new Error(`unexpected fixture module ${specifier}`)
      return modules.get(specifier)
    }
  }
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  expect([...ctx.loader.entries()].filter(entry => entry.fiber === undefined).map(entry => entry.options.id)).toEqual([])

  const agent = await ctx.agentLoop.create(SessionId('mumbo'), { provider: 'fixture', model: 'fixture' })
  if (planMode) ctx.planMode.set(agent, true)
  const idle = new Promise<void>((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Plan and ship the build.' }], source: { kind: 'user' } }))
  await idle
  return { ctx, agent, model, asked }
}

/** The model-visible text of each tool result, in order. */
function toolResults(agent: Agent): string[] {
  return agent.session.snapshotEvents().flatMap(event => event.type === 'tool/result'
    ? [event.data.message.content.map(block => block.type === 'text' ? block.text : '').join('')]
    : [])
}

/** The `mumbo:run-wild` section texts of a logged or requested runtime-context message. */
function runWildSections(message: { source?: unknown }): string[] {
  const source = message.source as { kind: string; sections?: { name: string; text: string }[] } | undefined
  return source?.kind === 'runtime-context'
    ? (source.sections ?? []).flatMap(section => section.name === RUN_WILD_CONTEXT ? [section.text] : [])
    : []
}

/** The payloads of one event type, in log order. */
function logged(agent: Agent, type: 'plan/mode' | 'runwild/decision'): unknown[] {
  return agent.session.snapshotEvents().flatMap(event => event.type === type ? [event.data] : [])
}

describe('real Loader composition', () => {
  it('in Run Wild, approves the plan, answers the question and runs the asking tool without asking the person', { timeout: 60_000 }, async () => {
    const { ctx, agent, asked } = await runTurn('run-wild')
    expect(ctx.permissionPresets.current(agent.session)).toBe('run-wild')
    expect(toolResults(agent)).toEqual([
      PLAN_APPROVED,
      JSON.stringify({ answers: [{ id: 'env', selected: [], custom: RUN_WILD_REPLY }] }),
      'deployed',
    ])
    expect(logged(agent, 'plan/mode')).toEqual([{ active: true }, { active: false }])
    expect(asked).toEqual({ questions: [], approvals: [] })
    expect(logged(agent, 'runwild/decision')).toEqual([
      {
        kind: 'plan-review', target: 'call-plan', reason: 'Run Wild approves plans without review.',
        summary: 'Approve this plan and leave plan mode?\n\n# Deploy plan\n\nShip the build.',
      },
      { kind: 'question', target: 'env', summary: 'Which environment?', reason: RUN_WILD_REPLY },
      { kind: 'approval', target: 'deploy', summary: 'Deploy to production?', reason: 'Run Wild allows tool approvals.' },
    ])
  })

  it('copies the turn\'s decisions into the box-wide record, which the service lists newest first', { timeout: 60_000 }, async () => {
    const { ctx, agent } = await runTurn('run-wild')
    const listed = async () => (await ctx['mumbo-run-wild-record'].list({ limit: 10 })).entries
    await vi.waitFor(async () => { expect(await listed()).toHaveLength(3) })
    const decisions = agent.session.snapshotEvents().filter(event => event.type === 'runwild/decision').reverse()
    const lines = decisions.map(event => ({ ...event.data, v: 1, time: event.time, session: agent.id, root: agent.id, seq: event.seq }))
    expect(await listed()).toEqual(lines)
  })

  it('in Full access, with the same knobs, leaves the plan, the question and the approval to the person', { timeout: 60_000 }, async () => {
    const { ctx, agent, asked } = await runTurn('danger-full-access')
    expect(ctx.permissionPresets.current(agent.session)).toBe('danger-full-access')
    expect(toolResults(agent)).toEqual([
      PLAN_APPROVED,
      JSON.stringify({ answers: [{ id: 'env', selected: ['Production'] }] }),
      'deployed',
    ])
    expect(asked).toEqual({ questions: ['plan-review', 'env'], approvals: ['deploy'] })
    expect(logged(agent, 'runwild/decision')).toEqual([])
  })
})

describe('Run Wild instructions through the real loop', () => {
  it('reaches the model at the step after a switch made during the turn', { timeout: 60_000 }, async () => {
    const { agent, model } = await runTurn('danger-full-access', [toolCallResponse('call-switch', 'switch', {}), textResponse('Done.')], false)
    const rows = agent.session.snapshotEvents()
    const snapshots = rows.flatMap((row, index) => row.type === 'user/message' && row.data.source.kind === 'runtime-context'
      ? [{ index, sections: runWildSections(row.data) }] : [])
    const step2 = rows.findIndex(row => row.type === 'step/start' && row.data.turn === 1 && row.data.step === 2)
    const reply = rows.findIndex(row => row.type === 'assistant/message' && row.data.step === 2)
    expect(snapshots.map(snapshot => snapshot.sections)).toEqual([[], [RUN_WILD_INSTRUCTIONS]])
    expect(snapshots[0]!.index).toBeLessThan(step2)
    expect(snapshots[1]!.index).toBeGreaterThan(step2)
    expect(snapshots[1]!.index).toBeLessThan(reply)
    expect(model.requests).toHaveLength(2)
    expect(runWildSections(model.requests[1]!.messages.at(-1)!)).toEqual([RUN_WILD_INSTRUCTIONS])
  })
})
