// node --test: end to end through userServer and boxFetcher with a fake box behind the client-proxy address. The sign-in cookie
// never reaches a box, a box cannot set a parent-domain cookie (in HTTP responses and WebSocket 101s alike), and the
// approve host and unknown hosts never reach one.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer, request } from 'node:http'
import { boxFetcher, userServer } from './edge.mjs'

// Sign-in cookies (SIGNIN_COOKIE, its chunks, and oauth2-proxy's default name) next to a box's own cookie.
const SIGNED_IN_COOKIES = '_oauth2_proxy_mumbo=a; _oauth2_proxy_mumbo_1=b; _oauth2_proxy=c; dsh-auth-x=d'
const listen = (server) => new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port)))
const call = (port, headers, extra = {}) => new Promise((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port, path: '/', headers }, (res) => {
    let body = ''; res.on('data', c => { body += c }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
  })
  req.on('upgrade', (res, socket) => { socket.destroy(); resolve({ upgraded: true, headers: res.headers }) })
  req.on('error', (e) => (extra.upgrade ? resolve({ error: e.code ?? e.message }) : reject(e)))
  req.end()
})

test('the sign-in cookie never reaches a box, Domain is dropped from box cookies, the approve host and unknown hosts never reach a box', async () => {
  const seen = []
  const fakeBox = createServer((req, res) => { seen.push(req.headers); res.writeHead(200, { 'set-cookie': ['s=1; Domain=.boxes.mumbo.si; Path=/'] }).end('from box') })
  const boxPort = await listen(fakeBox)
  const proxy = new URL(`http://127.0.0.1:${boxPort}`), cfg = { publicHost: 'boxes.mumbo.si', approveHost: 'approve.boxes.mumbo.si', allowed: ['@x.com'], signinCookie: '_oauth2_proxy_mumbo' }
  const ensured = []; const approved = []
  const box = { ensure: async (p) => { ensured.push(p); return { id: 'b1', token: 'T', proxy } }, touch: async () => {}, forget: async () => {} }
  const approve = async (req, res, email) => { approved.push(email); res.writeHead(200).end('approve page') }
  const server = userServer({ cfg, box, approve, log: () => {} })
  const port = await listen(server)
  const signedIn = { 'x-forwarded-email': 'a@x.com', cookie: SIGNED_IN_COOKIES }
  try {
    const r = await call(port, { ...signedIn, host: 'boxes.mumbo.si' })
    assert.equal(r.body, 'from box')
    assert.equal(seen.length, 1)
    assert.equal(seen[0].cookie, 'dsh-auth-x=d')
    assert.deepEqual(r.headers['set-cookie'], ['s=1; Path=/; Secure'])

    const a = await call(port, { ...signedIn, host: 'Approve.Boxes.Mumbo.Si:443' })
    assert.equal(a.body, 'approve page')
    assert.deepEqual(approved, ['a@x.com'])

    const other = await call(port, { ...signedIn, host: 'other.boxes.mumbo.si' })
    assert.equal(other.status, 404)

    for (const host of ['approve.boxes.mumbo.si', 'other.boxes.mumbo.si']) {
      const ws = await call(port, { ...signedIn, host, connection: 'Upgrade', upgrade: 'websocket' }, { upgrade: true })
      assert.ok(ws.error, `the WebSocket upgrade on ${host} is refused (${JSON.stringify(ws)})`)
    }

    assert.equal(seen.length, 1, 'only the main-host request reached a box')
    assert.deepEqual(ensured, ['a@x.com'], 'no box was started for the approve host or an unknown host')
  } finally { server.close(); fakeBox.close() }
})

test('a WebSocket upgrade reaches the box without the sign-in cookie, and its 101 cookies lose Domain, one line each', async () => {
  const seen = []
  const fakeBox = createServer()
  fakeBox.on('upgrade', (req, socket) => {
    seen.push(req.headers)
    socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Set-Cookie: t=1; Domain=.boxes.mumbo.si; Path=/\r\nSet-Cookie: u=2; Path=/; Secure\r\n\r\n')
  })
  const boxPort = await listen(fakeBox)
  const proxy = new URL(`http://127.0.0.1:${boxPort}`), cfg = { publicHost: 'boxes.mumbo.si', approveHost: 'approve.boxes.mumbo.si', allowed: ['@x.com'], signinCookie: '_oauth2_proxy_mumbo' }
  const box = { ensure: async () => ({ id: 'b1', token: 'T', proxy }), touch: async () => {}, forget: async () => {} }
  const server = userServer({ cfg, box, log: () => {} })
  const port = await listen(server)
  try {
    const ws = await call(port, { host: 'boxes.mumbo.si', origin: 'https://boxes.mumbo.si', 'x-forwarded-email': 'a@x.com', cookie: SIGNED_IN_COOKIES, connection: 'Upgrade', upgrade: 'websocket' }, { upgrade: true })
    assert.ok(ws.upgraded, JSON.stringify(ws))
    assert.equal(seen[0].cookie, 'dsh-auth-x=d')
    assert.deepEqual(ws.headers['set-cookie'], ['t=1; Path=/; Secure', 'u=2; Path=/; Secure'])
  } finally { server.close(); fakeBox.close() }
})

test('a relay request (boxFetcher) reaches the box without sign-in cookies, even when its caller passes them', async () => {
  const seen = []
  const fakeBox = createServer((req, res) => { seen.push(req.headers); res.end('{}') })
  const proxy = new URL(`http://127.0.0.1:${await listen(fakeBox)}`), cfg = { publicHost: 'boxes.mumbo.si', signinCookie: '_oauth2_proxy_mumbo' }
  try {
    await boxFetcher(cfg)({ id: 'b1', proxy }, 'p-0123456789abcdef.boxes.mumbo.si', '/api/session/create', { method: 'POST', headers: { cookie: SIGNED_IN_COOKIES }, body: '{}' })
    assert.equal(seen[0].cookie, 'dsh-auth-x=d')
    await boxFetcher(cfg)({ id: 'b1', proxy }, 'p-0123456789abcdef.boxes.mumbo.si', '/api/session/create', { method: 'POST', headers: { cookie: ['dsh-auth-x=d', '_oauth2_proxy_mumbo=a'] }, body: '{}' })
    assert.equal(seen[1].cookie, 'dsh-auth-x=d', 'an array-valued cookie header is filtered per cookie')
  } finally { fakeBox.close() }
})

test('a box cannot plant a sign-in cookie: Set-Cookie with a sign-in name or no name is dropped from HTTP responses and WebSocket 101s', async () => {
  // A nameless cookie (empty name, or no `=`) is stored and sent as its bare value, so `=<sign-in name>=V` plants one.
  const planted = ['_oauth2_proxy_mumbo=x; Path=/api', '_oauth2_proxy_1=y', '=_oauth2_proxy_mumbo=V; Path=/api', ' =_oauth2_proxy=V', '=abc', 'abc; Path=/', 'box=z']
  const fakeBox = createServer((req, res) => { res.writeHead(200, { 'set-cookie': planted }).end('from box') })
  fakeBox.on('upgrade', (req, socket) => {
    socket.end(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n${planted.map(c => `Set-Cookie: ${c}\r\n`).join('')}\r\n`)
  })
  const proxy = new URL(`http://127.0.0.1:${await listen(fakeBox)}`), cfg = { publicHost: 'boxes.mumbo.si', approveHost: 'approve.boxes.mumbo.si', allowed: ['@x.com'], signinCookie: '_oauth2_proxy_mumbo' }
  const box = { ensure: async () => ({ id: 'b1', token: 'T', proxy }), touch: async () => {}, forget: async () => {} }
  const server = userServer({ cfg, box, log: () => {} })
  const port = await listen(server)
  const signedIn = { host: 'boxes.mumbo.si', 'x-forwarded-email': 'a@x.com', cookie: 'dsh-auth-x=d' }
  try {
    assert.deepEqual((await call(port, signedIn)).headers['set-cookie'], ['box=z; Secure'])
    const ws = await call(port, { ...signedIn, origin: 'https://boxes.mumbo.si', connection: 'Upgrade', upgrade: 'websocket' }, { upgrade: true })
    assert.ok(ws.upgraded, JSON.stringify(ws))
    assert.deepEqual(ws.headers['set-cookie'], ['box=z; Secure'])
  } finally { server.close(); fakeBox.close() }
})
