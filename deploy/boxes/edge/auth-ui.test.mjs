// node --test: the Supabase sign-in page the edge serves to signed-out visitors (authUi) and its consent decision.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { request } from 'node:http'
import { test } from 'node:test'
import { authUi, userServer } from './edge.mjs'

const cfg = { publicHost: 'boxes.example', projectDomain: 'boxes.example', approveHost: 'approve.boxes.example', allowed: ['@x.com'], signinCookie: '_oauth2_proxy_mumbo', proxy: new URL('http://127.0.0.1:1') }
const read = (name) => readFileSync(new URL(`./auth-ui/${name}`, import.meta.url), 'utf8')
const html = read('index.html')
const consentJs = read('consent.js')
const anonKey = 'key"</script> '
const allowed = { clientIds: ['c1', 'c2'], redirectUris: ['https://boxes.example/oauth2/callback'] }
const signin = authUi({ html, supabaseJs: '/* supabase-js */', consentJs, supabaseUrl: 'https://ref.supabase.co', anonKey, ...allowed })
const consentDecision = new Function(`${consentJs}; return consentDecision`)()
const listen = (server) => new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port)))
const call = (port, { method = 'GET', path = '/', host = cfg.approveHost, headers = {} } = {}) => new Promise((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port, method, path, headers: { host, ...headers } }, (res) => {
    let data = ''; res.on('data', c => { data += c }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }))
  })
  req.on('upgrade', (res, socket) => { socket.destroy(); resolve({ status: res.statusCode }) })
  req.on('error', (e) => (headers.upgrade ? resolve({ error: e.code ?? e.message }) : reject(e)))
  req.end()
})
const upgrade = (host) => ({ connection: 'Upgrade', upgrade: 'websocket', origin: `https://${host}` })
/** Runs fn against a user server whose box layer records every call; returns the calls. */
async function serve(fn) {
  const boxCalls = []
  const box = { ensure: async (e) => { boxCalls.push(['ensure', e]); throw new Error('starting') }, firstSetUp: async () => false, touch: (id) => { boxCalls.push(['touch', id]) }, forget: (id) => { boxCalls.push(['forget', id]) } }
  const server = userServer({ cfg, box, signin, log: () => {} })
  const port = await listen(server)
  try { await fn(port) } finally { server.close() }
  return boxCalls
}

test('signed out, GET /oauth/consent on the approve host serves the sign-in page with a strict CSP and no box', async () => {
  const boxCalls = await serve(async (port) => {
    for (const path of ['/oauth/consent?authorization_id=x', '/oauth/consent']) {
      const r = await call(port, { path })
      assert.equal(r.status, 200)
      assert.equal(r.body, html)
      assert.match(r.headers['content-type'], /^text\/html/)
      assert.equal(r.headers['cache-control'], 'no-store')
      assert.equal(r.headers['x-frame-options'], 'DENY')
      assert.equal(r.headers['referrer-policy'], 'no-referrer')
      const csp = r.headers['content-security-policy']
      assert.match(csp, /(^|; )default-src 'none'(;|$)/)
      assert.match(csp, /(^|; )connect-src https:\/\/ref\.supabase\.co(;|$)/)
      assert.match(csp, /(^|; )frame-ancestors 'none'(;|$)/)
      assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|\*/)
      const inline = /<script>([\s\S]*?)<\/script>/.exec(html)[1]
      assert.ok(csp.includes(`'sha256-${createHash('sha256').update(inline).digest('base64')}'`), 'the inline script is allowed by hash')
    }
    assert.equal((await call(port, { path: '/oauth/consent?signout' })).status, 200)
  })
  assert.deepEqual(boxCalls, [])
})

test('the public host, which a box serves, redirects the page to the approve host, query kept', async () => {
  const boxCalls = await serve(async (port) => {
    const r = await call(port, { host: cfg.publicHost, path: '/oauth/consent?authorization_id=a%2Fb&x=1' })
    assert.equal(r.status, 302)
    assert.equal(r.headers.location, 'https://approve.boxes.example/oauth/consent?authorization_id=a%2Fb&x=1')
    assert.equal(r.headers['cache-control'], 'no-store')
    for (const path of ['/auth-ui/config.js', '/auth-ui/supabase.js', '/auth-ui/consent.js', '/oauth/consentx']) assert.equal((await call(port, { host: cfg.publicHost, path })).status, 401, path)
  })
  assert.deepEqual(boxCalls, [])
})

test('the page\'s scripts: the pinned supabase-js, the consent decision and a config with JSON-encoded values', async () => {
  await serve(async (port) => {
    const lib = await call(port, { path: '/auth-ui/supabase.js' })
    assert.equal(lib.status, 200); assert.equal(lib.body, '/* supabase-js */')
    assert.match(lib.headers['content-type'], /^text\/javascript/); assert.equal(lib.headers['cache-control'], 'no-store')
    assert.equal((await call(port, { path: '/auth-ui/consent.js' })).body, consentJs)
    const conf = await call(port, { path: '/auth-ui/config.js' })
    assert.equal(conf.status, 200); assert.equal(conf.headers['cache-control'], 'no-store')
    assert.deepEqual(new Function(`${conf.body}; return MUMBO`)(), { url: 'https://ref.supabase.co', anonKey, ...allowed })
  })
})

test('other methods, paths and hosts fall through to the signed-in router', async () => {
  const boxCalls = await serve(async (port) => {
    for (const method of ['HEAD', 'POST', 'PUT', 'OPTIONS']) {
      for (const host of [cfg.approveHost, cfg.publicHost]) assert.equal((await call(port, { method, host, path: '/oauth/consent?authorization_id=x' })).status, 401, `${method} ${host}`)
    }
    for (const path of ['/oauth/consent/x', '/oauth/consentx', '/OAUTH/consent', '/oauth/Consent', '//oauth/consent', '/x/../oauth/consent', '/oauth/consent%2F', '/auth-ui/', '/auth-ui/index.html', '/auth-ui/config.js?x', '/auth-ui/supabase.jsx', '/auth-ui/config.js/']) {
      assert.equal((await call(port, { path })).status, 401, path)
    }
    for (const host of ['p-0123456789abcdef.boxes.example', 'other.example']) {
      for (const path of ['/oauth/consent?authorization_id=x', '/auth-ui/config.js']) assert.equal((await call(port, { host, path })).status, 401, `${host}${path}`)
    }
  })
  assert.deepEqual(boxCalls, [])
})

test('oauth2-proxy skips sign-in for exactly the requests the edge serves signed out, and refuses with an email header', async () => {
  // v7.9 matches each --skip-auth-route regex against the request URI, query included.
  const tf = readFileSync(new URL('../prod/edge.tf', import.meta.url), 'utf8')
  const routes = [...tf.matchAll(/"--skip-auth-route=([^"]*)"/g)].map(m => m[1])
  assert.equal(routes.length, 2)
  assert.ok(routes.every(r => r.startsWith('GET=^') && r.endsWith('$')), 'GET only, anchored')
  const skipped = (uri) => routes.some(r => new RegExp(r.slice('GET='.length)).test(uri))
  await serve(async (port) => {
    for (const uri of ['/oauth/consent', '/oauth/consent?authorization_id=x', '/oauth/consent?signout', '/auth-ui/supabase.js', '/auth-ui/config.js', '/auth-ui/consent.js',
      '/', '/oauth/consent/x', '/oauth/consentx', '/OAUTH/consent', '/xoauth/consent', '/auth-ui/configxjs', '/auth-ui/config.js?x', '/auth-ui/supabase.js/', '/auth-ui/index.js', '/oauth2/start']) {
      assert.equal(skipped(uri), (await call(port, { path: uri })).status === 200, uri)
      // A skipped request carries no identity, so one with an email header did not come through sign-in.
      assert.equal(skipped(uri), (await call(port, { path: uri, headers: { 'x-forwarded-email': 'a@x.com' } })).status === 400, `${uri} with an email`)
    }
  })
})

test('a client X-Forwarded-Uri, on which oauth2-proxy skips sign-in for any path, is refused before routing, identity or a box, over HTTP and upgrade', async () => {
  const forged = { 'X-Forwarded-Uri': '/oauth/consent', 'X-Forwarded-Email': 'a@x.com' }
  const boxCalls = await serve(async (port) => {
    for (const host of [cfg.publicHost, cfg.approveHost, 'p-0123456789abcdef.boxes.example', 'other.example']) {
      for (const path of ['/', '/home', '/desktop/', '/oauth/consent', '/oauth/consent?authorization_id=x', '/auth-ui/config.js', '/edge/healthz']) {
        assert.equal((await call(port, { host, path, headers: forged })).status, 400, `${host}${path}`)
        assert.equal((await call(port, { host, path, headers: { ...forged, ...upgrade(host) } })).status, 400, `upgrade ${host}${path}`)
      }
    }
    for (const headers of [{ 'x-forwarded-uri': '' }, { 'X-FORWARDED-URI': '/home' }, { 'x-forwarded-uri': '/oauth/consent' }]) {
      assert.equal((await call(port, { host: cfg.publicHost, headers })).status, 400, JSON.stringify(headers))
      assert.equal((await call(port, { host: cfg.publicHost, headers: { ...headers, ...upgrade(cfg.publicHost) } })).status, 400, `upgrade ${JSON.stringify(headers)}`)
    }
    // Skip-auth paths with an email header, as an upgrade too.
    for (const host of [cfg.publicHost, cfg.approveHost]) {
      for (const path of ['/oauth/consent?authorization_id=x', '/auth-ui/supabase.js', '/auth-ui/config.js', '/auth-ui/consent.js']) {
        assert.equal((await call(port, { host, path, headers: { 'x-forwarded-email': 'a@x.com', ...upgrade(host) } })).status, 400, `upgrade ${host}${path}`)
      }
    }
  })
  assert.deepEqual(boxCalls, [])
  // Without the header the same signed-in requests reach the box.
  const reached = await serve(async (port) => {
    const email = { 'x-forwarded-email': 'a@x.com' }
    assert.equal((await call(port, { host: cfg.publicHost, headers: email })).status, 503)
    assert.ok((await call(port, { host: cfg.publicHost, headers: { ...email, ...upgrade(cfg.publicHost) } })).error)
  })
  assert.deepEqual(reached, [['ensure', 'a@x.com'], ['ensure', 'a@x.com']])
})

test('consent: approve only Mumbo\'s own client ids, follow an earlier consent only to Mumbo\'s redirect URI, refuse the rest', () => {
  assert.equal(consentDecision({ authorization_id: 'a', client: { id: 'c1', name: 'mumbo' }, redirect_uri: 'https://evil.example/cb' }, allowed), 'approve')
  assert.equal(consentDecision({ client: { id: 'c2' } }, allowed), 'approve')
  for (const id of ['c3', 'C1', ' c1', 'c1 ', '', undefined]) assert.equal(consentDecision({ client: { id } }, allowed), 'refuse', String(id))
  // A client is decided by its id, even when a redirect_url comes with it.
  assert.equal(consentDecision({ client: { id: 'c3' }, redirect_url: 'https://boxes.example/oauth2/callback?code=x' }, allowed), 'refuse')
  assert.equal(consentDecision({ redirect_url: 'https://boxes.example/oauth2/callback?code=x&state=y' }, allowed), 'follow')
  for (const url of ['https://evil.example/oauth2/callback?code=x', 'https://boxes.example/oauth2/callbackx?code=x', 'https://boxes.example.evil.example/oauth2/callback',
    'http://boxes.example/oauth2/callback', 'https://boxes.example:8443/oauth2/callback', 'javascript:alert(1)', 'not a url', '/oauth2/callback']) {
    assert.equal(consentDecision({ redirect_url: url }, allowed), 'refuse', url)
  }
  for (const details of [undefined, null, {}, { redirect_url: 5 }]) assert.equal(consentDecision(details, allowed), 'refuse', JSON.stringify(details))
  assert.equal(consentDecision({ client: { id: 'c1' } }, { clientIds: [], redirectUris: [] }), 'refuse')
})

test('the edge serves the same page as deploy/auth-ui (a copy: that file is outside the edge build context)', () => {
  assert.equal(html, readFileSync(new URL('../../auth-ui/index.html', import.meta.url), 'utf8'))
})
