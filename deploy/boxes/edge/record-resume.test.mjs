// node --test: the resume recorder (record-resume.e2e.mjs) acts only on its own throwaways and fills only a cell of
// throwaways; its fixtures keep no secret; the real SDK maps each replayed answer to the class the edge sees; and every
// committed fixture passes the leak guard, is recorded or names its sources, and still replays to the error it names.
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { PURPOSE, assertMine, assertOnlyThrowaways, fixtureText, keptResponse, leak, recorderArgs, redactIds } from './record-resume.e2e.mjs'
import { sdkError } from './testing/e2b-answers.mjs'

const env = { E2B_API_URL: 'http://127.0.0.1:13000', E2B_SANDBOX_URL: 'http://127.0.0.1:13002', E2B_API_KEY: 'testkey-not-real', CELL: 'ap-south-1' }
const ID = 'i0abcdefghijklmnopqr', ID2 = 'j1abcdefghijklmnopqr'
const CONNECT = { method: 'POST', path: '/v2/sandboxes/{sandboxID}/connect' }
const json = { 'content-type': 'application/json; charset=utf-8' }

/** An E2B Sandbox class over `sandboxes`, listing every one for any query, so the recorder's own checks are under test. */
const fakeE2B = (sandboxes) => ({
  getInfo: async (id) => sandboxes.find(s => s.sandboxId === id) ?? Promise.reject(new Error('404')),
  list: () => { let done = false; return { get hasNext() { return !done }, nextItems: async () => { done = true; return sandboxes } } },
})

test('arguments: a recording runs only with CELL ap-south-1 and a dated go-ahead; cleanup needs neither', () => {
  assert.deepEqual(recorderArgs(['full-cell', 'fill', '--go-ahead', '2026-11-12', '--lose', 'T@mumbo.si'], env), { cmd: 'full-cell', step: 'fill', cell: 'ap-south-1', lose: ['t@mumbo.si'] })
  assert.deepEqual(recorderArgs(['cleanup'], { ...env, CELL: 'us-east-1' }), { cmd: 'cleanup', cell: 'us-east-1', lose: [] })
  for (const [argv, vars, error] of [
    [['guest-unresponsive', '--go-ahead', '2026-11-12'], { ...env, CELL: 'us-east-1' }, /ap-south-1 only/],
    [['guest-unresponsive'], env, /go-ahead/],
    [['full-cell', 'fill', '--go-ahead', 'yes'], env, /go-ahead/],
    [['full-cell', '--go-ahead', '2026-11-12'], env, /usage/],
    [['node-gone', '--go-ahead', '2026-11-12'], env, /usage/],
    [['cleanup'], { ...env, E2B_SANDBOX_URL: '' }, /set E2B_SANDBOX_URL/],
  ]) assert.throws(() => recorderArgs(argv, vars), error, argv.join(' '))
})

test('a run acts only on sandboxes E2B lists with its own nonce', async () => {
  const E2B = fakeE2B([{ sandboxId: 'own', metadata: { purpose: PURPOSE, run: 'r1' } }, { sandboxId: 'earlier', metadata: { purpose: PURPOSE, run: 'r0' } },
    { sandboxId: 'person', metadata: { user: 'a@mumbo.si', run: 'r1' } }])
  await assertMine(E2B, 'r1', 'own')
  for (const id of ['earlier', 'person']) await assert.rejects(assertMine(E2B, 'r1', id), /not a throwaway of this run/, id)
  await assert.rejects(assertMine(E2B, 'r1', undefined), /404/)
})

test('the fill refuses a cell holding anything but throwaways and the sandboxes of accounts named to lose', async () => {
  const throwaway = { sandboxId: 'sbx-t', metadata: { purpose: PURPOSE, run: 'r0' } }
  const person = { sandboxId: 'sbx-p', metadata: { user: 'test@mumbo.si' } }, child = { sandboxId: 'sbx-c', metadata: { owner: 'Test@mumbo.si' } }
  const project = { sandboxId: 'sbx-j', metadata: { user: 'project:p1' } }, bare = { sandboxId: 'sbx-b', metadata: {} }
  await assertOnlyThrowaways(fakeE2B([throwaway]), [])
  await assertOnlyThrowaways(fakeE2B([throwaway, person, child]), ['test@mumbo.si'])
  await assert.rejects(assertOnlyThrowaways(fakeE2B([throwaway, person, child]), []), /refusing: the cell also holds test@mumbo\.si;/)
  await assert.rejects(assertOnlyThrowaways(fakeE2B([person, project, bare]), ['test@mumbo.si', 'project:p1']), (e) =>
    /holds a project box, a sandbox without an owner;/.test(e.message) && !/sbx-|p1/.test(e.message))
})

test('redaction: both forms of each id, three headers, and a 2xx body only as its state', () => {
  assert.equal(redactIds(`files for '${ID}' not found; ${ID}-6532622b; ${ID2}`, [ID, ID2]), "files for '<sandbox>' not found; <sandbox>; <sandbox-2>")
  const headers = new Headers({ ...json, 'retry-after': '5', 'should-retry': 'false', 'set-cookie': 'a=b', 'x-request-id': 'r1' })
  assert.deepEqual(keptResponse({ status: 201, headers, body: { sandboxID: ID, envdAccessToken: 'a', trafficAccessToken: 'b', state: 'running' } }),
    { status: 201, headers: { ...json, 'retry-after': '5', 'should-retry': 'false' }, body: { state: 'running' } })
  assert.deepEqual(keptResponse({ status: 204, headers: new Headers() }), { status: 204, headers: {} })
  const error = { code: 500, error_code: 'sandbox_create_failed', message: 'Failed to place sandbox: x' }
  assert.deepEqual(keptResponse({ status: 500, headers: new Headers(json), body: error }), { status: 500, headers: json, body: error })
})

test('leak guard: names the kind of secret, and passes error codes, dates and messages', () => {
  const secrets = { apiKey: 'testkey-not-real', ids: [ID] }
  for (const [text, kind] of [['key testkey-not-real', 'the API key'], [`box ${ID}`, 'a sandbox id'], ['e2b_abc', 'an e2b_ string'],
    ['run 0f8fad5b-d9cb-469f-a165-70867728950e', 'a UUID'], [`token ${'aB3'.repeat(11)}`, 'a run of 32 or more token characters'],
    [`path ${'a1'.repeat(16)}`, 'a run of 32 or more token characters']]) assert.equal(leak(text, secrets), kind, text)
  const clean = JSON.stringify({ recordedAt: '2026-11-12T10:00:00.000Z', e2bSha: '1619623fc', codes: ['sandbox_snapshot_guest_agent_unresponsive', 'sandbox_memory_override_disabled'],
    message: 'Failed to place sandbox: sandbox creation failed on 1 node(s), please retry; if the problem persists, contact us', id: '<sandbox>' }, null, 2)
  assert.equal(leak(clean, secrets), null)
})

test('a recording becomes redacted fixture text with the error its replay through the SDK throws', async () => {
  const head = { case: 'guest-unresponsive', step: 'resume', cell: 'ap-south-1', recordedAt: '2026-11-12T10:00:00.000Z', e2bSha: '1619623fc', sdk: 'e2b 2.63.0' }
  const secrets = { ids: [ID], apiKey: env.E2B_API_KEY }
  const request = { ...CONNECT, body: { timeout: 900 } }
  const answer = { status: 500, headers: new Headers(json), ms: 10400, body: { code: 500, error_code: 'sandbox_create_failed', message: `Failed to place sandbox: sandbox files for '${ID}' not found` } }
  const { text, leak: found } = await fixtureText(head, { request, answer, notes: { envdUnresponsiveAtPause: false } }, secrets)
  assert.equal(found, null)
  const message = "Failed to place sandbox: sandbox files for '<sandbox>' not found"
  assert.deepEqual(JSON.parse(text), { ...head, recorded: true, raw: { request, response: { status: 500, headers: json, body: { ...answer.body, message } }, ms: 10400 },
    sdkPath: { call: 'Sandbox.connect', replayed: true, error: { class: 'SandboxError', name: 'SandboxError', statusCode: 500, message: `500: ${message}` } }, notes: { envdUnresponsiveAtPause: false } })
  // A 2xx keeps no token and is not replayed; a hung request is replayed as the SDK's abort.
  const resumed = await fixtureText(head, { request, answer: { status: 201, headers: new Headers(json), ms: 4800, body: { sandboxID: ID, envdAccessToken: 'x'.repeat(40), state: 'running' } } }, secrets)
  assert.deepEqual([JSON.parse(resumed.text).raw.response.body, JSON.parse(resumed.text).sdkPath], [{ state: 'running' }, undefined])
  const hung = JSON.parse((await fixtureText(head, { request, answer: { hung: true, ms: 75000 } }, secrets)).text)
  assert.deepEqual([hung.raw, hung.sdkPath.error.class, hung.sdkPath.error.name], [{ request, hung: true, ms: 75000 }, 'DOMException', 'TimeoutError'])
  // An answer that still holds a secret after redaction is refused.
  assert.deepEqual(await fixtureText(head, { request, answer: { ...answer, body: { message: `token ${'aB3'.repeat(11)}` } } }, secrets), { leak: 'a run of 32 or more token characters' })
})

test('replay: each answer reaches the edge as the SDK class and status it maps to, with no retry', async () => {
  const answer = (status, body, headers = {}) => ({ raw: { request: CONNECT, response: { status, headers: { ...json, ...headers }, body } } })
  for (const [fixture, cls, statusCode] of [
    [answer(500, { code: 500, error_code: 'sandbox_create_failed', message: 'Failed to place sandbox: this node cannot map 2048 MiB of guest memory' }), 'SandboxError', 500],
    [answer(503, { code: 503, error_code: 'sandbox_capacity_unavailable', message: 'no nodes available' }), 'ServiceBusyError', 503],
    [answer(429, { code: 429, message: 'rate limited' }, { 'retry-after': '30' }), 'RateLimitError', 429],
    [answer(409, { code: 409, error_code: 'sandbox_snapshot_guest_agent_unresponsive', message: "Sandbox '<sandbox>' cannot be resumed with its memory" }), 'GuestUnresponsiveError', 409],
    [answer(404, { code: 404, message: 'not found' }), 'SandboxNotFoundError', undefined],
    [{ raw: { request: CONNECT, hung: true } }, 'DOMException', undefined],
    [{ raw: { request: { method: 'POST', path: '/v2/sandboxes' }, response: { status: 400, headers: json, body: { code: 400, message: 'bad' } } } }, 'SandboxError', 400],
  ]) {
    const { error } = await sdkError(fixture)
    assert.deepEqual([error.constructor.name, error.statusCode], [cls, statusCode], `${cls} ${statusCode}`)
  }
  assert.deepEqual(await sdkError({ raw: { request: { method: 'POST', path: '/sandboxes/{sandboxID}/pause' }, response: { status: 204, headers: {} } } }), { call: 'Sandbox.pause', error: null })
})

test('every committed fixture passes the leak guard, is recorded or names its sources, and replays to the SDK error it names', async () => {
  const dir = new URL('./testing/fixtures/resume/', import.meta.url)
  for (const name of existsSync(dir) ? readdirSync(dir) : []) {
    const text = readFileSync(new URL(name, dir), 'utf8')
    assert.equal(leak(text), null, name)
    const fixture = JSON.parse(text)
    assert.ok(fixture.recorded === true || (fixture.recorded === false && fixture.source?.length > 0), `${name}: recorded, or recorded: false with its source`)
    // A later SDK that maps a recorded answer to another class or status fails here, before the edge's classification.
    if (fixture.sdkPath?.replayed) {
      const { call, error } = await sdkError(fixture)
      assert.deepEqual({ call, class: error?.constructor.name, statusCode: error?.statusCode },
        { call: fixture.sdkPath.call, class: fixture.sdkPath.error?.class, statusCode: fixture.sdkPath.error?.statusCode }, name)
    }
  }
})
