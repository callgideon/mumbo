import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage, type MessageSource, ToolCallId } from '@deepseek-ai/dsh-llm'
import PermissionPresetService from '@deepseek-ai/dsh-permission-presets'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture, executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import Approval from '@deepseek-ai/dsh-user-approval'
import * as RunWild from '@mumbo/run-wild'
import { describe, expect, it, onTestFinished } from 'vitest'
import type { ProjectId } from '../src/auth.ts'
import type {} from '../src/conversation.ts'
import { gateReportTurns } from '../src/report-turns.ts'

/** The person-box preset table with the Run Wild entry. */
const PRESETS = {
  'danger-full-access': { sandbox: 'danger-full-access', approval: 'ask' },
  'run-wild': { sandbox: 'danger-full-access', approval: 'ask' },
} as const

const ASK = "The newest message in this Session is a project's report, so the shell asks before each command: it runs with your box's sign-ins, such as GitHub."
const REFUSAL = "Error: bash did not run: the newest message in this Session is a project's report, and in Run Wild the shell runs only after a message from the person. Say what you would run and why, so the person can reply to let it run."

const REPORT: MessageSource = { kind: 'report', project: brandString<ProjectId>('site0000000000aa') }
const PERSON: MessageSource = { kind: 'user' }
const DOOR: MessageSource = { kind: 'mcp', principal: 'ann' }

/** Where the gate's listener sits relative to Run Wild's: mounted before it (inner) or after it (outer). */
type Order = 'before Run Wild' | 'after Run Wild'

/**
 * Mount the real approval and permission services, Run Wild and the gate, a `bash` fixture and a `deploy` fixture, and
 * the person's answerer, which records each approval reason and gives `answer`.
 */
async function mounted(order: Order = 'before Run Wild') {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  const harness = await mountAgentLoopTestHarness(ctx)
  // The permission presets read the sandbox mode; the `bash` fixture stands in for the shell tool.
  ctx.provide('shell', { sandboxMode: 'danger-full-access' } as never)
  await ctx.plugin(Approval, { policy: 'ask' })
  await ctx.plugin(PermissionPresetService, { presets: PRESETS })
  const gate = { name: 'report-gate', inject: ['sessionProjections', 'permissionPresets'], apply: gateReportTurns }
  const gated = order === 'before Run Wild' ? await ctx.plugin(gate) : undefined
  await ctx.plugin(RunWild)
  const fiber = gated ?? await ctx.plugin(gate)
  const asked: (string | undefined)[] = []
  const person = { answer: 'rejected' as 'allowed-once' | 'rejected' }
  ctx.on('approval/request', (request) => {
    asked.push(request.reason)
    return Promise.resolve(person.answer)
  })
  for (const name of ['bash', 'deploy']) {
    ctx.tools.register(defineContentToolFixture({
      name, description: `${name} fixture`, parameters: {}, execute: () => Promise.resolve([{ type: 'text', text: `ran ${name}` }]),
    }))
  }
  const create = async (id: string, preset: string, sources: readonly MessageSource[]): Promise<Agent> => {
    const agent = await harness.create(SessionId(id))
    ctx.permissionPresets.set(agent.session, preset)
    agent.session.append('turn/start', { turn: 1 })
    for (const source of sources) say(agent, source)
    return agent
  }
  const run = (name: string, agent?: Agent): Promise<ToolExecutionResult> => executeToolFixture(ctx, {
    callId: ToolCallId(`call-${name}`), name, arguments: {}, signal: new AbortController().signal, ...agent === undefined ? {} : { agent },
  })
  return { ctx, asked, person, create, run, fiber }
}

/** Append one user-role message with `source`, as the loop logs a claimed message. */
function say(agent: Agent, source: MessageSource): void {
  agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'hello' }], source }), { surfaceOp: 'append' })
}

/** The text of a tool result. */
function text(result: ToolExecutionResult): string {
  return result.content.map(block => block.type === 'text' ? block.text : '').join('')
}

/** The `runwild/decision` records in an Agent's Session log. */
function decisions(agent: Agent) {
  return agent.session.snapshotEvents().filter(event => event.type === 'runwild/decision')
}

describe('reportStarted', () => {
  it('follows the newest message from a person or a project, and ignores every other source', async () => {
    const { ctx, create } = await mounted()
    const agent = await create('root', 'danger-full-access', [])
    const started = (): boolean => ctx['mumbo-report-turns'].reportStarted(agent)
    expect(started()).toBe(false)
    say(agent, REPORT)
    expect(started()).toBe(true)
    // Context the harness adds and a schedule's message are nobody's new request.
    say(agent, { kind: 'runtime-context' })
    say(agent, { kind: 'schedule' })
    expect(started()).toBe(true)
    say(agent, PERSON)
    expect(started()).toBe(false)
    say(agent, REPORT)
    say(agent, DOOR)
    expect(started()).toBe(false)
  })

  it('reads a report re-surfaced by a replacement as no new message', async () => {
    const { ctx, create } = await mounted()
    const agent = await create('root', 'danger-full-access', [PERSON])
    const replaced = SessionSeq(agent.session.seq - 1)
    agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'summary' }], source: REPORT }),
      { surfaceOp: { op: 'replace', startSeq: replaced, endSeq: replaced }, sourceEventSeqs: [replaced] })
    expect(ctx['mumbo-report-turns'].reportStarted(agent)).toBe(false)
  })

  it('follows a delegated child\'s live root Session', async () => {
    const { ctx, create } = await mounted()
    const root = await create('root', 'danger-full-access', [REPORT])
    const child = await create('child', 'danger-full-access', [PERSON])
    ctx.provide('subagents', { rootOf: (agent: Agent) => agent === child ? root : agent } as never)
    expect(ctx['mumbo-report-turns'].reportStarted(child)).toBe(true)
    say(root, PERSON)
    expect(ctx['mumbo-report-turns'].reportStarted(child)).toBe(false)
  })
})

describe('the shell in a report-started turn', () => {
  it('asks the person in Full access, and runs only when they allow it', async () => {
    const { asked, person, create, run } = await mounted()
    const agent = await create('root', 'danger-full-access', [PERSON, REPORT])
    expect(text(await run('bash', agent))).toBe('Error: the user rejected tool "bash"')
    person.answer = 'allowed-once'
    expect(text(await run('bash', agent))).toBe('ran bash')
    expect(asked).toEqual([ASK, ASK])
    // Only the shell is gated.
    expect(text(await run('deploy', agent))).toBe('ran deploy')
    expect(asked).toHaveLength(2)
  })

  it.each(['before Run Wild', 'after Run Wild'] as const)('is refused without asking under Run Wild, mounted %s', async (order) => {
    const { asked, create, run } = await mounted(order)
    const agent = await create('root', RunWild.RUN_WILD_PRESET, [REPORT])
    const refused = await run('bash', agent)
    expect(refused.isError).toBe(true)
    expect(text(refused)).toBe(REFUSAL)
    expect(asked).toEqual([])
    expect(decisions(agent)).toEqual([])
  })

  it('keeps a denial from a later policy', async () => {
    const { ctx, asked, create, run } = await mounted()
    ctx.on('tools/pre-execute', () => Promise.resolve({ kind: 'deny', reason: 'not here' }))
    const agent = await create('root', 'danger-full-access', [REPORT])
    expect(text(await run('bash', agent))).toBe('Error: not here')
    expect(asked).toEqual([])
  })
})

describe('the shell in a turn a person started', () => {
  it.each([
    ['Full access', 'danger-full-access', PERSON],
    ['Run Wild', RunWild.RUN_WILD_PRESET, PERSON],
    ['Full access, through the door', 'danger-full-access', DOOR],
  ] as const)('runs unasked in %s', async (_label, preset, source) => {
    const { asked, create, run } = await mounted()
    const agent = await create('root', preset, [REPORT, source])
    expect(text(await run('bash', agent))).toBe('ran bash')
    expect(asked).toEqual([])
  })

  it('runs unasked without an Agent, and once the gate is unloaded', async () => {
    const { ctx, asked, create, run, fiber } = await mounted()
    const agent = await create('root', 'danger-full-access', [REPORT])
    expect(text(await run('bash'))).toBe('ran bash')
    await fiber.dispose()
    expect(ctx.get('mumbo-report-turns')).toBeUndefined()
    expect(text(await run('bash', agent))).toBe('ran bash')
    expect(asked).toEqual([])
  })
})
