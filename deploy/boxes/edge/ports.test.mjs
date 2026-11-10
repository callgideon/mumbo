// node --test deploy/boxes/edge/ports.test.mjs
// The box ports of dsh and the live view (B24): a box from a template with the ports marker runs them on PORTS, one
// before it on OLD_PORTS. The edge records a box's pair when it creates or repairs it and routes every request by the
// record; a record without one is a box from before, on OLD_PORTS. The start script reads the same marker.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PORTS, OLD_PORTS, PORTS_MARKER, portsFrom, boxes, userServer, startScript, boxSite } from './edge.mjs'
import { PORTS_STEP } from './template.mjs'
import { memoryStore } from './store.mjs'

const cfg = { pageAfterMs: 3000, publicHost: 'boxes.example', projectDomain: 'boxes.example', llmHost: 'llm.example', template: 'mumbo-box', idleMs: 60_000, backupEveryMs: 600_000, maxRunningUnits: 10, allowed: ['@x.com'], egressIps: [], signinCookie: '_oauth2_proxy_mumbo' }

/** E2B with boxes whose marker reads `marker` ('' for a template without one); `ran` collects every command. */
function fakeE2B(marker) {
  const made = [], ran = []
  const box = (id) => ({ sandboxId: id, files: { write: async () => {} }, kill: async () => {}, commands: { run: async (c) => { ran.push(c); return { stdout: c.includes('dsh.log') ? 'launch123' : c.includes(PORTS_MARKER) ? marker : c.startsWith('curl') ? '200' : '' } } } })
  return {
    made, ran,
    Sandbox: {
      list: () => ({ hasNext: true, nextItems: async function () { this.hasNext = false; return made.map(m => ({ sandboxId: m.id, state: 'running', startedAt: '1' })) } }),
      create: async (tpl, opts) => { const id = `b${made.length + 1}`; made.push({ id, opts }); return box(id) },
      connect: async (id) => box(id),
      setTimeout: async () => {},
      getInfo: async () => ({ network: {} }),
    },
  }
}

test('ports: the marker names the pair, its absence is the old one, and anything else fails the create', () => {
  assert.deepEqual([PORTS, OLD_PORTS], [{ dsh: '880', live: '881' }, { dsh: '3080', live: '6080' }])
  assert.deepEqual(portsFrom('880 881\n'), PORTS)
  assert.deepEqual(portsFrom(''), OLD_PORTS)
  for (const bad of ['880', '880 881 882', 'x y', '880\t881']) assert.throws(() => portsFrom(bad), /box ports marker/, bad)
  // The template writes the marker from PORTS, so the template, the start script and the edge agree.
  const t = mkdtempSync(join(tmpdir(), 'marker-'))
  try {
    execFileSync('sh', ['-c', PORTS_STEP.replaceAll('/usr/local/share/mumbo', t)])
    assert.deepEqual(portsFrom(execFileSync('cat', [join(t, 'ports')], { encoding: 'utf8' })), PORTS)
  } finally { rmSync(t, { recursive: true, force: true }) }
})

test('create records the box\'s pair from its template; a record without one learns it at its next repair, which checks dsh on it', async () => {
  for (const [marker, ports] of [['880 881\n', PORTS], ['', OLD_PORTS]]) {
    const e2b = fakeE2B(marker), store = memoryStore()
    const b = boxes({ e2b, store, cfg, edgeKey: 'k', presignGet: async () => undefined, presignPut: async () => 'P', log: () => {} })
    const { id, ports: picked, token } = await b.ensure('a@x.com')
    assert.deepEqual([(await store.getBox(id)).ports, picked, token], [ports, ports, 'launch123'], 'the launch token is read from dsh\'s log whichever the port')
    assert.ok(e2b.ran.includes('chmod 0700 /root/.mumbo/start.sh && /root/.mumbo/start.sh'), 'the script, which holds the box token, is root\'s alone')
    // A record without ports (an edge before B24 made it, or a box adopted from E2B) and no launch token: repaired.
    await store.putBox(id, { email: 'a@x.com', active: Date.now(), extended: Date.now(), backedUp: 0, paused: true })
    e2b.ran.length = 0
    assert.deepEqual((await b.ensure('a@x.com')).ports, ports)
    assert.deepEqual((await store.getBox(id)).ports, ports)
    assert.ok(e2b.ran.some(c => c.startsWith('curl') && c.includes(`):${ports.dsh}/`)), 'dsh is checked on its own port')
  }
})

test('a running box\'s record without ports is a box from before the marker: its requests go to the old pair', async () => {
  const e2b = fakeE2B('880 881\n'), store = memoryStore()
  const b = boxes({ e2b, store, cfg, edgeKey: 'k', presignGet: async () => undefined, presignPut: async () => 'P', log: () => {} })
  const { id } = await b.ensure('a@x.com')
  await store.patchBox(id, { ports: undefined })
  assert.equal((await b.ensure('a@x.com')).ports, undefined)
})

/** userServer over a fake box behind the client-proxy address; the box answers on whatever port E2B names. */
async function serve(ports) {
  const seen = []
  const upstream = createServer((req, res) => { seen.push([req.method, req.url, req.headers['e2b-sandbox-port']]); res.writeHead(200, { 'content-type': 'text/html' }).end('box') })
  upstream.on('upgrade', (req, socket) => { seen.push(['UPGRADE', req.url, req.headers['e2b-sandbox-port']]); socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n') })
  await new Promise(r => upstream.listen(0, '127.0.0.1', r))
  const box = { ensure: async () => ({ id: 'ubox', token: 'T', host: 'boxes.example', ...(ports ? { ports } : {}) }), touch: async () => {}, forget: async () => {} }
  const server = userServer({ cfg: { ...cfg, approveHost: 'approve.example', proxy: new URL(`http://127.0.0.1:${upstream.address().port}`) }, box, log: () => {} })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const call = ({ method = 'GET', path = '/', headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: server.address().port, method, path, headers: { host: cfg.publicHost, 'x-forwarded-email': 'a@x.com', ...headers } }, (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location })) })
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve({ status: 101 }) })
    req.on('error', reject); req.end()
  })
  return { seen, call, close: () => { server.close(); upstream.close() } }
}

test('routing by the record: dsh and its launch redirect, the live view, its Origin check and its WebSocket, on 880/881 or on 3080/6080', async () => {
  for (const [ports, dsh, live] of [[PORTS, '880', '881'], [undefined, '3080', '6080']]) {
    const s = await serve(ports)
    try {
      // dsh without a cookie or token: the launch exchange (needsLaunch), then dsh itself on its port.
      assert.deepEqual(await s.call({ headers: { accept: 'text/html' } }), { status: 302, location: '/?token=T' })
      assert.equal((await s.call({ headers: { cookie: 'dsh-auth-x=1' } })).status, 200)
      assert.equal((await s.call({ path: '/desktop/vnc.html' })).status, 200)
      // The live view takes no write from another origin, and its WebSocket only from its own.
      assert.equal((await s.call({ method: 'POST', path: '/desktop/x', headers: { origin: 'https://evil.example' } })).status, 403)
      assert.equal((await s.call({ method: 'POST', path: '/desktop/x', headers: { origin: `https://${cfg.publicHost}` } })).status, 200)
      assert.equal((await s.call({ path: '/desktop/websockify', headers: { origin: `https://${cfg.publicHost}`, connection: 'Upgrade', upgrade: 'websocket' } })).status, 101)
      assert.deepEqual(s.seen, [['GET', '/', dsh], ['GET', '/vnc.html', live], ['POST', '/x', live], ['UPGRADE', '/websockify', live]])
    } finally { s.close() }
  }
})

test('the start script runs dsh and KasmVNC on the marker\'s pair, or the old one without a marker', () => {
  const s = startScript(cfg, 'T', boxSite(cfg, 'a@x.com'), 'role', undefined, {})
  const head = s.slice(s.indexOf('B24_TEMPLATE= DSH_PORT'), s.indexOf('\n', s.indexOf(`if [ -e ${PORTS_MARKER} ]`)) + 1)
  assert.equal(head, `B24_TEMPLATE= DSH_PORT=${OLD_PORTS.dsh} LIVE_PORT=${OLD_PORTS.live}\nif [ -e ${PORTS_MARKER} ]; then B24_TEMPLATE=1; read -r DSH_PORT LIVE_PORT < ${PORTS_MARKER}; fi\n`)
  const t = mkdtempSync(join(tmpdir(), 'ports-'))
  try {
    const run = () => execFileSync('sh', ['-c', `set -eu\n${head.replaceAll(PORTS_MARKER, join(t, 'ports'))}echo "$B24_TEMPLATE $DSH_PORT $LIVE_PORT"`], { encoding: 'utf8' })
    assert.equal(run(), ' 3080 6080\n')
    writeFileSync(join(t, 'ports'), `${PORTS.dsh} ${PORTS.live}\n`)
    assert.equal(run(), '1 880 881\n')
  } finally { rmSync(t, { recursive: true, force: true }) }
  assert.match(s, / --port \$DSH_PORT /)
  assert.match(s, / -interface \$ip -websocketPort \$LIVE_PORT /)
  const commands = s.replace(head, '').split('\n').filter(l => !l.trimStart().startsWith('#')).join('\n')
  assert.ok(!/\b(3080|6080)\b/.test(commands), 'the old numbers appear only in the fallback')
})
