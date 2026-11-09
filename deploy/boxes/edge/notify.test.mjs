// node --test: ntfy notifications for new approvals.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ntfy } from './notify.mjs'

const TOPIC = 'secret-topic-123'
const noTopic = (e) => !e.message.includes(TOPIC)

test('ntfy posts the message in the body and only ASCII in the Title and Click headers', async () => {
  const sent = []
  const send = ntfy({ topic: TOPIC, fetchImpl: async (url, init) => { sent.push({ url, init }); return new Response('{}') } })
  await send({ title: 'Approve merge: acme/app#1\r\nX-Evil: 1 — ok', body: 'Fix “login” ✓\nX-Evil: 1 · 12 lines · low-risk', click: 'https://approve.boxes.mumbo.si/' })
  assert.equal(sent.length, 1)
  const [{ url, init }] = sent
  assert.equal(url, `https://ntfy.sh/${TOPIC}`)
  assert.equal(init.method, 'POST')
  assert.equal(init.body, 'Fix “login” ✓\nX-Evil: 1 · 12 lines · low-risk')
  assert.deepEqual(init.headers, { title: 'Approve merge: acme/app#1??X-Evil: 1 ? ok', click: 'https://approve.boxes.mumbo.si/', 'content-type': 'text/plain; charset=utf-8' })
  assert.ok(init.signal instanceof AbortSignal)
})

test('ntfy rejects, without naming the topic, on a non-2xx answer, a failed or hung request, and an unset topic', async () => {
  const message = { title: 't', body: 'b', click: 'https://approve.boxes.mumbo.si/' }
  await assert.rejects(ntfy({ topic: TOPIC, fetchImpl: async () => new Response('no', { status: 429 }) })(message), (e) => /HTTP 429/.test(e.message) && noTopic(e))
  await assert.rejects(ntfy({ topic: TOPIC, fetchImpl: async (url) => { throw new TypeError(`fetch failed: ${url}`) } })(message), (e) => /request failed/.test(e.message) && noTopic(e))
  // A real request holds a socket open; this one holds a timer, because AbortSignal.timeout's own timer is unref'd.
  const hung = (url, init) => new Promise((_, reject) => {
    const open = setTimeout(() => {}, 5_000)
    init.signal.addEventListener('abort', () => { clearTimeout(open); reject(init.signal.reason) })
  })
  await assert.rejects(ntfy({ topic: TOPIC, fetchImpl: hung, timeoutMs: 20 })(message), (e) => /request failed \(TimeoutError\)/.test(e.message) && noTopic(e))
  let called = false
  await assert.rejects(ntfy({ topic: undefined, fetchImpl: async () => { called = true; return new Response('{}') } })(message), /NTFY_TOPIC is not set/)
  assert.equal(called, false)
})
