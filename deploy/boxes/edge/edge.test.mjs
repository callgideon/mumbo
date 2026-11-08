// node --test deploy/boxes/edge/edge.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { request } from 'node:http'
import { signBox, verifyBox, userPrefix, budget, needsLaunch, boxHeaders, boxes, modelServer, userServer, startScript, backupCommand, admitted, secureCookies, albIdentity } from './edge.mjs'
import { memoryStore, redisStore } from './store.mjs'
import { generateKeyPairSync, createSign } from 'node:crypto'

const cfg = { publicHost: 'boxes.example', llmHost: 'llm.example', template: 'mumbo-box', idleMs: 60_000, backupEveryMs: 600_000, maxRunning: 5, allowed: ['@x.com'], egressIps: [], proxy: new URL('http://127.0.0.1:1'), upstream: 'https://model.example' }
const listen = (server) => new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port)))
const call = (port, { method = 'GET', path = '/', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
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

test('cookies from the box get Secure', () => {
  assert.deepEqual(secureCookies({ 'set-cookie': ['a=1; Path=/', 'b=2; Secure'] })['set-cookie'], ['a=1; Path=/; Secure', 'b=2; Secure'])
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
  const b = boxes({ e2b, store: memoryStore(), cfg: { ...cfg, maxRunning: 1 }, edgeKey: 'k', presignGet: async () => undefined, presignPut: async () => 'P', log: () => {} })
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
