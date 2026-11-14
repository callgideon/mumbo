/** The box-wide record: what the `session/event` listener writes, what retention deletes, and what the service reads. */
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { brandString } from '@deepseek-ai/dsh-brand'
import PermissionPresetService from '@deepseek-ai/dsh-permission-presets'
import Approval from '@deepseek-ai/dsh-user-approval'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SubagentError } from '@deepseek-ai/dsh-subagent'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import * as RunWild from '../src/index.ts'
import { clipSummary } from '../src/record.ts'
import type { RecordCursor, RecordEntry } from '../src/record-types.ts'

const PRESETS = {
  'danger-full-access': { sandbox: 'danger-full-access', approval: 'ask' },
  'run-wild': { sandbox: 'danger-full-access', approval: 'ask' },
} as const

const QUESTION = { kind: 'question', target: 'env', summary: 'Which environment?', reason: RunWild.RUN_WILD_REPLY } as const

afterEach(() => { vi.useRealTimers() })

/** A fresh temporary directory, removed when the test ends. */
function temporary(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mumbo-run-wild-record-'))
  onTestFinished(() => { rmSync(dir, { recursive: true, force: true }) })
  return dir
}

/** Mount the agent-loop dependencies, the presets and Run Wild over a record in `root` (default: a new directory under a temporary one). */
async function mounted(root = join(temporary(), 'runwild'), config: { retentionDays?: number } = {}) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  const harness = await mountAgentLoopTestHarness(ctx)
  ctx.provide('shell', { sandboxMode: 'danger-full-access' } as never)
  await ctx.plugin(Approval, { policy: 'ask' })
  await ctx.plugin(PermissionPresetService, { presets: PRESETS })
  await ctx.plugin(UserQuestionService)
  const errors = vi.spyOn(ctx.logger, 'error')
  const warnings = vi.spyOn(ctx.logger, 'warn')
  const fiber = await ctx.plugin(RunWild, { root, retentionDays: 90, ...config })
  const create = async (id: string): Promise<Agent> => {
    const agent = await harness.create(SessionId(id))
    agent.session.append('turn/start', { turn: 1 })
    return agent
  }
  return { ctx, root, fiber, create, errors, warnings, record: () => ctx['mumbo-run-wild-record'] }
}

/** The parsed lines of one day file. */
function lines(root: string, day: string): unknown[] {
  return readFileSync(join(root, `${day}.jsonl`), 'utf8').split('\n').filter(line => line !== '').map((line): unknown => JSON.parse(line))
}

/** The UTC day of now. */
function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/** The day file names in a directory. */
function dayFiles(root: string): string[] {
  return readdirSync(root).sort()
}

/** One entry line as the writer writes it. */
function entry(time: number, fields: Partial<RecordEntry> = {}): RecordEntry {
  return { kind: 'question', target: 't', summary: 's', reason: 'r', v: 1, time, session: SessionId('s'), root: SessionId('s'), seq: 1, ...fields }
}

/** Write day files directly, each line a JSON value or raw text. */
function write(root: string, days: Record<string, (RecordEntry | Record<string, unknown> | string)[]>): void {
  mkdirSync(root, { recursive: true })
  for (const [day, items] of Object.entries(days)) {
    writeFileSync(join(root, `${day}.jsonl`), items.map(item => `${typeof item === 'string' ? item : JSON.stringify(item)}\n`).join(''))
  }
}

describe('the writer', () => {
  it('copies each committed decision into the day file once, with its Session, root, seq and time, and an added field', async () => {
    const { root, create } = await mounted()
    const agent = await create('root')
    agent.session.append('runwild/decision', QUESTION)
    agent.session.append('runwild/decision', { ...QUESTION, site: 'example.com' } as never)
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const logged = agent.session.snapshotEvents().filter(event => event.type === 'runwild/decision')
    await vi.waitFor(() => { expect(lines(root, today())).toHaveLength(2) })
    expect(lines(root, today())).toEqual(logged.map(event => ({ ...event.data, v: 1, time: event.time, session: 'root', root: 'root', seq: event.seq })))
    expect(lines(root, today())[1]).toMatchObject({ site: 'example.com' })
  })

  it('writes what Run Wild itself decides, such as a question it answers', async () => {
    const { ctx, root, create } = await mounted()
    const agent = await create('root')
    ctx.permissionPresets.set(agent.session, RunWild.RUN_WILD_PRESET)
    await ctx.userQuestions.ask({ agent, questions: [{ id: 'env', question: 'Which environment?', options: [] }] })
    await vi.waitFor(() => { expect(lines(root, today())).toMatchObject([QUESTION]) })
  })

  it('records a delegated child\'s decision with its root, and with its own id once its root is gone', async () => {
    const { ctx, root, create } = await mounted()
    const parent = await create('parent')
    const child = await create('child')
    let rootOf = (agent: Agent): Agent => agent === child ? parent : agent
    ctx.provide('subagents', { rootOf: (agent: Agent) => rootOf(agent) } as never)
    child.session.append('runwild/decision', QUESTION)
    rootOf = () => { throw new SubagentError('the root is gone', 'UNAUTHORIZED') }
    child.session.append('runwild/decision', QUESTION)
    await vi.waitFor(() => { expect(lines(root, today())).toHaveLength(2) })
    expect(lines(root, today())).toMatchObject([{ session: 'child', root: 'parent' }, { session: 'child', root: 'child' }])
  })

  it.each([new Error('broken registry'), new SubagentError('no manager', 'CONTINUATION_UNAVAILABLE')])('loses a decision whose root cannot be read (%s): logs only its Session and seq, and reports the record incomplete', async (failure) => {
    const { ctx, root, create, errors, record } = await mounted()
    const agent = await create('root')
    let rootOf = (_agent: Agent): Agent => { throw failure }
    ctx.provide('subagents', { rootOf: (subject: Agent) => rootOf(subject) } as never)
    agent.session.append('runwild/decision', QUESTION)
    rootOf = subject => subject
    agent.session.append('runwild/decision', { ...QUESTION, target: 'second' })
    await vi.waitFor(() => { expect(lines(root, today())).toMatchObject([{ target: 'second' }]) })
    const seq = agent.session.snapshotEvents().find(event => event.type === 'runwild/decision')!.seq
    expect(errors.mock.calls).toEqual([['mumbo-run-wild: the record lost a decision', SessionId('root'), seq, failure]])
    expect(await record().list({ limit: 5 })).toMatchObject({ entries: [{ target: 'second' }], incomplete: true })
  })

  it('links a Session without a live Agent to itself', async () => {
    const { ctx, root } = await mounted()
    const session = ctx.sessions.create(SessionId('loose'))
    session.append('runwild/decision', QUESTION)
    await vi.waitFor(() => { expect(lines(root, today())).toMatchObject([{ session: 'loose', root: 'loose' }]) })
  })

  it('writes nothing for other events, nor for decisions a resumed or forked Session inherits', async () => {
    const { ctx, root, create } = await mounted()
    const agent = await create('root')
    agent.session.append('runwild/decision', QUESTION)
    await vi.waitFor(() => { expect(lines(root, today())).toHaveLength(1) })
    await ctx.agents.create({ sessionId: SessionId('resumed'), seed: agent.session.snapshotEvents() })
    const fork = await ctx.agents.create({ sessionId: SessionId('fork'), seed: agent.session.snapshotEvents() })
    fork.agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await ctx.fiber.dispose()
    expect(lines(root, today())).toHaveLength(1)
  })

  it('keeps the directory 0700 and the files 0600, and appends without changing earlier lines', async () => {
    const { root, create } = await mounted()
    const agent = await create('root')
    agent.session.append('runwild/decision', QUESTION)
    await vi.waitFor(() => { expect(lines(root, today())).toHaveLength(1) })
    const first = readFileSync(join(root, `${today()}.jsonl`), 'utf8')
    agent.session.append('runwild/decision', { ...QUESTION, target: 'second' })
    await vi.waitFor(() => { expect(lines(root, today())).toHaveLength(2) })
    expect(readFileSync(join(root, `${today()}.jsonl`), 'utf8').startsWith(first)).toBe(true)
    expect(statSync(root).mode & 0o777).toBe(0o700)
    expect(statSync(join(root, `${today()}.jsonl`)).mode & 0o777).toBe(0o600)
  })

  it('narrows a directory and a day file that already exist with wider modes', async () => {
    const root = join(temporary(), 'runwild')
    mkdirSync(root)
    writeFileSync(join(root, `${today()}.jsonl`), '')
    chmodSync(root, 0o755)
    chmodSync(join(root, `${today()}.jsonl`), 0o644)
    const { create } = await mounted(root)
    const agent = await create('root')
    agent.session.append('runwild/decision', QUESTION)
    await vi.waitFor(() => { expect(lines(root, today())).toHaveLength(1) })
    expect([statSync(root).mode & 0o777, statSync(join(root, `${today()}.jsonl`)).mode & 0o777]).toEqual([0o700, 0o600])
  })

  it('starts on a new line after a partial line a crash left, and leaves a complete file as it is', async () => {
    const root = join(temporary(), 'runwild')
    mkdirSync(root)
    writeFileSync(join(root, `${today()}.jsonl`), '{"v":1,"kind":"quest')
    const { create, record } = await mounted(root)
    const agent = await create('root')
    agent.session.append('runwild/decision', QUESTION)
    agent.session.append('runwild/decision', QUESTION)
    await vi.waitFor(() => { expect(readFileSync(join(root, `${today()}.jsonl`), 'utf8').split('\n')).toHaveLength(4) })
    const page = await record().list({ limit: 10 })
    expect([page.entries.length, page.skipped]).toEqual([2, 1])
  })

  it('on a failed write logs only the Session and seq, keeps the Session\'s append, and reports the record incomplete', async () => {
    const parent = temporary()
    const root = join(parent, 'runwild')
    writeFileSync(root, 'not a directory')
    const { create, errors, record } = await mounted(root)
    const agent = await create('root')
    const secret = { ...QUESTION, summary: 'password hunter2 in the refused call' }
    agent.session.append('runwild/decision', secret)
    await vi.waitFor(() => { expect(errors).toHaveBeenCalled() })
    const seq = agent.session.snapshotEvents().find(event => event.type === 'runwild/decision')!.seq
    expect(errors.mock.calls[0]!.slice(0, 3)).toEqual(['mumbo-run-wild: the record lost a decision', SessionId('root'), seq])
    expect(JSON.stringify(errors.mock.calls, (_key, value: unknown) => value instanceof Error ? value.message : value)).not.toContain('hunter2')
    rmSync(root)
    expect(await record().list({ limit: 1 })).toMatchObject({ entries: [], incomplete: true })
    expect(await record().count(0, Date.now())).toMatchObject({ incomplete: true })
  })

  it('finishes pending writes before the plugin unloads', async () => {
    const { root, create, fiber } = await mounted()
    const agent = await create('root')
    for (let n = 0; n < 20; n += 1) agent.session.append('runwild/decision', { ...QUESTION, target: String(n) })
    await fiber.dispose()
    expect(lines(root, today()).map(line => (line as RecordEntry).target)).toEqual(Array.from({ length: 20 }, (_, n) => String(n)))
  })
})

describe('retention', () => {
  it('deletes day files older than the retention at start and at the first write of a new day, and leaves newer and other files', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-12T10:00:00Z'))
    const root = join(temporary(), 'runwild')
    write(root, { '2026-08-13': [entry(0)], '2026-08-14': [entry(0)], '2026-11-11': [entry(0)] })
    writeFileSync(join(root, 'notes.txt'), 'kept')
    const { create } = await mounted(root)
    await vi.waitFor(() => { expect(dayFiles(root)).toEqual(['2026-08-14.jsonl', '2026-11-11.jsonl', 'notes.txt']) })
    vi.setSystemTime(new Date('2026-11-13T00:00:01Z'))
    const agent = await create('root')
    agent.session.append('runwild/decision', QUESTION)
    await vi.waitFor(() => { expect(dayFiles(root)).toEqual(['2026-11-11.jsonl', '2026-11-13.jsonl', 'notes.txt']) })
  })

  it('takes its days from the Config, and logs a delete that fails', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-12T10:00:00Z'))
    const root = join(temporary(), 'runwild')
    write(root, { '2026-11-10': [entry(0)], '2026-11-11': [entry(0)] })
    mkdirSync(join(root, '2026-11-09.jsonl', 'busy'), { recursive: true })
    const { warnings } = await mounted(root, { retentionDays: 1 })
    await vi.waitFor(() => { expect(dayFiles(root)).toEqual(['2026-11-09.jsonl', '2026-11-11.jsonl']) })
    expect(warnings).toHaveBeenCalledWith('mumbo-run-wild: could not delete an expired record file', '2026-11-09.jsonl', expect.anything())
  })

  it('starts with nothing to do without a directory, and warns when the directory cannot be read', async () => {
    const parent = temporary()
    await mounted(join(parent, 'absent'))
    writeFileSync(join(parent, 'file'), '')
    const { warnings } = await mounted(join(parent, 'file'))
    await vi.waitFor(() => { expect(warnings).toHaveBeenCalledWith('mumbo-run-wild: could not read the record directory for retention', expect.anything()) })
  })
})

describe('the service', () => {
  const DAY1 = '2026-11-10', DAY2 = '2026-11-11'
  const at = (day: string, hour: number): number => Date.parse(`${day}T${String(hour).padStart(2, '0')}:00:00Z`)

  it('lists newest first by time, then line order, across days, with the day\'s skipped lines', async () => {
    const root = join(temporary(), 'runwild')
    write(root, {
      [DAY1]: [entry(at(DAY1, 9), { target: 'a' }), 'not json', 'null', { ...entry(at(DAY1, 9)), v: 2 }, entry(at(DAY1, 9), { target: 'b' })],
      [DAY2]: [entry(at(DAY2, 8), { target: 'd', kind: 'paint', colour: 'red' }), entry(at(DAY2, 7), { target: 'c' })],
    })
    writeFileSync(join(root, 'other.txt'), '')
    const { record } = await mounted(root)
    const page = await record().list({ limit: 10 })
    expect(page.entries.map(item => item.target)).toEqual(['d', 'c', 'b', 'a'])
    expect(page.entries[0]).toEqual(entry(at(DAY2, 8), { target: 'd', kind: 'paint', colour: 'red' }))
    expect([page.skipped, page.incomplete, page.retentionDays, page.next]).toEqual([3, false, 90, undefined])
  })

  it('pages with a cursor across two days, filters by kind, and stops at since', async () => {
    const root = join(temporary(), 'runwild')
    write(root, {
      [DAY1]: [entry(at(DAY1, 1), { target: 'a', kind: 'send' }), entry(at(DAY1, 2), { target: 'b' }), entry(at(DAY1, 3), { target: 'c', kind: 'send' })],
      [DAY2]: [entry(at(DAY2, 1), { target: 'd', kind: 'send' }), entry(at(DAY2, 2), { target: 'e' })],
    })
    const { record } = await mounted(root)
    const first = await record().list({ limit: 2 })
    expect([first.entries.map(item => item.target), first.next]).toEqual([['e', 'd'], `${DAY2}:0`])
    const second = await record().list({ limit: 2, cursor: first.next! })
    expect([second.entries.map(item => item.target), second.next]).toEqual([['c', 'b'], `${DAY1}:1`])
    const third = await record().list({ limit: 2, cursor: second.next! })
    expect([third.entries.map(item => item.target), third.next]).toEqual([['a'], undefined])
    expect((await record().list({ limit: 10, kinds: ['send'] })).entries.map(item => item.target)).toEqual(['d', 'c', 'a'])
    expect((await record().list({ limit: 10, since: at(DAY1, 2) })).entries.map(item => item.target)).toEqual(['e', 'd', 'c', 'b'])
    expect((await record().list({ limit: 10, since: at(DAY2, 0) })).entries.map(item => item.target)).toEqual(['e', 'd'])
    // A cursor into a day that retention deleted ends the listing; one the service cannot read starts from the newest.
    expect((await record().list({ limit: 10, cursor: brandString<RecordCursor>('2026-01-01:0') })).entries).toEqual([])
    expect((await record().list({ limit: 1, cursor: brandString<RecordCursor>('yesterday') })).entries.map(item => item.target)).toEqual(['e'])
  })

  it('reads an empty record before the first write, and fails when the root cannot be listed', async () => {
    const parent = temporary()
    const { record } = await mounted(join(parent, 'absent'))
    expect(await record().list({ limit: 5 })).toEqual({ entries: [], skipped: 0, incomplete: false, retentionDays: 90 })
    expect(await record().count(0, 1)).toEqual({ counts: {}, skipped: 0, incomplete: false })
    writeFileSync(join(parent, 'file'), '')
    const broken = await mounted(join(parent, 'file'))
    await expect(broken.record().list({ limit: 5 })).rejects.toThrow(/ENOTDIR/)
  })

  it('skips a day file that vanished after the directory was listed', async () => {
    const root = join(temporary(), 'runwild')
    write(root, { [DAY2]: [entry(at(DAY2, 1), { kind: 'send' })] })
    // A link to nothing is listed but cannot be read, as a file retention deleted meanwhile.
    symlinkSync(join(root, 'gone'), join(root, `${DAY1}.jsonl`))
    const { record } = await mounted(root)
    expect((await record().list({ limit: 5 })).entries).toHaveLength(1)
    expect((await record().count(at(DAY1, 0), at(DAY2, 23))).counts).toEqual({ send: 1 })
  })

  it('fails when a day file cannot be read', async () => {
    const root = join(temporary(), 'runwild')
    mkdirSync(join(root, `${DAY1}.jsonl`), { recursive: true })
    const { record } = await mounted(root)
    await expect(record().list({ limit: 5 })).rejects.toThrow(/EISDIR/)
  })

  it('counts entries per kind with since <= time < until', async () => {
    const root = join(temporary(), 'runwild')
    write(root, {
      [DAY1]: [entry(at(DAY1, 23), { kind: 'send' }), 'bad'],
      [DAY2]: [entry(at(DAY2, 0), { kind: 'send' }), entry(at(DAY2, 5), { kind: 'post' }), entry(at(DAY2, 5), { kind: 'send' })],
      '2026-11-12': [entry(Date.parse('2026-11-12T00:00:00Z'), { kind: 'send' })],
    })
    const { record } = await mounted(root)
    expect(await record().count(at(DAY2, 0), Date.parse('2026-11-12T00:00:00Z'))).toEqual({ counts: { send: 2, post: 1 }, skipped: 0, incomplete: false })
    expect(await record().count(at(DAY1, 23), at(DAY2, 0) + 1)).toEqual({ counts: { send: 2 }, skipped: 1, incomplete: false })
  })

  it('clips a summary to 2,000 characters', async () => {
    expect(clipSummary('x'.repeat(2000))).toBe('x'.repeat(2000))
    expect(clipSummary('x'.repeat(2001))).toBe(`${'x'.repeat(1999)}…`)
    const { root, create } = await mounted()
    const agent = await create('root')
    agent.session.append('runwild/decision', { ...QUESTION, summary: 'y'.repeat(3000) })
    await vi.waitFor(() => { expect(lines(root, today())).toMatchObject([{ summary: `${'y'.repeat(1999)}…` }]) })
  })

  it('ends with the plugin, and a missing root fails at load', async () => {
    const { ctx, fiber } = await mounted()
    expect(ctx.get('mumbo-run-wild-record')).toBeDefined()
    await fiber.dispose()
    expect(ctx.get('mumbo-run-wild-record')).toBeUndefined()
    expect(() => RunWild.Config({} as never)).toThrow()
    expect(() => RunWild.Config({ root: 'relative/dir', retentionDays: 90 })).toThrow()
  })
})
