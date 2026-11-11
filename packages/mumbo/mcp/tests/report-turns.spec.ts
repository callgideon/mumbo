import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { brandString } from '@deepseek-ai/dsh-brand'
import { CompactionId, compactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import { GoalId } from '@deepseek-ai/dsh-goal'
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
import { gateReportTurns, runsUnasked } from '../src/report-turns.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Stands in for a source this package does not know, such as a resume notice. */
    'mumbo-resume': { kind: 'mumbo-resume' }
  }
}

/** The person-box preset table with the Run Wild entry. */
const PRESETS = {
  'danger-full-access': { sandbox: 'danger-full-access', approval: 'ask' },
  'run-wild': { sandbox: 'danger-full-access', approval: 'ask' },
} as const

const ASK = "This turn started with a project's report, so every action but reading asks first: it runs with your box's sign-ins, such as GitHub."
const refusal = (tool: string): string => `Error: ${tool} did not run: this turn started with a project's report, and in Run Wild such a turn runs only reading tools and todo_write. Say what you would do and why, so the person can reply to let it run.`

const REPORT: MessageSource = { kind: 'report', project: brandString<ProjectId>('site0000000000aa') }
const PERSON: MessageSource = { kind: 'user' }
const DOOR: MessageSource = { kind: 'mcp', principal: 'ann' }
const SCHEDULE: MessageSource = { kind: 'schedule' }
const GOAL: MessageSource = { kind: 'goal', goalId: GoalId('goal-1'), revision: 1, round: 1 }
/** The runtime-context snapshot the loop appends after a step's claimed messages. */
const CONTEXT: MessageSource = { kind: 'runtime-context', form: 'snapshot', sections: [{ name: 'time', text: 'Now: 09:00.' }] }
const RESUME: MessageSource = { kind: 'mumbo-resume' }

/**
 * Gated stand-ins: the shells, programs, schedule and goal changes, delegation, the web, the desktop, and MCP writes.
 * `run_code` is reserved for the PTC executor, so no fixture stands in for it.
 */
const GATED = [
  'bash', 'pwsh', 'workflow', 'schedule_create', 'schedule_edit', 'create_goal', 'subagent', 'team_task_create', 'web_fetch',
  'web_search', 'computer', 'mcp__playwright-mcp__browser_click', 'mcp__sandboxes__create', 'write',
] as const

/** Stand-ins that run unasked: file reads and searches, status reads, the todo list, and browser reads. */
const UNASKED = ['read', 'read_image', 'glob', 'grep', 'get_goal', 'job_list', 'todo_write', 'mcp__playwright-mcp__browser_snapshot'] as const

/** Where the gate's listener sits relative to Run Wild's: mounted before it (inner) or after it (outer). */
type Order = 'before Run Wild' | 'after Run Wild'

/**
 * Mount the real approval and permission services, Run Wild and the gate, a fixture for each named tool, and the
 * person's answerer, which records each approval reason and gives `answer`.
 */
async function mounted(order: Order = 'before Run Wild') {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  const harness = await mountAgentLoopTestHarness(ctx)
  // The permission presets read the sandbox mode; the fixtures stand in for the box's tools.
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
  for (const name of [...GATED, ...UNASKED, 'mcp__playwright-mcp__browser_navigate']) {
    ctx.tools.register(defineContentToolFixture({
      name, description: `${name} fixture`, parameters: { url: { type: 'string' } }, execute: () => Promise.resolve([{ type: 'text', text: `ran ${name}` }]),
    }))
  }
  /** Create a root Agent in `preset` whose first turn's first step claims `sources`. */
  const create = async (id: string, preset: string, sources: readonly MessageSource[]): Promise<{ agent: Agent; log: TurnLog }> => {
    const agent = await harness.create(SessionId(id))
    ctx.permissionPresets.set(agent.session, preset)
    const log = turnLog(agent)
    log.turn(...sources)
    return { agent, log }
  }
  const run = (name: string, agent?: Agent, args: Record<string, unknown> = {}): Promise<ToolExecutionResult> => executeToolFixture(ctx, {
    callId: ToolCallId(`call-${name}`), name, arguments: args, signal: new AbortController().signal, ...agent === undefined ? {} : { agent },
  })
  return { ctx, asked, person, create, run, fiber }
}

/** Logs a Session's turns as the loop does: each step claims its messages after `step/start`. */
interface TurnLog {
  /** Close the open step and turn, if any, open the next turn, and log its first step with `sources`. */
  turn(...sources: MessageSource[]): void
  /** Close the open step and log the next step of the same turn with `sources`. */
  step(...sources: MessageSource[]): void
}

/** A {@link TurnLog} for one Agent's Session. */
function turnLog(agent: Agent): TurnLog {
  let turn = 0
  let step = 0
  const closeStep = (): void => {
    if (step > 0) agent.session.append('step/end', { turn, step })
  }
  const log: TurnLog = {
    turn: (...sources) => {
      closeStep()
      if (turn > 0) agent.session.append('turn/end', { turn, reason: { kind: 'completed' } })
      turn += 1
      step = 0
      agent.session.append('turn/start', { turn })
      log.step(...sources)
    },
    step: (...sources) => {
      closeStep()
      step += 1
      agent.session.append('step/start', { turn, step })
      for (const source of sources) say(agent, source)
    },
  }
  return log
}

/**
 * Continue a turn whose first step logged a report and a runtime-context snapshot, as its last two events: a second step
 * compacts both into a checkpoint, a third gets a runtime-context refresh, and a fourth a resume notice.
 */
function continueReportTurn(agent: Agent, log: TurnLog): void {
  const [report, context] = [SessionSeq(agent.session.seq - 2), SessionSeq(agent.session.seq - 1)]
  log.step()
  const checkpoint = createUserMessage({ content: [{ type: 'text', text: 'summary' }], source: compactCheckpointSource(CompactionId('compaction-1')) })
  agent.session.append('user/message', checkpoint, { surfaceOp: { op: 'replace', startSeq: report, endSeq: context }, sourceEventSeqs: [report, context] })
  log.step(CONTEXT)
  log.step(RESUME)
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
  it('follows the message that opened the current turn', async () => {
    const { ctx, create } = await mounted()
    const { agent, log } = await create('root', 'danger-full-access', [])
    const started = (): boolean => ctx['mumbo-report-turns'].reportStarted(agent)
    expect(started()).toBe(false)
    log.turn(REPORT, CONTEXT)
    expect(started()).toBe(true)
    for (const source of [PERSON, DOOR, SCHEDULE, GOAL]) {
      log.turn(REPORT)
      expect(started()).toBe(true)
      log.turn(source, CONTEXT)
      expect(started(), source.kind).toBe(false)
    }
  })

  it('keeps the origin through a mid-turn compaction, a runtime-context refresh and a resume notice', async () => {
    const { ctx, create } = await mounted()
    const { agent, log } = await create('root', 'danger-full-access', [REPORT, CONTEXT])
    continueReportTurn(agent, log)
    expect(ctx['mumbo-report-turns'].reportStarted(agent)).toBe(true)
  })

  it('keeps the origin when a later step claims a person\'s message', async () => {
    const { ctx, create } = await mounted()
    const { agent, log } = await create('root', 'danger-full-access', [REPORT])
    log.step(PERSON)
    expect(ctx['mumbo-report-turns'].reportStarted(agent)).toBe(true)
    log.turn(PERSON)
    log.step(REPORT)
    expect(ctx['mumbo-report-turns'].reportStarted(agent)).toBe(false)
  })

  it('counts a report claimed with a person\'s message in the opening step, in either order', async () => {
    const { ctx, create } = await mounted()
    const { agent, log } = await create('root', 'danger-full-access', [PERSON, REPORT])
    expect(ctx['mumbo-report-turns'].reportStarted(agent)).toBe(true)
    log.turn(REPORT, DOOR)
    expect(ctx['mumbo-report-turns'].reportStarted(agent)).toBe(true)
  })

  it('keeps the previous turn\'s origin when no message of a new turn names one', async () => {
    const { ctx, create } = await mounted()
    const { agent, log } = await create('root', 'danger-full-access', [REPORT])
    log.turn(RESUME, CONTEXT)
    expect(ctx['mumbo-report-turns'].reportStarted(agent)).toBe(true)
    log.turn(PERSON)
    log.turn(RESUME)
    expect(ctx['mumbo-report-turns'].reportStarted(agent)).toBe(false)
  })

  it('reads a report re-surfaced by a replacement as no new message', async () => {
    const { ctx, create } = await mounted()
    const { agent, log } = await create('root', 'danger-full-access', [PERSON])
    log.turn(RESUME)
    const replaced = SessionSeq(agent.session.seq - 1)
    agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'summary' }], source: REPORT }),
      { surfaceOp: { op: 'replace', startSeq: replaced, endSeq: replaced }, sourceEventSeqs: [replaced] })
    expect(ctx['mumbo-report-turns'].reportStarted(agent)).toBe(false)
  })

  it('follows a delegated child\'s live root Session', async () => {
    const { ctx, create } = await mounted()
    const { agent: root, log } = await create('root', 'danger-full-access', [REPORT])
    const { agent: child } = await create('child', 'danger-full-access', [PERSON])
    ctx.provide('subagents', { rootOf: (agent: Agent) => agent === child ? root : agent } as never)
    expect(ctx['mumbo-report-turns'].reportStarted(child)).toBe(true)
    log.turn(PERSON)
    expect(ctx['mumbo-report-turns'].reportStarted(child)).toBe(false)
  })
})

describe('runsUnasked', () => {
  it('lets only reads and the todo list run, and follows browser consent for browser calls', () => {
    expect(UNASKED.filter(name => !runsUnasked(name, {}))).toEqual([])
    // `needs_you` is the door's tool for the edge, not a model tool, so the list does not name it.
    expect([...GATED, 'run_code', 'needs_you'].filter(name => runsUnasked(name, {}))).toEqual([])
    expect(runsUnasked('mcp__playwright-mcp__browser_navigate', { url: 'https://example.com' })).toBe(true)
    expect(runsUnasked('mcp__playwright-mcp__browser_navigate', { url: 'file:///etc/passwd' })).toBe(false)
  })
})

describe('tools in a report-started turn', () => {
  it.each(GATED)('%s asks the person in Full access, and runs only when they allow it', async (name) => {
    const { asked, person, create, run } = await mounted()
    const { agent } = await create('root', 'danger-full-access', [REPORT])
    expect(text(await run(name, agent))).toBe(`Error: the user rejected tool "${name}"`)
    person.answer = 'allowed-once'
    expect(text(await run(name, agent))).toBe(`ran ${name}`)
    expect(asked).toEqual([ASK, ASK])
  })

  it.each(UNASKED)('%s runs unasked, in Run Wild too', async (name) => {
    const { asked, create, run } = await mounted()
    const { agent } = await create('root', RunWild.RUN_WILD_PRESET, [REPORT])
    expect(text(await run(name, agent))).toBe(`ran ${name}`)
    expect(asked).toEqual([])
  })

  it('asks for a browser navigation that browser consent does not count as a read', async () => {
    const { asked, create, run } = await mounted()
    const { agent } = await create('root', 'danger-full-access', [REPORT])
    const navigate = 'mcp__playwright-mcp__browser_navigate'
    expect(text(await run(navigate, agent, { url: 'https://example.com' }))).toBe(`ran ${navigate}`)
    expect(text(await run(navigate, agent, { url: 'file:///etc/passwd' }))).toBe(`Error: the user rejected tool "${navigate}"`)
    expect(asked).toEqual([ASK])
  })

  it.each(['before Run Wild', 'after Run Wild'] as const)('bash is refused without asking under Run Wild, mounted %s', async (order) => {
    const { asked, create, run } = await mounted(order)
    const { agent } = await create('root', RunWild.RUN_WILD_PRESET, [REPORT])
    const refused = await run('bash', agent)
    expect(refused.isError).toBe(true)
    expect(text(refused)).toBe(refusal('bash'))
    expect(asked).toEqual([])
    expect(decisions(agent)).toEqual([])
  })

  it.each(GATED)('%s is refused without asking under Run Wild', async (name) => {
    const { asked, create, run } = await mounted('after Run Wild')
    const { agent } = await create('root', RunWild.RUN_WILD_PRESET, [REPORT])
    expect(text(await run(name, agent))).toBe(refusal(name))
    expect(asked).toEqual([])
  })

  it('still refuses bash on the last step of a turn that compacted, refreshed its context and got a resume notice', async () => {
    const { create, run } = await mounted()
    const { agent, log } = await create('root', RunWild.RUN_WILD_PRESET, [REPORT, CONTEXT])
    continueReportTurn(agent, log)
    expect(text(await run('bash', agent))).toBe(refusal('bash'))
  })

  it('keeps a denial from a later policy', async () => {
    const { ctx, asked, create, run } = await mounted()
    ctx.on('tools/pre-execute', () => Promise.resolve({ kind: 'deny', reason: 'not here' }))
    const { agent } = await create('root', 'danger-full-access', [REPORT])
    expect(text(await run('bash', agent))).toBe('Error: not here')
    expect(asked).toEqual([])
  })
})

describe('tools in a turn a person started', () => {
  it.each([
    ['Full access', 'danger-full-access', PERSON],
    ['Run Wild', RunWild.RUN_WILD_PRESET, PERSON],
    ['Full access, through the door', 'danger-full-access', DOOR],
    ['Run Wild, by a scheduled task', RunWild.RUN_WILD_PRESET, SCHEDULE],
    ['Run Wild, by a goal', RunWild.RUN_WILD_PRESET, GOAL],
  ] as const)('run unasked in %s', async (_label, preset, source) => {
    const { asked, create, run } = await mounted()
    const { agent, log } = await create('root', preset, [REPORT])
    log.turn(source)
    for (const name of ['bash', 'web_fetch']) expect(text(await run(name, agent))).toBe(`ran ${name}`)
    expect(asked).toEqual([])
  })

  it('run unasked without an Agent, and once the gate is unloaded', async () => {
    const { ctx, asked, create, run, fiber } = await mounted()
    const { agent } = await create('root', 'danger-full-access', [REPORT])
    expect(text(await run('bash'))).toBe('ran bash')
    await fiber.dispose()
    expect(ctx.get('mumbo-report-turns')).toBeUndefined()
    expect(text(await run('bash', agent))).toBe('ran bash')
    expect(asked).toEqual([])
  })
})
