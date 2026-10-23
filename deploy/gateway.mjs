// mumbo account gateway on the API host: speaks the desktop account protocol of
// @deepseek-ai/dsh-deepseek-account-platform (platformOrigin) and llm-deepseek-account (inference).
// Sign-in uses the Supabase login page at https://<app host>/oauth/consent in desktop mode; anyone with a
// Supabase account may sign in. Model requests are forwarded to DeepSeek with the server API key.
// Stateless: authorize ids, codes and account tokens are HMAC-signed, so tasks need no shared store.
// ponytail: tokens cannot be revoked before expiry (logout is local only); add a denylist if that matters.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { Readable } from 'node:stream'

const env = (name) => process.env[name] ?? (() => { throw new Error(`gateway: set ${name}`) })()
const KEY = createHash('sha256').update(`mumbo-gateway:${env('GATEWAY_SECRET')}`).digest()
const API = `https://${process.env.MUMBO_API_HOST}`
const APP = `https://${process.env.MUMBO_PUBLIC_HOST}`
const UPSTREAM = 'https://api.deepseek.com'
const TOKEN_TTL = 30 * 86400
// The account route reads its catalog here; names come from the bundled (rebranded) catalog.
const MODELS = { data: [
  { id: 'deepseek-flash', input_modalities: ['text', 'image'], api_capabilities: { anthropic_messages: { system_prompt_update: 'in-history' } } },
  { id: 'deepseek-v4-pro', api_capabilities: { anthropic_messages: {} } },
] }

const b64 = (value) => Buffer.from(value).toString('base64url')
const mac = (body) => createHmac('sha256', KEY).update(body).digest('base64url')
export function sign(type, payload, ttl) {
  const body = b64(JSON.stringify({ ...payload, t: type, exp: Math.floor(Date.now() / 1000) + ttl }))
  return `${body}.${mac(body)}`
}
export function verify(type, value) {
  if (typeof value !== 'string') return undefined
  const [body, sig, extra] = value.split('.')
  if (!body || !sig || extra !== undefined) return undefined
  const expected = Buffer.from(mac(body))
  if (Buffer.byteLength(sig) !== expected.length || !timingSafeEqual(Buffer.from(sig), expected)) return undefined
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  return payload.t === type && payload.exp > Date.now() / 1000 ? payload : undefined
}
const loopbackCallback = (uri) => typeof uri === 'string'
  && /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):[1-9][0-9]{0,4}\/oauth\/callback$/.test(uri)
const profile = (u) => ({ id: u.id, email: u.email, id_profile: { name: u.name, picture: u.picture } })
const ok = (biz_data) => ({ code: 0, msg: '', data: { biz_code: 0, biz_msg: '', biz_data } })

async function readBody(req, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw Object.assign(new Error('body too large'), { status: 413 })
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}
const json = (res, status, value, headers = {}) =>
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }).end(JSON.stringify(value))

async function supabaseUser(accessToken) {
  const response = await fetch(`${env('SUPABASE_URL')}/auth/v1/user`, {
    headers: { apikey: env('SUPABASE_ANON_KEY'), authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) return undefined
  const user = await response.json()
  const meta = user.user_metadata ?? {}
  return { id: user.id, email: user.email ?? '', name: meta.full_name ?? meta.name ?? null, picture: meta.avatar_url ?? meta.picture ?? null }
}

async function proxyModel(req, res, account, path) {
  const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readBody(req, 64 << 20)
  const headers = {}
  for (const name of ['content-type', 'accept', 'anthropic-version', 'anthropic-beta', 'user-agent']) {
    if (req.headers[name] !== undefined) headers[name] = req.headers[name]
  }
  headers['x-api-key'] = env('DEEPSEEK_API_KEY')
  const upstream = await fetch(`${UPSTREAM}${path}`, { method: req.method, headers, body, redirect: 'error' })
  console.log(JSON.stringify({ gateway: 'model', user: account.u.id, email: account.u.email, path: path.split('?')[0], status: upstream.status }))
  const out = {}
  for (const [name, value] of upstream.headers) {
    if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'set-cookie'].includes(name)) out[name] = value
  }
  res.writeHead(upstream.status, out)
  if (upstream.body === null) return void res.end()
  Readable.fromWeb(upstream.body).on('error', () => res.destroy()).pipe(res)
}

async function handle(req, res) {
  const url = new URL(req.url ?? '/', API)
  const path = url.pathname
  const account = verify('tok', req.headers['x-dsh-auth-token'])
  const post = async () => JSON.parse((await readBody(req, 65_536)).toString('utf8') || '{}')

  if (req.method === 'POST' && path === '/auth-api/v0/dsh/auth_init') {
    const b = await post()
    if (b.code_challenge_method !== 'S256' || typeof b.code_challenge !== 'string' || typeof b.state !== 'string' || !loopbackCallback(b.redirect_uri)) {
      return json(res, 400, { code: 400, msg: 'invalid request' })
    }
    const aid = sign('aid', { ch: b.code_challenge, st: b.state, ru: b.redirect_uri }, 600)
    return json(res, 200, ok({ authorize_url: `${API}/dsh/authorize?aid=${aid}`, authorize_id: aid, expires_in: 600 }))
  }
  if (req.method === 'GET' && path === '/dsh/authorize') {
    if (!verify('aid', url.searchParams.get('aid'))) return json(res, 400, { error: 'expired' })
    // The login page's existing return URL keeps the authorization_id parameter; the dsh. prefix selects desktop mode.
    res.writeHead(302, { location: `${APP}/oauth/consent?authorization_id=dsh.${url.searchParams.get('aid')}`, 'cache-control': 'no-store' }).end()
    return
  }
  if (req.method === 'POST' && path === '/dsh/approve') {
    const b = await post()
    const attempt = verify('aid', b.aid)
    if (!attempt) return json(res, 400, { error: 'This sign-in link expired. Start again from the mumbo app.' })
    const user = typeof b.access_token === 'string' ? await supabaseUser(b.access_token) : undefined
    if (!user) return json(res, 401, { error: 'Sign-in failed. Try again.' })
    console.log(JSON.stringify({ gateway: 'sign-in', user: user.id, email: user.email }))
    const code = sign('code', { ch: attempt.ch, ru: attempt.ru, u: user }, 120)
    return json(res, 200, { redirect: `${attempt.ru}?code=${code}&state=${encodeURIComponent(attempt.st)}` })
  }
  if (req.method === 'POST' && path === '/auth-api/v0/dsh/auth_exchange') {
    const b = await post()
    const grant = verify('code', b.code)
    if (!grant || typeof b.code_verifier !== 'string' || b.redirect_uri !== grant.ru
      || createHash('sha256').update(b.code_verifier).digest('base64url') !== grant.ch) {
      return json(res, 200, { code: 0, data: { biz_code: 1, biz_msg: 'invalid code', biz_data: null } })
    }
    return json(res, 200, ok({ token: sign('tok', { u: grant.u }, TOKEN_TTL), authorized_url: `${API}/dsh/authorized`, user: profile(grant.u) }))
  }
  if (req.method === 'POST' && path === '/auth-api/v0/dsh/auth_cancel') return json(res, 200, ok(null))
  if (req.method === 'GET' && path === '/dsh/authorized') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    return void res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>mumbo</title>'
      + '<body style="font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0"><p>Signed in to mumbo. You can close this tab and return to the app.</p>')
  }
  if (req.method === 'GET' && path === '/healthz') return json(res, 200, { ok: true })

  // Everything below needs a valid account token; 401 makes the app sign out and offer sign-in again.
  if (!account) return json(res, 401, { code: 40003, msg: 'sign in again' })
  if (req.method === 'GET' && path === '/auth-api/v0/users/current') return json(res, 200, ok(profile(account.u)))
  if (req.method === 'GET' && path === '/api/v0/users/get_user_summary') return json(res, 200, ok({ normal_wallets: [], bonus_wallets: [] }))
  if (req.method === 'GET' && path === '/api/v0/users/get_unnotified_bonuses') return json(res, 200, ok([]))
  if (req.method === 'POST' && ['/api/v0/users/ack_bonus_notified', '/auth-api/v0/users/logout'].includes(path)) return json(res, 200, ok(null))
  if (req.method === 'GET' && path === '/models') return json(res, 200, MODELS)
  if (path.startsWith('/anthropic/')) return proxyModel(req, res, account, `${path}${url.search}`)
  return json(res, 404, { error: 'not found' })
}

if (process.argv[2] === '--selftest') {
  const code = sign('code', { ch: 'x' }, 60)
  console.assert(verify('code', code)?.ch === 'x', 'round trip')
  console.assert(verify('tok', code) === undefined, 'type confusion')
  console.assert(verify('code', `${code.split('.')[0]}.${mac('other')}`) === undefined, 'forged signature')
  console.assert(verify('code', sign('code', {}, -1)) === undefined, 'expired')
  console.assert(loopbackCallback('http://127.0.0.1:5123/oauth/callback') && !loopbackCallback('https://evil.example/oauth/callback'), 'redirect')
  console.log('gateway selftest done')
} else {
  createServer((req, res) => {
    handle(req, res).catch((error) => {
      console.error('gateway:', error.message)
      if (!res.headersSent) json(res, error.status ?? 502, { error: 'gateway error' })
      else res.destroy()
    })
  }).listen(4300, '127.0.0.1', () => console.log('gateway: listening on 127.0.0.1:4300'))
}
