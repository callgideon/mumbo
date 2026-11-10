// node --test: door keys (B31). The format and checksum are jumbo's (vectors from its key_format.checksum with the mumbo
// prefix); the store holds only hashes; verify refuses with jumbo's codes; the home page's key manager mints, lists and
// revokes only the signed-in person's own keys, behind Origin, navigation and CSRF checks, and shows a new key once.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash, createHmac } from 'node:crypto'
import { request } from 'node:http'
import { checksum, doorKeys, generateKey, isKey, keyHash, keyManager, PREFIX } from './keys.mjs'
import { signBox, userServer } from './edge.mjs'
import { memoryStore } from './store.mjs'
import { projects } from './projects.mjs'

const A = 'a@x.com', B = 'b@x.com'
const NOW = Date.parse('2026-11-10T12:00:00Z')
const DAY = 86_400_000
const HOST = 'boxes.mumbo.si'
const CSRF_KEY = Buffer.from('h'.repeat(32))
const VECTOR = `${PREFIX}0123456789ABCDEFGHIJKLMNOPQRSTUV3nCqy1`
const HOSTILE = '"><script>alert(1)</script><b x=\''

/** A memory store that records every value written. */
function recording() {
  const store = memoryStore(), written = []
  return { written, store: { ...store,
    putDoc: (k, v) => { written.push(k, v); return store.putDoc(k, v) },
    addToSet: (k, m) => { written.push(k, m); return store.addToSet(k, m) } } }
}
/** The key service over a project store where A owns P and B owns Q; `at` moves the clock, `allowed` is the allowlist. */
async function setup(store = memoryStore()) {
  const proj = projects({ store, admitted: () => true, log: () => {} })
  const P = (await proj.create(A, 'Mine')).id, Q = (await proj.create(B, 'Theirs')).id
  let now = NOW
  const allowed = new Set([A, B])
  const keys = doorKeys({ store, projects: proj, admitted: (e) => allowed.has(e), now: () => now, log: () => {} })
  return { store, proj, keys, P, Q, allowed, at: (ms) => { now = ms } }
}

test('a key is mumbo_pat_, 32 base62 characters and their base62 CRC32, as jumbo computes it', () => {
  // jumbo key_format.checksum with PREFIX set to 'mumbo_pat_' (python3 -I); the last one is padded with a leading '0'.
  for (const [body, sum] of [['0123456789ABCDEFGHIJKLMNOPQRSTUV', '3nCqy1'], ['z'.repeat(32), '1rRjEm'], [`${'a'.repeat(31)}1`, '0vgSqX']]) {
    assert.equal(checksum(body), sum)
    assert.ok(isKey(PREFIX + body + sum))
  }
  const made = new Set(Array.from({ length: 200 }, generateKey))
  assert.equal(made.size, 200)
  for (const k of made) { assert.match(k, /^mumbo_pat_[0-9A-Za-z]{38}$/); assert.ok(isKey(k)) }
})

test('isKey refuses a flipped character, a wrong length, a wrong prefix and anything not a string', () => {
  const flip = (i) => VECTOR.slice(0, i) + (VECTOR[i] === 'A' ? 'B' : 'A') + VECTOR.slice(i + 1)
  for (const i of [10, 25, 41, 42, 47]) assert.equal(isKey(flip(i)), false, `flipped at ${i}`)
  assert.equal(isKey(VECTOR.slice(0, -1)), false)
  assert.equal(isKey(`${VECTOR}A`), false)
  assert.equal(isKey('jumbo_pat_0123456789ABCDEFGHIJKLMNOPQRSTUV0YWqe1'), false, 'a valid jumbo key (its own checksum)')
  assert.equal(isKey(`Mumbo_pat_${VECTOR.slice(10)}`), false)
  assert.equal(isKey(`${VECTOR.slice(0, 20)}-${VECTOR.slice(21)}`), false, 'not base62')
  for (const v of [undefined, null, 42, {}, '']) assert.equal(isKey(v), false)
})

test('the store holds only the SHA-256 of a key; list shows neither the key nor its hash', async () => {
  const { store, written } = recording()
  const t = await setup(store)
  const { key, record } = await t.keys.mint(A, { name: 'laptop', scopes: ['read'] })
  const hash = createHash('sha256').update(key).digest('hex')
  assert.equal(keyHash(key), hash)
  assert.deepEqual(await store.getDoc(`key:${hash}`), record)
  assert.deepEqual(await store.setMembers(`keys:${A}`), [hash])
  await t.keys.verify(key)
  const all = JSON.stringify(written)
  assert.ok(!all.includes(key.slice(10, 42)), 'neither the key nor its random part is ever written')
  const listed = JSON.stringify(await t.keys.list(A))
  assert.ok(!listed.includes(key.slice(10, 42)) && !listed.includes(hash))
})

test('verify refuses with jumbo\'s codes, and checks the format before any store read', async () => {
  const t = await setup()
  const reads = [], getDoc = t.store.getDoc
  t.store.getDoc = (k) => { reads.push(k); return getDoc(k) }
  await assert.rejects(t.keys.verify(signBox('k', A, 'box1')), { status: 403, code: 'user_key_required' }, 'a person box token (the assistant)')
  await assert.rejects(t.keys.verify(signBox('k', `project:${t.P}`, 'box2')), { status: 403, code: 'user_key_required' }, 'a project box token (a coordinator)')
  for (const bad of [undefined, '', `Bearer ${VECTOR}`, 'mumbo_pat_short', `${VECTOR.slice(0, -1)}2`]) await assert.rejects(t.keys.verify(bad), { status: 401, code: 'invalid_api_key' }, String(bad))
  assert.deepEqual(reads, [], 'no store read before the format and checksum pass')
  await assert.rejects(t.keys.verify(generateKey()), { status: 401, code: 'invalid_api_key' }, 'well formed, never minted')
  assert.equal(reads.length, 1)
  const { key, record } = await t.keys.mint(A, { name: 'k', scopes: ['read'] })
  assert.equal((await t.keys.verify(key)).id, record.id)
  t.keys.requireScope(record, 'read')
  assert.throws(() => t.keys.requireScope(record, 'prompt'), { status: 403, code: 'insufficient_scope' })
  t.allowed.delete(A)
  await assert.rejects(t.keys.verify(key), { status: 403, code: 'user_disabled' }, 'the owner is off the allowlist')
  t.allowed.add(A)
  await t.keys.revoke(A, record.id)
  await assert.rejects(t.keys.verify(key), { status: 401, code: 'key_revoked' })
})

test('a key expires exactly at expiresAt; a key without a lifetime never does', async () => {
  const t = await setup()
  const { key, record } = await t.keys.mint(A, { name: 'week', scopes: ['read'], expiresInDays: 7 })
  assert.equal(record.expiresAt, NOW + 7 * DAY)
  t.at(record.expiresAt - 1)
  await t.keys.verify(key)
  t.at(record.expiresAt)
  await assert.rejects(t.keys.verify(key), { status: 401, code: 'key_expired' })
  t.at(NOW)
  const forever = await t.keys.mint(A, { name: 'forever', scopes: ['read'] })
  assert.equal(forever.record.expiresAt, undefined)
  t.at(NOW + 3650 * DAY)
  await t.keys.verify(forever.key)
})

test('a revoked key fails on the very next call; list keeps it with its last use and first revocation time', async () => {
  const t = await setup()
  const { key, record } = await t.keys.mint(A, { name: 'k', scopes: ['read'] })
  t.at(NOW + 1000)
  await t.keys.verify(key)
  t.at(NOW + 2000)
  await t.keys.revoke(A, record.id)
  await assert.rejects(t.keys.verify(key), { code: 'key_revoked' })
  t.at(NOW + 3000)
  await t.keys.revoke(A, record.id)
  const [listed] = await t.keys.list(A)
  assert.deepEqual([listed.lastUsedAt, listed.revokedAt], [NOW + 1000, NOW + 2000])
})

test('mint takes a name, known scopes, an offered lifetime and only projects the owner is a member of', async () => {
  const t = await setup()
  for (const [what, input] of [['no name', { name: ' ', scopes: ['read'] }], ['a long name', { name: 'n'.repeat(81), scopes: ['read'] }],
    ['no scope', { name: 'k', scopes: [] }], ['an unknown scope', { name: 'k', scopes: ['read', 'model'] }], ['3 days', { name: 'k', scopes: ['read'], expiresInDays: 3 }]]) {
    await assert.rejects(t.keys.mint(A, input), { status: 400 }, what)
  }
  await assert.rejects(t.keys.mint(A, { name: 'k', scopes: ['read'], projects: [t.P, t.Q] }), { status: 403, code: 'not_a_member' }, 'B\'s project')
  await assert.rejects(t.keys.mint(A, { name: 'k', scopes: ['read'], projects: ['0000000000000000'] }), { status: 403 }, 'no such project')
  assert.deepEqual(await t.keys.list(A), [], 'nothing minted')
  const { key } = await t.keys.mint(A, { name: ' k ', scopes: ['workspace', 'read', 'read'], projects: [t.P, t.P] })
  const k = await t.keys.verify(key)
  assert.deepEqual([k.name, k.scopes, k.projects], ['k', ['read', 'workspace'], [t.P]])
  await t.keys.requireProject(k, t.P)
  await assert.rejects(t.keys.requireProject(k, t.Q), { status: 403, code: 'project_not_allowed' })
  // The owner leaves the project after the mint (projects.mjs has no removal yet, so the doc is edited).
  const p = await t.store.getDoc(`project:${t.P}`)
  await t.store.putDoc(`project:${t.P}`, { ...p, members: [] })
  await assert.rejects(t.keys.requireProject(k, t.P), { status: 403, code: 'project_not_allowed' })
})

test('nobody lists or revokes another person\'s key', async () => {
  const t = await setup()
  const { key, record } = await t.keys.mint(A, { name: 'k', scopes: ['read'] })
  assert.deepEqual(await t.keys.list(B), [])
  await assert.rejects(t.keys.revoke(B, record.id), { status: 404, code: 'not_found' })
  await t.keys.verify(key)
})

// ---- the key manager on /home, through userServer
const listen = (server) => new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port)))
const call = (port, { method = 'GET', path = '/home', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const all = Object.fromEntries(Object.entries({ host: HOST, 'x-forwarded-email': A, ...headers, ...(body === undefined ? {} : { 'content-length': Buffer.byteLength(body) }) }).filter(([, v]) => v !== undefined))
  const req = request({ host: '127.0.0.1', port, method, path, headers: all }, (res) => {
    let text = ''; res.setEncoding('utf8'); res.on('data', c => { text += c }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }))
  })
  req.on('error', reject)
  req.end(body)
})
/** A form POST as the browser sends it from the home page. */
const NAV = { origin: `https://${HOST}`, 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }
const post = (port, path, fields, headers = {}) => call(port, { method: 'POST', path, headers: { ...NAV, ...headers }, body: new URLSearchParams(fields).toString() })
const csrfOf = (html) => /name="csrf" value="([^"]+)"/.exec(html)[1]
const keyIn = (html) => /<code>(mumbo_pat_[0-9A-Za-z]{38})<\/code>/.exec(html)?.[1]

async function site(projectName) {
  const t = await setup()
  if (projectName) t.H = (await t.proj.create(A, projectName)).id
  const cfg = { publicHost: HOST, projectDomain: HOST, approveHost: `approve.${HOST}`, allowed: ['@x.com'], signinCookie: '_oauth2_proxy_mumbo', proxy: new URL('http://127.0.0.1:1') }
  const box = { ensure: async () => assert.fail('the key manager starts no box'), touch: async () => {}, forget: async () => {}, firstSetUp: async () => false }
  const server = userServer({ cfg, box, projects: t.proj, keys: keyManager({ cfg, keys: t.keys, csrfKey: CSRF_KEY, now: () => NOW }), log: () => {} })
  return { ...t, port: await listen(server), close: () => server.close() }
}

test('home: a person creates a key, sees it once, finds it listed and revokes it', async () => {
  const t = await site()
  try {
    const home = await call(t.port)
    assert.equal(home.status, 200)
    assert.deepEqual([home.headers['x-frame-options'], home.headers['cross-origin-opener-policy'], home.headers['cache-control']], ['DENY', 'same-origin', 'no-store'])
    assert.match(home.headers['content-security-policy'], /^default-src 'none';.*frame-ancestors 'none'/)
    assert.match(home.body, new RegExp(`<input type="checkbox" name="project" value="${t.P}"> Mine</label>`))
    assert.ok(!home.body.includes(t.Q), 'another person\'s project is not offered')
    const csrf = csrfOf(home.body)
    const made = await post(t.port, '/home/keys', [['csrf', csrf], ['name', 'laptop Claude Code'], ['scope', 'read'], ['scope', 'prompt'], ['project', t.P], ['expires', '30']])
    assert.deepEqual([made.status, made.headers['cache-control'], made.headers['x-frame-options']], [200, 'no-store', 'DENY'])
    const key = keyIn(made.body)
    assert.ok(isKey(key))
    assert.equal(made.body.split(key.slice(10)).length, 2, 'the key appears once')
    assert.match(made.body, /Copy it now: it is not shown again\./)
    const k = await t.keys.verify(key)
    assert.deepEqual([k.owner, k.name, k.scopes, k.projects, k.expiresAt], [A, 'laptop Claude Code', ['read', 'prompt'], [t.P], NOW + 30 * DAY])
    const again = await call(t.port)
    assert.ok(!again.body.includes(key.slice(10)) && keyIn(again.body) === undefined, 'never shown again')
    assert.match(again.body, /<strong>laptop Claude Code<\/strong> <small>read, prompt · projects: Mine · created 2026-11-10 12:00 UTC · expires 2026-12-10 12:00 UTC · last used 2026-11-10 12:00 UTC<\/small><form method="post" action="\/home\/keys\/revoke">/)
    const revoked = await post(t.port, '/home/keys/revoke', { id: k.id, csrf })
    assert.deepEqual([revoked.status, revoked.headers.location], [303, '/home'])
    await assert.rejects(t.keys.verify(key), { code: 'key_revoked' })
    const after = (await call(t.port)).body
    assert.match(after, /· revoked 2026-11-10 12:00 UTC<\/small><\/li>/)
    assert.ok(!after.includes('action="/home/keys/revoke"'), 'a revoked key has no Revoke button')
  } finally { t.close() }
})

test('home: a create or revoke without the exact origin, a form navigation, a form body or the person\'s own CSRF token changes nothing', async () => {
  const t = await site()
  try {
    const csrf = csrfOf((await call(t.port)).body)
    const { record } = await t.keys.mint(A, { name: 'kept', scopes: ['read'] })
    const other = (key, email) => createHmac('sha256', key).update(`${email}:2026-11-10`).digest('base64url')
    const fields = { csrf, name: 'x', scope: 'read' }
    const cases = [
      ['no Origin', fields, { origin: undefined }, 403], ['another site', fields, { origin: 'https://evil.example' }, 403],
      ['plain http', fields, { origin: `http://${HOST}` }, 403], ['a project host', fields, { origin: `https://p-${t.P}.${HOST}` }, 403],
      ['a fetch', fields, { 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' }, 403], ['a frame', fields, { 'sec-fetch-dest': 'iframe' }, 403],
      ['no Sec-Fetch headers', fields, { 'sec-fetch-mode': undefined, 'sec-fetch-dest': undefined }, 403],
      ['no token', { name: 'x', scope: 'read' }, {}, 403], ['B\'s token', { ...fields, csrf: other(CSRF_KEY, B) }, {}, 403],
      ['the approve page\'s token', { ...fields, csrf: other(Buffer.from('k'.repeat(32)), A) }, {}, 403],
      ['JSON', fields, { 'content-type': 'application/json' }, 415],
    ]
    for (const [what, body, headers, status] of cases) {
      assert.equal((await post(t.port, '/home/keys', body, headers)).status, status, `create: ${what}`)
      assert.equal((await post(t.port, '/home/keys/revoke', { ...body, id: record.id }, headers)).status, status, `revoke: ${what}`)
    }
    assert.equal((await call(t.port, { path: '/home/keys' })).status, 405)
    const listed = await t.keys.list(A)
    assert.deepEqual(listed.map(k => [k.name, k.revokedAt]), [['kept', undefined]])
  } finally { t.close() }
})

test('home: another person sees none of a person\'s keys and cannot revoke one', async () => {
  const t = await site()
  try {
    const { key, record } = await t.keys.mint(A, { name: 'a-only', scopes: ['read'] })
    const page = await call(t.port, { headers: { 'x-forwarded-email': B } })
    assert.ok(!page.body.includes('a-only') && !page.body.includes(record.id))
    const r = await post(t.port, '/home/keys/revoke', { id: record.id, csrf: csrfOf(page.body) }, { 'x-forwarded-email': B })
    assert.equal(r.status, 404)
    await t.keys.verify(key)
  } finally { t.close() }
})

test('home: a hostile key or project name is escaped; bad input is refused with its reason', async () => {
  const t = await site(HOSTILE)
  try {
    const csrf = csrfOf((await call(t.port)).body)
    const made = await post(t.port, '/home/keys', [['csrf', csrf], ['name', HOSTILE], ['scope', 'read'], ['project', t.H]])
    assert.equal(made.status, 200)
    for (const html of [made.body, (await call(t.port)).body]) {
      assert.ok(!html.includes('<script>') && !html.includes(HOSTILE), 'no raw hostile text')
      assert.ok(html.includes('&#34;&#62;&#60;script&#62;alert(1)&#60;/script&#62;&#60;b x=&#39;'))
    }
    const none = await post(t.port, '/home/keys', { csrf, name: 'x' })
    assert.deepEqual([none.status, none.body], [400, 'A key needs one or more of the scopes read, prompt, workspace.'])
    assert.equal((await post(t.port, '/home/keys', [['csrf', csrf], ['name', 'x'], ['scope', 'read'], ['project', t.Q]])).status, 403)
    assert.equal((await post(t.port, '/home/keys', [['csrf', csrf], ['name', 'x'], ['scope', 'read'], ['expires', '2']])).status, 400)
  } finally { t.close() }
})
