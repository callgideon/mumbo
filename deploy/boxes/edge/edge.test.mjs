// node --test deploy/boxes/edge/edge.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { request, createServer } from 'node:http'
import { inParallel, signBox, verifyBox, userPrefix, budget, needsLaunch, boxHeaders, boxes, modelServer, userServer, startScript, backupCommand, admitted, secureCookies, albIdentity } from './edge.mjs'
import { memoryStore, redisStore } from './store.mjs'
import { generateKeyPairSync, createSign } from 'node:crypto'

const cfg = { publicHost: 'boxes.example', projectDomain: 'boxes.example', llmHost: 'llm.example', template: 'mumbo-box', idleMs: 60_000, backupEveryMs: 600_000, maxRunningUnits: 10, allowed: ['@x.com'], egressIps: [], signinCookie: '_oauth2_proxy_mumbo', proxy: new URL('http://127.0.0.1:1'), upstream: 'https://model.example' }
const listen = (server) => new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port)))
const call = (port, { method = 'GET', path = '/', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port, method, path, headers: { host: cfg.publicHost, ...headers } }, (res) => {
    let data = ''; res.on('data', c => { data += c }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }))
  })
  req.on('error', reject); req.end(body)
})

test('box tokens bind user and box and reject tampering', () => {
  const t = signBox('k', 'a@x.com', 'box1')
  assert.deepEqual(verifyBox('k', t), { u: 'a@x.com', b: 'box1' })
  assert.equal(verifyBox('other', t), undefined)
  const [p, body, sig] = t.split('.')
  const forged = Buffer.from(JSON.stringify({ u: 'b@x.com', b: 'box1' })).toString('base64url')
  assert.equal(verifyBox('k', `${p}.${forged}.${sig}`), undefined)
  assert.equal(verifyBox('k', `${p}.${body}`), undefined)
  assert.equal(verifyBox('k', undefined), undefined)
})

test('backup prefix is per user, case-insensitive, and path-safe', () => {
  assert.equal(userPrefix('A@x.com'), userPrefix('a@x.com'))
  assert.notEqual(userPrefix('a@x.com'), userPrefix('b@x.com'))
  assert.match(userPrefix('../../etc@x.com'), /^users\/[0-9a-f]{64}$/)
})

test('daily budget counts per user and per day', async () => {
  const allow = budget(memoryStore(), 2)
  const d = new Date('2026-11-08T10:00:00Z')
  assert.ok(await allow('a', d)); assert.ok(await allow('a', d)); assert.equal(await allow('a', d), false)
  assert.ok(await allow('b', d))
  assert.ok(await allow('a', new Date('2026-11-09T00:00:01Z')))
})

test('only cookie-less, token-less GETs go to the launch exchange', () => {
  assert.ok(needsLaunch({ method: 'GET', url: '/', headers: {} }))
  assert.equal(needsLaunch({ method: 'GET', url: '/?token=x', headers: {} }), false)
  assert.equal(needsLaunch({ method: 'GET', url: '/', headers: { cookie: 'a=1; dsh-auth-abc=v1' } }), false)
  assert.equal(needsLaunch({ method: 'POST', url: '/', headers: {} }), false)
})

test('box requests drop identity headers and cannot pick another box', () => {
  const h = boxHeaders(cfg, { 'x-forwarded-email': 'a@x.com', authorization: 'Bearer s', 'e2b-sandbox-id': 'victim', 'e2b-traffic-access-token': 'theirs', cookie: 'c=1', host: 'evil' }, { id: 'mine', traffic: 'T' })
  assert.equal(h['e2b-traffic-access-token'], 'T')
  assert.equal(h['x-forwarded-email'], undefined)
  assert.equal(h.authorization, undefined)
  assert.equal(h['e2b-sandbox-id'], 'mine')
  assert.equal(h.host, 'sandbox.boxes.example')
  assert.equal(h.cookie, 'c=1')
})

test('box start script carries only the box token, aimed at the model host', () => {
  const start = startScript(cfg, 'mbx.tok.sig')
  assert.match(start, /DEEPSEEK_API_KEY=mbx\.tok\.sig/)
  assert.match(start, /DEEPSEEK_BASE_URL=https:\/\/llm\.example\/anthropic/)
  assert.match(start, /DEEPSEEK_SEARCH_BASE_URL=https:\/\/llm\.example /)
  assert.match(start, /--trusted-host boxes\.example/)
  assert.match(backupCommand('U'), /--exclude=node_modules.*--upload-file "\$f" 'U'/)
})

test('allowlist takes exact addresses and @domains, and admits nobody when empty', () => {
  assert.ok(admitted(['@x.com'], 'a@x.com'))
  assert.equal(admitted(['@x.com'], 'a@evilx.com'), false)
  assert.ok(admitted(['b@y.com'], 'b@y.com'))
  assert.equal(admitted([], 'a@x.com'), false)
})

test('an @domain entry admits that exact domain, in any case, and never a subdomain or lookalike', () => {
  const allowed = ['@mumbo.si', '@cambrialabs.ai']
  for (const email of ['a@mumbo.si', 'A.B@Mumbo.SI', 'x@cambrialabs.ai']) assert.ok(admitted(allowed, email), email)
  for (const email of ['x@evil-mumbo.si', 'x@mumbo.si.evil.com', 'x@sub.mumbo.si', 'x@mumbo.si.', 'mumbo.si@gmail.com', 'x@gmail.com']) assert.equal(admitted(allowed, email), false, email)
  assert.ok(admitted(['@sub.mumbo.si'], 'x@sub.mumbo.si'), 'a subdomain is admitted when it is listed')
})

test('cookies from the box get Secure', () => {
  assert.deepEqual(secureCookies(cfg, { 'set-cookie': ['a=1; Path=/', 'b=2; Secure'] })['set-cookie'], ['a=1; Path=/; Secure', 'b=2; Secure'])
})

function fakeE2B() {
  const made = []
  const box = (id) => ({ sandboxId: id, files: { write: async () => {} }, commands: { run: async (c) => ({ stdout: c.includes('dsh.log') ? 'launch123' : '' }) }, kill: async () => {} })
  return {
    made,
    Sandbox: {
      list: () => ({ hasNext: true, nextItems: async function () { this.hasNext = false; return made.map(m => ({ sandboxId: m.id, state: 'running', startedAt: '1' })) } }),
      create: async (tpl, opts) => { await new Promise(r => setTimeout(r, 20)); const id = `b${made.length + 1}`; made.push({ id, opts }); return box(id) },
      connect: async (id) => box(id),
      setTimeout: async () => {},
    },
  }
}

test('two first visits at once create exactly one box, tagged with the user', async () => {
  const e2b = fakeE2B()
  const b = boxes({ e2b, store: memoryStore(), cfg, edgeKey: 'k', presignGet: async () => undefined, presignPut: async () => 'P', log: () => {} })
  const [x, y] = await Promise.all([b.ensure('a@x.com'), b.ensure('a@x.com')])
  assert.equal(e2b.made.length, 1)
  assert.equal(x.id, y.id)
  assert.equal(x.token, 'launch123')
  assert.deepEqual(e2b.made[0].opts.metadata, { user: 'a@x.com' })
  assert.equal(e2b.made[0].opts.lifecycle.onTimeout, 'pause')
  assert.equal(e2b.made[0].opts.network.maskRequestHost, 'boxes.example')
  assert.equal(e2b.made[0].opts.network.allowPublicTraffic, false)
  assert.ok(await b.owns('a@x.com', x.id))
  assert.equal(await b.owns('b@x.com', x.id), false)
})

test('idle boxes are backed up, then paused; their tokens stop working', async () => {
  const e2b = fakeE2B(); const ran = []; const paused = []
  e2b.Sandbox.pause = async (id) => { paused.push(id) }
  const realConnect = e2b.Sandbox.connect
  e2b.Sandbox.connect = async (id) => { const b = await realConnect(id); b.commands.run = async (c) => { ran.push(c); return { stdout: '' } }; return b }
  const b = boxes({ e2b, store: memoryStore(), cfg, edgeKey: 'k', presignGet: async () => undefined, presignPut: async () => 'PUT', log: () => {} })
  const { id } = await b.ensure('a@x.com')
  await b.sweep(Date.now() + cfg.idleMs + 1)
  assert.ok(ran.some(c => c.includes("--upload-file \"$f\" 'PUT'")))
  assert.deepEqual(paused, [id])
  assert.equal(await b.owns('a@x.com', id), false)
})

test('box creation stops at the running-box cap', async () => {
  const e2b = fakeE2B()
  const b = boxes({ e2b, store: memoryStore(), cfg: { ...cfg, maxRunningUnits: 2 }, edgeKey: 'k', presignGet: async () => undefined, presignPut: async () => 'P', log: () => {} })
  await b.ensure('a@x.com')
  e2b.Sandbox.list = () => ({ hasNext: true, nextItems: async function () { this.hasNext = false; return e2b.made.map(m => ({ sandboxId: m.id, state: 'running', startedAt: '1', metadata: { user: 'a@x.com' } })).filter(() => true) } })
  const findFor = e2b.Sandbox.list
  e2b.Sandbox.list = (o) => o.query.metadata ? ({ hasNext: false, nextItems: async () => [] }) : findFor(o)
  await assert.rejects(b.ensure('c@x.com'), /capacity/)
})

test('user router refuses requests without a signed-in email', async () => {
  const s = userServer({ cfg, box: { ensure: async (e) => { if (e !== 'a@x.com') assert.fail('must not route'); throw new Error('starting') }, touch() {}, forget() {} }, log: () => {} })
  const port = await listen(s)
  assert.equal((await call(port)).status, 401)
  assert.equal((await call(port, { headers: { 'x-forwarded-email': 'z@other.com' } })).status, 403)
  const r = await call(port, { headers: { 'x-forwarded-email': 'a@x.com' } })
  s.close()
  assert.equal(r.status, 503)
})

test('user router sends a cookie-less browser to its own launch token', async () => {
  const s = userServer({ cfg, box: { ensure: async (e) => ({ id: 'b1', token: e === 'a@x.com' ? 'TA' : 'TB' }), touch() {}, forget() {} }, log: () => {} })
  const port = await listen(s)
  const r = await call(port, { headers: { 'x-forwarded-email': 'A@x.com' } })
  s.close()
  assert.equal(r.status, 302)
  assert.equal(r.headers.location, '/?token=TA')
})

test('model host swaps the box token for the server key, checks ownership, source and budget', async () => {
  const seen = []; const touched = []
  const fetchImpl = async (url, init) => { seen.push({ url, init }); return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }) }
  let allowed = true
  const s = modelServer({ cfg: { ...cfg, egressIps: ['1.2.3.4'] }, edgeKey: 'k', modelKey: 'SERVER', allow: async () => allowed, owns: async (u, b) => u === 'a@x.com' && b === 'b1', touch: (b) => touched.push(b), fetchImpl, log: () => {} })
  const port = await listen(s)
  const tok = signBox('k', 'a@x.com', 'b1')
  const from = { 'x-forwarded-for': '1.2.3.4' }
  assert.equal((await call(port, { method: 'POST', path: '/anthropic/v1/messages', headers: { 'x-api-key': tok, 'x-forwarded-for': '9.9.9.9' } })).status, 403)
  // A client-supplied entry before the load balancer's own does not pass.
  assert.equal((await call(port, { method: 'POST', path: '/anthropic/v1/messages', headers: { 'x-api-key': tok, 'x-forwarded-for': '1.2.3.4, 9.9.9.9' } })).status, 403)
  assert.equal((await call(port, { method: 'POST', path: '/anthropic/v1/messages', headers: { ...from, 'x-api-key': 'nope' } })).status, 401)
  assert.equal((await call(port, { method: 'POST', path: '/anthropic/v1/messages', headers: { ...from, 'x-api-key': signBox('k', 'a@x.com', 'old-box') } })).status, 401)
  const ok = await call(port, { method: 'POST', path: '/anthropic/v1/messages', headers: { ...from, 'x-api-key': tok, 'content-type': 'application/json' }, body: '{}' })
  assert.equal(ok.status, 200)
  assert.equal(seen[0].url, 'https://model.example/anthropic/v1/messages')
  assert.equal(seen[0].init.headers['x-api-key'], 'SERVER')
  assert.deepEqual(touched, ['b1'])
  assert.equal((await call(port, { path: '/models', headers: { ...from, authorization: `Bearer ${tok}` } })).status, 200)
  assert.equal((await call(port, { path: '/v1/tools/search', headers: { ...from, 'x-api-key': tok } })).status, 200)
  assert.equal((await call(port, { path: '/user/balance', headers: { ...from, 'x-api-key': tok } })).status, 404)
  allowed = false
  assert.equal((await call(port, { method: 'POST', path: '/anthropic/v1/messages', headers: { ...from, 'x-api-key': tok } })).status, 429)
  s.close()
})

test('model host hooks: /github/ reaches the forwarder after the token check; halt answers 503 uncounted; token budget after the request count; bodies metered', async () => {
  const forwarded = []; const counted = []; const metered = []
  const fetchImpl = async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
  const s = modelServer({ cfg, edgeKey: 'k', modelKey: 'SERVER', owns: async () => true, touch: () => {}, fetchImpl, log: () => {},
    allow: async (u) => { counted.push(`requests ${u}`); return true },
    github: async (req, res, claim) => { forwarded.push([req.url, claim.u]); res.writeHead(204).end() },
    halt: { isHalted: async (u) => u === 'halted@x.com' },
    tokens: { allow: async (u) => { counted.push(`tokens ${u}`); return u !== 'spent@x.com' }, meter: (u, body, type) => { metered.push([u, type]); return body } } })
  const port = await listen(s)
  const as = (u) => ({ 'x-api-key': signBox('k', u, 'b1') })
  const model = (u) => call(port, { method: 'POST', path: '/anthropic/v1/messages', headers: as(u), body: '{}' })
  try {
    assert.equal((await call(port, { path: '/github/api.github.com/user?x=1', headers: as('project:0123456789abcdef') })).status, 204)
    assert.equal((await call(port, { path: '/github/api.github.com/user', headers: { 'x-api-key': 'nope' } })).status, 401)
    assert.deepEqual(forwarded, [['/github/api.github.com/user?x=1', 'project:0123456789abcdef']])
    const halted = await model('halted@x.com')
    assert.equal(halted.status, 503)
    assert.deepEqual(JSON.parse(halted.body), { type: 'error', error: { type: 'api_error', message: 'Stopped by the founder' } })
    const spent = await model('spent@x.com')
    assert.equal(spent.status, 429)
    assert.equal(JSON.parse(spent.body).error.message, 'Daily token budget reached for spent@x.com')
    assert.deepEqual(counted, ['requests spent@x.com', 'tokens spent@x.com'], 'a halted call is not counted; requests are counted before tokens')
    const ok = await model('a@x.com')
    assert.equal(ok.status, 200); assert.equal(ok.body, '{"ok":true}')
    assert.deepEqual(metered, [['a@x.com', 'application/json']])
  } finally { s.close() }
})

test('after a restart the edge adopts running boxes and backs them up on the next sweep', async () => {
  const e2b = fakeE2B(); const ran = []
  e2b.Sandbox.list = () => ({ hasNext: true, nextItems: async function () { this.hasNext = false; return [{ sandboxId: 'old', state: 'running', metadata: { user: 'a@x.com' } }, { sandboxId: 'stray', state: 'running', metadata: {} }] } })
  e2b.Sandbox.connect = async (id) => ({ sandboxId: id, commands: { run: async (c) => { ran.push(c); return { stdout: '' } } } })
  const store = memoryStore()
  const b = boxes({ e2b, store, cfg, edgeKey: 'k', presignGet: async () => undefined, presignPut: async () => 'PUT', log: () => {} })
  await b.sweep()
  assert.deepEqual((await store.listBoxes()).map(x => x.id), ['old'])
  assert.ok(ran.some(c => c.includes("'PUT'")))
})

test('ALB identity: accepts our ALB\'s signed token, rejects other signers, bad signatures and expiry', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const kid = '11111111-2222-3333-4444-555555555555'
  const arn = 'arn:aws:elasticloadbalancing:us-east-1:1:loadbalancer/app/edge/abc'
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const make = (header, payload, key = privateKey) => {
    const h = enc({ alg: 'ES256', kid, signer: arn, exp: Math.floor(Date.now() / 1000) + 60, ...header }), p = enc(payload)
    const sig = createSign('SHA256').update(`${h}.${p}`).sign({ key, dsaEncoding: 'ieee-p1363' }).toString('base64url')
    return `${h}.${p}.${sig}`
  }
  let fetched = 0
  const verify = albIdentity({ albArn: arn, region: 'us-east-1', fetchImpl: async (url) => { fetched++; assert.ok(url.endsWith(kid)); return new Response(publicKey.export({ type: 'spki', format: 'pem' })) } })
  assert.equal(await verify(make({}, { email: 'A@x.com' })), 'a@x.com')
  assert.equal(await verify(make({ signer: 'arn:aws:elasticloadbalancing:us-east-1:1:loadbalancer/app/other/x' }, { email: 'a@x.com' })), undefined)
  assert.equal(await verify(make({ exp: 1 }, { email: 'a@x.com' })), undefined)
  assert.equal(await verify(make({}, { email: 'a@x.com' }, generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey)), undefined)
  assert.equal(await verify('a.b'), undefined)
  assert.equal(fetched, 1)
})

test('user router behind an ALB trusts only the verified token, never the email header', async () => {
  const s = userServer({ cfg, verifyAlb: async (t) => (t === 'good' ? 'a@x.com' : undefined), box: { ensure: async () => ({ id: 'b1', token: 'TA' }), touch: async () => {}, forget: async () => {} }, log: () => {} })
  const port = await listen(s)
  assert.equal((await call(port, { headers: { 'x-forwarded-email': 'a@x.com' } })).status, 401)
  const r = await call(port, { headers: { 'x-amzn-oidc-data': 'good' } })
  assert.equal((await call(port, { path: '/edge/healthz' })).status, 200)
  s.close()
  assert.equal(r.status, 302)
})

test('locks serialise per key and are released after errors', async () => {
  const store = memoryStore(); const order = []
  await Promise.all([1, 2, 3].map(i => store.withLock('u', 5_000, async () => { order.push(`in${i}`); await new Promise(r => setTimeout(r, 10)); order.push(`out${i}`) })))
  assert.deepEqual(order, ['in1', 'out1', 'in2', 'out2', 'in3', 'out3'])
  await assert.rejects(store.withLock('u', 5_000, async () => { throw new Error('boom') }))
  assert.equal(await store.withLock('u', 5_000, async () => 'free'), 'free')
  assert.ok(await store.lease('sweep', 1_000)); assert.equal(await store.lease('sweep', 1_000), false)
})

test('redis store has the same contract', { skip: !process.env.REDIS_URL && 'set REDIS_URL to run' }, async () => {
  const { createClient } = await import('redis')
  const client = createClient({ url: process.env.REDIS_URL }); await client.connect(); await client.flushDb()
  const store = redisStore(client)
  await store.putBox('b1', { email: 'a@x.com', active: 1 }); await store.patchBox('b1', { active: 2 })
  assert.deepEqual(await store.getBox('b1'), { email: 'a@x.com', active: 2 })
  assert.deepEqual((await store.listBoxes()).map(b => b.id), ['b1'])
  assert.equal(await store.increment('c', 60), 1); assert.equal(await store.increment('c', 60), 2)
  const order = []
  await Promise.all([1, 2].map(i => store.withLock('u', 5_000, async () => { order.push(`in${i}`); await new Promise(r => setTimeout(r, 20)); order.push(`out${i}`) })))
  assert.deepEqual(order.slice(0, 2).map(x => x.slice(0, 2)), ['in', 'ou'])
  assert.ok(await store.lease('l', 1_000)); assert.equal(await store.lease('l', 1_000), false)
  await store.deleteBox('b1'); assert.deepEqual(await store.listBoxes(), [])
  await store.close()
})

test('a box whose snapshot cannot be resumed is replaced from backup instead of stranding the user', async () => {
  const e2b = fakeE2B(); const killed = []
  e2b.made.push({ id: 'broken', opts: {} })
  e2b.Sandbox.list = (o) => ({ hasNext: true, nextItems: async function () { this.hasNext = false; return o.query.metadata ? e2b.made.filter(m => m.id !== 'gone').map(m => ({ sandboxId: m.id, state: m.id === 'broken' ? 'paused' : 'running', startedAt: m.id })) : [] } })
  e2b.Sandbox.connect = async () => { throw new Error('snapshot not found in storage') }
  e2b.Sandbox.kill = async (id) => { killed.push(id); e2b.made = e2b.made.filter(m => m.id !== id); e2b.made.forEach(() => {}) }
  const b = boxes({ e2b, store: memoryStore(), cfg, edgeKey: 'k', presignGet: async () => undefined, presignPut: async () => 'P', log: () => {} })
  const r = await b.ensure('a@x.com')
  assert.deepEqual(killed, ['broken'])
  assert.notEqual(r.id, 'broken')
  assert.equal(r.token, 'launch123')
})

test('inParallel keeps order and never exceeds the limit', async () => {
  let live = 0, peak = 0
  const out = await inParallel([1, 2, 3, 4, 5], 2, async (n) => { live++; peak = Math.max(peak, live); await new Promise(r => setTimeout(r, 5)); live--; return n * 2 })
  assert.deepEqual(out, [2, 4, 6, 8, 10])
  assert.equal(peak, 2)
})

test('a box being restored is neither backed up nor started by another replica, and an abandoned create is dropped', async () => {
  const e2b = fakeE2B(); const ran = []; const killed = []
  let release; const restoring = new Promise(r => { release = r })
  e2b.Sandbox.create = async (tpl, opts) => {
    const id = `b${e2b.made.length + 1}`; e2b.made.push({ id, opts })
    return { sandboxId: id, files: { write: async () => {} }, kill: async () => {}, commands: { run: async (c) => { if (c.includes('GET-URL')) await restoring; return { stdout: c.includes('dsh.log') ? 'launch123' : '' } } } }
  }
  e2b.Sandbox.list = () => ({ hasNext: true, nextItems: async function () { this.hasNext = false; return e2b.made.map(m => ({ sandboxId: m.id, state: 'running', startedAt: '1', metadata: { user: 'a@x.com' } })) } })
  e2b.Sandbox.connect = async (id) => ({ sandboxId: id, commands: { run: async (c) => { ran.push(c); return { stdout: '' } } } })
  e2b.Sandbox.kill = async (id) => { killed.push(id) }
  const store = memoryStore()
  const a = boxes({ e2b, store, cfg, edgeKey: 'k', presignGet: async () => 'GET-URL', presignPut: async () => 'PUT', log: () => {} })
  const other = boxes({ e2b, store, cfg: { ...cfg }, edgeKey: 'k', presignGet: async () => 'GET-URL', presignPut: async () => 'PUT', log: () => {} })
  const first = a.ensure('a@x.com')
  await new Promise(r => setTimeout(r, 20))
  await other.sweep(Date.now() + cfg.backupEveryMs + 1)
  assert.equal(ran.length, 0, 'no backup of a half-restored box')
  release(); const { id } = await first
  assert.equal((await store.getBox(id)).creating, undefined)

  // A create whose replica died mid-restore: the record stays `creating` and is dropped after 15 minutes.
  await store.putBox('dead', { email: 'b@x.com', creating: Date.now(), active: Date.now(), extended: Date.now(), backedUp: Date.now(), paused: false })
  await store.release('sweep')
  await other.sweep(Date.now() + 16 * 60_000)
  assert.deepEqual(killed, ['dead'])
  assert.equal(await store.getBox('dead'), undefined)
})

// ---- child sandboxes (sandboxes.mjs)
import { children, mcpServer } from './sandboxes.mjs'
function fakeChildE2B() {
  const live = new Map(); let n = 0
  return {
    live,
    Sandbox: {
      list: ({ query }) => ({ hasNext: true, nextItems: async function () { this.hasNext = false; return [...live.values()].filter(s => s.metadata.owner === query.metadata.owner) } }),
      create: async (template, opts) => { const s = { sandboxId: `c${++n}`, templateId: template, metadata: opts.metadata, opts }; live.set(s.sandboxId, s); return s },
      getInfo: async (id) => { const s = live.get(id); if (!s) throw new Error('not found'); return s },
      connect: async (id) => ({
        commands: { run: async (cmd) => { if (cmd === 'false') throw Object.assign(new Error('exit 1'), { exitCode: 1, stdout: '', stderr: 'no' }); return { exitCode: 0, stdout: `ran ${cmd} in ${id}`, stderr: '' } } },
        files: { write: async () => {}, read: async (p) => `content of ${p}` },
      }),
      kill: async (id) => { live.delete(id) },
    },
  }
}
const childCfg = { childTemplates: ['mumbo-child'], maxChildren: 2 }

test('child sandboxes: owned per user, capped, template-limited, never tagged as the user\'s box', async () => {
  const e2b = fakeChildE2B(); const ops = children({ e2b, cfg: childCfg, log: () => {} })
  const { id } = await ops.create('a@x.com', 'box1')
  assert.deepEqual(e2b.live.get(id).metadata, { owner: 'a@x.com', parent: 'box1' })
  assert.equal(e2b.live.get(id).metadata.user, undefined)
  assert.equal(e2b.live.get(id).opts.network.allowPublicTraffic, false)
  await assert.rejects(ops.create('a@x.com', 'box1', { template: 'mumbo-box' }), /template must be/)
  await ops.create('a@x.com', 'box1')
  await assert.rejects(ops.create('a@x.com', 'box1'), (e) => e.status === 429)
  assert.equal((await ops.list('a@x.com')).length, 2)
  assert.equal((await ops.list('b@x.com')).length, 0)
  await assert.rejects(ops.run('b@x.com', id, { command: 'ls' }), /no sandbox/)
  await assert.rejects(ops.kill('b@x.com', id), /no sandbox/)
  assert.deepEqual(await ops.run('a@x.com', id, { command: 'false' }), { exitCode: 1, stdout: '', stderr: 'no' })
  await ops.kill('a@x.com', id)
  assert.equal(e2b.live.has(id), false)
})

test('MCP endpoint on the model host: box token required, tools act as the token\'s user', async () => {
  const e2b = fakeChildE2B(); const ops = children({ e2b, cfg: childCfg, log: () => {} })
  const mcp = mcpServer({ ops, claimOf: (info) => verifyBox('k', String(info?.headers.get('authorization') ?? '').replace(/^Bearer /, '')) })
  const server = modelServer({ cfg: { ...cfg, egressIps: [] }, edgeKey: 'k', modelKey: 'SERVER', allow: async () => true, owns: async (u, b) => u === 'a@x.com' && b === 'box1', touch: () => {}, mcp, log: () => {} })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${server.address().port}/mcp`
  const rpc = async (method, params, token = signBox('k', 'a@x.com', 'box1')) => {
    const r = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
    const text = await r.text()
    return { status: r.status, body: text.startsWith('{') ? JSON.parse(text) : JSON.parse(text.split('\n').find(l => l.startsWith('data:')).slice(5)) }
  }
  try {
    assert.equal((await rpc('tools/list', {}, 'mbx.bad.sig').catch(() => ({ status: 401 }))).status, 401)
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } })
    assert.equal(init.status, 200)
    const tools = (await rpc('tools/list', {})).body.result.tools.map(t => t.name).sort()
    assert.deepEqual(tools, ['sandbox_create', 'sandbox_kill', 'sandbox_list', 'sandbox_read_file', 'sandbox_run', 'sandbox_write_file'])
    const made = JSON.parse((await rpc('tools/call', { name: 'sandbox_create', arguments: {} })).body.result.content[0].text)
    assert.equal(e2b.live.get(made.id).metadata.owner, 'a@x.com')
    const ran = (await rpc('tools/call', { name: 'sandbox_run', arguments: { id: made.id, command: 'echo hi' } })).body.result
    assert.match(ran.content[0].text, /ran echo hi/)
  } finally { server.close() }
})

test('desktop live view: /desktop/ goes to the box\'s noVNC port, everything else to dsh', async () => {
  const { boxRoute } = await import('./edge.mjs')
  assert.match(boxRoute('/desktop').redirect, /^\/desktop\/vnc\.html\?.*path=desktop\/websockify/)
  assert.deepEqual(boxRoute('/desktop/websockify'), { port: '6080', path: '/websockify', base: '' })
  assert.deepEqual(boxRoute('/desktop-not'), { port: '3080', path: '/desktop-not', base: '' })
  assert.deepEqual(boxRoute('/api/remote.mux'), { port: '3080', path: '/api/remote.mux', base: '' })
  assert.equal(boxHeaders(cfg, {}, { id: 'b1' }, '6080')['e2b-sandbox-port'], '6080')
})

test('backups carry the browser profile without caches or profile locks, and tolerate its absence', async () => {
  const { backupCommand } = await import('./edge.mjs')
  const c = backupCommand('URL')
  assert.match(c, /ls -d root\/\.dsh root\/projects root\/\.mumbo-sqlite home\/browser\/profile 2>\/dev\/null/)
  for (const x of ['Singleton*', '*/Cache', '*/Code Cache', '*/GPUCache']) assert.ok(c.includes(`--exclude='home/browser/profile/${x}'`), x)
})

test('an idle box is paused with its next scheduled run and woken for it, restarting dsh', async () => {
  const { NEXT_WAKE_COMMAND } = await import('./edge.mjs')
  const e2b = fakeE2B(); const ran = []; const paused = []
  const due = Date.now() + 3 * 3600_000
  e2b.Sandbox.pause = async (id) => { paused.push(id) }
  const realConnect = e2b.Sandbox.connect
  e2b.Sandbox.connect = async (id) => { const b = await realConnect(id); b.commands.run = async (c) => { ran.push(c); return { stdout: c === NEXT_WAKE_COMMAND ? String(due) : c.includes('dsh.log') ? 'launch456' : '' } }; return b }
  const store = memoryStore()
  const b = boxes({ e2b, store, cfg, edgeKey: 'k', presignGet: async () => undefined, presignPut: async () => 'PUT', log: () => {} })
  const { id } = await b.ensure('a@x.com')
  await b.sweep(Date.now() + cfg.idleMs + 1)
  assert.deepEqual(paused, [id])
  assert.equal((await store.getBox(id)).wakeAt, due)
  ran.length = 0
  await store.release('sweep')
  await b.sweep(due - 2 * 60_000)  // not yet due: stays paused
  assert.equal((await store.getBox(id)).paused, true)
  await store.release('sweep')
  await b.sweep(due - 30_000)
  const rec = await store.getBox(id)
  assert.equal(rec.paused, false); assert.equal(rec.wakeAt, undefined); assert.equal(rec.launch, 'launch456')
  assert.ok(ran.includes('/root/.mumbo/start.sh'))
})

test('with PAUSE_IDLE=false idle boxes stay running: no pause, backups only when stale, E2B timer kept extended', async () => {
  const e2b = fakeE2B(); const ran = []; const paused = []; const extended = []
  e2b.Sandbox.pause = async (id) => { paused.push(id) }
  e2b.Sandbox.setTimeout = async (id) => { extended.push(id) }
  const realConnect = e2b.Sandbox.connect
  e2b.Sandbox.connect = async (id) => { const b = await realConnect(id); b.commands.run = async (c) => { ran.push(c); return { stdout: '' } }; return b }
  const store = memoryStore()
  const b = boxes({ e2b, store, cfg: { ...cfg, pauseIdle: false }, edgeKey: 'k', presignGet: async () => undefined, presignPut: async () => 'PUT', log: () => {} })
  const { id } = await b.ensure('a@x.com')
  const t = Date.now() + Math.max(cfg.idleMs, 5 * 60_000) + 1  // idle, and past the 5-minute keepalive interval
  await store.patchBox(id, { backedUp: t - 1000 })
  await b.sweep(t)
  assert.deepEqual(paused, [])
  assert.equal(ran.filter(c => c.includes("'PUT'")).length, 0, 'fresh backup: none taken although idle')
  assert.deepEqual(extended, [id])
  await store.release('sweep')
  await b.sweep(t + cfg.backupEveryMs)
  assert.equal(ran.filter(c => c.includes("'PUT'")).length, 1, 'stale backup: taken')
  assert.deepEqual(paused, [])
})

// ---- shared projects (projects.mjs)
import { projects as projectStore } from './projects.mjs'

test('projects: owner creates and lists; adding a second member is refused by the member gate', async () => {
  const p = projectStore({ store: memoryStore(), admitted: (e) => e.endsWith('@x.com'), log: () => {} })
  const { id } = await p.create('a@x.com', ' Landing page ')
  assert.match(id, /^[a-z0-9]{16}$/)
  assert.equal((await p.list('a@x.com'))[0].name, 'Landing page')
  await assert.rejects(p.addMember('b@x.com', id, 'c@x.com'), (e) => e.status === 404)
  await assert.rejects(p.addMember('a@x.com', id, 'B@x.com'), (e) => e.status === 403 && e.code === 'member_gate' && e.message === 'Projects take more members once agent containment lands.')
  assert.equal(await p.isMember('b@x.com', id), false)
  assert.deepEqual((await p.list('a@x.com')).map(x => x.id), [id])
  assert.deepEqual(await p.list('b@x.com'), [])
  assert.equal(await p.isMember('a@x.com', 'not-an-id'), false)
})

test('project paths redirect to the project\'s own host, which members reach with its launch path at /', async () => {
  const ensured = []
  const box = { ensure: async (principal) => { ensured.push(principal); return { id: principal === 'a@x.com' ? 'ubox' : 'pbox', token: 'TOK' } }, touch: async () => {}, forget: async () => {} }
  const proj = projectStore({ store: memoryStore(), admitted: () => true, log: () => {} })
  const { id } = await proj.create('a@x.com', 'P')
  const server = userServer({ cfg, box, projects: proj, log: () => {} })
  const port = await listen(server)
  const go = (path, email, host = `p-${id}.${cfg.publicHost}`) => call(port, { path, headers: { host, 'x-forwarded-email': email, accept: 'text/html' } })
  try {
    assert.equal((await go(`/p/${id}`, 'a@x.com', cfg.publicHost)).headers.location, `https://p-${id}.boxes.example/`)
    const r = await go('/', 'a@x.com')
    assert.equal(r.status, 302); assert.equal(r.headers.location, '/?token=TOK')
    assert.deepEqual(ensured, [`project:${id}`])
    assert.equal((await go('/', 'b@x.com')).status, 403)
    assert.equal(ensured.length, 1, 'a non-member never starts the project box')
  } finally { server.close() }
})

test('project boxes: own masked host and public path, no desktop or browser tools', async () => {
  const { boxSite } = await import('./edge.mjs')
  const c = { llmHost: 'llm.x', publicHost: 'boxes.x', projectDomain: 'boxes.x' }
  const site = boxSite(c, 'project:0123456789abcdef')
  assert.deepEqual(site, { host: 'p-0123456789abcdef.boxes.x', publicUrl: 'https://p-0123456789abcdef.boxes.x/', desktop: false })
  const script = startScript(c, 'T', site, '', undefined, { proxy: 'P', gh: 'G' })
  assert.ok(!script.includes('browser-use') && !script.includes('chromium'))
  assert.match(script, /--trusted-host boxes\.x --trusted-host p-0123456789abcdef\.boxes\.x/)
  assert.deepEqual(boxSite(c, 'a@x.com'), { host: 'boxes.x', publicUrl: 'https://boxes.x/', desktop: true })
})

test('project tools are offered to a person\'s box and not to a project box', async () => {
  const proj = projectStore({ store: memoryStore(), admitted: () => true, log: () => {} })
  const ops = children({ e2b: fakeChildE2B(), cfg: childCfg, log: () => {} })
  const mcp = mcpServer({ ops, projects: proj, projectDomain: 'projects.example', claimOf: (info) => verifyBox('k', String(info?.headers.get('authorization') ?? '').replace(/^Bearer /, '')) })
  const server = createServer((req, res) => mcp(req, res))
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const call = async (token, method, params) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
    const t = await r.text(); return JSON.parse(t.startsWith('{') ? t : t.split('\n').find(l => l.startsWith('data:')).slice(5))
  }
  try {
    const person = signBox('k', 'a@x.com', 'b1'), project = signBox('k', 'project:0123456789abcdef', 'pb')
    const names = async (tok) => (await call(tok, 'tools/list', {})).result.tools.map(t => t.name)
    assert.ok((await names(person)).includes('project_create'))
    assert.match((await call(person, 'tools/list', {})).result.tools.find(t => t.name === 'project_create').description, /at https:\/\/p-<id>\.projects\.example\/;/)
    assert.ok(!(await names(project)).some(n => n.startsWith('project_')))
    const made = JSON.parse((await call(person, 'tools/call', { name: 'project_create', arguments: { name: 'Shop' } })).result.content[0].text)
    assert.equal((await proj.list('a@x.com'))[0].id, made.id)
  } finally { server.close() }
})

test('box requests carry the browser Origin unchanged, so a box\'s dsh compares it with its own host', () => {
  for (const origin of [`https://${cfg.publicHost}`, `https://p-0123456789abcdef.${cfg.publicHost}`, 'https://evil.example']) assert.equal(boxHeaders(cfg, { origin }, { id: 'pb' }).origin, origin)
})

test('project relay: signs in once, creates the coordinator session once, re-signs after 401, members only', async () => {
  const { projectRelay } = await import('./projects.mjs')
  const store = memoryStore()
  const proj = projectStore({ store, admitted: () => true, log: () => {} })
  const { id } = await proj.create('a@x.com', 'P')
  const calls = []; let expire = false
  const boxFetch = async (target, host, path, init) => {
    calls.push(`${init.method} ${path}`)
    if (path.startsWith('/?token=')) return { status: 303, setCookie: ['dsh-auth-abc=v1; Path=/; HttpOnly'], body: '' }
    if (expire) { expire = false; return { status: 401, setCookie: [], body: '' } }
    const req = JSON.parse(init.body)
    assert.equal(init.headers.cookie, 'dsh-auth-abc=v1'); assert.equal(host, `p-${id}.boxes.example`)
    const value = req.method === 'session/create' ? { sessionId: 'S1' } : { accepted: true }
    if (req.method === 'session/prompt') { assert.equal(req.payload.args.request.sessionId, 'S1'); assert.match(req.payload.args.request.content[0].text, /^\[from a@x\.com\] /) }
    return { status: 200, setCookie: [], body: JSON.stringify({ type: 'server-response', rpcId: req.rpcId, result: { ok: true, value } }) }
  }
  const box = { ensure: async (p) => ({ id: 'pbox', token: 'TOK', principal: p }) }
  const relay = projectRelay({ store, projects: proj, box, boxFetch, siteHostOf: () => `p-${id}.boxes.example`, log: () => {} })
  assert.deepEqual(await relay.message('a@x.com', id, ' hi '), { delivered: true, project: id, coordinatorSession: 'S1' })
  await relay.message('a@x.com', id, 'again')
  assert.equal(calls.filter(c => c.startsWith('GET /?token=')).length, 1)
  assert.equal(calls.filter(c => c === 'POST /api/session/create').length, 1)
  expire = true
  await relay.message('a@x.com', id, 'after expiry')
  assert.equal(calls.filter(c => c.startsWith('GET /?token=')).length, 2)
  await assert.rejects(relay.message('b@x.com', id, 'hi'), (e) => e.status === 404)
  await assert.rejects(relay.message('a@x.com', id, '  '), (e) => e.status === 400)
})

test('role instructions: assistant with write consent and desktop sign-in; coordinator without accounts', async () => {
  const { roleInstructions } = await import('./edge.mjs')
  const c = { publicHost: 'boxes.x', projectDomain: 'boxes.x' }
  const a = roleInstructions(c, 'a@x.com')
  assert.match(a, /personal assistant of a@x\.com/)
  assert.match(a, /wait for the user to agree/)
  assert.match(a, /https:\/\/boxes\.x\/desktop\//)
  assert.match(a, /project_message/)
  const p = roleInstructions(c, 'project:0123456789abcdef')
  assert.match(p, /coordinate the shared mumbo project 0123456789abcdef\. Its members reach you at https:\/\/p-0123456789abcdef\.boxes\.x\/ /)
  assert.match(p, /\[from <email>\]/)
  assert.match(p, /no browser and nobody's accounts/)
  const script = startScript(c, 'T', undefined, a)
  assert.match(script, /DSH_AGENTS_HOME=\/root\/\.mumbo\/agents/)
  assert.ok(script.includes(`<<'MD'\n${a}\nMD`))
})

test('home page lists the assistant, desktop and the member\'s projects without starting a box, escaping names', async () => {
  const ensured = []
  const box = { ensure: async (p) => { ensured.push(p); return { id: 'x', token: 'T' } }, touch: async () => {}, forget: async () => {} }
  const proj = projectStore({ store: memoryStore(), admitted: () => true, log: () => {} })
  const { id } = await proj.create('a@x.com', '<b>Shop</b>')
  await proj.create('c@x.com', 'Not mine')
  const server = userServer({ cfg, box, projects: proj, log: () => {} })
  const port = await listen(server)
  try {
    const html = (await call(port, { path: '/home', headers: { 'x-forwarded-email': 'a@x.com' } })).body
    assert.ok(html.includes(`href="https://p-${id}.boxes.example/"`) && html.includes('&#60;b&#62;Shop&#60;/b&#62;') && !html.includes('<b>Shop'))
    assert.ok(!html.includes('Not mine'))
    assert.ok(html.includes('href="/desktop/"'))
    assert.deepEqual(ensured, [])
  } finally { server.close() }
})

test('never-pause keepalive drops a box E2B no longer has', async () => {
  const e2b = fakeE2B()
  e2b.Sandbox.setTimeout = async (id) => { throw new Error(`Sandbox ${id} not found`) }
  const store = memoryStore()
  const b = boxes({ e2b, store, cfg: { ...cfg, pauseIdle: false }, edgeKey: 'k', presignGet: async () => undefined, presignPut: async () => 'PUT', log: () => {} })
  const { id } = await b.ensure('a@x.com')
  await store.patchBox(id, { backedUp: Date.now() + 3600_000 })
  await b.sweep(Date.now() + 6 * 60_000)
  assert.equal(await store.getBox(id), undefined)
})

// ---- project members (dsh @mumbo/edge-member)
test('member header: exact format, signed with the per-box key, 5 minutes', async () => {
  const { memberKey, memberHeader } = await import('./edge.mjs')
  const { createHmac } = await import('node:crypto')
  const key = memberKey('edge-secret', 'box1')
  assert.equal(key.length, 32)
  assert.deepEqual(key, createHmac('sha256', 'edge-secret').update('member:box1').digest())
  const h = memberHeader(key, 'A@X.com', 1_000_000_000)
  const [e, exp, mac] = h.split('.')
  assert.equal(Buffer.from(e, 'base64url').toString(), 'a@x.com')
  assert.equal(Number(exp), 1_000_300)
  assert.equal(mac, createHmac('sha256', key).update(`${e}.${exp}`).digest('base64url'))
  assert.ok(!h.includes('='))
})

test('project start script carries the member key and loads the project overlay only when the image has it', async () => {
  const c = { llmHost: 'l', publicHost: 'boxes.x', projectDomain: 'boxes.x' }
  const { boxSite } = await import('./edge.mjs')
  const p = startScript(c, 'T', boxSite(c, 'project:0123456789abcdef'), 'role', 'KEYTEXT', { proxy: 'P', gh: 'G' })
  assert.match(p, /export MUMBO_MEMBER_KEY=KEYTEXT/)
  assert.match(p, /if \[ -f \/src\/deploy\/mumbo-project\.overlay\.yml \]; then PROJECT_PATCH="--patch \/src\/deploy\/mumbo-project\.overlay\.yml"; touch \/root\/\.mumbo\/member-auth; else rm -f \/root\/\.mumbo\/member-auth; fi/)
  assert.match(p, /sandboxes\.overlay\.yml \$LINKS_PATCH \$PROJECT_PATCH/)
  const u = startScript(c, 'T', boxSite(c, 'a@x.com'), 'role')
  assert.ok(!u.includes('MUMBO_MEMBER_KEY') && !u.includes('PROJECT_PATCH'))
})

test('routing: browser member headers are stripped; member-capable project boxes get the member, never the owner token', async () => {
  const { memberKey, memberHeader } = await import('./edge.mjs')
  const seen = []
  const upstream = createServer((req, res) => { seen.push({ path: req.url, member: req.headers['x-mumbo-member'] }); res.writeHead(req.url === '/deny' ? 401 : 200).end('ok') })
  await new Promise(r => upstream.listen(0, '127.0.0.1', r))
  const key = memberKey('k', 'pbox')
  const proj = projectStore({ store: memoryStore(), admitted: () => true, log: () => {} })
  const capable = (await proj.create('a@x.com', 'Capable')).id
  const legacy = (await proj.create('a@x.com', 'Legacy')).id
  const box = { ensure: async (p) => p === `project:${capable}` ? { id: 'pbox', token: 'OWNER', member: (e) => memberHeader(key, e) } : { id: p === 'a@x.com' ? 'ubox' : 'lbox', token: 'OWNER' }, touch: async () => {}, forget: async () => {} }
  const server = userServer({ cfg: { ...cfg, proxy: new URL(`http://127.0.0.1:${upstream.address().port}`) }, box, projects: proj, log: () => {} })
  const port = await listen(server)
  const go = (host, path = '/', extra = {}) => call(port, { path, headers: { host, 'x-forwarded-email': 'a@x.com', accept: 'text/html', ...extra } })
  const at = (id) => `p-${id}.${cfg.publicHost}`
  try {
    await go(cfg.publicHost, '/', { cookie: 'dsh-auth-x=1', 'x-mumbo-member': 'forged' })
    assert.equal(seen.at(-1).member, undefined, 'a browser-sent member header never reaches a box')
    const r = await go(at(capable), '/', { 'x-mumbo-member': 'forged' })
    assert.equal(r.status, 200, 'no owner launch redirect for a member')
    const [e, exp, mac] = seen.at(-1).member.split('.')
    assert.equal(Buffer.from(e, 'base64url').toString(), 'a@x.com')
    assert.equal(mac, (await import('node:crypto')).createHmac('sha256', key).update(`${e}.${exp}`).digest('base64url'), 'signed with this box\'s key')
    assert.equal((await go(at(capable), '/deny', { cookie: 'dsh-auth-x=1' })).status, 401, 'a member 401 is not turned into an owner launch')
    const old = await go(at(legacy))
    assert.equal(old.headers.location, '/?token=OWNER', 'a box without the member plugin keeps the launch flow, at /')
  } finally { server.close(); upstream.close() }
})

test('relay to a member-capable box sends the member header and no owner sign-in', async () => {
  const { projectRelay } = await import('./projects.mjs')
  const { boxFetcher, boxSite } = await import('./edge.mjs')
  const seen = []
  const upstream = createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c
    seen.push({ path: req.url, headers: req.headers })
    const value = JSON.parse(body).method === 'session/create' ? { sessionId: 'S' } : { accepted: true }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ result: { ok: true, value } }))
  })
  const c = { ...cfg, proxy: new URL(`http://127.0.0.1:${await listen(upstream)}`) }
  const store = memoryStore()
  const proj = projectStore({ store, admitted: () => true, log: () => {} })
  const { id } = await proj.create('a@x.com', 'P')
  const box = { ensure: async () => ({ id: 'pbox', token: 'OWNER', member: (e) => `hdr-for-${e}` }) }
  const relay = projectRelay({ store, projects: proj, box, boxFetch: boxFetcher(c), siteHostOf: (p) => boxSite(c, p).host, log: () => {} })
  try {
    await relay.message('a@x.com', id, 'hi')
    assert.deepEqual(seen.map(s => s.path), ['/api/session/create', '/api/session/prompt'], 'no owner sign-in')
    for (const { headers: h } of seen) {
      assert.equal(h['x-mumbo-member'], 'hdr-for-a@x.com')
      assert.equal(h.cookie, undefined)
      assert.equal(h.origin, `https://p-${id}.boxes.example`, 'the origin of the project\'s own host')
      assert.equal(h['e2b-sandbox-id'], 'pbox')
    }
  } finally { upstream.close() }
})

test('the sign-in cookie never reaches a box, and boxes cannot set parent-domain cookies', () => {
  const h = boxHeaders(cfg, { cookie: '_oauth2_proxy_mumbo=a; _oauth2_proxy_mumbo_1=b; _oauth2_proxy=c; dsh-auth-x=d' }, { id: 'b' })
  assert.equal(h.cookie, 'dsh-auth-x=d')
  const only = boxHeaders(cfg, { cookie: '_oauth2_proxy_mumbo_0=a; _oauth2_proxy_mumbo_1=b; _oauth2_proxy_mumbo_0f3a_csrf=c; _oauth2_proxy=d' }, { id: 'b' })
  assert.equal('cookie' in only, false, 'no cookie header when only sign-in cookies were sent')
  assert.equal(boxHeaders(cfg, { cookie: 'dsh-auth-x=_oauth2_proxy_mumbo; _oauth2_proxy_mumbo=a' }, { id: 'b' }).cookie, 'dsh-auth-x=_oauth2_proxy_mumbo', 'matched by name, not value')
  assert.equal(boxHeaders({ publicHost: 'boxes.example' }, { cookie: '_oauth2_proxy_mumbo=a; undefined=1' }, { id: 'b' }).cookie, 'undefined=1', 'a cfg without signinCookie uses the default name, not "undefined"')
  // A configured name outside the _oauth2_proxy prefix is dropped in requests and in box Set-Cookie alike.
  const custom = { ...cfg, signinCookie: '_custom' }
  assert.equal(boxHeaders(custom, { cookie: '_custom=a; _custom_1=b; _oauth2_proxy=c; x=1' }, { id: 'b' }).cookie, 'x=1')
  assert.deepEqual(secureCookies(custom, { 'set-cookie': ['_custom=a; Path=/', '_custom_x_csrf=b', 'x=1'] })['set-cookie'], ['x=1; Secure'])
  assert.equal('set-cookie' in secureCookies(custom, { 'set-cookie': ['_custom=a'] }), false, 'no Set-Cookie when only sign-in names were set')
  const out = secureCookies(cfg, { 'set-cookie': ['s=1; Domain=.boxes.mumbo.si; Path=/', 't=2; path=/; domain=boxes.mumbo.si; HttpOnly'] })['set-cookie']
  assert.deepEqual(out, ['s=1; Path=/; Secure', 't=2; path=/; HttpOnly; Secure'])
})

test('model host: a client that drops mid-stream cancels the upstream and the metered stream charges', async () => {
  const { tokenBudget } = await import('./budget.mjs')
  const store = memoryStore()
  const tokens = tokenBudget({ store, limits: { user: 1e9, project: 1e9 }, now: () => Date.parse('2026-11-09T12:00:00Z') })
  const enc = new TextEncoder()
  const ev = (o) => enc.encode(`data: ${JSON.stringify(o)}\n\n`)
  let cancelled = false
  const fetchImpl = async () => new Response(new ReadableStream({
    start(c) { c.enqueue(ev({ type: 'message_start', message: { usage: { input_tokens: 100 } } })) },
    cancel() { cancelled = true },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  const s = modelServer({ cfg, edgeKey: 'k', modelKey: 'SERVER', owns: async () => true, touch: () => {}, fetchImpl, log: () => {}, allow: async () => true, tokens })
  const port = await listen(s)
  try {
    await new Promise((resolve, reject) => {
      const r = request({ port, method: 'POST', path: '/anthropic/v1/messages', headers: { 'x-api-key': signBox('k', 'a@x.com', 'b1') } }, (res) => res.once('data', () => { r.destroy(); resolve() }))
      r.on('error', () => {}); r.end('{}')
    })
    for (let i = 0; i < 50 && !cancelled; i++) await new Promise((r) => setTimeout(r, 20))
    assert.equal(cancelled, true, 'upstream stream cancelled')
    assert.equal(await store.getCount('tokens:2026-11-09:a@x.com'), 100)
  } finally { s.close() }
})

test('capacity counts a box at 2 units and a running child at 1, and refuses past the limit', async () => {
  const { runningUnits, atCapacity, UNITS } = await import('./capacity.mjs')
  const list = (items) => ({ Sandbox: { list: () => { let more = true; return { get hasNext() { return more }, nextItems: async () => { more = false; return items } } } } })
  const e2b = list([{ metadata: { user: 'a@x.com' } }, { metadata: { user: 'project:p' } }, { metadata: { owner: 'a@x.com' } }, { metadata: { owner: 'a@x.com' } }])
  assert.equal(await runningUnits(e2b), 6)
  assert.equal(await atCapacity(e2b, { maxRunningUnits: 7 }, UNITS.child), false)
  assert.equal(await atCapacity(e2b, { maxRunningUnits: 7 }, UNITS.box), true)
  assert.equal(await atCapacity(e2b, { maxRunningUnits: 0 }, UNITS.box), false, '0 is no cap')
})

test('child creation goes through the same unit cap', async () => {
  const { children } = await import('./sandboxes.mjs')
  const running = [{ metadata: { user: 'a@x.com' } }, { metadata: { user: 'b@x.com' } }, { metadata: { owner: 'b@x.com' } }]  // 5 units
  const created = []
  const e2b = { Sandbox: {
    list: ({ query }) => { let more = true; return { get hasNext() { return more }, nextItems: async () => { more = false; return running.filter(s => !query.metadata || s.metadata.owner === query.metadata.owner) } } },
    create: async (t, o) => { created.push(t); running.push({ metadata: o.metadata }); return { sandboxId: 'c' + created.length } },
  } }
  const ops = children({ e2b, cfg: { childTemplates: ['mumbo-child'], maxChildren: 10, maxRunningUnits: 7 }, log: () => {} })
  await ops.create('a@x.com', 'p'); await ops.create('a@x.com', 'p')  // 6 then 7 units
  await assert.rejects(ops.create('a@x.com', 'p'), /capacity/)
  assert.equal(created.length, 2)
})

test('a box create at 6 of 7 units is refused: it weighs 2, not the child weight of 1', async () => {
  const e2b = fakeE2B()
  e2b.Sandbox.list = ({ query }) => { let more = true; return { get hasNext() { return more }, nextItems: async () => { more = false; return query.metadata ? [] : [{ metadata: { user: 'b@x.com' } }, { metadata: { user: 'c@x.com' } }, { metadata: { user: 'd@x.com' } }] } } }
  const b = boxes({ e2b, store: memoryStore(), cfg: { ...cfg, maxRunningUnits: 7 }, edgeKey: 'k', presignGet: async () => undefined, presignPut: async () => 'P', log: () => {} })
  await assert.rejects(b.ensure('a@x.com'), /capacity/)
})

test('a !address entry denies exactly that address, before any allow match', () => {
  const list = ['@mumbo.si', '!a@mumbo.si']
  assert.equal(admitted(list, 'a@mumbo.si'), false)
  assert.equal(admitted(['@mumbo.si', '!A@mumbo.si'], 'a@mumbo.si'), false, 'a mixed-case entry still denies')
  assert.equal(admitted(list, 'A@Mumbo.si'), false)
  assert.ok(admitted(list, 'aa@mumbo.si'), 'a longer local part is not denied')
  assert.ok(admitted(list, 'b@mumbo.si'))
  assert.equal(admitted(['!a@mumbo.si', 'a@mumbo.si'], 'a@mumbo.si'), false, 'order does not matter')
})
