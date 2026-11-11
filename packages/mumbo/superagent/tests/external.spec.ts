/**
 * In Mumbo, the external-worker Executor (`UPSTREAM.md` S13) on a running Runtime: relayed requests become external Tickets,
 * which workers outside the box claim and report on through the management API under a lease that each call renews, an
 * expired lease ends, and work that waits queues again. DSH admission is the fixture's owner, or a stand-in member.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { key, type Ticket } from '../src/core/index.ts'
import { KV } from '../src/kv.ts'
import type { ClaimView, Lease, ReportView } from '../src/mumbo/external.ts'
import { ciSummary } from '../src/sources/github-read.ts'
import { ciTrigger } from '../src/sources/github-trigger.ts'
import { RELAY_PATH, registerRelay, relayTrigger } from '../src/sources/relay.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

type Handler = (req: unknown, res: unknown) => Promise<void>
const ALICE = 'alice@example.com'
const HOPS = [{ node: 'member', id: ALICE }, { node: 'edge', id: 'app.mumbo.si' }]
const LAPTOP = { key: 'k1', name: 'laptop', model: 'claude-opus' }
const MINUTE = 60_000
const LONG = 'Steps: '.padEnd(700, 'x')

let host: Host
let relayHandler: Handler | undefined
let unregister: () => void
beforeEach(async () => {
  host = await startRuntime()
  unregister = registerRelay({ connection: { admit: () => ({ peer: { principal: { kind: 'edge-member', email: ALICE }, signal: new AbortController().signal } }) },
    webServer: { register: (route: { path: string; handler: Handler }) => {
      expect(route.path).toBe(RELAY_PATH)
      relayHandler = route.handler
      return () => { relayHandler = undefined }
    } } } as never, host.runtime)
})
afterEach(async () => { vi.useRealTimers(); unregister(); await host.stop() })

const message = (id: string, kind: 'request' | 'context', text: string, extra: Record<string, unknown> = {}) =>
  ({ id, kind, text, hops: HOPS, ...extra })
/** Relay one message as Alice; returns the route's status and JSON body. */
async function relay(body: Record<string, unknown>) {
  let status = 0, text = ''
  const req = { method: 'POST', url: RELAY_PATH, headers: {}, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) } }
  await relayHandler!(req, { writeHead: (code: number) => { status = code }, end: (data: string) => { text = data } })
  await host.runtime.idle()
  return { status, body: JSON.parse(text) as Record<string, unknown> }
}
const store = () => host.runtime.store
const stored = (id: string): Ticket => store().tickets.get(id)!
/** Accept the candidate of `triggerId` as the main Session would; returns the Ticket. */
async function accept(triggerId: string, name: string): Promise<Ticket> {
  const result = await host.route({ kind: 'accept', trigger_id: triggerId, title: `Fix ${name}`, worktree_name: `fix-${name}`, acknowledgement: 'On it.' })
  await host.runtime.idle()
  return stored((result.ticket as { ticket_id: string }).ticket_id)
}
/** A relayed request from Alice, accepted as a Ticket for a worker outside the box, or a local one. */
async function requested(id: string, external = true): Promise<Ticket> {
  const sent = await relay(message(id, 'request', `Fix ${id}`, external ? { worker: 'external' } : {}))
  return accept(String(sent.body.trigger), id)
}
const claim = (body: Record<string, unknown> = {}) => host.api('POST', 'workers/claim', { request: 'r1', worker: LAPTOP, ...body })
/** A response body as the route's answer type. */
const answered = <T>(response: { body: unknown }): T => response.body as T
async function claimed(body: Record<string, unknown> = {}): Promise<ClaimView> {
  const answer = await claim(body)
  expect(answer.status, JSON.stringify(answer.body)).toBe(200)
  return answered<ClaimView>(answer)
}
const report = (view: Pick<ClaimView, 'assignment' | 'lease'>, body: Record<string, unknown> = {}) => host.api('POST',
  `workers/${view.assignment}/report`, { lease: view.lease, worker: { key: LAPTOP.key }, state: 'progress', summary: 'Working on it', ...body })
const refused = (status: number, code: string) => ({ status, body: { error: expect.any(String), code } })
/** Moves the clock `minutes` on; the clock stands still from then on. */
function later(minutes: number): void {
  const at = Date.now() + minutes * MINUTE
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(at)
}
const lease = (assignment: string): Lease | undefined => store().get(KV.external.lease(assignment))
/** Releases a lease, as a submit of the worker's result does. */
const release = (assignment: string) => { store().set(KV.external.lease(assignment), { ...lease(assignment)!, releasedAt: new Date().toISOString() }) }
/** The Ticket's Assignments as `[state, endedReason]`. */
const assignments = (id: string) => stored(id).assignments.map(item => [item.state, item.endedReason])
const inputText = (view: { inputs: { text: string }[] }) => view.inputs.map(input => input.text)
const latestState = (id: string) => stored(id).assignments.at(-1)!.report?.state
/** Acknowledges every Input the claim answered, then releases the lease. */
async function settled(view: ClaimView): Promise<void> {
  expect((await report(view, { ack: view.inputs.map(input => input.id) })).status).toBe(200)
  release(view.assignment)
}

describe('claim', () => {
  it('leases the oldest queued external Ticket, or the named one, with its full brief and Inputs, which stay undelivered until acknowledged', async () => {
    // A request with context on its conversation, assessed together: the context is the Ticket's batch.
    const request = relayTrigger(ALICE, { id: 'm1', kind: 'request', text: `Fix the login page. ${LONG}`, hops: HOPS, worker: 'external' }, new Date().toISOString())
    const context = relayTrigger(ALICE, { id: 'm2', kind: 'context', text: `It uses OAuth. ${LONG}`, hops: HOPS, thread: 'm1' }, new Date().toISOString())
    host.runtime.engine.receive(request); host.runtime.engine.receive(context)
    await host.runtime.pump()
    await host.runtime.idle()
    const first = await accept(request.id, 'm1')
    const second = await requested('m3')
    // A follow-up on the conversation reaches the first Ticket as an Input.
    await relay(message('m4', 'context', `The second button. ${LONG}`, { thread: 'm1' }))
    const input = stored(first.id).undelivered[0]!
    const view = await claimed()
    expect(view).toMatchObject({ ticket: first.id, title: 'Fix m1', assignment: first.assignments[0]!.id, attempt: 1, renewWithinSeconds: 600,
      repository: 'acme/widgets', branch: `agent/${first.execution!.name}`, base: 'main', more: 0,
      brief: { request: { trigger_id: request.id, from: ALICE, text: request.text }, batch: [{ trigger_id: context.id, text: context.text }],
        assignment: first.execution!.assignment, mandate: '' } })
    expect(view.lease).toMatch(/^[0-9a-f]{32}$/)
    expect(Date.parse(view.leaseExpiresAt) - Date.now()).toBeGreaterThan(19 * MINUTE)
    expect(view.inputs.map(item => [item.id, JSON.parse(item.text).text])).toEqual([[input, `The second button. ${LONG}`]])
    // A worker outside the box reads no in-box resource.
    expect(JSON.stringify(view)).not.toMatch(/"(read|chars|source_url_read)"/)
    expect(stored(first.id).assignments[0]).toMatchObject({ state: 'running', worker: LAPTOP })
    expect(stored(first.id).undelivered).toEqual([input])
    expect(lease(view.assignment)).toMatchObject({ id: view.lease, ticketId: first.id, worker: LAPTOP, request: 'r1', expiresAt: view.leaseExpiresAt })
    // The Inputs wait until a report acknowledges them.
    expect(inputText(answered<ReportView>(await report(view)))).toHaveLength(1)
    expect((await report(view, { ack: [input] })).body).toMatchObject({ inputs: [], more: 0 })
    expect(stored(first.id)).toMatchObject({ undelivered: [] })
    expect(stored(first.id).inputs.find(item => item.id === input)).toMatchObject({ deliveredTo: view.assignment, readAt: expect.any(String) })
    expect(await claimed({ ticket: second.id, request: 'r2' })).toMatchObject({ ticket: second.id, attempt: 1 })
  })

  it('answers a retried claim with its lease, with no second Ticket claimed, and nothing of it to another key', async () => {
    const first = await requested('m1'), second = await requested('m2')
    const view = await claimed()
    later(1)
    const again = await claimed()
    expect(again).toMatchObject({ ticket: first.id, assignment: view.assignment, lease: view.lease })
    expect(Date.parse(again.leaseExpiresAt)).toBeGreaterThan(Date.parse(view.leaseExpiresAt))
    expect(stored(second.id).assignments[0]!.state).toBe('pending')
    const other = await claimed({ worker: { key: 'k2', name: 'desktop' } })
    expect(other).toMatchObject({ ticket: second.id })
    expect(other.lease).not.toBe(view.lease)
    expect(await claim({ request: 'r3' })).toEqual(refused(409, 'nothing_queued'))
    release(view.assignment)
    expect(await claim()).toEqual(refused(409, 'lease_released'))
  })

  it('refuses a local Ticket, a leased one with any key, a released one and an unknown one, and every claim while paused', async () => {
    const local = await requested('m1', false)
    expect(local.executor).toBeUndefined()
    expect(await claim({ ticket: local.id })).toEqual(refused(409, 'not_claimable'))
    expect(await claim()).toEqual(refused(409, 'nothing_queued'))
    const ticket = await requested('m2')
    const view = await claimed({ ticket: ticket.id })
    for (const body of [{ request: 'r2' }, { request: 'r1', worker: { key: 'k2', name: 'desktop' } }]) {
      expect(await claim({ ticket: ticket.id, ...body })).toEqual(refused(409, 'already_claimed'))
    }
    release(view.assignment)
    expect(await claim({ ticket: ticket.id, request: 'r2' })).toEqual(refused(409, 'not_claimable'))
    expect(await claim({ ticket: 'f'.repeat(32), request: 'r4' })).toEqual(refused(404, 'not_found'))
    await requested('m4')
    await host.runtime.settings.pause(true, 'panel')
    expect(await claim({ request: 'r4' })).toEqual(refused(409, 'paused'))
    await host.runtime.settings.pause(false, 'panel')
    vi.spyOn(host.runtime.setup, 'configured').mockReturnValue(false)
    expect(await claim({ request: 'r4' })).toEqual(refused(409, 'paused'))
  })

  it('admits only the owner and panel admins', async () => {
    vi.spyOn(host.connection, 'admit').mockReturnValue({ peer: { principal: { kind: 'edge-member', email: 'bob@example.com' }, signal: new AbortController().signal } } as never)
    expect(await claim()).toEqual({ status: 403, body: { error: 'Management requires the owner or a panel admin' } })
    expect((await report({ assignment: 'a', lease: 'f'.repeat(32) })).status).toBe(403)
  })
})

describe('report', () => {
  it('renews the lease, asks a person a question through the main Session, records an answer, and refuses ready', async () => {
    const ticket = await requested('m1')
    const view = await claimed()
    later(5)
    const asked = await report(view, { question: 'Which button?' })
    expect(asked).toMatchObject({ status: 200, body: { inputs: [], more: 0, attention: { question: 'Which button?' } } })
    expect(Date.parse(String(asked.body.leaseExpiresAt))).toBe(Date.now() + 20 * MINUTE)
    expect(lease(view.assignment)?.renewedAt).toBe(new Date().toISOString())
    const attention = stored(ticket.id).attention!
    await host.runtime.idle()
    expect(host.relays(host.runtime.masterId).filter(item => item.kind === 'worker_attention')).toMatchObject([{ ticket: { ticket_id: ticket.id } }])
    // The main Session sends the question to the conversation the request came from.
    await host.runTool(host.runtime.masterId, 'orchestrator_reply', { purpose: 'attention', ticket_id: ticket.id, human_action: 'Which button?', text: 'Which button?' })
    expect(store().receipts.get(key('attention-reply', attention.id))).toMatchObject({ kind: 'reply', channel: { source: 'relay', thread: `relay:${ALICE}/m1` } })
    // The worker answers the person's request in a report.
    const answer = await report(view, { question: null, answers: ticket.origin.triggerId, summary: 'The second button is fixed.' })
    expect(answer.body).not.toHaveProperty('attention')
    expect(stored(ticket.id)).toMatchObject({ answers: [ticket.origin.triggerId] })
    await host.runtime.idle()
    expect(host.relays(host.runtime.masterId).filter(item => item.kind === 'worker_report')).toMatchObject([{ answer_to: ticket.origin.triggerId }])
    expect(await report(view, { state: 'ready' })).toMatchObject({ status: 400 })
    expect(latestState(ticket.id)).toBe('progress')
  })

  it('refuses another key, a stale lease, a released lease, a stopped Ticket and an unknown Assignment, recording nothing; passes while paused', async () => {
    const ticket = await requested('m1')
    const view = await claimed()
    await host.runtime.settings.pause(true, 'panel')
    expect((await report(view)).status).toBe(200)
    expect(await host.api('POST', `workers/${view.assignment}/report`, { lease: view.lease, worker: { key: 'k2' }, state: 'progress', summary: 'Mine' }))
      .toEqual(refused(409, 'not_holder'))
    expect(await report({ ...view, lease: 'f'.repeat(32) }, { summary: 'Stale' })).toEqual(refused(409, 'lease_expired'))
    expect(await report({ ...view, assignment: 'f'.repeat(32) })).toEqual(refused(404, 'not_found'))
    expect(stored(ticket.id).assignments[0]!.report?.summary).toBe('Working on it')
    release(view.assignment)
    expect(await report(view)).toEqual(refused(409, 'lease_released'))
    host.runtime.engine.stopTicket(ticket.id)
    expect(lease(view.assignment)).toBeUndefined()
    expect(await report(view)).toEqual(refused(409, 'assignment_ended'))
  })

  it('ends the Ticket on a dropped report, and its lease with it; a person\'s message resumes it for a worker outside the box', async () => {
    const ticket = await requested('m1')
    const view = await claimed()
    expect((await report(view, { state: 'dropped', summary: 'Already fixed upstream' })).body).toMatchObject({ inputs: [], more: 0 })
    expect(stored(ticket.id).ended).toMatchObject({ outcome: 'dropped' })
    expect(lease(view.assignment)).toBeUndefined()
    await relay(message('m2', 'context', 'Also the footer', { thread: 'm1' }))
    expect(assignments(ticket.id)).toEqual([['ended', undefined], ['pending', undefined]])
    const resumed = await claimed({ request: 'r2' })
    expect(inputText(resumed)[0]).toBe('This ticket ended earlier and the message that follows, on its thread, resumed it under the same '
      + `mandate. If it asks for more within the original scope, fetch \`agent/${ticket.execution!.name}\`, inspect what is pushed and the PR, `
      + 'continue, and finish with task_submit; if it asks for work beyond that scope or for another ticket, report dropped with task_report '
      + 'without acknowledging the message, so it is routed again; if it needs nothing, such as thanks, report dropped. Do not repeat completed work.')
    expect(JSON.parse(inputText(resumed)[1]!).text).toBe('Also the footer')
    expect(JSON.stringify(resumed)).not.toMatch(/orchestrator_|"(read|chars|source_url_read)"/)
  })
})

describe('expiry', () => {
  it('replaces a working Assignment whose lease expired, with the lease note and its unacknowledged Inputs, and refuses its late report', async () => {
    const ticket = await requested('m1')
    const view = await claimed()
    await relay(message('m2', 'context', 'Also the footer', { thread: 'm1' }))
    const input = stored(ticket.id).undelivered[0]!
    later(21)
    expect(await report(view, { summary: 'Late' })).toEqual(refused(409, 'lease_expired'))
    host.runtime.external.sweep()
    expect(lease(view.assignment)).toBeUndefined()
    expect(assignments(ticket.id)).toEqual([['ended', 'leaseExpired'], ['pending', undefined]])
    expect(await report(view, { summary: 'Late' })).toEqual(refused(409, 'lease_expired'))
    expect(stored(ticket.id).assignments[0]!.report?.summary).toBe(undefined)
    const next = await claimed({ request: 'r2' })
    expect(next).toMatchObject({ ticket: ticket.id, attempt: 2, assignment: stored(ticket.id).assignments[1]!.id })
    expect(next.inputs.map(item => item.id)[0]).toBe(input)
    expect(inputText(next)[1]).toBe(`The previous worker's lease expired. Fetch \`agent/${ticket.execution!.name}\`, inspect what is pushed and the PR, `
      + 'and continue; do not repeat finished outside actions.')
  })

  it('sweeps before a claim, so a claim of a Ticket whose lease expired since the last sweep takes its new Assignment', async () => {
    const ticket = await requested('m1')
    const view = await claimed()
    later(21)
    const next = await claimed({ ticket: ticket.id, request: 'r2' })
    expect(next).toMatchObject({ attempt: 2, assignment: stored(ticket.id).assignments[1]!.id })
    expect(next.lease).not.toBe(view.lease)
  })

  it('replaces a handed-off Assignment whose lease expired while a person\'s message waits, with the message and the lease note', async () => {
    const ticket = await requested('m1')
    const view = await claimed()
    await report(view, { question: 'Which button?' })
    await relay(message('m2', 'context', 'The blue one', { thread: 'm1' }))
    expect(assignments(ticket.id)).toEqual([['running', undefined]])
    later(21)
    host.runtime.external.sweep()
    expect(assignments(ticket.id)).toEqual([['ended', 'leaseExpired'], ['pending', undefined]])
    const next = await claimed({ request: 'r2' })
    expect(JSON.parse(inputText(next)[0]!).text).toBe('The blue one')
    expect(inputText(next)[1]).toContain('The previous worker\'s lease expired.')
  })

  it('keeps a handed-off Assignment running without a lease, which a claim of its Ticket takes under a new lease, and brings the person\'s answer to the next report', async () => {
    const ticket = await requested('m1')
    const view = await claimed()
    await report(view, { question: 'Which button?' })
    later(21)
    host.runtime.external.sweep()
    expect([lease(view.assignment), assignments(ticket.id)]).toEqual([undefined, [['running', undefined]]])
    const again = await claimed({ ticket: ticket.id, request: 'r2' })
    expect(again).toMatchObject({ assignment: view.assignment, attempt: 1 })
    expect(again.lease).not.toBe(view.lease)
    expect(await report(view)).toEqual(refused(409, 'lease_expired'))
    await relay(message('m2', 'context', 'The blue one', { thread: 'm1' }))
    expect(assignments(ticket.id)).toEqual([['running', undefined]])
    const answer = answered<ReportView>(await report(again, { question: null }))
    expect(answer.inputs.map(item => JSON.parse(item.text))).toMatchObject([{ text: 'The blue one' }])
  })

  it('keeps a blocked Assignment whose lease expired for a claim of its Ticket, which a claim without one passes over, and queues the Ticket again once a person\'s message waits', async () => {
    const ticket = await requested('m1')
    const view = await claimed()
    await report(view, { state: 'blocked', summary: 'Which database?' })
    const queued = await requested('m3')
    later(21)
    host.runtime.external.sweep()
    expect([lease(view.assignment), assignments(ticket.id)]).toEqual([undefined, [['running', undefined]]])
    expect(await claimed({ request: 'r2' })).toMatchObject({ ticket: queued.id })
    expect(await claim({ request: 'r3' })).toEqual(refused(409, 'nothing_queued'))
    const again = await claimed({ ticket: ticket.id, request: 'r3' })
    expect(again).toMatchObject({ ticket: ticket.id, assignment: view.assignment, attempt: 1 })
    expect(again.lease).not.toBe(view.lease)
    later(21)
    host.runtime.external.sweep()
    await relay(message('m2', 'context', 'Postgres', { thread: 'm1' }))
    expect(assignments(ticket.id)).toEqual([['ended', 'workerLeft'], ['pending', undefined]])
    const next = await claimed({ request: 'r4' })
    expect(inputText(next)[0]).toContain('Postgres')
    expect(inputText(next)[1]).toContain('new work waits')
  })

  it('keeps a lease across a Runtime restart and sweeps an expired one at once, then on its timer', async () => {
    await host.stop()
    const now = Date.now()
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'], now })
    const seeded = (id: string, expiresAt: number): [Ticket, Lease] => [{ id, title: id, decisionId: '', channels: [], inputs: [], undelivered: [],
      mandate: { strength: 'explicit', policyVersion: '', basis: { via: 'listed' }, actor: { source: 'relay', id: ALICE }, scope: '' },
      assignments: [{ id: `${id}-1`, state: 'running', createdAt: '2026-11-01T00:00:00.000Z', startedAt: '2026-11-01T00:00:00.000Z' }],
      createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', origin: { triggerId: '', triggerIds: [] }, executor: 'external',
      execution: { name: `fix-${id}`, directory: '', assignment: '' } },
    { id: id.padEnd(32, '0'), ticketId: id, worker: LAPTOP, request: id, claimedAt: '', renewedAt: '', expiresAt: new Date(expiresAt).toISOString() }]
    const tickets = [seeded('live', now + 10 * MINUTE), seeded('gone', now - MINUTE)]
    host = await startRuntime(seed => {
      for (const [ticket, item] of tickets) { seed.tickets.save(ticket); seed.set(KV.external.lease(ticket.assignments[0]!.id), item) }
    })
    expect([lease('live-1'), assignments('live')]).toEqual([tickets[0]![1], [['running', undefined]]])
    expect([lease('gone-1'), assignments('gone')]).toEqual([undefined, [['ended', 'leaseExpired'], ['pending', undefined]]])
    vi.setSystemTime(now + 11 * MINUTE)
    vi.advanceTimersByTime(2 * MINUTE)
    expect([lease('live-1'), assignments('live')]).toEqual([undefined, [['ended', 'leaseExpired'], ['pending', undefined]]])
  })

  it('reports a failed sweep on the external health entry, keeping the lease, until a sweep succeeds', async () => {
    // An expired lease on a Ticket the store does not hold.
    const orphan: Lease = { id: '0'.repeat(32), ticketId: 'gone', worker: LAPTOP, request: 'r1', claimedAt: '', renewedAt: '', expiresAt: new Date(0).toISOString() }
    store().set(KV.external.lease('gone-1'), orphan)
    host.runtime.external.sweep()
    expect(host.runtime.health.external).toMatchObject({ state: 'error', detail: 'Sweeping expired leases failed: Error: Ticket gone is missing' })
    expect(lease('gone-1')).toEqual(orphan)
    store().delete(KV.external.lease('gone-1'))
    host.runtime.external.sweep()
    expect(host.runtime.health.external).toMatchObject({ state: 'ready' })
  })
})

describe('requeue', () => {
  it('queues a released Ticket again for a person\'s message, a text Input or a red CI result, while other CI changes wait for the next claim', async () => {
    const ticket = await requested('m1')
    host.runtime.engine.bindThread(ticket.id, { source: 'github', id: '7' }, true)
    const pr = { number: 7, html_url: 'https://github.com/acme/widgets/pull/7', user: { login: 'agent-bot' } }
    const ci = async (revision: number, failed: boolean) => {
      const checks = [{ name: 'test', status: 'completed', conclusion: failed ? 'failure' : 'success' }]
      host.runtime.receive(ciTrigger(pr, revision, ciSummary({ head: 'abc1234', checks, statuses: [] }, 'PR #7', 'github/pulls/7/checks'), failed))
      await host.runtime.idle()
    }
    let view = await claimed()
    await settled(view)
    await ci(1, false)
    expect(assignments(ticket.id)).toEqual([['running', undefined]])
    await ci(2, true)
    expect(assignments(ticket.id)).toEqual([['ended', 'workerLeft'], ['pending', undefined]])
    view = await claimed({ request: 'r2' })
    // The CI text names the failed checks, without the in-box resource of every check.
    expect(inputText(view).slice(0, 2).map(text => JSON.parse(text).text)).toEqual(['CI passed 1/1 on PR #7 at abc1234',
      'CI failed 1/1 on PR #7 at abc1234: test'])
    expect(JSON.stringify(view)).not.toMatch(/github\/pulls|"(read|chars|source_url_read)"/)
    expect(inputText(view)[2]).toContain('new work waits')
    await settled(view)
    await relay(message('m2', 'context', 'One more thing', { thread: 'm1' }))
    expect(assignments(ticket.id).map(([state, reason]) => [state, reason])).toEqual([['ended', 'workerLeft'], ['ended', 'workerLeft'],
      ['pending', undefined]])
    view = await claimed({ request: 'r3' })
    await settled(view)
    // A text Input, such as a review's findings.
    const current = stored(ticket.id)
    store().tickets.save({ ...current, inputs: [...current.inputs, { id: 'findings', kind: 'text', text: 'Fix the failing check',
      at: new Date().toISOString() }], undelivered: ['findings'] })
    store().atomic(() => { host.runtime.external.deliver(stored(ticket.id), stored(ticket.id).assignments.at(-1)!) })
    await host.runtime.idle()
    expect(assignments(ticket.id).map(([state]) => state)).toEqual(['ended', 'ended', 'ended', 'pending'])
  })

  it('does not queue a released Ticket again for an Input its worker received before the release without acknowledging it', async () => {
    const ticket = await requested('m1')
    host.runtime.engine.bindThread(ticket.id, { source: 'github', id: '7' }, true)
    const pr = { number: 7, html_url: 'https://github.com/acme/widgets/pull/7', user: { login: 'agent-bot' } }
    await relay(message('m2', 'context', 'Also the footer', { thread: 'm1' }))
    const view = await claimed()
    expect(inputText(view)).toHaveLength(1)
    later(1)
    release(view.assignment)
    host.runtime.receive(ciTrigger(pr, 1, 'CI running', false))
    await host.runtime.idle()
    expect(assignments(ticket.id)).toEqual([['running', undefined]])
    // A red CI result after the release queues the Ticket, and the unacknowledged message goes with it.
    host.runtime.receive(ciTrigger(pr, 2, 'CI failed', true))
    await host.runtime.idle()
    expect(assignments(ticket.id)).toEqual([['ended', 'workerLeft'], ['pending', undefined]])
    expect(JSON.parse(inputText(await claimed({ request: 'r2' }))[0]!).text).toBe('Also the footer')
  })

  it('leaves a Ticket alone when its queued requeue runs after a worker holds it again, or once nothing waits', async () => {
    const ticket = await requested('m1')
    const view = await claimed()
    const requeue = async () => {
      host.runtime.effects.enqueue('requeue', ticket.id, { ticketId: ticket.id, assignmentId: view.assignment })
      await host.runtime.idle()
    }
    // A person's message waits for the worker that holds the lease.
    await relay(message('m2', 'context', 'One more thing', { thread: 'm1' }))
    await requeue()
    expect(assignments(ticket.id)).toEqual([['running', undefined]])
    await settled(answered<ClaimView>(await claim()))
    await requeue()
    expect(assignments(ticket.id)).toEqual([['running', undefined]])
  })
})

describe('relay', () => {
  it('makes a request with `worker: external` an external Ticket, shown on its candidate card, and one without the flag a local Ticket', async () => {
    const sent = await relay(message('m1', 'request', 'Fix the login page', { worker: 'external' }))
    expect(store().triggers.get(String(sent.body.trigger))?.meta).toMatchObject({ kind: 'request', worker: 'external' })
    const card = (id: unknown) => host.relays(host.runtime.masterId).find(item => item.kind === 'candidate' && item.trigger_id === id)
    expect(card(sent.body.trigger)).toMatchObject({ worker: 'external' })
    expect((await accept(String(sent.body.trigger), 'm1')).executor).toBe('external')
    const local = await relay(message('m2', 'request', 'Fix the logout page'))
    expect(card(local.body.trigger)).not.toHaveProperty('worker')
    expect((await accept(String(local.body.trigger), 'm2')).executor).toBeUndefined()
  })

  it('refuses the flag on context, and a repeated message id with another worker', async () => {
    expect(await relay(message('m1', 'context', 'FYI', { worker: 'external' }))).toMatchObject({ status: 400,
      body: { code: 'invalid_request', issues: [{ path: 'worker' }] } })
    await relay(message('m2', 'request', 'Fix it', { worker: 'external' }))
    expect(await relay(message('m2', 'request', 'Fix it'))).toEqual({ status: 409,
      body: { error: 'Message m2 was relayed before with other content', code: 'id_reused' } })
    expect(await relay(message('m2', 'request', 'Fix it', { worker: 'external' }))).toMatchObject({ status: 200, body: { result: 'duplicate' } })
  })
})
