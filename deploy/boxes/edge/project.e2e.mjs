// Live check of a shared project box against real E2B (tunnel to api :13000 and client-proxy :13002): a member is
// routed to the project box under /p/<id>/, signs in, loads the page and assets, opens the dsh WebSocket; a
// non-member is refused. Env: E2B_API_URL, E2B_SANDBOX_URL, E2B_API_KEY.
import * as e2b from 'e2b'
import { boxes, userServer } from './edge.mjs'
import { memoryStore } from './store.mjs'
import { projects } from './projects.mjs'
const cfg = { publicHost: 'boxes.mumbo.si', llmHost: 'llm.boxes.mumbo.si', template: 'mumbo-box', idleMs: 3600_000, backupEveryMs: 3600_000, maxRunning: 0,
  allowed: ['@mumbo.si'], egressIps: [], proxy: new URL(process.env.E2B_SANDBOX_URL), bucket: 'unused', pauseIdle: false }
const store = memoryStore()
const box = boxes({ e2b, store, cfg, edgeKey: 'e2e-key', presignGet: async () => undefined, presignPut: async () => 'http://127.0.0.1:9/none', log: () => {} })
const proj = projects({ store, admitted: (e) => e.endsWith('@mumbo.si'), log: () => {} })
const user = `e2e-${Date.now()}@mumbo.si`
const { id } = await proj.create(user, 'e2e project')
const server = userServer({ cfg, box, projects: proj, log: (l) => console.log('  log', l) })
await new Promise(r => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`
const H = { 'x-forwarded-email': user, accept: 'text/html' }
let ok = true; const check = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'} ${n} ${x}`); ok &&= c }
let t = performance.now()
const first = await fetch(`${base}/p/${id}/`, { headers: H, redirect: 'manual' })
console.log(`first visit ${Math.round(performance.now() - t)} ms`)
check('first visit goes to the project launch token', first.status === 302 && first.headers.get('location').startsWith(`/p/${id}/?token=`), first.headers.get('location'))
const ex = await fetch(base + first.headers.get('location'), { headers: H, redirect: 'manual' })
const cookie = (ex.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0]).join('; ')
check('token exchange sets a cookie and redirects inside the project', /dsh-auth-/.test(cookie) && ['./', `/p/${id}/`].includes(String(ex.headers.get('location'))), `${ex.status} -> ${ex.headers.get('location')}`)
const page = await fetch(`${base}/p/${id}/`, { headers: { ...H, cookie } })
const html = await page.text()
check('project page loads with the cookie', page.status === 200 && html.includes('<'), String(page.status))
const assets = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(m => m[1].replaceAll('&amp;', '&')).filter(u => !u.startsWith('http') && !u.startsWith('data:')).slice(0, 4)
console.log('asset refs:', assets.length)
for (const a of assets.slice(0, 2)) { const u = a.startsWith('/') ? a : `/p/${id}/${a.replace(/^\.\//, '')}`; const r = await fetch(base + u, { headers: { ...H, cookie } }); check(`asset ${u}`, r.status === 200 && u.startsWith(`/p/${id}/`), String(r.status)) }
const { request } = await import('node:http')
const ws = await new Promise((resolve) => {
  const req = request(`${base}/p/${id}/api/remote.mux`, { headers: { ...H, cookie, origin: 'https://boxes.mumbo.si', connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' } })
  req.on('upgrade', (r, sock) => { sock.destroy(); resolve('open') })
  req.on('response', (r) => resolve(`http ${r.statusCode}`)); req.on('error', (e) => resolve(e.message)); setTimeout(() => resolve('timeout'), 15000); req.end()
})
check('dsh WebSocket opens under the project path', ws === 'open', ws)
// Relay: the edge's own path (projectRelay over boxFetcher) creates the coordinator session and prompts it.
const { projectRelay } = await import('./projects.mjs')
const { boxFetcher, boxSite } = await import('./edge.mjs')
const relay = projectRelay({ store, projects: proj, box, boxFetch: boxFetcher(cfg), siteHostOf: (p) => boxSite(cfg, p).host, log: () => {} })
const sent = await relay.message(user, id, 'hello coordinator').catch(e => ({ error: e.message }))
check('relay: message delivered into a coordinator session', sent.delivered === true && /^session-/.test(sent.coordinatorSession ?? ''), JSON.stringify(sent))
const again = await relay.message(user, id, 'second message').catch(e => ({ error: e.message }))
check('relay: second message reuses the same session', again.coordinatorSession === sent.coordinatorSession, JSON.stringify(again))
const pbox = (await store.listBoxes()).find(b => b.email === `project:${id}`)
const role = (await (await e2b.Sandbox.connect(pbox.id)).commands.run("head -1 /root/.mumbo/agents/AGENTS.md; tr '\\0' '\\n' < /proc/$(pgrep -f 'apps/cli/src/bin.ts' | head -1)/environ | grep DSH_AGENTS_HOME")).stdout
check('project box runs dsh with the coordinator role', role.includes('# Project coordinator') && role.includes('DSH_AGENTS_HOME=/root/.mumbo/agents'), JSON.stringify(role))
const stranger = await fetch(`${base}/p/${id}/`, { headers: { ...H, 'x-forwarded-email': 'other@mumbo.si' }, redirect: 'manual' })
check('non-member refused', stranger.status === 404, String(stranger.status))
const rec = (await store.listBoxes()).find(b => b.email === `project:${id}`)
await e2b.Sandbox.kill(rec.id)
server.close(); process.exit(ok ? 0 : 1)
