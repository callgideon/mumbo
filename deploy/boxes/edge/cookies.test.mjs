// node --test: end to end through userServer with a fake box behind the client-proxy address. The sign-in cookie
// never reaches a box, a box cannot set a parent-domain cookie (in HTTP responses and WebSocket 101s alike), and the
// approve host and unknown hosts never reach one.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer, request } from 'node:http'
import { userServer } from './edge.mjs'

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
  const cfg = { publicHost: 'boxes.mumbo.si', approveHost: 'approve.boxes.mumbo.si', allowed: ['@x.com'], proxy: new URL(`http://127.0.0.1:${boxPort}`) }
  const ensured = []; const approved = []
  const box = { ensure: async (p) => { ensured.push(p); return { id: 'b1', token: 'T' } }, touch: async () => {}, forget: async () => {} }
  const approve = async (req, res, email) => { approved.push(email); res.writeHead(200).end('approve page') }
  const server = userServer({ cfg, box, approve, log: () => {} })
  const port = await listen(server)
  const signedIn = { 'x-forwarded-email': 'a@x.com', cookie: '_oauth2_proxy=a; _oauth2_proxy_1=b; dsh-auth-x=c' }
  try {
    const r = await call(port, { ...signedIn, host: 'boxes.mumbo.si' })
    assert.equal(r.body, 'from box')
    assert.equal(seen.length, 1)
    assert.equal(seen[0].cookie, 'dsh-auth-x=c')
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
  const cfg = { publicHost: 'boxes.mumbo.si', approveHost: 'approve.boxes.mumbo.si', allowed: ['@x.com'], proxy: new URL(`http://127.0.0.1:${boxPort}`) }
  const box = { ensure: async () => ({ id: 'b1', token: 'T' }), touch: async () => {}, forget: async () => {} }
  const server = userServer({ cfg, box, log: () => {} })
  const port = await listen(server)
  try {
    const ws = await call(port, { host: 'boxes.mumbo.si', origin: 'https://boxes.mumbo.si', 'x-forwarded-email': 'a@x.com', cookie: '_oauth2_proxy=a; dsh-auth-x=c', connection: 'Upgrade', upgrade: 'websocket' }, { upgrade: true })
    assert.ok(ws.upgraded, JSON.stringify(ws))
    assert.equal(seen[0].cookie, 'dsh-auth-x=c')
    assert.deepEqual(ws.headers['set-cookie'], ['t=1; Path=/; Secure', 'u=2; Path=/; Secure'])
  } finally { server.close(); fakeBox.close() }
})
