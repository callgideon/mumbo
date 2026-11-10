// node --test: a project box is served at the root of its own origin, p-<16 hex>.<project domain>, end to end through
// userServer with a fake box behind the client-proxy address. Members reach it as themselves; nothing on that host
// reaches the founder's box, /home or the approve page; the old /p/<id>/ path redirects there.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHmac } from 'node:crypto'
import { createServer, request } from 'node:http'
import { config, userServer, memberKey, memberHeader, boxSite, roleInstructions } from './edge.mjs'
import { memoryStore } from './store.mjs'
import { projects } from './projects.mjs'

const listen = (server) => new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port)))
const call = (port, { method = 'GET', path = '/', headers = {} } = {}) => new Promise((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port, method, path, headers: { 'x-forwarded-email': 'a@x.com', accept: 'text/html', ...headers } }, (res) => {
    let body = ''; res.on('data', c => { body += c }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
  })
  req.on('upgrade', (res, socket) => { socket.destroy(); resolve({ upgraded: true, headers: res.headers }) })
  req.on('error', (e) => (headers.upgrade ? resolve({ error: e.code ?? e.message }) : reject(e)))
  req.end()
})
const upgrade = { connection: 'Upgrade', upgrade: 'websocket' }
/** The email a member header names, after checking its MAC against the project box's key. */
const memberOf = (key, header) => {
  const [e, exp, mac] = header.split('.')
  assert.equal(mac, createHmac('sha256', key).update(`${e}.${exp}`).digest('base64url'))
  return Buffer.from(e, 'base64url').toString()
}

/** userServer over a fake box; `extra` overrides the config. */
async function setup(extra = {}) {
  const seen = []
  const fakeBox = createServer((req, res) => {
    seen.push({ method: req.method, path: req.url, headers: req.headers })
    // Two paths send the box's own frame policy: a complete one, and a CSP without frame-ancestors.
    const policy = { '/own-policy': { 'content-security-policy': "default-src 'self'; frame-ancestors 'none'", 'x-frame-options': 'DENY' }, '/csp': { 'content-security-policy': "default-src 'self'" } }[req.url]
    res.writeHead(req.url === '/deny' ? 401 : 200, { 'set-cookie': ['dsh-auth-p=1; Domain=.boxes.mumbo.si; Path=/; HttpOnly'], ...policy }).end('from box')
  })
  fakeBox.on('upgrade', (req, socket) => {
    seen.push({ path: req.url, headers: req.headers })
    socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
  })
  const cfg = { publicHost: 'boxes.mumbo.si', projectDomain: 'boxes.mumbo.si', approveHost: 'approve.boxes.mumbo.si', allowed: ['@x.com'], signinCookie: '_oauth2_proxy_mumbo', ...extra, proxy: new URL(`http://127.0.0.1:${await listen(fakeBox)}`) }
  const proj = projects({ store: memoryStore(), admitted: () => true, log: () => {} })
  const { id } = await proj.create('a@x.com', 'P')
  const key = memberKey('k', 'pbox')
  const ensured = []; const approved = []
  const box = {
    // Both boxes were created under boxes.mumbo.si, so that is their masked host (boxSite at creation).
    ensure: async (p) => { ensured.push(p); return p === `project:${id}` ? { id: 'pbox', token: 'OWNER', host: `p-${id}.boxes.mumbo.si`, member: (e) => memberHeader(key, e) } : { id: 'ubox', token: 'T', host: 'boxes.mumbo.si' } },
    touch: async () => {}, forget: async () => {},
  }
  const approve = async (req, res) => { approved.push(req.url); res.writeHead(200).end('approve page') }
  const server = userServer({ cfg, box, projects: proj, approve, log: () => {} })
  const port = await listen(server)
  return { id, key, seen, ensured, approved, port, host: `p-${id}.${cfg.projectDomain}`, close: () => { server.close(); fakeBox.close() } }
}

test('a member on p-<id>.<project domain> reaches the project box at /, as themselves, without the sign-in cookie', async () => {
  const t = await setup()
  try {
    const r = await call(t.port, { headers: { host: `P-${t.id}.Boxes.Mumbo.Si:443`, cookie: '_oauth2_proxy_mumbo=s; _oauth2_proxy_mumbo_1=s; _oauth2_proxy=s; dsh-auth-p=1', 'x-mumbo-member': 'forged' } })
    assert.equal(r.status, 200, 'no owner launch redirect for a member')
    assert.equal(r.body, 'from box')
    assert.deepEqual(r.headers['set-cookie'], ['dsh-auth-p=1; Path=/; HttpOnly; Secure'], 'the box cookie stays host-only')
    const got = t.seen[0]
    assert.equal(got.path, '/')
    assert.equal(got.headers['e2b-sandbox-id'], 'pbox')
    assert.equal(got.headers.cookie, 'dsh-auth-p=1')
    assert.equal(memberOf(t.key, got.headers['x-mumbo-member']), 'a@x.com')
    assert.equal((await call(t.port, { path: '/deny', headers: { host: t.host } })).status, 401, 'a member 401 is not turned into an owner launch')
    assert.deepEqual(t.ensured, [`project:${t.id}`, `project:${t.id}`])
  } finally { t.close() }
})

test('a non-member on a project host gets 403 and never starts the project box', async () => {
  const t = await setup()
  try {
    const r = await call(t.port, { headers: { host: t.host, 'x-forwarded-email': 'b@x.com' } })
    assert.equal(r.status, 403)
    assert.deepEqual(t.ensured, [])
    assert.equal(t.seen.length, 0)
  } finally { t.close() }
})

test('/p/<id>/… on the main host answers 302 to the project origin, starting no box', async () => {
  const t = await setup()
  try {
    const r = await call(t.port, { path: `/p/${t.id}/x?y=1`, headers: { host: 'boxes.mumbo.si' } })
    assert.equal(r.status, 302)
    assert.equal(r.headers.location, `https://p-${t.id}.boxes.mumbo.si/x?y=1`)
    assert.equal((await call(t.port, { path: `/p/${t.id}`, headers: { host: 'boxes.mumbo.si' } })).headers.location, `https://p-${t.id}.boxes.mumbo.si/`)
    assert.deepEqual(t.ensured, [])
  } finally { t.close() }
})

test('on a project host, /home and the approve page\'s paths go to the project box, never the founder\'s', async () => {
  const t = await setup()
  try {
    for (const path of ['/home', '/', '/desktop/']) assert.equal((await call(t.port, { path, headers: { host: t.host } })).body, 'from box')
    assert.deepEqual(t.seen.map(s => [s.path, s.headers['e2b-sandbox-id'], s.headers['e2b-sandbox-port']]), [['/home', 'pbox', '3080'], ['/', 'pbox', '3080'], ['/desktop/', 'pbox', '3080']])
    assert.ok(t.ensured.every(p => p === `project:${t.id}`))
    assert.deepEqual(t.approved, [])
  } finally { t.close() }
})

test('a WebSocket upgrade on a project host reaches the project box with a fresh member header; a non-member\'s is refused', async () => {
  const t = await setup()
  try {
    const own = `https://${t.host}`
    const ws = await call(t.port, { path: '/api/remote.mux', headers: { host: t.host, origin: own, cookie: '_oauth2_proxy_mumbo=s; _oauth2_proxy=s', 'x-mumbo-member': 'forged', ...upgrade } })
    assert.ok(ws.upgraded, JSON.stringify(ws))
    const got = t.seen[0]
    assert.equal(got.path, '/api/remote.mux')
    assert.equal(got.headers['e2b-sandbox-id'], 'pbox')
    assert.equal(got.headers.cookie, undefined)
    assert.equal(memberOf(t.key, got.headers['x-mumbo-member']), 'a@x.com')
    assert.ok((await call(t.port, { headers: { host: t.host, origin: own, 'x-forwarded-email': 'b@x.com', ...upgrade } })).error)
    assert.equal(t.seen.length, 1)
  } finally { t.close() }
})

test('an HTTP request from Origin: https://boxes.mumbo.si reaches the project box with that Origin unchanged', async () => {
  const t = await setup()
  try {
    await call(t.port, { headers: { host: t.host, origin: 'https://boxes.mumbo.si' } })
    assert.deepEqual(t.seen.map(s => s.headers.origin), ['https://boxes.mumbo.si'])
  } finally { t.close() }
})

test('on app.mumbo.si, boxes masked as boxes.mumbo.si get a same-origin Origin as their own; foreign Origins, no Origin and Sec-Fetch-Site pass unchanged', async () => {
  const t = await setup({ publicHost: 'app.mumbo.si', projectDomain: 'app.mumbo.si', approveHost: 'approve.app.mumbo.si' })
  const main = 'app.mumbo.si', oldUser = 'https://boxes.mumbo.si', oldProject = `https://p-${t.id}.boxes.mumbo.si`
  const post = (host, headers) => call(t.port, { method: 'POST', path: '/api/x', headers: { host, cookie: 'dsh-auth-x=1', ...headers } })
  try {
    assert.equal((await post(main, { origin: `https://${main}`, 'sec-fetch-site': 'same-origin' })).body, 'from box', 'a same-origin POST reaches dsh')
    await post(t.host, { origin: `https://${t.host}`, 'sec-fetch-site': 'same-origin' })
    assert.ok((await call(t.port, { path: '/api/remote.mux', headers: { host: main, origin: `https://${main}`, ...upgrade } })).upgraded)
    assert.ok((await call(t.port, { path: '/api/remote.mux', headers: { host: t.host, origin: `https://${t.host}`, ...upgrade } })).upgraded)
    // A project page posting to the founder's box keeps its own Origin, which that box's dsh refuses (not its masked host).
    await post(main, { origin: `https://${t.host}`, 'sec-fetch-site': 'same-site' })
    await post(main, {})
    await post(main, { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' })
    assert.deepEqual(t.seen.map(s => [s.headers['e2b-sandbox-id'], s.headers.origin, s.headers['sec-fetch-site']]), [
      ['ubox', oldUser, 'same-origin'], ['pbox', oldProject, 'same-origin'], ['ubox', oldUser, undefined], ['pbox', oldProject, undefined],
      ['ubox', `https://${t.host}`, 'same-site'], ['ubox', undefined, undefined], ['ubox', 'https://evil.example', 'cross-site'],
    ])
  } finally { t.close() }
})

test('on app.mumbo.si, the URLs the former-host redirects send to (marker query first) reach the same pages', async () => {
  const t = await setup({ publicHost: 'app.mumbo.si', projectDomain: 'app.mumbo.si', approveHost: 'approve.app.mumbo.si' })
  const main = 'app.mumbo.si'
  try {
    assert.equal((await call(t.port, { path: '/?moved=1&', headers: { host: main } })).headers.location, '/?token=T', 'the launch exchange')
    assert.match((await call(t.port, { path: '/desktop/?moved=1&', headers: { host: main } })).headers.location, /^\/desktop\/vnc\.html\?/)
    assert.match((await call(t.port, { path: '/home?moved=1&', headers: { host: main } })).body, /<h1>mumbo<\/h1>/)
    for (const [path, to] of [[`/p/${t.id}/x?moved=1&`, '/x?moved=1&'], [`/p/${t.id}?moved=1&`, '/?moved=1&'], [`/p/${t.id}?moved=1&a=b`, '/?moved=1&a=b'], [`/p/${t.id}/?moved=1&a=b`, '/?moved=1&a=b']]) {
      assert.equal((await call(t.port, { path, headers: { host: main } })).headers.location, `https://${t.host}${to}`, path)
    }
    assert.deepEqual(t.ensured, ['a@x.com'], 'only the launch exchange started a box; the redirects started none')
  } finally { t.close() }
})

test('an upgrade from another origin, or with none, is refused, so a project page cannot open the visitor\'s desktop; same-origin upgrades work', async () => {
  const t = await setup()
  const main = 'boxes.mumbo.si'
  try {
    for (const [host, origin] of [[main, `https://${t.host}`], [t.host, `https://${main}`], [main, undefined], [t.host, undefined], [main, `http://${main}`], [main, `https://${main}:8443`]]) {
      const r = await call(t.port, { path: '/desktop/websockify', headers: { host, ...(origin ? { origin } : {}), ...upgrade } })
      assert.ok(r.error, `${host} from ${origin}: ${JSON.stringify(r)}`)
    }
    assert.deepEqual(t.ensured, [], 'no box was started')
    assert.equal(t.seen.length, 0)
    assert.ok((await call(t.port, { path: '/desktop/websockify', headers: { host: main, origin: `https://${main}`, ...upgrade } })).upgraded)
    assert.ok((await call(t.port, { path: '/api/remote.mux', headers: { host: t.host, origin: `https://${t.host}`, ...upgrade } })).upgraded)
    assert.deepEqual(t.seen.map(s => [s.path, s.headers['e2b-sandbox-id'], s.headers['e2b-sandbox-port']]), [['/websockify', 'ubox', '6080'], ['/api/remote.mux', 'pbox', '3080']])
  } finally { t.close() }
})

test('Host: other.boxes.mumbo.si and near-miss project hosts give 404, and their upgrades are refused', async () => {
  const t = await setup()
  try {
    for (const host of ['other.boxes.mumbo.si', `p-${t.id}.boxes.mumbo.si.evil.example`, `x.p-${t.id}.boxes.mumbo.si`, `p-${t.id}0.boxes.mumbo.si`, `p-${t.id.slice(1)}.boxes.mumbo.si`, 'p-zzzzzzzzzzzzzzzz.boxes.mumbo.si', `p-${t.id}.boxesxmumbo.si`, `p-${t.id}xboxes.mumbo.si`]) {
      assert.equal((await call(t.port, { headers: { host } })).status, 404, host)
      assert.ok((await call(t.port, { headers: { host, ...upgrade } })).error, host)
    }
    assert.deepEqual(t.ensured, [])
    assert.equal(t.seen.length, 0)
  } finally { t.close() }
})

test('a desktop request other than a read must come from the desktop\'s own page; reads and same-origin requests pass', async () => {
  const t = await setup()
  const main = 'boxes.mumbo.si'
  try {
    for (const origin of [`https://${t.host}`, 'null', undefined]) {
      const r = await call(t.port, { path: '/desktop/x', headers: { host: main, ...(origin ? { origin } : {}) }, method: 'POST' })
      assert.equal(r.status, 403, String(origin))
    }
    assert.deepEqual(t.ensured, []); assert.equal(t.seen.length, 0)
    assert.equal((await call(t.port, { path: '/desktop/x', headers: { host: main, origin: `https://${main}` }, method: 'POST' })).body, 'from box')
    assert.equal((await call(t.port, { path: '/desktop/vnc.html', headers: { host: main } })).body, 'from box')
    assert.deepEqual(t.seen.map(s => [s.method, s.path, s.headers['e2b-sandbox-port']]), [['POST', '/x', '6080'], ['GET', '/vnc.html', '6080']])
  } finally { t.close() }
})

/** config() with exactly these environment variables among those it reads. */
function configFrom(vars) {
  const keys = ['PUBLIC_HOST', 'LLM_HOST', 'BACKUP_BUCKET', 'ALLOWED_EMAILS', 'PROJECT_DOMAIN', 'APPROVE_HOST']
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]))
  const apply = (values) => { for (const k of keys) if (values[k] === undefined) delete process.env[k]; else process.env[k] = values[k] }
  apply(vars)
  try { return config() } finally { apply(saved) }
}

const env = { PUBLIC_HOST: 'boxes.mumbo.si', LLM_HOST: 'llm.boxes.mumbo.si', BACKUP_BUCKET: 'b', ALLOWED_EMAILS: '@x.com' }

test('with PROJECT_DOMAIN=projects.example, p-<id>.projects.example is the project origin, p-<id>.boxes.mumbo.si answers 404, and links use the new domain', async () => {
  assert.equal(configFrom(env).projectDomain, env.PUBLIC_HOST, 'unset: the public host')
  const c = configFrom({ ...env, PROJECT_DOMAIN: 'projects.example' })
  const t = await setup(c)
  const host = `p-${t.id}.projects.example`, old = `p-${t.id}.boxes.mumbo.si`
  try {
    assert.equal(t.host, host)
    assert.equal((await call(t.port, { headers: { host } })).body, 'from box')
    assert.ok((await call(t.port, { path: '/api/remote.mux', headers: { host, origin: `https://${host}`, ...upgrade } })).upgraded)
    assert.equal((await call(t.port, { headers: { host: old } })).status, 404)
    assert.ok((await call(t.port, { headers: { host: old, origin: `https://${old}`, ...upgrade } })).error)
    assert.deepEqual(t.seen.map(s => s.headers['e2b-sandbox-id']), ['pbox', 'pbox'])
    assert.equal((await call(t.port, { path: `/p/${t.id}/x`, headers: { host: 'boxes.mumbo.si' } })).headers.location, `https://${host}/x`)
    assert.ok((await call(t.port, { path: '/home', headers: { host: 'boxes.mumbo.si' } })).body.includes(`href="https://${host}/"`))
    assert.deepEqual(boxSite(c, `project:${t.id}`), { host, publicUrl: `https://${host}/`, desktop: false })
    assert.ok(roleInstructions(c, `project:${t.id}`).includes(`Its members reach you at https://${host}/ `))
    assert.deepEqual(t.ensured, [`project:${t.id}`, `project:${t.id}`])
  } finally { t.close() }
})

test('PROJECT_DOMAIN must be a bare lowercase hostname with a dot; anything else fails at start', () => {
  for (const bad of ['', ' ', 'Boxes.mumbo.si', 'https://boxes.mumbo.si', 'boxes.mumbo.si:443', 'boxes.mumbo.si/x', 'boxes.mumbo.si.', '.boxes.mumbo.si', 'localhost', 'a..b', '-a.b', 'a-.b', 'a_b.example', 'boxes.mumbo.si ']) {
    assert.throws(() => configFrom({ ...env, PROJECT_DOMAIN: bad }), /edge: PROJECT_DOMAIN must be a bare lowercase hostname/, JSON.stringify(bad))
  }
  for (const good of ['projects.example', 'boxes.mumbo.si', 'p1.x-y.example']) assert.equal(configFrom({ ...env, PROJECT_DOMAIN: good }).projectDomain, good)
})

test('no other origin may frame our pages: box responses on the main and project hosts and the edge\'s own pages say so; a box\'s own frame policy is kept', async () => {
  const t = await setup()
  const main = 'boxes.mumbo.si'
  const framing = (r) => [r.headers['content-security-policy'], r.headers['x-frame-options']]
  const ours = ["frame-ancestors 'self'", 'SAMEORIGIN']
  try {
    // The live view's pages also get a second policy that keeps their connections on this host (edge.test.mjs).
    assert.deepEqual(framing(await call(t.port, { path: '/desktop/vnc.html?autoconnect=1', headers: { host: main } })), [`${ours[0]}, connect-src 'self' wss://${main} data:`, ours[1]], 'the main-host desktop')
    assert.deepEqual(framing(await call(t.port, { headers: { host: main, cookie: 'dsh-auth-x=1' } })), ours, 'the main-host dsh')
    assert.deepEqual(framing(await call(t.port, { headers: { host: t.host } })), ours, 'a project host')
    assert.deepEqual(framing(await call(t.port, { path: '/own-policy', headers: { host: t.host } })), ["default-src 'self'; frame-ancestors 'none'", 'DENY'], 'a box\'s own policy is kept')
    assert.deepEqual(framing(await call(t.port, { path: '/csp', headers: { host: t.host } })), ["default-src 'self'; frame-ancestors 'self'", 'SAMEORIGIN'], 'a box CSP without frame-ancestors gains ours')
    assert.equal(t.seen.length, 5, 'all five came from a box')
    const edgePages = {
      home: await call(t.port, { path: '/home', headers: { host: main } }),
      'launch redirect': await call(t.port, { headers: { host: main } }),
      'not signed in': await call(t.port, { headers: { host: main, 'x-forwarded-email': '' } }),
      'not invited': await call(t.port, { headers: { host: main, 'x-forwarded-email': 'z@other.example' } }),
      'non-member': await call(t.port, { headers: { host: t.host, 'x-forwarded-email': 'b@x.com' } }),
      'unknown host': await call(t.port, { headers: { host: 'other.boxes.mumbo.si' } }),
    }
    assert.deepEqual(Object.values(edgePages).map(r => r.status), [200, 302, 401, 403, 403, 404])
    // The home page carries CSRF tokens and, once, a new door key (keys.mjs): no page may frame it, not even its own origin's.
    const home = ["default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'", 'DENY']
    for (const [what, r] of Object.entries(edgePages)) assert.deepEqual(framing(r), what === 'home' ? home : ours, what)
    assert.equal(t.seen.length, 5, 'the edge answered those itself')
  } finally { t.close() }
})
