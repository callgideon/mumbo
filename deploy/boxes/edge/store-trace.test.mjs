// node --test: the edge's sequential store round trips per request path (spec R6b, trace first), through the real handlers
// over testing/store-trace.mjs, a store whose every round trip answers after a fixed latency. Each path runs cold (a new
// edge process: empty placement cache, no last-use write yet) and then warm (the same request again on that edge), against a
// person whose box runs and whose records exist, as the founder's did when R6 measured the Mumbai edge, with a project whose
// box runs too and which the door key reaches. The edge has the
// Mumbai edge's settings (EDGE_REGION ap-south-1, PLACEMENT_CACHE_MS 30000, so the read cache is on and subscribed); E2B and
// the box are local stubs that answer at once. The counts asserted: depth, the round trips the answer waited for one after
// another, and total, every store call the request caused, the unawaited ones included. STORE_TRACE=<file> writes each
// path's levels there as Markdown.
import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { test } from 'node:test'
import { door, doorTools, mumboForwarder } from './door.mjs'
import { budget, tokenBudget } from './budget.mjs'
import { admitted, boxes, boxFetcher, boxSite, modelServer, PORTS, signBox, userServer } from './edge.mjs'
import { haltService } from './halt.mjs'
import { doorKeys } from './keys.mjs'
import { projectRelay, projects, RELAY_PATH } from './projects.mjs'
import { tracedStore } from './testing/store-trace.mjs'

const EMAIL = 'founder@x.com', BOX = 'sbx-founder', PBOX = 'sbx-project', PUBLIC = 'app.example', LLM = 'llm.app.example', EDGE_KEY = 'edge-key'
const cfg = { publicHost: PUBLIC, projectDomain: PUBLIC, llmHost: LLM, allowed: ['@x.com'], egressIps: [], openrouterModels: [], upstream: 'https://model.example',
  pageAfterMs: 3000, idleMs: 3_600_000, template: 'mumbo-box', signinCookie: '_oauth2_proxy_mumbo', edgeRegion: 'ap-south-1', placementCacheMs: 30_000 }
const silent = () => {}
const listen = (server) => new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port)))

/** The box behind the client-proxy address: @mumbo/mcp's door answers a tools/call, a project box's Superagent its relay
 *  route and management API, dsh any page, the live view upgrades. */
function stubBox() {
  const json = (res, value) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value))
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c }).on('end', () => {
      const path = req.url.split('?')[0]
      if (path === '/mcp') return json(res, { jsonrpc: '2.0', id: JSON.parse(body).id, result: { content: [{ type: 'text', text: '{"messages":[]}' }] } })
      if (path === RELAY_PATH) return json(res, { trigger: 'T1', thread: 'H1', result: 'queued' })
      if (path === '/orchestrator/api/overview') return json(res, { problems: [], person: [], executor: { running: 0, queued: 0, idle: 1, maxWorkers: 1 } })
      if (path === '/orchestrator/api/tickets') return json(res, { items: [], total: 0 })
      res.writeHead(200, { 'content-type': 'text/plain' }).end('from the box')
    })
  })
  server.on('upgrade', (req, socket) => socket.end('HTTP/1.1 101 Switching Protocols\r\nconnection: Upgrade\r\nupgrade: websocket\r\n\r\n'))
  return server
}

/** An Anthropic Messages stream in three chunks: message_start with input usage, a text delta, message_delta with output. */
const anthropicStream = () => new Response(new ReadableStream({
  start(c) {
    for (const e of [
      { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } },
      { type: 'message_delta', usage: { output_tokens: 5 } },
    ]) c.enqueue(new TextEncoder().encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`))
    c.close()
  },
}), { headers: { 'content-type': 'text/event-stream' } })

/** One request; marks `first byte` at the first body chunk (or the 101) and `end` once the answer is complete. */
const send = (port, mark, { method = 'GET', path = '/', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
    let text = ''
    res.on('data', (c) => { if (!text) mark('first byte'); text += c }).on('end', () => { mark('end'); resolve({ status: res.statusCode, text }) })
  })
  req.on('upgrade', (res, socket) => { mark('first byte'); mark('end'); socket.destroy(); resolve({ status: res.statusCode }) })
  req.on('error', reject)
  req.end(body)
})

/** Markdown for one path: its counts, then each run's commands by level. */
function table(name, runs) {
  const row = (run, c) => `| ${run} | ${c.level} | ${c.name} | \`${c.key}\` | ${c.method} | ${c.at} | ${c.off ? 'no' : 'yes'} |`
  return [`### ${name}`, '', '| Path | Cold depth | Cold total | Warm depth | Warm total |', '|---|---|---|---|---|',
    `| ${name} | ${runs.cold.depth('end')} | ${runs.cold.commands.length} | ${runs.warm.depth('end')} | ${runs.warm.commands.length} |`, '',
    '| Run | Level | Command | Key | Store method | Issued at | Awaited |', '|---|---|---|---|---|---|---|',
    ...['cold', 'warm'].flatMap(run => runs[run].commands.toSorted((a, b) => a.level - b.level).map(c => row(run, c))), ''].join('\n')
}

test('the traced store: commands issued together are one level, a command after a reply is the next; off-path commands count in no depth', async () => {
  const t = tracedStore({ latencyMs: 5 })
  const { commands, depth } = await t.trace(async (mark) => {
    await Promise.all([t.store.getDoc('a'), t.store.getCount('b')])
    t.offPath(async () => { await t.store.getBox('x'); await t.store.getBox('y') })
    await t.store.patchBox('z', {})
    mark('end')
  })
  assert.deepEqual(commands.map(c => [c.level, c.name, c.key, c.method, c.off]),
    [[1, 'GET', 'doc:a', 'getDoc', false], [1, 'GET', 'b', 'getCount', false], [2, 'GET', 'box:x', 'getBox', true], [2, 'GET', 'box:z', 'patchBox', false], [3, 'GET', 'box:y', 'getBox', true]])
  assert.equal(depth('end'), 2)
})

test('store round trips per request path, cold and warm, at the Mumbai edge\'s settings', async () => {
  const proxy = stubBox()
  const proxyUrl = new URL(`http://127.0.0.1:${await listen(proxy)}`)
  // Stand-in values, replaced by their names in the keys the trace shows.
  const names = [[EMAIL, '<email>'], [PBOX, '<project box>'], [BOX, '<box>']]
  const t = tracedStore({ latencyMs: 50, names })
  const { store } = t
  // The records the founder had: a person doc, a running box with its record, a door key, a project with its own box.
  const proj = projects({ store, admitted: () => true, log: silent })
  await store.putDoc(`person:${EMAIL}`, { region: 'us-east-1', at: Date.now() })
  const P = (await proj.create(EMAIL, 'Mine')).id
  const keys = doorKeys({ store, projects: proj, admitted: (e) => admitted(cfg.allowed, e), log: silent })
  const { key, record } = await keys.mint(EMAIL, { name: 'laptop', scopes: ['read', 'prompt'], projects: [P] })
  names.push([P, '<project>'], [record.id, '<key id>'])
  const now = Date.now(), running = { region: 'us-east-1', traffic: 'TT', ports: PORTS, active: now, extended: now, backedUp: now, paused: false }
  await store.putBox(BOX, { ...running, email: EMAIL, host: PUBLIC, launch: 'L', memberAuth: false })
  await store.putBox(PBOX, { ...running, email: `project:${P}`, host: `p-${P}.${PUBLIC}`, launch: 'LP', memberAuth: true })
  const listed = [[BOX, EMAIL], [PBOX, `project:${P}`]].map(([sandboxId, user]) => ({ sandboxId, metadata: { user }, state: 'running', startedAt: '0' }))
  const Sandbox = {
    list: ({ query }) => { let more = true; return { get hasNext() { return more }, nextItems: async () => { more = false; return listed.filter(s => s.metadata.user === query.metadata?.user && query.state.includes(s.state)) } } },
    setTimeout: async () => {},
  }
  const cells = new Map(['us-east-1', 'ap-south-1'].map(region => [region, { region, Sandbox, proxy: proxyUrl, bucket: `b-${region}`, maxUnits: 0, presignGet: async () => undefined, presignPut: async () => 'P' }]))

  /** A new edge process over the shared data, wired as main() wires it: its own store with the read cache on at
   *  PLACEMENT_CACHE_MS and subscribed. The box touches, the budgets' additions (a call's charge, the meter's token
   *  counts) and a door key's last-use write, which the code fires and forgets (budget.test.mjs and keys.test.mjs show
   *  they hold nothing up), are flagged off the path. */
  async function edge() {
    const store = await t.connect({ cacheMs: cfg.placementCacheMs })
    const proj = projects({ store, admitted: () => true, log: silent })
    const box = boxes({ cells, store, cfg, edgeKey: EDGE_KEY, log: silent })
    const traced = { ...box, touch: (id) => t.offPath(() => box.touch(id)) }
    const lastUse = { ...store, putDoc: (k, v) => (k.startsWith('key-used:') ? t.offPath(() => store.putDoc(k, v)) : store.putDoc(k, v)) }
    const keys = doorKeys({ store: lastUse, projects: proj, admitted: (e) => admitted(cfg.allowed, e), log: silent })
    const siteHostOf = (p) => boxSite(cfg, p).host
    const mumbo = mumboForwarder({ box: traced, boxFetch: boxFetcher(cfg), edgeKey: EDGE_KEY, siteHostOf, log: silent })
    const relay = projectRelay({ projects: proj, box: traced, boxFetch: boxFetcher(cfg), siteHostOf, edgeHost: PUBLIC, log: silent })
    const counters = { ...store, increment: (...a) => t.offPath(() => store.increment(...a)), incrementBy: (...a) => t.offPath(() => store.incrementBy(...a)) }
    const requests = budget({ store: counters, limit: 1e6 })
    const tokens = tokenBudget({ store: counters, limits: { user: 1e9, project: 1e9 }, now: Date.now })
    const front = door({ keys, tools: doorTools({ projects: proj, mumbo, relay }), requests, tokens, rate: { perMinute: 60, burst: 100 }, log: silent })
    const model = modelServer({ cfg, edgeKey: EDGE_KEY, modelKey: 'SERVER', requests, owns: box.owns, touch: traced.touch, door: front, halt: haltService({ store }), tokens,
      fetchImpl: async () => anthropicStream(), log: silent })
    const users = userServer({ cfg, box: traced, projects: proj, log: silent })
    const ports = { model: await listen(model), users: await listen(users) }
    return { ports, close: () => { for (const s of [model, users]) { s.close(); s.closeAllConnections() } return store.close() } }
  }

  const tool = (name, args) => ({ method: 'POST', path: '/mcp', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    headers: { host: PUBLIC, authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' } })
  const browser = { 'x-forwarded-email': EMAIL, cookie: 'dsh-auth-abc=v', accept: 'text/html' }
  const paths = {
    '(a) door: agent_read': ['model', tool('agent_read', { after_seq: 0 })],
    '(a) door: agent_send (charged to the budgets)': ['model', tool('agent_send', { text: 'hi', request_id: 'r1' })],
    '(b) app request: the person\'s box': ['users', { headers: { host: PUBLIC, ...browser } }],
    '(b) app request: a project\'s box': ['users', { headers: { host: `p-${P}.${PUBLIC}`, ...browser } }],
    '(c) model host call (streamed)': ['model', { method: 'POST', path: '/anthropic/v1/messages', body: '{}', headers: { host: LLM, 'x-api-key': signBox(EDGE_KEY, EMAIL, BOX), 'content-type': 'application/json' } }],
    '(c) model host call, project box (streamed)': ['model', { method: 'POST', path: '/anthropic/v1/messages', body: '{}', headers: { host: LLM, 'x-api-key': signBox(EDGE_KEY, `project:${P}`, PBOX), 'content-type': 'application/json' } }],
    '(d) live view connect': ['users', { path: '/desktop/websockify', headers: { host: PUBLIC, origin: `https://${PUBLIC}`, 'x-forwarded-email': EMAIL, connection: 'Upgrade', upgrade: 'websocket' } }],
    '(e) door: project_status': ['model', tool('project_status', { project: P })],
    '(e) door: project_message (charged to the budgets, through the relay)': ['model', tool('project_message', { project: P, message: 'hi', messageId: 'm1' })],
  }
  const counts = {}, out = []
  try {
    for (const [name, [listener, req]] of Object.entries(paths)) {
      const e = await edge()
      const run = () => t.trace(async (mark) => {
        const r = await send(e.ports[listener], mark, req)
        assert.ok([101, 200].includes(r.status) && !r.text?.includes('"isError":true'), `${name}: ${r.status} ${r.text}`)
      })
      const runs = { cold: await run(), warm: await run() }
      await e.close()
      counts[name] = Object.fromEntries(Object.entries(runs).map(([k, r]) => [k, [r.depth('end'), r.commands.length]]))
      if (name.startsWith('(c)')) counts[name].firstByte = [runs.cold.depth('first byte'), runs.warm.depth('first byte')]
      out.push(table(name, runs))
    }
  } finally { proxy.close(); proxy.closeAllConnections() }
  if (process.env.STORE_TRACE) appendFileSync(process.env.STORE_TRACE, out.join('\n'))
  // [depth, total] per run; for the stream, the depth at its first byte, cold and warm.
  assert.deepEqual(counts, {
    '(a) door: agent_read': { cold: [3, 7], warm: [0, 3] },
    '(a) door: agent_send (charged to the budgets)': { cold: [4, 10], warm: [0, 4] },
    '(b) app request: the person\'s box': { cold: [2, 5], warm: [0, 3] },
    '(b) app request: a project\'s box': { cold: [2, 5], warm: [0, 3] },
    '(c) model host call (streamed)': { cold: [1, 10], warm: [0, 6], firstByte: [1, 0] },
    '(c) model host call, project box (streamed)': { cold: [2, 11], warm: [0, 6], firstByte: [2, 0] },
    '(d) live view connect': { cold: [2, 5], warm: [0, 3] },
    '(e) door: project_status': { cold: [3, 4], warm: [0, 0] },
    '(e) door: project_message (charged to the budgets, through the relay)': { cold: [4, 7], warm: [0, 1] },
  })
})
