// node --test: the model host's OpenRouter route (/openrouter/v1/…) against a local fake upstream.
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { test } from 'node:test'
import { modelServer, signBox, startScript } from './edge.mjs'
import { tokenBudget } from './budget.mjs'
import { memoryStore } from './store.mjs'

const MODELS = ['qwen/qwen3.8-27b', 'qwen/qwen3.5-9b']
const cfg = { llmHost: 'llm.example', publicHost: 'boxes.example', projectDomain: 'boxes.example', egressIps: ['1.2.3.4'], upstream: 'https://model.example', openrouterModels: MODELS, openrouterKey: 'OR-KEY', openrouterZdr: true }
const TOKEN = signBox('k', 'a@x.com', 'b1')
const listen = (server) => new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port)))
const call = (port, { method = 'POST', path = '/openrouter/v1/chat/completions', headers = { authorization: `Bearer ${TOKEN}` }, body } = {}) => new Promise((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port, method, path, headers: { 'x-forwarded-for': '1.2.3.4', 'content-type': 'application/json', ...headers } }, (res) => {
    let data = ''; res.on('data', c => { data += c }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }))
  })
  req.on('error', reject); req.end(body)
})
const sse = (...events) => new Response(events.map(e => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } })

/** A model server over a fake upstream; `respond(url, init)` answers each forwarded request. */
async function host({ respond = () => Response.json({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }), halted = false, allow = async () => true, limit = 1e9, config = cfg } = {}) {
  const seen = []; const store = memoryStore()
  const tokens = tokenBudget({ store, limits: { user: limit, project: limit }, now: () => Date.parse('2026-11-09T12:00:00Z') })
  const fetchImpl = async (url, init) => { seen.push({ url, init, body: init.body === undefined ? undefined : JSON.parse(init.body) }); return respond(url, init) }
  const server = modelServer({ cfg: config, edgeKey: 'k', modelKey: 'DEEPSEEK-KEY', allow, owns: async (u, b) => u === 'a@x.com' && b === 'b1', touch: () => {}, fetchImpl, log: () => {}, tokens, halt: { isHalted: async () => halted } })
  const port = await listen(server)
  return { port, seen, store, close: () => server.close(), counted: () => store.getCount('tokens:2026-11-09:a@x.com') }
}
const chat = (extra = {}) => JSON.stringify({ model: MODELS[0], messages: [{ role: 'user', content: 'hi' }], ...extra })

test('OpenRouter route: box token and source address required; nothing reaches the upstream without them', async () => {
  const h = await host()
  try {
    assert.equal((await call(h.port, { headers: {}, body: chat() })).status, 401)
    assert.equal((await call(h.port, { headers: { authorization: 'Bearer nope' }, body: chat() })).status, 401)
    assert.equal((await call(h.port, { headers: { authorization: `Bearer ${signBox('k', 'a@x.com', 'old-box')}` }, body: chat() })).status, 401)
    assert.equal((await call(h.port, { headers: { authorization: `Bearer ${TOKEN}`, 'x-forwarded-for': '9.9.9.9' }, body: chat() })).status, 403)
    assert.equal((await call(h.port, { method: 'GET', path: '/openrouter/v1/models', headers: {} })).status, 401)
    assert.deepEqual(h.seen, [])
  } finally { h.close() }
})

test('OpenRouter route: off (404) while OPENROUTER_MODELS is empty; other methods and paths 404', async () => {
  const off = await host({ config: { ...cfg, openrouterModels: [] } })
  const on = await host()
  try {
    assert.equal((await call(off.port, { body: chat() })).status, 404)
    assert.equal((await call(off.port, { method: 'GET', path: '/openrouter/v1/models' })).status, 404)
    assert.equal((await call(on.port, { method: 'GET' })).status, 404)
    assert.equal((await call(on.port, { path: '/openrouter/v1/completions', body: chat() })).status, 404)
    assert.equal((await call(on.port, { path: '/openrouter/v1/chat/completions/../../credits', body: chat() })).status, 404)
    assert.deepEqual([...off.seen, ...on.seen], [])
  } finally { off.close(); on.close() }
})

test('a model outside OPENROUTER_MODELS, a missing model or a non-JSON body is refused with 400 and never forwarded', async () => {
  const h = await host()
  try {
    for (const body of [chat({ model: 'openai/gpt-5' }), chat({ model: 'qwen/qwen3.8-27b:online' }), chat({ model: undefined }), '{nope', '[]', 'null']) {
      const r = await call(h.port, { body })
      assert.equal(r.status, 400, body)
      assert.equal(typeof JSON.parse(r.body).error.message, 'string')
    }
    assert.deepEqual(h.seen, [])
  } finally { h.close() }
})

test('credentials swap: the upstream is fixed and sees only the OpenRouter key, never the box token or the DeepSeek key', async () => {
  const h = await host()
  try {
    const r = await call(h.port, { path: '/openrouter/v1/chat/completions?base=https://evil.example', headers: { authorization: `Bearer ${TOKEN}`, 'x-api-key': TOKEN, cookie: 'c=1', 'http-referer': 'x' }, body: chat() })
    assert.equal(r.status, 200)
    const [{ url, init }] = h.seen
    assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions')
    assert.deepEqual(init.headers, { 'content-type': 'application/json', authorization: 'Bearer OR-KEY' })
    assert.equal(init.redirect, 'error')
    const sent = JSON.stringify(init)
    for (const secret of [TOKEN, 'DEEPSEEK-KEY']) assert.equal(sent.includes(secret), false, secret)
  } finally { h.close() }
})

test('routing and cost fields are stripped; provider is always the edge\'s own (data_collection deny, ZDR); streams ask for usage', async () => {
  const h = await host()
  const zdrOff = await host({ config: { ...cfg, openrouterZdr: false } })
  try {
    const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } }
    const messages = [{ role: 'user', content: [{ type: 'text', text: 'what is this?' }, image] }]
    await call(h.port, { body: chat({ messages, max_tokens: 99, reasoning: { effort: 'low' }, provider: { data_collection: 'allow', order: ['x'], allow_fallbacks: true }, models: ['openai/gpt-5'], plugins: [{ id: 'web' }], route: 'fallback', transforms: ['middle-out'], web_search_options: {} }) })
    await call(h.port, { body: chat({ stream: true, stream_options: { other: 1 } }) })
    await call(zdrOff.port, { body: chat() })
    const [first, streamed] = h.seen.map(s => s.body)
    assert.deepEqual(first, { model: MODELS[0], messages, max_tokens: 99, reasoning: { effort: 'low' }, provider: { data_collection: 'deny', zdr: true } })
    assert.deepEqual(streamed.provider, { data_collection: 'deny', zdr: true })
    assert.deepEqual(streamed.stream_options, { other: 1, include_usage: true })
    assert.deepEqual(zdrOff.seen[0].body.provider, { data_collection: 'deny' })
  } finally { h.close(); zdrOff.close() }
})

test('usage is charged from the stream\'s final chunk and from a JSON body; bytes pass through unchanged', async () => {
  const final = { object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 1200, completion_tokens: 300, completion_tokens_details: { reasoning_tokens: 100 } } }
  const streamed = await host({ respond: () => sse({ choices: [{ delta: { content: 'hello' } }], usage: null }, final, '[DONE]') })
  const plain = await host({ respond: () => Response.json({ choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 40, completion_tokens: 2 } }) })
  try {
    const r = await call(streamed.port, { body: chat({ stream: true }) })
    assert.equal(r.status, 200); assert.match(r.headers['content-type'], /text\/event-stream/)
    assert.equal(r.body.split('\n\n').filter(Boolean).at(-1), 'data: [DONE]')
    assert.equal(await streamed.counted(), 1500)
    assert.equal(JSON.parse((await call(plain.port, { body: chat() })).body).usage.prompt_tokens, 40)
    assert.equal(await plain.counted(), 42)
  } finally { streamed.close(); plain.close() }
})

test('a box that drops a stream before its usage chunk is charged the input estimate plus ceil(chars / 3), images excluded', async () => {
  let cancelled = false
  const enc = new TextEncoder()
  const h = await host({ respond: () => new Response(new ReadableStream({
    start(c) { c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'x'.repeat(30) } }] })}\n\n`)) },
    cancel() { cancelled = true },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } }) })
  const url = `data:image/png;base64,${'A'.repeat(30_000)}`
  const body = chat({ stream: true, messages: [{ role: 'user', content: [{ type: 'text', text: 'y'.repeat(600) }, { type: 'image_url', image_url: { url } }] }] })
  try {
    await new Promise((resolve, reject) => {
      const r = request({ host: '127.0.0.1', port: h.port, method: 'POST', path: '/openrouter/v1/chat/completions', headers: { 'x-forwarded-for': '1.2.3.4', authorization: `Bearer ${TOKEN}` } }, (res) => res.once('data', () => { r.destroy(); resolve() }))
      r.on('error', reject); r.end(body)
    })
    for (let i = 0; i < 50 && !cancelled; i++) await new Promise((r) => setTimeout(r, 20))
    assert.equal(cancelled, true, 'upstream stream cancelled')
    assert.equal(await h.counted(), Math.ceil((Buffer.byteLength(body) - url.length) / 3) + 10)
  } finally { h.close() }
})

test('halt, the request budget and the token budget refuse before anything is forwarded', async () => {
  const halted = await host({ halted: true })
  const requests = await host({ allow: async () => false })
  const spent = await host({ limit: 0 })
  try {
    assert.equal((await call(halted.port, { body: chat() })).status, 503)
    assert.equal((await call(requests.port, { body: chat() })).status, 429)
    assert.equal((await call(spent.port, { body: chat() })).status, 429)
    assert.equal((await call(spent.port, { method: 'GET', path: '/openrouter/v1/models' })).status, 429)
    assert.deepEqual([...halted.seen, ...requests.seen, ...spent.seen], [])
  } finally { halted.close(); requests.close(); spent.close() }
})

test('bodies over 20 MiB are refused with 413 and not forwarded; the cap is the OpenRouter route\'s only', async () => {
  const h = await host()
  try {
    const big = chat({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(20 * 1024 * 1024)}` } }] }] })
    assert.equal((await call(h.port, { body: big })).status, 413)
    assert.deepEqual(h.seen, [])
    const fits = chat({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(19 * 1024 * 1024)}` } }] }] })
    assert.equal((await call(h.port, { body: fits })).status, 200)
    assert.equal((await call(h.port, { path: '/anthropic/v1/messages', headers: { 'x-api-key': TOKEN }, body: big })).status, 200)
  } finally { h.close() }
})

test('/models lists only allowlisted models from the upstream list, fetched with the OpenRouter key', async () => {
  const h = await host({ respond: () => Response.json({ data: [{ id: 'qwen/qwen3.8-27b', context_length: 1024000 }, { id: 'openai/gpt-5' }, { id: 'qwen/qwen3.5-9b', context_length: 262144 }] }) })
  try {
    const r = await call(h.port, { method: 'GET', path: '/openrouter/v1/models' })
    assert.equal(r.status, 200)
    assert.deepEqual(JSON.parse(r.body).data.map(m => [m.id, m.context_length]), [['qwen/qwen3.8-27b', 1024000], ['qwen/qwen3.5-9b', 262144]])
    assert.equal(h.seen[0].url, 'https://openrouter.ai/api/v1/models')
    assert.deepEqual(h.seen[0].init.headers, { authorization: 'Bearer OR-KEY' })
  } finally { h.close() }
})

test('the model host refuses to start with OpenRouter models but no OpenRouter key', () => {
  assert.throws(() => modelServer({ cfg: { ...cfg, openrouterKey: undefined }, edgeKey: 'k', modelKey: 'x', allow: async () => true, owns: async () => true, touch: () => {} }), /OPENROUTER_API_KEY/)
})

test('box start script: an OpenRouter route on the model host for every allowlisted model, image input declared; none when off', () => {
  const start = startScript(cfg, 'mbx.tok.sig')
  const overlay = /cat > \/root\/\.mumbo\/models\.overlay\.yml <<'YML'\n([\s\S]*?)\nYML\n/.exec(start)?.[1]
  assert.ok(overlay, 'models overlay written')
  assert.match(overlay, /^- id: llm-pi-ai\n {2}config:\n {4}providers: /)
  const providers = JSON.parse(overlay.split('providers: ')[1])
  assert.deepEqual(providers, { openrouter: {
    apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://llm.example/openrouter/v1', maxRequestImageBytes: 12 * 1024 * 1024,
    models: [{ id: 'qwen/qwen3.8-27b', contextWindow: 1_024_000, input: ['text', 'image'] }, { id: 'qwen/qwen3.5-9b', contextWindow: 262_144, input: ['text', 'image'] }],
  } })
  assert.match(start, /--patch \/root\/\.mumbo\/models\.overlay\.yml/)
  assert.equal(startScript({ ...cfg, openrouterModels: ['other/model'] }, 't').includes('"models":[{"id":"other/model"}]'), true, 'a model without box metadata takes the catalog\'s')
  const off = startScript({ ...cfg, openrouterModels: [] }, 't')
  assert.equal(off.includes('models.overlay.yml'), false)
})
