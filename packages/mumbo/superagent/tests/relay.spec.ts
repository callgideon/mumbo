/**
 * The relay Source (UPSTREAM.md S9) on a running Runtime: messages posted to `/orchestrator/relay` as a project member
 * become Triggers that the real Engine, Policy, Settings and main Session tools act on. DSH admission is a stand-in that
 * answers the principal each case names; the real Connection's admission is covered in `http.spec.ts`.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { key } from '../src/core/index.ts'
import { RELAY_LIMITS, RELAY_PATH, registerRelay } from '../src/sources/relay.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

type Handler = (req: unknown, res: unknown) => Promise<void>
type Admission = { peer: { principal: { kind: string; email?: string }; signal: AbortSignal } } | { rejection: 401 | 403 }
const ALICE = 'alice@example.com', BOB = 'bob@example.com'
/** The relay path of a message from `email`, which starts at that member. */
const hopsOf = (email: string) => [{ node: 'member', id: email }, { node: 'mumbo', id: 'box-1' }, { node: 'edge', id: 'app.mumbo.si' }]
const HOPS = hopsOf(ALICE)
const peer = (principal: { kind: string; email?: string }, signal = new AbortController().signal): Admission => ({ peer: { principal, signal } })
const member = (email: string) => peer({ kind: 'edge-member', email })

let host: Host
let handler: Handler | undefined
let admission: Admission
let unregister: () => void
const register = () => registerRelay({ connection: { admit: () => admission },
  webServer: { register: (route: { path: string; handler: Handler }) => {
    expect(route.path).toBe(RELAY_PATH)
    handler = route.handler
    return () => { handler = undefined }
  } } } as never, host.runtime)

// No relay Policy part is stored, as on a fresh box.
beforeEach(async () => {
  host = await startRuntime()
  unregister = register()
})
afterEach(async () => { unregister(); await host.stop() })

/** Post one body (a string is sent as is) to the relay route as `who`; returns its status and JSON body. */
async function post(body: unknown, who: Admission = member(ALICE), method = 'POST') {
  admission = who
  let status = 0, text = ''
  const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
  const req = { method, url: RELAY_PATH, headers: {}, async *[Symbol.asyncIterator]() { yield* chunks } }
  await handler!(req, { writeHead: (code: number) => { status = code }, end: (data: string) => { text = data } })
  return { status, body: JSON.parse(text) as Record<string, unknown> }
}
const message = (id: string, kind: 'request' | 'context', text = `${kind} ${id}`, extra: Record<string, unknown> = {}) =>
  ({ id, kind, text, hops: HOPS, ...extra })
const stored = () => host.runtime.store.read.recentTriggers(0, 50).filter(trigger => trigger.source === 'relay')
const candidate = (triggerId: string) => host.relays(host.runtime.masterId).find(item => item.kind === 'candidate' && item.trigger_id === triggerId)
/** Save these Policy parts over the stored ones through Settings, as the panel does. */
async function savePolicy(parts: Record<string, Record<string, unknown>>) {
  const policy = host.runtime.store.settings().policy
  await host.runtime.settings.save('policy', { ...policy, sources: { ...policy.sources, ...parts } }, host.runtime.store.blockRevision('policy'), 'panel')
}
/** Accept the request `id` that `email` relayed as a Ticket; returns the Ticket's id. */
async function accepted(email: string, id: string) {
  const sent = await post(message(id, 'request', `Fix ${id}`, { hops: hopsOf(email) }), member(email))
  await host.runtime.idle()
  const result = await host.route({ kind: 'accept', trigger_id: sent.body.trigger, title: `Fix ${id}`, worktree_name: `fix-${id}`,
    acknowledgement: 'On it.' })
  await host.runtime.idle()
  return (result.ticket as { ticket_id: string }).ticket_id
}

it('turns a request into an explicit Trigger from the member with its hop chain, which reaches the main Session as an explicit candidate from any member', async () => {
  const sent = await post(message('m1', 'request', 'Fix the login page'))
  expect(sent).toEqual({ status: 200, body: { result: 'stored', trigger: key('relay', ALICE, 'm1'), thread: 'm1' } })
  expect(host.runtime.store.triggers.get(key('relay', ALICE, 'm1'))).toMatchObject({ source: 'relay', human: true, addressed: 'direct',
    actor: { source: 'relay', id: ALICE }, text: 'Fix the login page', threads: [{ source: 'relay', id: `${ALICE}/m1` }],
    channel: { source: 'relay', thread: `relay:${ALICE}/m1`, address: { member: ALICE, thread: 'm1' } },
    meta: { kind: 'request', message: 'm1', hops: HOPS } })
  expect(host.runtime.store.threads.get(`relay:${ALICE}/m1`)?.meta.facts).toEqual({ member: { label: 'Member', value: ALICE },
    via: { label: 'Relayed through', value: `member ${ALICE} → mumbo box-1 → edge app.mumbo.si` } })
  await host.runtime.idle()
  expect(candidate(key('relay', ALICE, 'm1'))).toMatchObject({ from: ALICE, thread: `relay:${ALICE}/m1`, strength: 'explicit' })
})

it('turns context into an implicit Trigger, an inferred candidate at most from any member', async () => {
  expect(await post(message('m2', 'context', 'The login page uses OAuth now'))).toMatchObject({ status: 200, body: { result: 'stored' } })
  const trigger = host.runtime.store.triggers.get(key('relay', ALICE, 'm2'))!
  expect(trigger).toMatchObject({ human: true, meta: { kind: 'context' } })
  expect(trigger.addressed).toBeUndefined()
  await host.runtime.idle()
  expect(candidate(trigger.id)).toMatchObject({ from: ALICE, strength: 'inferred' })
})

it('with every member switched off, admits only the members on the allowed list, refusing another\'s request and context', async () => {
  await savePolicy({ relay: { allowed: [{ id: ALICE }], allMembers: false } })
  await post(message('m1', 'request'))
  for (const kind of ['request', 'context'] as const) {
    expect(await post(message(`bob-${kind}`, kind, undefined, { hops: hopsOf(BOB) }), member(BOB))).toMatchObject({ status: 200, body: { result: 'stored' } })
  }
  await host.runtime.idle()
  for (const kind of ['request', 'context']) {
    expect(candidate(key('relay', BOB, `bob-${kind}`))).toBeUndefined()
    expect(host.runtime.store.decisions.byThread(`relay:${BOB}/bob-${kind}`)).toMatchObject([{ kind: 'ignore', reason: [{ code: 'not_a_member' }] }])
  }
  expect(candidate(key('relay', ALICE, 'm1'))).toMatchObject({ from: ALICE, strength: 'explicit' })
})

it('takes the authority of switched-off members\' Mandates, as removing them from the list would', async () => {
  const alice = await accepted(ALICE, 'm1'), bob = await accepted(BOB, 'm2')
  await savePolicy({ relay: { allowed: [{ id: BOB }], allMembers: false } })
  const policyInputs = (id: string) => host.runtime.store.tickets.get(id)!.inputs.filter(input => input.kind === 'policy-changed')
  expect(policyInputs(alice)).toMatchObject([{ effect: { requesterAllowed: false, requester: { source: 'relay', id: ALICE } } }])
  expect(policyInputs(bob)).toEqual([])
  expect(host.runtime.store.settingsHistory(1)[0]).toMatchObject({ policyChanged: true, notified: [alice] })
  // Alice's later message on her Thread no longer reaches her Ticket.
  await post(message('m3', 'context', 'It is the second button', { thread: 'm1' }))
  expect(host.runtime.store.triggers.disposition(key('relay', ALICE, 'm3'))?.fanout).toEqual([])
})

it('shows the switch on the panel, on while no relay part is stored, and only the relay kind accepts it', async () => {
  const view = (await host.api('GET', 'settings')).body as { blocks: { policy: { value: { sources: Record<string, unknown> } } },
    sources: { id: string; policy?: { fields: { key: string; type: string }[]; defaults: unknown } }[] }
  const relay = view.sources.find(source => source.id === 'relay')!.policy!
  expect(relay.fields.map(field => [field.key, field.type])).toEqual([['allowed', 'rows'], ['allMembers', 'switch']])
  expect(relay.defaults).toEqual({ allowed: [], allMembers: true })
  expect(view.blocks.policy.value.sources.relay).toBeUndefined()
  // The kinds whose senders name themselves refuse the field, so a stored one is never read.
  await expect(savePolicy({ github: { allowed: [], allMembers: true } })).rejects.toThrow('allMembers')
  await expect(savePolicy({ feishu: { allowed: [], allMembers: true } })).rejects.toThrow('allMembers')
  const { sources, store } = host.runtime
  const settings = store.settings()
  const stored = (parts: Record<string, Record<string, unknown>>) => ({ ...settings, policy: { ...settings.policy, sources: parts as never } })
  expect(['relay', 'github', 'unknown'].map(id => sources.allMembers(id, stored({ github: { allowed: [], allMembers: true } }))))
    .toEqual([true, false, false])
  // A stored relay part its kind refuses counts no member.
  expect(sources.allMembers('relay', stored({ relay: { allowed: [{ id: 'Not a member' }] } }))).toBe(false)
  // With every allowed list empty, the members are who may originate work, until the switch is off.
  const noAllowed = async () => ((await host.api('GET', 'overview')).body.problems as { kind: string }[]).some(problem => problem.kind === 'no-allowed')
  await savePolicy({ feishu: { allowed: [], syncChat: '' }, github: { allowed: [] } })
  expect(await noAllowed()).toBe(false)
  await savePolicy({ relay: { allMembers: false } })
  expect(await noAllowed()).toBe(true)
})

it('receives nothing from a request DSH does not admit as a live project member', async () => {
  const refused = (status: number, code: string) => ({ status, body: { error: expect.any(String), code } })
  expect(await post(message('x', 'request'), { rejection: 401 })).toEqual(refused(401, 'unauthenticated'))
  expect(await post(message('x', 'request'), { rejection: 403 })).toEqual(refused(403, 'unauthenticated'))
  expect(await post(message('x', 'request'), peer({ kind: 'owner' }))).toEqual(refused(403, 'member_required'))
  expect(await post(message('x', 'request'), peer({ kind: 'share-viewer', email: ALICE }))).toEqual(refused(403, 'member_required'))
  // A disposed Peer, such as a member whose last signed header expired.
  expect(await post(message('x', 'request'), peer({ kind: 'edge-member', email: ALICE }, AbortSignal.abort()))).toEqual(refused(403, 'member_required'))
  expect(stored()).toEqual([])
})

it('stores a message id once per member: a retry answers duplicate, and other content under the same id is refused', async () => {
  const first = await post(message('m1', 'request', 'Fix the login page'))
  expect(await post(message('m1', 'request', 'Fix the login page'))).toEqual({ status: 200,
    body: { result: 'duplicate', trigger: first.body.trigger, thread: 'm1' } })
  for (const changed of [message('m1', 'request', 'Fix the logout page'), message('m1', 'context', 'Fix the login page'),
    message('m1', 'request', 'Fix the login page', { thread: 'm0' })]) {
    expect(await post(changed)).toEqual({ status: 409, body: { error: 'Message m1 was relayed before with other content', code: 'id_reused' } })
  }
  // Message ids are the member's own: another member's m1 is another message.
  expect(await post(message('m1', 'request', 'Fix the login page', { hops: hopsOf(BOB) }), member(BOB))).toMatchObject({ status: 200, body: { result: 'stored' } })
  expect(stored()).toHaveLength(2)
  await host.runtime.idle()
  expect(host.candidates().filter(id => id === first.body.trigger)).toHaveLength(1)
})

it('refuses a malformed body or one whose first hop is not the admitted member with 400 and the fields, an oversized one with 413 and another method with 405, storing nothing', async () => {
  const invalid = async (body: unknown) => {
    const answer = await post(body)
    expect(answer, JSON.stringify(body).slice(0, 80)).toMatchObject({ status: 400, body: { code: 'invalid_request' } })
    return (answer.body.issues as { path: string }[] | undefined)?.map(issue => issue.path)
  }
  expect(await post('not json')).toEqual({ status: 400, body: { error: 'The request body is not JSON', code: 'invalid_request' } })
  expect(await invalid({})).toEqual(['id', 'kind', 'text', 'hops'])
  expect(await invalid(['m1'])).toEqual([''])
  expect(await invalid(message('m1', 'order' as never))).toEqual(['kind'])
  expect(await invalid(message('m1', 'request', '  \n '))).toEqual(['text'])
  expect(await invalid(message('m1', 'request', 'x'.repeat(RELAY_LIMITS.text + 1)))).toEqual(['text'])
  expect(await invalid(message('a/b', 'request'))).toEqual(['id'])
  expect(await invalid(message('m1', 'request', 'hi', { thread: 'a/b' }))).toEqual(['thread'])
  expect(await invalid(message('m1', 'request', 'hi', { hops: [] }))).toEqual(['hops'])
  expect(await invalid(message('m1', 'request', 'hi', { hops: Array.from({ length: RELAY_LIMITS.hops + 1 }, () => HOPS[0]) }))).toEqual(['hops'])
  expect(await invalid(message('m1', 'request', 'hi', { hops: [{ node: 'Edge!', id: 'x' }] }))).toEqual(['hops.0.node'])
  expect(await invalid(message('m1', 'request', 'hi', { hops: [{ node: 'edge', id: 'a\u0007b' }] }))).toEqual(['hops.0.id'])
  expect(await invalid(message('m1', 'request', 'hi', { hops: [{ node: 'edge', id: 'x'.repeat(RELAY_LIMITS.hop + 1) }] }))).toEqual(['hops.0.id'])
  // The actor is the admitted member; a body cannot name another, nor start its relay path at another node.
  expect(await invalid(message('m1', 'request', 'hi', { actor: BOB }))).toEqual([''])
  expect(await invalid(message('m1', 'request', 'hi', { hops: hopsOf(BOB) }))).toEqual(['hops.0'])
  expect(await invalid(message('m1', 'request', 'hi', { hops: HOPS.slice(1) }))).toEqual(['hops.0'])
  expect(await post({ ...message('m1', 'request'), text: 'x'.repeat(RELAY_LIMITS.bodyBytes) })).toEqual({ status: 413,
    body: { error: `The request exceeds ${RELAY_LIMITS.bodyBytes} bytes`, code: 'too_large' } })
  expect(await post(undefined, member(ALICE), 'GET')).toEqual({ status: 405, body: { error: 'Relay a message with POST', code: 'method' } })
  expect(stored()).toEqual([])
  // The text bound is inclusive, after trimming.
  expect(await post(message('m1', 'request', ` ${'x'.repeat(RELAY_LIMITS.text)} `))).toMatchObject({ status: 200, body: { result: 'stored' } })
})

it('continues a conversation on its Thread, so a later message reaches the Ticket its first one started', async () => {
  const first = await post(message('m1', 'request', 'Fix the login page'))
  await host.runtime.idle()
  const accepted = await host.route({ kind: 'accept', trigger_id: first.body.trigger, title: 'Fix the login page', worktree_name: 'fix-login',
    acknowledgement: 'On it.' })
  await host.runtime.idle()
  const ticketId = (accepted.ticket as { ticket_id: string }).ticket_id
  expect(await post(message('m2', 'context', 'It is the second button', { thread: 'm1' }))).toEqual({ status: 200,
    body: { result: 'stored', trigger: key('relay', ALICE, 'm2'), thread: 'm1' } })
  expect(host.runtime.store.triggers.get(key('relay', ALICE, 'm2'))?.threads).toEqual([{ source: 'relay', id: `${ALICE}/m1` }])
  expect(host.runtime.store.triggers.disposition(key('relay', ALICE, 'm2'))?.fanout).toEqual([ticketId])
  // The relay Source has no Channel adapter yet, so the acknowledgement is dropped as undeliverable.
  await host.runtime.sendReplies()
  expect(host.runtime.store.receipts.get(key('ack', String(first.body.trigger)))).toMatchObject({ status: 'dropped' })
})

it('refuses with 409 while the relay Source is switched off, and says when evaluation waits for setup', async () => {
  const settings = host.runtime.store.settings()
  host.runtime.store.saveSettings({ ...settings, sources: { ...settings.sources, relay: { enabled: false, config: {} } } })
  expect(await post(message('m1', 'request'))).toEqual({ status: 409, body: { error: 'The project\'s relay Source is switched off', code: 'relay_off' } })
  expect(stored()).toEqual([])
  host.runtime.store.saveSettings(settings)
  vi.spyOn(host.runtime.setup, 'configured').mockReturnValue(false)
  expect(await post(message('m1', 'request'))).toMatchObject({ status: 200, body: { result: 'stored', waiting: 'setup' } })
})

it('unregisters the kind and unmounts the route when disposed', () => {
  unregister()
  expect(host.runtime.sources.kind('relay')).toBeUndefined()
  expect(handler).toBeUndefined()
  unregister = register()
  expect(host.runtime.sources.kind('relay')).toBeDefined()
})
