// End-to-end check of the edge router against a live E2B: create a user's box, run the launch-token exchange,
// load the page, open the dsh WebSocket with the browser's Origin, then pause and come back.
// Run from the repo root with E2B_API_URL / E2B_SANDBOX_URL / E2B_API_KEY set.
import * as e2b from '../edge/node_modules/e2b/dist/index.mjs'
import { boxes, userServer } from '../edge/edge.mjs'

const cfg = { publicHost: 'boxes.mumbo.si', llmHost: 'llm.boxes.mumbo.si', template: 'mumbo-box', idleMs: 600_000, backupEveryMs: 600_000, maxRunning: 5,
  allowed: ['@mumbo.si'], egressIps: [], proxy: new URL(process.env.E2B_SANDBOX_URL), bucket: 'unused', upstream: 'https://api.deepseek.com' }
const user = `e2e-${Date.now()}@mumbo.si`
const box = boxes({ e2b, cfg, edgeKey: 'e2e-key', presignGet: async () => undefined, presignPut: async () => 'http://127.0.0.1:9/none', log: () => {} })
const server = userServer({ cfg, box, log: (l) => console.log('  log', l) })
await new Promise(r => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`
const H = { 'x-forwarded-email': user, accept: 'text/html' }
const t = async (label, fn) => { const s = performance.now(); const r = await fn(); console.log(`${label}: ${Math.round(performance.now() - s)} ms`); return r }
let ok = true
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name} ${extra}`); ok &&= cond }

const first = await t('first visit (create box, start dsh)', () => fetch(`${base}/`, { headers: H, redirect: 'manual' }))
check('cookie-less visit goes to token exchange', first.status === 302 && /^\/\?token=/.test(first.headers.get('location')), String(first.status))
const exchange = await fetch(`${base}${first.headers.get('location')}`, { headers: H, redirect: 'manual' })
const cookie = (exchange.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0]).join('; ')
check('token exchange sets a Secure dsh cookie', /dsh-auth-/.test(cookie) && (exchange.headers.getSetCookie?.() ?? []).every(c => /;\s*Secure/i.test(c)), String(exchange.status))
const page = await fetch(`${base}/`, { headers: { ...H, cookie } })
check('page loads with the cookie', page.status === 200 && (await page.text()).includes('<'), String(page.status))
const otherUser = await fetch(`${base}/`, { headers: { 'x-forwarded-email': 'stranger@evil.com' }, redirect: 'manual' })
check('non-allowlisted user gets no box', otherUser.status === 403, String(otherUser.status))

const { request } = await import('node:http')
const ws = await new Promise((resolve) => {
  const req = request(`${base}/api/remote.mux`, { headers: { ...H, cookie, origin: 'https://boxes.mumbo.si', connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' } })
  req.on('upgrade', (res, sock) => { sock.destroy(); resolve('open') })
  req.on('response', (res) => { let b = ''; res.on('data', c => { b += c }); res.on('end', () => resolve(`http ${res.statusCode} ${b.slice(0, 160)}`)) })
  req.on('error', (e) => resolve(`error ${e.message}`)); setTimeout(() => resolve('timeout'), 15_000); req.end()
})
check('dsh stream WebSocket (/api/remote.mux) opens with the browser Origin', ws === 'open', ws)

const { id } = await box.ensure(user)
await t('pause box', () => e2b.Sandbox.pause(id))
box.state.get(id).paused = true
const back = await t('visit after pause (resume)', () => fetch(`${base}/`, { headers: { ...H, cookie } }))
check('resumed box serves the page with the same cookie', back.status === 200, String(back.status))
await e2b.Sandbox.kill(id)
server.close()
process.exit(ok ? 0 : 1)
