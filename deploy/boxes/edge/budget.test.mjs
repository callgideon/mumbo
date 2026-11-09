import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memoryStore } from './store.mjs'
import { tokenBudget } from './budget.mjs'

const now = () => Date.parse('2026-11-09T12:00:00Z')
const key = (p) => `tokens:2026-11-09:${p}`
const enc = new TextEncoder()
const ev = (o) => `event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`
const start = ev({ type: 'message_start', message: { usage: { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 20, cache_creation_input_tokens: 0 } } })
const delta = ev({ type: 'message_delta', usage: { output_tokens: 50 } })
const make = () => { const store = memoryStore(); return { store, t: tokenBudget({ store, limits: { user: 1000, project: 5000 }, now }) } }
const stream = (...parts) => new ReadableStream({ start(c) { for (const p of parts) c.enqueue(enc.encode(p)); c.close() } })
const drain = async (s) => Buffer.concat(await Array.fromAsync(s)).toString()

test('SSE usage is counted from the last values seen and bytes are unchanged', async () => {
  const { store, t } = make()
  const out = await drain(t.meter('a@x.co', stream(start, 'event: ping\ndata: {}\n\n', delta), 'text/event-stream; charset=utf-8'))
  assert.equal(out, start + 'event: ping\ndata: {}\n\n' + delta)
  assert.equal(await store.getCount(key('a@x.co')), 170)
})

test('events split across chunks are still counted', async () => {
  const { store, t } = make()
  const all = start + delta
  await drain(t.meter('a@x.co', stream(all.slice(0, 40), all.slice(40, 130), all.slice(130)), 'text/event-stream'))
  assert.equal(await store.getCount(key('a@x.co')), 170)
})

test('a stream cancelled after message_start has counted 120', async () => {
  const { store, t } = make()
  const body = new ReadableStream({ start(c) { c.enqueue(enc.encode(start)) } })
  const reader = t.meter('a@x.co', body, 'text/event-stream').getReader()
  await reader.read()
  await reader.cancel()
  assert.equal(await store.getCount(key('a@x.co')), 120)
})

test('JSON usage is counted once', async () => {
  const { store, t } = make()
  const json = JSON.stringify({ content: [], usage: { input_tokens: 7, output_tokens: 3 } })
  assert.equal(await drain(t.meter('a@x.co', stream(json), 'application/json')), json)
  assert.equal(await store.getCount(key('a@x.co')), 10)
})

test('a malformed event counts 0 and leaves the stream intact', async () => {
  const { store, t } = make()
  const bad = 'event: message_start\ndata: {nope\n\n'
  assert.equal(await drain(t.meter('a@x.co', stream(bad), 'text/event-stream')), bad)
  assert.equal(await store.getCount(key('a@x.co')), 0)
})

test('other media types pass through unmetered', async () => {
  const { t } = make()
  const body = stream('x')
  assert.equal(t.meter('a@x.co', body, 'text/plain'), body)
})

test('allow is false at or over the limit; project and user limits are separate', async () => {
  const { store, t } = make()
  assert.equal(await t.allow('a@x.co'), true)
  await store.incrementBy(key('a@x.co'), 999, 1)
  assert.equal(await t.allow('a@x.co'), true)
  await store.incrementBy(key('a@x.co'), 1, 1)
  assert.equal(await t.allow('a@x.co'), false)
  await store.incrementBy(key('project:p1'), 1000, 1)
  assert.equal(await t.allow('project:p1'), true)
  await store.incrementBy(key('project:p1'), 4000, 1)
  assert.equal(await t.allow('project:p1'), false)
})

const textDelta = (text) => ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })

test('cancelling after 3 text deltas of 30 chars charges the estimate on top of the input', async () => {
  const { store, t } = make()
  const body = new ReadableStream({ start(c) { for (const p of [start, textDelta('a'.repeat(10)), textDelta('b'.repeat(10)), textDelta('c'.repeat(10))]) c.enqueue(enc.encode(p)) } })
  const reader = t.meter('a@x.co', body, 'text/event-stream').getReader()
  for (let i = 0; i < 4; i++) await reader.read()
  await reader.cancel()
  assert.equal(await store.getCount(key('a@x.co')), 130)
})

test('a completed stream with a final usage charges only the real figure', async () => {
  const { store, t } = make()
  await drain(t.meter('a@x.co', stream(start, textDelta('x'.repeat(3000)), delta), 'text/event-stream'))
  assert.equal(await store.getCount(key('a@x.co')), 170)
})
