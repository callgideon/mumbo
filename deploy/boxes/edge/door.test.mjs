// node --test: the MCP door (B32) over the wire, through modelServer as main() wires it: bearer door keys only, jumbo's
// refusal codes as HTTP statuses with JSON-RPC errors, the per-key rate limit, one log line per call without secrets,
// the dispatcher's scope, project, budget and declaration checks, whoami and project_list, and the box-token endpoint
// beside it unchanged. Then the Mumbo tools (B33), forwarded through a fake client proxy to the owner's box.
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { createServer, request } from 'node:http'
import { test } from 'node:test'
import { z } from 'zod'
import { door, doorTools, mumboForwarder } from './door.mjs'
import { boxFetcher, mcpPrincipal, memberKey, modelServer, mumboMcpKey, signBox, verifyBox } from './edge.mjs'
import { doorKeys, keyHash } from './keys.mjs'
import { projects } from './projects.mjs'
import { children, mcpServer } from './sandboxes.mjs'
import { memoryStore } from './store.mjs'

const A = 'a@x.com', B = 'b@x.com'
const PUBLIC = 'app.example', LLM = 'llm.app.example'
const NOW = Date.parse('2026-11-10T12:00:00Z')
const cfg = { publicHost: PUBLIC, llmHost: LLM, egressIps: ['1.2.3.4'], openrouterModels: [] }
const INIT = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } }

/** One HTTP request; `headers` may be an array of raw header strings (repeated names). JSON or SSE bodies are parsed. */
const send = (port, { host = PUBLIC, path = '/mcp', method = 'POST', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const base = { host, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
  const all = Array.isArray(headers) ? [...Object.entries(base).flat(), ...headers] : { ...base, ...headers }
  const req = request({ host: '127.0.0.1', port, method, path, headers: all }, (r) => {
    const chunks = []
    r.on('data', c => chunks.push(c)).on('end', () => {
      const text = Buffer.concat(chunks).toString()
      const data = text.startsWith('{') ? text : text.split('\n').find(l => l.startsWith('data:'))?.slice(5)
      resolve({ status: r.statusCode, headers: r.headers, text, json: data ? JSON.parse(data) : undefined })
    })
  })
  req.on('error', reject)
  req.end(body)
})

/**
 * The edge's model listener with a door over a memory store: A owns projects P and Q, B owns R. `tools` are added to the
 * door's own; `rate` and the budgets can be set. `at(ms)` moves the clock.
 */
async function setup({ tools = [], rate = { perMinute: 60, burst: 100 }, budgetOpen = true, tokensOpen = true, mumbo = async () => { throw new Error('no box here') } } = {}) {
  const store = memoryStore(), lines = [], charged = []
  let now = NOW
  const proj = projects({ store, admitted: () => true, log: () => {} })
  const P = (await proj.create(A, 'Mine')).id, Q = (await proj.create(A, 'Other')).id, R = (await proj.create(B, 'Theirs')).id
  const allowed = new Set([A, B])
  const keys = doorKeys({ store, projects: proj, admitted: (e) => allowed.has(e), now: () => now, log: () => {} })
  const front = door({ keys, tools: [...doorTools({ projects: proj, mumbo }), ...tools], rate, now: () => now, log: (l) => lines.push(l),
    allow: async (u) => { charged.push(`requests ${u}`); return budgetOpen }, tokens: { allow: async (u) => { charged.push(`tokens ${u}`); return tokensOpen } } })
  const ops = children({ e2b: { Sandbox: { list: () => ({ hasNext: false }) } }, cfg: { childTemplates: ['c'], maxChildren: 1 }, log: () => {} })
  const mcp = mcpServer({ ops, claimOf: (info) => verifyBox('k', String(info?.headers.get('authorization') ?? '').replace(/^Bearer /, '')) })
  const server = modelServer({ cfg, edgeKey: 'k', modelKey: 'SERVER', allow: async () => true, owns: async (u, b) => u === A && b === 'box1', touch: () => {}, mcp, door: front, log: () => {} })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const mint = async (spec = {}, owner = A) => (await keys.mint(owner, { name: 'laptop', scopes: ['read'], ...spec })).key
  /** A JSON-RPC call with `key` as the bearer. */
  const rpc = (key, method, params = {}, extra = {}) => send(port, { ...extra, headers: { authorization: `Bearer ${key}`, ...extra.headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 7, method, params }) })
  const tool = (key, name, args = {}) => rpc(key, 'tools/call', { name, arguments: args })
  const logs = () => lines.map(l => JSON.parse(l))
  return { store, proj, keys, P, Q, R, allowed, port, mint, rpc, tool, lines, logs, charged, at: (ms) => { now = ms }, close: () => server.close() }
}
const refused = (r, status, code) => {
  assert.equal(r.status, status, r.text)
  assert.equal(r.json.error.data.code, code, r.text)
  assert.match(r.json.error.message, new RegExp(`^${code}: `))
}
const result = (r) => { assert.equal(r.status, 200, r.text); assert.equal(r.json.result.isError, undefined, r.text); return JSON.parse(r.json.result.content[0].text) }
/** The log lines are written when each response closes, just after the client has read it. */
const settle = () => new Promise(r => setImmediate(r))

test('bearer only: no key, a cookie alone, a box token, a malformed or repeated header are refused; a revocation holds from the next call', async () => {
  const t = await setup()
  try {
    const key = await t.mint()
    const init = await t.rpc(key, 'initialize', INIT)
    assert.equal(init.status, 200); assert.equal(init.json.result.serverInfo.name, 'mumbo')
    const none = await send(t.port, { body: '{}' })
    refused(none, 401, 'invalid_api_key')
    assert.equal(none.headers['www-authenticate'], 'Bearer realm="mumbo"')
    // The signed-in browser's cookies, sign-in and dsh's, are never read.
    refused(await send(t.port, { headers: { cookie: `_oauth2_proxy_mumbo=s; dsh-auth-x=1; key=${key}` }, body: '{}' }), 401, 'invalid_api_key')
    refused(await t.rpc(signBox('k', A, 'box1'), 'tools/list'), 403, 'user_key_required')
    for (const authorization of [key, `Basic ${key}`, `Bearer ${key} x`, `Bearer ${key.slice(0, -1)}`, 'Bearer ']) {
      const r = await send(t.port, { headers: { authorization }, body: '{}' })
      refused(r, 401, 'invalid_api_key')
      assert.equal(r.headers['www-authenticate'], 'Bearer realm="mumbo", error="invalid_token"', authorization)
    }
    refused(await send(t.port, { headers: ['authorization', `Bearer ${key}`, 'authorization', `Bearer ${key}`], body: '{}' }), 401, 'invalid_api_key')
    assert.deepEqual(result(await t.tool(key, 'whoami')).owner, A)
    await t.keys.revoke(A, (await t.keys.list(A))[0].id)
    refused(await t.tool(key, 'whoami'), 401, 'key_revoked')
  } finally { t.close() }
})

test('every refusal over the wire: its status, JSON-RPC error and code, WWW-Authenticate on 401s, and never the key', async () => {
  const t = await setup({ tools: [{ name: 'project_status', scope: 'read', project: true, turns: false, input: z.object({ project: z.string() }), description: 'd', run: async (k, a) => a.project }] })
  try {
    const expiring = await t.mint({ expiresInDays: 7 }), plain = await t.mint(), prompt = await t.mint({ scopes: ['prompt'] }), revoked = await t.mint({ name: 'old' })
    await t.keys.revoke(A, (await t.keys.list(A)).find(k => k.name === 'old').id)
    const bOwn = await t.mint({}, B)
    t.allowed.delete(B)
    const cases = [
      [await t.tool(revoked, 'whoami'), 401, 'key_revoked'],
      [await t.tool(`mumbo_pat_${'A'.repeat(38)}`, 'whoami'), 401, 'invalid_api_key'],
      [await t.tool(bOwn, 'whoami'), 403, 'user_disabled'],
      [await t.tool(prompt, 'whoami'), 403, 'insufficient_scope'],
      [await t.tool(plain, 'project_status', { project: t.P }), 403, 'project_not_allowed'],
      [await t.tool(signBox('k', A, 'box1'), 'whoami'), 403, 'user_key_required'],
      [await t.rpc(plain, 'tools/list', {}, { headers: { origin: `https://${PUBLIC}` } }), 403, 'origin_refused'],
      [await t.rpc(plain, 'tools/list', {}, { path: '/mcp/x' }), 404, 'not_found'],
      [await send(t.port, { headers: { authorization: `Bearer ${plain}` }, body: '{' }), 400, 'parse_error'],
      [await send(t.port, { headers: { authorization: `Bearer ${plain}` }, body: '[]' }), 400, 'invalid_request'],
      [await send(t.port, { headers: { authorization: `Bearer ${plain}` }, body: 'x'.repeat(1024 * 1024 + 1) }), 413, 'body_too_large'],
      [await send(t.port, { method: 'GET', headers: { authorization: `Bearer ${plain}` } }), 405, 'method_not_allowed'],
    ]
    t.at(NOW + 7 * 86_400_000)
    cases.push([await t.tool(expiring, 'whoami'), 401, 'key_expired'])
    for (const [r, status, code] of cases) {
      refused(r, status, code)
      assert.equal(r.headers['access-control-allow-origin'], undefined, code)
      assert.equal(r.headers['www-authenticate'] !== undefined, status === 401, code)
      for (const k of [expiring, plain, prompt, revoked, bOwn]) assert.ok(!r.text.includes(k.slice(10, 42)), `${code} echoes no key`)
    }
    // The JSON-RPC id is echoed once the body was read.
    assert.equal(cases[4][0].json.id, 7)
    assert.equal(cases.find(([, , code]) => code === 'method_not_allowed')[0].headers.allow, 'POST')
  } finally { t.close() }
})

test('a method other than POST is answered 405 before its body is read: a 64 MiB PUT or DELETE gets its answer after 1 MiB', async () => {
  const t = await setup()
  try {
    const key = await t.mint()
    for (const method of ['PUT', 'DELETE']) {
      // The client declares 64 MiB but sends only 1 MiB and never ends, so a door that read the body would never answer.
      const r = await new Promise((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port: t.port, method, path: '/mcp', headers: { host: PUBLIC, authorization: `Bearer ${key}`, 'content-type': 'application/json', 'content-length': 64 * 1024 * 1024 } }, (res) => {
          const chunks = []
          res.on('data', c => chunks.push(c)).on('end', () => { req.destroy(); resolve({ status: res.statusCode, headers: res.headers, json: JSON.parse(Buffer.concat(chunks)) }) })
        })
        req.on('error', (e) => { if (!req.destroyed) reject(e) })
        req.write('x'.repeat(1024 * 1024))
      })
      refused(r, 405, 'method_not_allowed')
      assert.equal(r.headers.allow, 'POST', method)
      assert.equal(r.headers.connection, 'close', method)
    }
  } finally { t.close() }
})

test('rate limit: a bucket of DOOR_BURST calls per key refilled at DOOR_RATE_PER_MINUTE; 429 with Retry-After, other keys unaffected', async () => {
  const t = await setup({ rate: { perMinute: 30, burst: 2 } })
  try {
    const key = await t.mint(), other = await t.mint({ name: 'other' })
    assert.equal((await t.tool(key, 'whoami')).status, 200)
    assert.equal((await t.rpc(key, 'tools/list')).status, 200)
    const limited = await t.tool(key, 'whoami')
    refused(limited, 429, 'rate_limited')
    assert.equal(limited.headers['retry-after'], '2', 'one call refills in 2 s at 30 a minute')
    assert.equal((await t.tool(other, 'whoami')).status, 200)
    t.at(NOW + 1000)
    assert.equal((await t.tool(key, 'whoami')).headers['retry-after'], '1')
    t.at(NOW + 2000)
    assert.equal((await t.tool(key, 'whoami')).status, 200)
    refused(await t.tool(key, 'whoami'), 429, 'rate_limited')
  } finally { t.close() }
})

test('one log line per call: key id and name, owner, method, tool, outcome, status and duration; never the key, its hash or an argument', async () => {
  const t = await setup({ tools: [{ name: 'echo', scope: 'read', project: false, turns: false, input: z.object({ text: z.string() }), description: 'd',
    run: async (k, a) => { if (a.text === 'fail') throw Object.assign(new Error('no'), { code: 'nope' }); return a.text } }] })
  try {
    const key = await t.mint({ scopes: ['prompt'] }), reader = await t.mint({ name: 'reader' })
    const [id, readerId] = (await t.keys.list(A)).sort((a, b) => a.name.localeCompare(b.name)).map(k => k.id)
    await t.rpc(reader, 'initialize', INIT)
    await t.tool(reader, 'echo', { text: 'SECRET-ARGUMENT' })
    await t.tool(reader, 'echo', { text: 'fail' })
    await t.tool(reader, 'echo', { wrong: 1 })
    await t.tool(key, 'whoami')
    await send(t.port, { headers: { authorization: `Bearer ${key.slice(0, -1)}x` }, body: '{}' })
    await send(t.port, { method: 'DELETE', headers: { authorization: `Bearer ${reader}` } })
    // The SDK's own refusal of a body that is not JSON.
    await t.rpc(reader, 'tools/list', {}, { headers: { 'content-type': 'text/plain' } })
    await settle()
    const logs = t.logs()
    for (const l of logs) assert.equal(typeof l.ms, 'number')
    assert.deepEqual(logs.map(({ ms, ...l }) => l), [
      { edge: 'door', key: readerId, name: 'reader', owner: A, method: 'initialize', outcome: 'ok', status: 200 },
      { edge: 'door', key: readerId, name: 'reader', owner: A, method: 'tools/call', tool: 'echo', outcome: 'ok', status: 200 },
      { edge: 'door', key: readerId, name: 'reader', owner: A, method: 'tools/call', tool: 'echo', outcome: 'nope', status: 200 },
      { edge: 'door', key: readerId, name: 'reader', owner: A, method: 'tools/call', tool: 'echo', outcome: 'not_run', status: 200 },
      { edge: 'door', key: id, name: 'laptop', owner: A, method: 'tools/call', tool: 'whoami', outcome: 'insufficient_scope', status: 403 },
      { edge: 'door', outcome: 'invalid_api_key', status: 401 },
      { edge: 'door', key: readerId, name: 'reader', owner: A, outcome: 'method_not_allowed', status: 405 },
      { edge: 'door', key: readerId, name: 'reader', owner: A, method: 'tools/list', outcome: 'http_415', status: 415 },
    ])
    const all = t.lines.join('\n')
    for (const k of [key, reader]) { assert.ok(!all.includes(k.slice(10, 42))); assert.ok(!all.includes(keyHash(k))) }
    assert.ok(!all.includes('SECRET-ARGUMENT'))
  } finally { t.close() }
})

test('the dispatcher checks declaration, scope, project and budget before a tool runs', async () => {
  const ran = []
  const tool = (name, decl) => ({ name, description: 'd', input: z.object({ project: z.string().optional() }), ...decl, run: async (k, a) => { ran.push(name); return a.project ?? 'done' } })
  const tools = [tool('no_scope', { project: false, turns: false }), tool('bad_scope', { scope: 'admin', project: false, turns: false }), tool('no_turns', { scope: 'read', project: false }),
    tool('no_project', { scope: 'read', turns: false }), tool('in_project', { scope: 'read', project: true, turns: false }), tool('send', { scope: 'prompt', project: true, turns: true }),
    // Its input schema hands the tool another project than the dispatcher checked.
    { ...tool('shifty', { scope: 'read', project: true, turns: false }), input: z.object({ project: z.string().transform(s => `${s}x`) }) }]
  const t = await setup({ tools })
  try {
    const key = await t.mint({ projects: [] }), wide = await t.mint({ name: 'wide', scopes: ['read', 'prompt'] })
    for (const name of ['no_scope', 'bad_scope', 'no_turns', 'no_project']) refused(await t.tool(wide, name), 403, 'tool_undeclared')
    await t.keys.revoke(A, (await t.keys.list(A)).find(k => k.name === 'wide').id)
    const both = await t.mint({ name: 'both', scopes: ['read', 'prompt'], projects: [t.P] })
    refused(await t.tool(key, 'in_project', { project: t.P }), 403, 'project_not_allowed')
    refused(await t.tool(both, 'in_project', {}), 403, 'project_not_allowed')
    refused(await t.tool(both, 'in_project', { project: t.R }), 403, 'project_not_allowed', 'another person\'s project')
    assert.equal(result(await t.tool(both, 'in_project', { project: t.P })), t.P)
    const shifted = await t.tool(both, 'shifty', { project: t.P })
    assert.equal(shifted.json.result.isError, true); assert.match(shifted.json.result.content[0].text, /^tool_undeclared: /)
    refused(await t.tool(key, 'send', { project: t.P }), 403, 'insufficient_scope')
    assert.deepEqual(t.charged, [], 'a refused call is not charged; read tools are never charged')
    assert.equal(result(await t.tool(both, 'send', { project: t.P })), t.P)
    assert.deepEqual(t.charged, [`requests ${A}`, `tokens ${A}`])
    assert.deepEqual(ran, ['in_project', 'send'])
    assert.equal(result(await t.tool(both, 'whoami')).name, 'both')
    assert.equal(t.charged.length, 2, 'whoami causes no model turns')
  } finally { t.close() }
  for (const [budgetOpen, tokensOpen] of [[false, true], [true, false]]) {
    const s = await setup({ tools, budgetOpen, tokensOpen })
    try {
      const key = await s.mint({ scopes: ['prompt'], projects: [s.P] })
      refused(await s.tool(key, 'send', { project: s.P }), 429, 'budget_exhausted')
    } finally { s.close() }
  }
  assert.deepEqual(ran, ['in_project', 'send'], 'nothing ran on a spent budget')
})

test('whoami and project_list: the key itself, and the projects it names whose owner is still a member', async () => {
  const t = await setup({ tools: [{ name: 'in_project', scope: 'read', project: true, turns: false, input: z.object({ project: z.string() }), description: 'd', run: async () => 'ran' }] })
  try {
    const key = await t.mint({ name: 'laptop Claude Code', scopes: ['read', 'workspace'], projects: [t.P, t.Q], expiresInDays: 30 })
    const id = (await t.keys.list(A))[0].id
    assert.deepEqual(result(await t.tool(key, 'whoami')), { id, name: 'laptop Claude Code', owner: A, scopes: ['read', 'workspace'], projects: [t.P, t.Q], expiresAt: '2026-12-10T12:00:00.000Z' })
    assert.equal(result(await t.tool(await t.mint({ name: 'forever' }), 'whoami')).expiresAt, null)
    const names = (r) => result(r).map(p => p.name).sort()
    assert.deepEqual(names(await t.tool(key, 'project_list')), ['Mine', 'Other'])
    assert.deepEqual(result(await t.tool(key, 'project_list')).find(p => p.id === t.P), { id: t.P, name: 'Mine', owner: A, members: [A] })
    // A leaves Q after the key was minted: Q drops from the list, and its tools are refused.
    const q = await t.store.getDoc(`project:${t.Q}`)
    await t.store.putDoc(`project:${t.Q}`, { ...q, members: [] })
    assert.deepEqual(names(await t.tool(key, 'project_list')), ['Mine'])
    refused(await t.tool(key, 'in_project', { project: t.Q }), 403, 'project_not_allowed')
    assert.equal(result(await t.tool(key, 'in_project', { project: t.P })), 'ran')
    const listed = (await t.rpc(key, 'tools/list')).json.result.tools.map(x => x.name).sort()
    assert.deepEqual(listed, ['agent_read', 'agent_send', 'in_project', 'needs_you', 'project_list', 'task_reply', 'task_result', 'task_status', 'whoami'])
  } finally { t.close() }
})

test('the box-token endpoint beside the door: unchanged on the model host, closed to a door key; the public host reaches only the door', async () => {
  const t = await setup()
  try {
    const key = await t.mint(), box = signBox('k', A, 'box1'), from = { 'x-forwarded-for': '1.2.3.4' }
    const boxCall = (token, headers = from) => send(t.port, { host: LLM, headers: { authorization: `Bearer ${token}`, ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) })
    const listed = await boxCall(box)
    assert.equal(listed.status, 200)
    assert.ok(listed.json.result.tools.some(x => x.name === 'sandbox_create'))
    const doorKey = await boxCall(key)
    assert.equal(doorKey.status, 401); assert.deepEqual(doorKey.json, { error: 'invalid box token' })
    assert.equal((await boxCall(box, {})).status, 403, 'the box endpoint still checks the source address')
    // A door call comes from anywhere: no X-Forwarded-For from a box address is needed.
    assert.equal((await t.rpc(key, 'tools/list')).status, 200)
    // No model route answers on the public host, not even to a box token from a box address.
    refused(await send(t.port, { path: '/anthropic/v1/messages', headers: { 'x-api-key': box, ...from }, body: '{}' }), 404, 'not_found')
    refused(await send(t.port, { headers: { authorization: `Bearer ${box}`, ...from }, body: '{}' }), 403, 'user_key_required')
  } finally { t.close() }
})

// ---- Mumbo through the door (B33): the six @mumbo/mcp tools forwarded to the owner's person box.

const BOX = { id: 'sbx1', token: 'launch', traffic: 'TT', host: PUBLIC }
const boxOf = (ensured, touched, ensure = async () => BOX) => ({ ensure: async (p) => { ensured.push(p); return ensure(p) }, touch: async (id) => { touched.push(id) } })
/** A fake E2B client proxy: records each request and answers `answer(seen)`, a { status?, body } (body JSON unless a string). */
async function fakeProxy(answer) {
  const seen = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', c => chunks.push(c)).on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headersDistinct, body: JSON.parse(Buffer.concat(chunks)) })
      const { status = 200, body } = answer(seen.at(-1))
      res.writeHead(status, { 'content-type': 'application/json' }).end(typeof body === 'string' ? body : JSON.stringify(body))
    })
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  return { seen, url: new URL(`http://127.0.0.1:${server.address().port}`), close: () => server.close() }
}

test('the per-box key is HMAC(edge key, mumbo-mcp:<box id>): stable per box, different across boxes and from the member key; the handle fits @mumbo/mcp', () => {
  const k = mumboMcpKey('edge', 'box1')
  assert.equal(k, mumboMcpKey('edge', 'box1'))
  assert.equal(k, createHmac('sha256', 'edge').update('mumbo-mcp:box1').digest('base64url'))
  assert.match(k, /^[A-Za-z0-9_-]{43}$/)
  for (const other of [mumboMcpKey('edge', 'box2'), mumboMcpKey('other', 'box1'), memberKey('edge', 'box1').toString('base64url')]) assert.notEqual(k, other)
  for (const [email, handle] of [['a@x.com', 'a'], ['Rishabh.17IITkgp@gmail.com', 'rishabh-17iitkgp'], ['9lives+tag@x.com', 'lives-tag'], ['__@x.com', 'person'], [`${'b'.repeat(31)}.c@x.com`, 'b'.repeat(31)]]) {
    assert.equal(mcpPrincipal(email), handle, email)
    assert.match(handle, /^[a-z][a-z0-9-]{0,31}$/)
  }
})

test('Mumbo tools reach the owner\'s box: ensured, then one tools/call to its @mumbo/mcp route with the box key, the owner\'s handle and the key\'s name; the box\'s result comes back unchanged', async () => {
  const replies = {
    agent_send: { content: [{ type: 'text', text: '{"message_id":"m1","after_seq":3}' }] },
    task_reply: { content: [{ type: 'text', text: '{"code":"needs_person","message":"this tool approval can only be answered by a person in the browser"}' }], isError: true },
  }
  const proxy = await fakeProxy(({ body }) => ({ body: { jsonrpc: '2.0', id: body.id, result: replies[body.params.name] } }))
  const ensured = [], touched = []
  const mumbo = mumboForwarder({ box: boxOf(ensured, touched), boxFetch: boxFetcher({ publicHost: PUBLIC, proxy: proxy.url }), edgeKey: 'edge-secret', siteHostOf: () => PUBLIC, log: () => {} })
  const t = await setup({ mumbo })
  try {
    const key = await t.mint({ name: 'laptop Claude Code [ü]', scopes: ['prompt'] })
    const sent = await t.tool(key, 'agent_send', { text: 'hello', request_id: 'r1', extra: 'dropped' })
    assert.equal(sent.status, 200)
    assert.deepEqual(sent.json.result, replies.agent_send)
    const [call] = proxy.seen
    assert.deepEqual([call.method, call.url], ['POST', '/mcp'])
    assert.deepEqual(call.body, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'agent_send', arguments: { text: 'hello', request_id: 'r1' } } })
    const h = call.headers
    assert.deepEqual(h.authorization, [`Bearer ${mumboMcpKey('edge-secret', 'sbx1')}`], 'the box key, never the door key')
    assert.deepEqual(h['x-mcp-principal'], ['a'])
    assert.deepEqual(h['x-mumbo-key-name'], [encodeURIComponent('laptop Claude Code [ü]')])
    assert.deepEqual([h['e2b-sandbox-id'], h['e2b-sandbox-port'], h['e2b-traffic-access-token']], [['sbx1'], ['3092'], ['TT']])
    assert.deepEqual(h['content-type'], ['application/json'])
    assert.equal(h.accept[0], 'application/json, text/event-stream')
    assert.deepEqual(ensured, [A]); assert.deepEqual(touched, ['sbx1'])
    // The box refuses an approval itself; its refusal passes through unchanged.
    assert.deepEqual((await t.tool(key, 'task_reply', { ask_id: 'x', request_id: 'r2', answers: [] })).json.result, replies.task_reply)
    await settle()
    assert.deepEqual(t.logs().map(l => [l.tool, l.outcome]), [['agent_send', 'ok'], ['task_reply', 'box_error']])
  } finally { t.close(); proxy.close() }
})

test('Mumbo tools: read scope for needs_you, task_status and task_result, prompt for agent_send, agent_read and task_reply; only agent_send is charged; runs_halt and runs_resume are not on the door', async () => {
  const forwarded = []
  const t = await setup({ mumbo: async (key, name) => { forwarded.push(name); return { content: [{ type: 'text', text: name }] } } })
  try {
    const reader = await t.mint({ name: 'reader' }), prompter = await t.mint({ name: 'prompter', scopes: ['prompt'] })
    const args = { agent_send: { text: 'hi', request_id: 'r' }, agent_read: { after_seq: 0 }, task_reply: { ask_id: 'a', request_id: 'r' }, needs_you: {}, task_status: {}, task_result: { branch: 'b' } }
    for (const [name, a] of Object.entries(args)) {
      const read = ['needs_you', 'task_status', 'task_result'].includes(name)
      assert.equal((await t.tool(read ? reader : prompter, name, a)).json.result.content[0].text, name)
      refused(await t.tool(read ? prompter : reader, name, a), 403, 'insufficient_scope')
    }
    assert.deepEqual(forwarded, Object.keys(args))
    assert.deepEqual(t.charged, [`requests ${A}`, `tokens ${A}`], 'agent_send alone causes model turns')
    const listed = (await t.rpc(reader, 'tools/list')).json.result.tools.map(x => x.name)
    for (const name of ['runs_halt', 'runs_resume']) {
      assert.ok(!listed.includes(name), name)
      const r = await t.tool(prompter, name, { request_id: 'r' })
      assert.ok(r.json.error ?? r.json.result.isError, name)
    }
    assert.equal(forwarded.length, 6, 'nothing is forwarded for runs_*')
  } finally { t.close() }
})

test('box unavailable: an image without the door route, a box that cannot start or is still starting, and an answer without a tool result', async () => {
  let answer = () => ({ status: 502, body: 'The sandbox is running but port is not open' })
  const proxy = await fakeProxy((seen) => answer(seen))
  const forward = (ensure, readyMs) => mumboForwarder({ box: boxOf([], [], ensure), boxFetch: boxFetcher({ publicHost: PUBLIC, proxy: proxy.url }), edgeKey: 'k', siteHostOf: () => PUBLIC, readyMs, log: () => {} })
  const t = await setup({ mumbo: forward() })
  try {
    const r = await t.tool(await t.mint(), 'task_status')
    assert.equal(r.status, 200); assert.equal(r.json.result.isError, true)
    assert.match(r.json.result.content[0].text, /^box_unavailable: .*\(HTTP 502\): its image may not have the door yet/)
    await settle()
    assert.equal(t.logs().at(-1).outcome, 'box_unavailable')
    const key = { owner: A, name: 'k' }
    answer = ({ body }) => ({ body: { jsonrpc: '2.0', id: body.id, error: { code: -32602, message: 'Tool task_status not found' } } })
    await assert.rejects(forward()(key, 'task_status', {}), { code: 'box_unavailable', message: /answered no tool result/ })
    await assert.rejects(forward(async () => { throw Object.assign(new Error('capacity'), { capacity: true, status: 503 }) })(key, 'task_status', {}), { code: 'box_unavailable', message: /at capacity/ })
    await assert.rejects(forward(async () => { throw new Error('restore failed') })(key, 'task_status', {}), { code: 'box_unavailable', message: /not ready: it is starting, or it could not start/ })
    await assert.rejects(forward(() => new Promise(() => {}), 10)(key, 'task_status', {}), { code: 'box_unavailable', message: /is starting/ })
    assert.equal(proxy.seen.length, 2, 'a box that is not ready gets no call')
  } finally { t.close(); proxy.close() }
})

test('agent_read waits at most 40 s, less after a slow start, so a call ends within 50 s, inside the ALB and CloudFront 60 s', async () => {
  let clock = NOW, start = 0
  const sent = []
  const boxFetch = async (target, host, path, opts) => { sent.push({ args: JSON.parse(opts.body).params.arguments, timeoutMs: opts.timeoutMs }); return { status: 200, body: JSON.stringify({ result: { content: [] } }) } }
  const forward = mumboForwarder({ box: { ensure: async () => { clock += start; return BOX }, touch: async () => {} }, boxFetch, edgeKey: 'k', siteHostOf: () => PUBLIC, now: () => clock, log: () => {} })
  const key = { owner: A, name: 'k' }
  await forward(key, 'agent_read', { after_seq: 4, wait_s: 40 })
  await forward(key, 'agent_read', { after_seq: 4 })
  start = 15_000
  await forward(key, 'agent_read', { after_seq: 4, wait_s: 40 })
  start = 48_000
  await forward(key, 'agent_read', { after_seq: 4, wait_s: 40 })
  assert.deepEqual(sent.map(s => s.args.wait_s), [40, 0, 30, 0])
  assert.deepEqual(sent.map(s => s.timeoutMs), [50_000, 50_000, 35_000, 2_000])
  assert.deepEqual(sent[0].args, { after_seq: 4, wait_s: 40 })
  const failing = mumboForwarder({ box: { ensure: async () => BOX, touch: async () => {} }, boxFetch: async () => { throw new Error('box request timed out') }, edgeKey: 'k', siteHostOf: () => PUBLIC, log: () => {} })
  await assert.rejects(failing(key, 'agent_read', { after_seq: 0 }), { code: 'box_unavailable', message: /did not answer in time/ })
})
