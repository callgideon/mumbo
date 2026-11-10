// node --test: the Supabase sign-in page the edge serves to signed-out visitors (authUi) and its consent decision.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { request } from 'node:http'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { authUi, userServer } from './edge.mjs'

const cfg = { publicHost: 'boxes.example', projectDomain: 'boxes.example', approveHost: 'approve.boxes.example', allowed: ['@x.com'], signinCookie: '_oauth2_proxy_mumbo', proxy: new URL('http://127.0.0.1:1') }
const read = (name) => readFileSync(new URL(`./auth-ui/${name}`, import.meta.url), 'utf8')
const html = read('index.html')
const consentJs = read('consent.js')
const inline = /<script>([\s\S]*?)<\/script>/.exec(html)[1]
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
  // PKCE, and nothing read from the URL by supabase-js (the page's own init exchanges a ?code=).
  assert.deepEqual((await runPage('https://approve.boxes.example/oauth/consent')).calls[0], ['createClient', 'https://ref.supabase.co', 'anon', { auth: { flowType: 'pkce', detectSessionInUrl: false } }])
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

test('oauth2-proxy skips sign-in for exactly the requests the edge serves signed out; a signed-in visitor gets the same page', async () => {
  // v7.9 matches each --skip-auth-route regex against the request URI, query included.
  const tf = readFileSync(new URL('../prod/modules/edge/edge.tf', import.meta.url), 'utf8')
  const routes = [...tf.matchAll(/"--skip-auth-route=([^"]*)"/g)].map(m => m[1])
  assert.equal(routes.length, 2)
  assert.ok(routes.every(r => r.startsWith('GET=^') && r.endsWith('$')), 'GET only, anchored')
  // Client identity headers are stripped on these routes too, stated rather than left to the default.
  assert.match(tf, /"--skip-auth-strip-headers=true"/)
  // The ALB refuses any X-Forwarded-Uri (on which oauth2-proxy would skip sign-in) before every other rule.
  assert.match(tf, /resource "aws_lb_listener_rule" "x_forwarded_uri" \{\s*listener_arn = aws_lb_listener\.https\.arn\s*priority\s*= 1\s*condition \{\s*http_header \{\s*http_header_name = "X-Forwarded-Uri"\s*values\s*= \["\*"\]\s*\}\s*\}\s*action \{\s*type = "fixed-response"[^}]*status_code\s*= "400"/)
  const skipped = (uri) => routes.some(r => new RegExp(r.slice('GET='.length)).test(uri))
  await serve(async (port) => {
    for (const uri of ['/oauth/consent', '/oauth/consent?authorization_id=x', '/oauth/consent?signout', '/auth-ui/supabase.js', '/auth-ui/config.js', '/auth-ui/consent.js',
      '/', '/oauth/consent/x', '/oauth/consentx', '/OAUTH/consent', '/xoauth/consent', '/auth-ui/configxjs', '/auth-ui/config.js?x', '/auth-ui/supabase.js/', '/auth-ui/index.js', '/oauth2/start']) {
      assert.equal(skipped(uri), (await call(port, { path: uri })).status === 200, uri)
      // oauth2-proxy sets X-Forwarded-Email on a skip-auth route when the visitor has a session: the page is served the same.
      if (skipped(uri)) assert.equal((await call(port, { path: uri, headers: { 'x-forwarded-email': 'a@x.com' } })).status, 200, `${uri} signed in`)
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

/**
 * Runs the page's scripts (consent.js, then the inline script) at `href` with a fake DOM and a fake supabase-js whose
 * auth calls are recorded and answered from `answers` by name (default { data: {}, error: null }). Resolves once the
 * page's start-up has settled, with the calls (createClient, auth and oauth methods, history and location) and the texts.
 */
async function runPage(href, answers = {}) {
  const calls = []
  const answer = (name) => (...args) => { calls.push([name, ...args]); return Promise.resolve(answers[name] ?? { data: {}, error: null }) }
  const auth = (prefix) => new Proxy({}, { get: (_, k) => (prefix === '' && k === 'oauth' ? auth('oauth.') : answer(prefix + String(k))) })
  const els = new Map()
  const el = () => ({ hidden: false, disabled: false, textContent: '', value: '', classList: { toggle() {} }, addEventListener() {}, querySelectorAll: () => [], focus() {} })
  const url = new URL(href)
  runInNewContext(`${consentJs}\n${inline}`, {
    MUMBO: { url: 'https://ref.supabase.co', anonKey: 'anon', ...allowed },
    supabase: { createClient: (...args) => { calls.push(['createClient', ...args]); return { auth: auth('') } } },
    document: { getElementById: (id) => els.get(id) ?? els.set(id, el()).get(id) },
    location: { origin: url.origin, pathname: url.pathname, search: url.search, hash: url.hash, href, replace: (u) => { calls.push(['location.replace', u]) } },
    history: { replaceState: (_, __, u) => { calls.push(['history.replaceState', u]) } },
    URL, URLSearchParams,
  })
  await new Promise(r => setImmediate(r))
  return { calls: JSON.parse(JSON.stringify(calls)), text: (id) => els.get(id)?.textContent }
}

test('a planted session in the URL is never used: fragment tokens and foreign codes set no session and consent to nothing', async () => {
  const base = 'https://approve.boxes.example/oauth/consent?authorization_id=A1'
  const tokens = 'access_token=AT&refresh_token=RT&expires_in=3600&token_type=bearer&type=magiclink'
  const signedOut = { getSession: { data: { session: null } } }
  for (const href of [`${base}#${tokens}`, `${base}&${tokens}`, `${base}#code=C`, `${base}&error=x&error_description=y#${tokens}`]) {
    const { calls } = await runPage(href, signedOut)
    // The address keeps only the authorization id; nothing but getSession reaches Supabase.
    assert.deepEqual(calls.slice(1), [['history.replaceState', base], ['getSession']], href)
  }
  // A ?code= without this browser's PKCE verifier: supabase-js refuses it, and the page says where the link works.
  const foreign = await runPage(`${base}&code=C#${tokens}`, { ...signedOut, exchangeCodeForSession: { data: { session: null }, error: { code: 'pkce_code_verifier_not_found' } } })
  assert.deepEqual(foreign.calls.slice(1), [['history.replaceState', base], ['exchangeCodeForSession', 'C'], ['getSession']])
  // Opening the link used its one-time code, so the page asks for a new email rather than that code.
  assert.equal(foreign.text('msg'), 'This link was opened in a different browser from the one that asked for it. Go back to that browser and request a new email.')
  // This browser's own Google or link sign-in: the code is exchanged after the address is cleaned, then consent runs.
  const own = await runPage(`${base}&code=C`, {
    getSession: { data: { session: { user: { email: 'a@x.com' } } } },
    'oauth.getAuthorizationDetails': { data: { client: { id: 'c1' }, redirect_uri: 'https://boxes.example/oauth2/callback' } },
    'oauth.approveAuthorization': { data: { redirect_url: 'https://boxes.example/oauth2/callback?code=X&state=S' } },
  })
  assert.deepEqual(own.calls.slice(1), [['history.replaceState', base], ['exchangeCodeForSession', 'C'], ['getSession'], ['oauth.getAuthorizationDetails', 'A1'],
    ['oauth.approveAuthorization', 'A1', { skipBrowserRedirect: true }], ['location.replace', 'https://boxes.example/oauth2/callback?code=X&state=S']])
})

test('consent: approve only Mumbo\'s own client ids with Mumbo\'s redirect URI, follow an earlier consent only to Mumbo\'s redirect URI, refuse the rest', () => {
  const cb = 'https://boxes.example/oauth2/callback'
  const bad = ['https://evil.example/oauth2/callback?code=x', 'https://boxes.example/oauth2/callbackx?code=x', 'https://boxes.example.evil.example/oauth2/callback',
    'http://boxes.example/oauth2/callback', 'https://boxes.example:8443/oauth2/callback', 'javascript:alert(1)', 'not a url', '/oauth2/callback', '', 5, undefined]
  const rows = [
    [{ authorization_id: 'a', client: { id: 'c1', name: 'mumbo' }, redirect_uri: cb }, 'approve'],
    [{ client: { id: 'c2' }, redirect_uri: `${cb}?x=1` }, 'approve'],
    // A Mumbo client id is approved only toward Mumbo's redirect URI: the client could carry another one.
    ...bad.map(u => [{ client: { id: 'c1' }, redirect_uri: u }, 'refuse']),
    [{ client: { id: 'c1' } }, 'refuse'],
    ...['c3', 'C1', ' c1', 'c1 ', '', undefined].map(id => [{ client: { id }, redirect_uri: cb }, 'refuse']),
    // A client is decided by its id and redirect_uri, even when a redirect_url comes with it.
    [{ client: { id: 'c3' }, redirect_uri: cb, redirect_url: `${cb}?code=x` }, 'refuse'],
    [{ redirect_url: `${cb}?code=x&state=y` }, 'follow'],
    ...bad.map(u => [{ redirect_url: u }, 'refuse']),
    ...[undefined, null, {}].map(d => [d, 'refuse']),
  ]
  for (const [details, decision] of rows) assert.equal(consentDecision(details, allowed), decision, JSON.stringify(details))
  assert.equal(consentDecision({ client: { id: 'c1' }, redirect_uri: cb }, { clientIds: [], redirectUris: [] }), 'refuse')
  assert.equal(consentDecision({ client: { id: 'c1' }, redirect_uri: cb }, { clientIds: ['c1'], redirectUris: [] }), 'refuse')
})

test('the page goes only to Mumbo\'s redirect URI, uses only a plain authorization id, and shows no text from the link', async () => {
  const base = 'https://approve.boxes.example/oauth/consent?authorization_id=A1'
  const signedIn = { getSession: { data: { session: { user: { email: 'a@x.com' } } } } }
  const pending = { 'oauth.getAuthorizationDetails': { data: { client: { id: 'c1' }, redirect_uri: 'https://boxes.example/oauth2/callback' } } }
  // Approving returns a redirect_url elsewhere: the page stays.
  const approved = await runPage(base, { ...signedIn, ...pending, 'oauth.approveAuthorization': { data: { redirect_url: 'https://evil.example/oauth2/callback?code=X' } } })
  assert.equal(approved.calls.at(-1)[0], 'oauth.approveAuthorization')
  assert.equal(approved.text('msg'), 'Authorization failed. Try again from the app address.')
  // An earlier consent is followed to Mumbo's redirect URI.
  const followed = await runPage(base, { ...signedIn, 'oauth.getAuthorizationDetails': { data: { redirect_url: 'https://boxes.example/oauth2/callback?code=X' } } })
  assert.deepEqual(followed.calls.at(-1), ['location.replace', 'https://boxes.example/oauth2/callback?code=X'])
  // An authorization id that is not a plain token reaches no Supabase path.
  for (const id of ['..', '.', '../../user', 'a/b', 'a%2Fb', 'a.b', 'a?b', 'A1 ', '']) {
    const r = await runPage(`https://approve.boxes.example/oauth/consent?authorization_id=${encodeURIComponent(id)}`, { ...signedIn, ...pending })
    assert.deepEqual(r.calls.map(c => c[0]), ['createClient'], id)
    assert.equal(r.text('msg'), 'Open mumbo from its address to sign in.', id)
  }
  // Error parameters from the link get fixed text.
  const failed = await runPage(`${base}&error=server_error&error_description=${encodeURIComponent('Your account is locked. Call +1 555 0100.')}`, { getSession: { data: { session: null } } })
  assert.equal(failed.text('msg'), 'Sign-in failed. Try again.')
})

test('the edge serves the same page as deploy/auth-ui (a copy: that file is outside the edge build context)', () => {
  assert.equal(html, readFileSync(new URL('../../auth-ui/index.html', import.meta.url), 'utf8'))
})
