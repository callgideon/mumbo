// node --test: the model host's OpenRouter route (/openrouter/v1/…) against a local fake upstream.
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { connect } from 'node:net'
import { test } from 'node:test'
import { imageSize, modelServer, signBox, startScript } from './edge.mjs'
import { tokenBudget } from './budget.mjs'
import { memoryStore } from './store.mjs'

const MODELS = ['qwen/qwen3.8-27b', 'qwen/qwen3.5-9b']
const cfg = { llmHost: 'llm.example', publicHost: 'boxes.example', projectDomain: 'boxes.example', egressIps: ['1.2.3.4'], upstream: 'https://model.example', openrouterModels: MODELS, openrouterKey: 'OR-KEY', openrouterZdr: true, openrouterImageTokens: 1500 }
const TOKEN = signBox('k', 'a@x.com', 'b1')
const listen = (server) => new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port)))
const call = (port, { method = 'POST', path = '/openrouter/v1/chat/completions', headers = { authorization: `Bearer ${TOKEN}` }, body } = {}) => new Promise((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port, method, path, headers: { 'x-forwarded-for': '1.2.3.4', 'content-type': 'application/json', ...headers } }, (res) => {
    let data = ''; res.on('data', c => { data += c }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }))
  })
  req.on('error', reject); req.end(body)
})
const OPENROUTER_LIMIT = 20 * 1024 * 1024
const sse = (...events) => new Response(events.map(e => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } })

/** A model server over a fake upstream; `respond(url, init)` answers each forwarded request. */
async function host({ respond = () => Response.json({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }), halted = false, allow = async () => true, limit = 1e9, config = cfg } = {}) {
  const seen = []; const logged = []; const store = memoryStore()
  const tokens = tokenBudget({ store, limits: { user: limit, project: limit }, now: () => Date.parse('2026-11-09T12:00:00Z') })
  const fetchImpl = async (url, init) => { seen.push({ url, init, body: init.body === undefined ? undefined : JSON.parse(init.body) }); return respond(url, init) }
  const server = modelServer({ cfg: config, edgeKey: 'k', modelKey: 'DEEPSEEK-KEY', allow, owns: async (u, b) => u === 'a@x.com' && b === 'b1', touch: () => {}, fetchImpl, log: (l) => logged.push(JSON.parse(l)), tokens, halt: { isHalted: async () => halted } })
  const port = await listen(server)
  return { port, seen, logged, store, close: () => server.close(), counted: () => store.getCount('tokens:2026-11-09:a@x.com') }
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

const user = (...content) => chat({ messages: [{ role: 'user', content }] })
test('a model outside OPENROUTER_MODELS, a missing model, no messages, a non-JSON body or a content part other than text and data: images is refused with 400 and never forwarded', async () => {
  const h = await host()
  try {
    const refused = [chat({ model: 'openai/gpt-5' }), chat({ model: 'qwen/qwen3.8-27b:online' }), chat({ model: undefined }), chat({ messages: 'hi' }), '{nope', '[]', 'null',
      user({ type: 'file', file: { filename: 'a.pdf', file_data: 'data:application/pdf;base64,JVBERi0=' } }), user({ type: 'input_audio', input_audio: { data: 'AAAA', format: 'wav' } }),
      user({ type: 'video_url', video_url: { url: 'data:video/mp4;base64,AAAA' } }), user({ type: 'image_url', image_url: { url: 'https://example.com/huge.png' } }),
      user({ type: 'image_url', image_url: { url: 'data:application/pdf;base64,JVBERi0=' } }), user({ type: 'image_url' }), user('text', null),
      user({ type: 'text', text: { nested: 'object' } }), user({ type: 'text' }),
      chat({ messages: [{ role: 'user', content: { type: 'file', file: { file_data: 'data:application/pdf;base64,JVBERi0=' } } }] }), chat({ messages: [{ role: 'user', content: 7 }] }),
      chat({ messages: [{ role: 'function', content: 'x' }] }), chat({ messages: [{ content: 'x' }] }), chat({ messages: ['hi'] }),
      chat({ tools: [{ type: 'function', function: { name: 'f' } }, { type: 'web_search' }] }), chat({ tools: { type: 'function' } }),
      chat({ tool_choice: { type: 'web_search' } }), chat({ tool_choice: 3 })]
    for (const body of refused) {
      const r = await call(h.port, { body })
      assert.equal(r.status, 400, body)
      assert.equal(typeof JSON.parse(r.body).error.message, 'string')
    }
    assert.deepEqual(h.seen, [])
    const accepted = [user({ type: 'text', text: 'a' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } }),
      chat({ messages: [{ role: 'system', content: 'be brief' }, { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'f', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'c', content: 'ok' }] }),
      chat({ messages: [{ role: 'user', content: 'the word undefined is fine' }], tools: [{ type: 'function', function: { name: 'f' } }], tool_choice: 'auto' }),
      chat({ tool_choice: { type: 'function', function: { name: 'f' } } })]
    for (const body of accepted) assert.equal((await call(h.port, { body })).status, 200, body)
  } finally { h.close() }
})

test('credentials swap: the upstream is fixed and sees only the OpenRouter key and pi-ai\'s session id, never the box token or the DeepSeek key', async () => {
  const h = await host()
  try {
    const r = await call(h.port, { path: '/openrouter/v1/chat/completions?base=https://evil.example', headers: { authorization: `Bearer ${TOKEN}`, 'x-api-key': TOKEN, cookie: 'c=1', 'http-referer': 'x', 'x-session-id': 'session-1f0c2b7e-aa' }, body: chat() })
    assert.equal(r.status, 200)
    for (const bad of [TOKEN, signBox('k', 'b@x.com', 'other'), 'mbx.forged', TOKEN.replace(/\./g, '/'), 's'.repeat(129), 'a b']) await call(h.port, { headers: { authorization: `Bearer ${TOKEN}`, 'x-session-id': bad }, body: chat() })
    const [{ url, init }, ...rest] = h.seen
    assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions')
    assert.deepEqual(init.headers, { 'content-type': 'application/json', authorization: 'Bearer OR-KEY', 'x-session-id': 'session-1f0c2b7e-aa' })
    assert.equal(init.redirect, 'error')
    for (const other of rest) assert.deepEqual(other.init.headers, { 'content-type': 'application/json', authorization: 'Bearer OR-KEY' }, 'a malformed session id is dropped')
    const sent = JSON.stringify(h.seen.map(s => s.init))
    for (const secret of [TOKEN, 'DEEPSEEK-KEY']) assert.equal(sent.includes(secret), false, secret)
  } finally { h.close() }
})

test('only allowlisted top-level fields pass; the edge sets stream, usage, visible reasoning and its own provider (data_collection deny, ZDR)', async () => {
  const h = await host()
  const zdrOff = await host({ config: { ...cfg, openrouterZdr: false } })
  try {
    const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } }
    const messages = [{ role: 'user', content: [{ type: 'text', text: 'what is this?' }, image] }]
    const tools = [{ type: 'function', function: { name: 'f', parameters: { type: 'object' } } }]
    // What dsh's pi-ai sent for this route (local run), plus fields that change routing or cost.
    await call(h.port, { body: chat({ messages, stream: false, stream_options: { other: 1 }, store: false, max_completion_tokens: 99, tools, reasoning: { effort: 'low', exclude: true },
      provider: { data_collection: 'allow', order: ['x'], allow_fallbacks: true }, models: ['openai/gpt-5'], plugins: [{ id: 'file-parser' }], route: 'fallback', transforms: ['middle-out'],
      web_search_options: {}, preset: 'paid', usage: { include: true }, prompt_cache_retention: '24h', include_reasoning: false, unknown: 1 }) })
    await call(h.port, { body: chat({ reasoning: 'high' }) })
    await call(zdrOff.port, { body: chat() })
    const [first, second] = h.seen.map(s => s.body)
    assert.deepEqual(first, { model: MODELS[0], messages, stream: true, stream_options: { include_usage: true }, max_completion_tokens: 99, tools,
      reasoning: { effort: 'low', exclude: false }, provider: { data_collection: 'deny', zdr: true } })
    assert.deepEqual(second.reasoning, { exclude: false })
    assert.deepEqual(zdrOff.seen[0].body, { model: MODELS[0], messages: [{ role: 'user', content: 'hi' }], stream: true, stream_options: { include_usage: true }, provider: { data_collection: 'deny' } })
  } finally { h.close(); zdrOff.close() }
})

test('messages keep only pi-ai\'s fields, and each content part is rebuilt from its known keys', async () => {
  const h = await host()
  try {
    const url = 'data:image/png;base64,iVBORw0KGgo='
    const messages = [
      { role: 'system', content: 'x', tools: [{ type: 'function' }], extra: 1 },
      { role: 'user', content: [{ type: 'text', text: 'a', extra: 1, cache_control: { type: 'ephemeral', ttl: '1h' } }, { type: 'image_url', image_url: { url, detail: 'high', extra: 1 }, extra: 1 }, { type: 'image_url', image_url: { url, detail: 'max' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'f', arguments: '{}' } }], reasoning: 'r', reasoning_details: [{ type: 'reasoning.text', text: 'r' }], plugins: [] },
      { role: 'tool', tool_call_id: 'c', name: 'f', content: 'ok', file: {} },
    ]
    assert.equal((await call(h.port, { body: chat({ messages }) })).status, 200)
    assert.deepEqual(h.seen[0].body.messages, [
      { role: 'system', content: 'x' },
      { role: 'user', content: [{ type: 'text', text: 'a', cache_control: { type: 'ephemeral' } }, { type: 'image_url', image_url: { url, detail: 'high' } }, { type: 'image_url', image_url: { url } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'f', arguments: '{}' } }], reasoning: 'r', reasoning_details: [{ type: 'reasoning.text', text: 'r' }] },
      { role: 'tool', tool_call_id: 'c', name: 'f', content: 'ok' },
    ])
  } finally { h.close() }
})

test('usage is charged from the stream\'s final chunk and from a JSON body; an upstream error is not charged; bytes pass through unchanged', async () => {
  const final = { object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 1200, completion_tokens: 300, completion_tokens_details: { reasoning_tokens: 100 } } }
  const streamed = await host({ respond: () => sse({ choices: [{ delta: { content: 'hello' } }], usage: null }, final, '[DONE]') })
  const plain = await host({ respond: () => Response.json({ choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 40, completion_tokens: 2 } }) })
  const failed = await host({ respond: () => Response.json({ error: { code: 404, message: 'No endpoints found matching your data policy' } }, { status: 404 }) })
  try {
    const r = await call(streamed.port, { body: chat() })
    assert.equal(r.status, 200); assert.match(r.headers['content-type'], /text\/event-stream/)
    assert.equal(r.body.split('\n\n').filter(Boolean).at(-1), 'data: [DONE]')
    assert.equal(await streamed.counted(), 1500)
    assert.equal(JSON.parse((await call(plain.port, { body: chat() })).body).usage.prompt_tokens, 40)
    assert.equal(await plain.counted(), 42)
    assert.equal((await call(failed.port, { body: chat() })).status, 404)
    assert.equal(await failed.counted(), 0)
  } finally { streamed.close(); plain.close(); failed.close() }
})

/** The first bytes of a PNG of `width` x `height`, base64, padded with `pad` more base64 characters. */
const png = (width, height, pad = 0) => {
  const head = Buffer.alloc(24); Buffer.from('\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR', 'latin1').copy(head); head.writeUInt32BE(width, 16); head.writeUInt32BE(height, 20)
  return head.toString('base64') + 'A'.repeat(pad)
}
test('image sizes are read from PNG, GIF, WebP and JPEG headers', () => {
  const b64 = (...parts) => Buffer.concat(parts.map(p => typeof p === 'string' ? Buffer.from(p, 'latin1') : Buffer.from(p))).toString('base64')
  const u16le = (n) => [n & 0xff, n >> 8], u16be = (n) => [n >> 8, n & 0xff], u24le = (n) => [n & 0xff, (n >> 8) & 0xff, n >> 16]
  assert.deepEqual(imageSize(png(1440, 900)), { width: 1440, height: 900 })
  assert.deepEqual(imageSize(b64('GIF89a', u16le(640), u16le(480))), { width: 640, height: 480 })
  const riff = (kind, body) => b64('RIFF', [0, 0, 0, 0], 'WEBP', kind, [0, 0, 0, 0], body, new Array(16).fill(0))
  assert.deepEqual(imageSize(riff('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, ...u16le(800), ...u16le(600)])), { width: 800, height: 600 })
  const l = (800 - 1) | ((600 - 1) << 14)
  assert.deepEqual(imageSize(riff('VP8L', [0x2f, l & 0xff, (l >> 8) & 0xff, (l >> 16) & 0xff, (l >>> 24) & 0xff])), { width: 800, height: 600 })
  assert.deepEqual(imageSize(riff('VP8X', [0, 0, 0, 0, ...u24le(1999), ...u24le(1499)])), { width: 2000, height: 1500 })
  assert.deepEqual(imageSize(b64([0xff, 0xd8, 0xff, 0xe0], u16be(16), new Array(14).fill(0), [0xff, 0xc2], u16be(17), [8], u16be(768), u16be(1024), new Array(12).fill(0))), { width: 1024, height: 768 })
  for (const bad of ['', 'AAAA', b64('RIFF', [0, 0, 0, 0], 'WEBPVP8Z', new Array(20).fill(0)), b64([0xff, 0xd8, 0x00, 0x00])]) assert.equal(imageSize(bad), undefined, bad)
})

test('a box that drops a stream before its usage chunk is charged ceil(bytes without image data / 3), each image\'s pixels / 784 (at most OPENROUTER_IMAGE_TOKENS) and ceil(chars / 3)', async () => {
  let cancelled = false
  const enc = new TextEncoder()
  const h = await host({ respond: () => new Response(new ReadableStream({
    start(c) { c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'x'.repeat(30) } }] })}\n\n`)) },
    cancel() { cancelled = true },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } }), config: { ...cfg, openrouterImageTokens: 16384 } })
  const url = `data:image/png;base64,${png(1440, 900, 30_000)}`
  const big = `data:image/png;base64,${png(8000, 8000)}`
  const odd = `data:image/png;base64,${'A'.repeat(100)}`
  const body = chat({ messages: [{ role: 'user', content: [{ type: 'text', text: 'y'.repeat(600) }, { type: 'image_url', image_url: { url } }, { type: 'image_url', image_url: { url: big } }, { type: 'image_url', image_url: { url: odd } }] }] })
  try {
    await new Promise((resolve, reject) => {
      const r = request({ host: '127.0.0.1', port: h.port, method: 'POST', path: '/openrouter/v1/chat/completions', headers: { 'x-forwarded-for': '1.2.3.4', authorization: `Bearer ${TOKEN}` } }, (res) => res.once('data', () => { r.destroy(); resolve() }))
      r.on('error', reject); r.end(body)
    })
    for (let i = 0; i < 50 && !cancelled; i++) await new Promise((r) => setTimeout(r, 20))
    assert.equal(cancelled, true, 'upstream stream cancelled')
    // 1440 x 900 is 1654 tokens; 8000 x 8000 (81,633) is capped at 16384; an unreadable image is charged the cap.
    assert.equal(await h.counted(), Math.ceil((Buffer.byteLength(body) - url.length - big.length - odd.length) / 3) + 1654 + 16384 + 16384 + 10)
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

/** A raw HTTP/1.1 request whose body the client keeps sending; resolves with the status line and whether the edge closed. */
const rawRequest = (port, head, body) => new Promise((resolve) => {
  const socket = connect(port, '127.0.0.1', () => { socket.write(head); socket.write(body, () => {}) })
  let text = ''
  socket.on('data', (c) => { text += c })
  socket.on('error', () => {})
  socket.on('close', () => resolve({ status: Number(text.split(' ')[1]), closeHeader: /\r\nconnection: close\r\n/i.test(text) }))
})

test('bodies over 20 MiB get 413 and a closed connection, at once for a declared length, and are not forwarded; the cap is the OpenRouter route\'s only', async () => {
  const h = await host()
  try {
    const big = chat({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(20 * 1024 * 1024)}` } }] }] })
    const head = (length) => `POST /openrouter/v1/chat/completions HTTP/1.1\r\nhost: x\r\nx-forwarded-for: 1.2.3.4\r\nauthorization: Bearer ${TOKEN}\r\n${length}\r\n`
    // Declared: the edge answers before the body arrives (the client sends only 1 KiB of it).
    assert.deepEqual(await rawRequest(h.port, head(`content-length: ${Buffer.byteLength(big)}\r\n`), 'x'.repeat(1024)), { status: 413, closeHeader: true })
    // Chunked: the edge stops reading once over the cap.
    const chunked = Buffer.from(`${Buffer.byteLength(big).toString(16)}\r\n${big}\r\n0\r\n\r\n`)
    assert.deepEqual(await rawRequest(h.port, head('transfer-encoding: chunked\r\n'), chunked), { status: 413, closeHeader: true })
    assert.deepEqual(h.seen, [])
    const fits = chat({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(19 * 1024 * 1024)}` } }] }] })
    assert.equal((await call(h.port, { body: fits })).status, 200)
    assert.equal((await call(h.port, { path: '/anthropic/v1/messages', headers: { 'x-api-key': TOKEN }, body: big })).status, 200)
  } finally { h.close() }
})

test('refused requests (400, 413) are logged; a client that leaves mid-body ends its request without forwarding anything', async () => {
  const h = await host()
  try {
    assert.equal((await call(h.port, { body: chat({ model: 'openai/gpt-5' }) })).status, 400)
    const head = (length) => `POST /openrouter/v1/chat/completions HTTP/1.1\r\nhost: x\r\nx-forwarded-for: 1.2.3.4\r\nauthorization: Bearer ${TOKEN}\r\ncontent-length: ${length}\r\n\r\n`
    assert.equal((await rawRequest(h.port, head(OPENROUTER_LIMIT + 1), 'x')).status, 413)
    const gone = connect(h.port, '127.0.0.1', () => { gone.write(head(1000)); gone.end('{"model":') })
    gone.on('error', () => {})
    for (let i = 0; i < 50 && !h.logged.some(l => l.edge === 'error'); i++) await new Promise(r => setTimeout(r, 20))
    // Node reports the reset as the request's 'aborted' error, or readBody as 'request aborted' on close.
    assert.deepEqual(h.logged.map(({ ms, ...l }) => l.edge === 'error' ? { ...l, error: /aborted/.test(l.error) } : l), [
      { edge: 'model', user: 'a@x.com', box: 'b1', path: '/openrouter/v1/chat/completions', status: 400 },
      { edge: 'model', user: 'a@x.com', box: 'b1', path: '/openrouter/v1/chat/completions', status: 413 },
      { edge: 'error', path: '/openrouter/v1/chat/completions', error: true },
    ])
    assert.deepEqual(h.seen, [])
  } finally { h.close() }
})

test('/models lists only allowlisted models from the upstream list, fetched with the OpenRouter key, and is logged', async () => {
  const h = await host({ respond: () => Response.json({ data: [{ id: 'qwen/qwen3.8-27b', context_length: 1024000 }, { id: 'openai/gpt-5' }, { id: 'qwen/qwen3.5-9b', context_length: 262144 }] }) })
  try {
    const r = await call(h.port, { method: 'GET', path: '/openrouter/v1/models' })
    assert.equal(r.status, 200)
    assert.deepEqual(JSON.parse(r.body).data.map(m => [m.id, m.context_length]), [['qwen/qwen3.8-27b', 1024000], ['qwen/qwen3.5-9b', 262144]])
    assert.equal(h.seen[0].url, 'https://openrouter.ai/api/v1/models')
    assert.deepEqual(h.seen[0].init.headers, { authorization: 'Bearer OR-KEY' })
    assert.deepEqual(h.logged.map(({ ms, ...l }) => l), [{ edge: 'model', user: 'a@x.com', box: 'b1', path: '/openrouter/v1/models', status: 200 }])
  } finally { h.close() }
})

test('the model host refuses to start with OpenRouter models but no OpenRouter key', () => {
  assert.throws(() => modelServer({ cfg: { ...cfg, openrouterKey: undefined }, edgeKey: 'k', modelKey: 'x', allow: async () => true, owns: async () => true, touch: () => {} }), /OPENROUTER_API_KEY/)
})

test('box start script: an OpenRouter route on the model host for every allowlisted model, image input declared, context from the catalog; none when off', () => {
  const start = startScript(cfg, 'mbx.tok.sig')
  const overlay = /cat > \/root\/\.mumbo\/models\.overlay\.yml <<'YML'\n([\s\S]*?)\nYML\n/.exec(start)?.[1]
  assert.ok(overlay, 'models overlay written')
  assert.match(overlay, /^- id: llm-pi-ai\n {2}config:\n {4}providers: /)
  const providers = JSON.parse(overlay.split('providers: ')[1])
  assert.deepEqual(providers, { openrouter: {
    displayName: 'OpenRouter', apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://llm.example/openrouter/v1', maxRequestImageBytes: 12 * 1024 * 1024,
    models: [{ id: 'qwen/qwen3.8-27b', input: ['text', 'image'] }, { id: 'qwen/qwen3.5-9b', input: ['text', 'image'] }],
  } })
  assert.match(start, /--patch \/root\/\.mumbo\/models\.overlay\.yml/)
  assert.equal(startScript({ ...cfg, openrouterModels: ['other/model'] }, 't').includes('"models":[{"id":"other/model"}]'), true, 'a model without box metadata takes the catalog\'s')
  const off = startScript({ ...cfg, openrouterModels: [] }, 't')
  assert.equal(off.includes('models.overlay.yml'), false)
})
