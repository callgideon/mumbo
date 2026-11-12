// node --test: counters, documents and sets added for the M1 edge services, on both stores; the read cache (spec R6b) over
// two edge tasks sharing one fake Redis (testing/store-trace.mjs fakeRedis).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { haltService } from './halt.mjs'
import { doorKeys } from './keys.mjs'
import { projects } from './projects.mjs'
import { INVALIDATE, memoryStore, redisStore } from './store.mjs'
import { fakeRedis, subscribed } from './testing/store-trace.mjs'

async function contract(store) {
  assert.equal(await store.getCount('tokens:a'), 0)
  assert.equal(await store.incrementBy('tokens:a', 3, 60_000), 3)
  assert.equal(await store.incrementBy('tokens:a', 5, 60_000), 8)
  assert.equal(await store.getCount('tokens:a'), 8)
  assert.equal(await store.getCount('tokens:b'), 0)
  await store.putDoc('approval:x', { id: 'x' })
  await store.deleteDoc('approval:x')
  assert.equal(await store.getDoc('approval:x'), undefined)
  await store.deleteDoc('approval:missing')
  await store.addToSet('open', 'a'); await store.addToSet('open', 'b')
  await store.removeFromSet('open', 'a')
  assert.deepEqual(await store.setMembers('open'), ['b'])
  await store.removeFromSet('open', 'missing'); await store.removeFromSet('no-such-set', 'a')
  assert.deepEqual(await store.setMembers('open'), ['b'])
  // A lease is released only with its holder's token: a holder whose lease ran out never deletes the next holder's.
  const first = await store.lease('l', 20)
  assert.ok(typeof first === 'string' && first.length > 0)
  assert.equal(await store.lease('l', 60_000), false)
  await new Promise(r => setTimeout(r, 40))
  const second = await store.lease('l', 60_000)
  assert.ok(second && second !== first)
  await store.release('l', first)
  assert.equal(await store.lease('l', 60_000), false, 'the stale token released nothing')
  await store.release('l', second)
  assert.ok(await store.lease('l', 60_000), 'the holder\'s own token released it')
}

test('memory store: incrementBy, getCount, deleteDoc, removeFromSet, and leases released by token', () => contract(memoryStore()))

test('redis store: a lease holds a fresh token, and release is the compare-and-delete script with it, never a plain DEL', async () => {
  const calls = []
  const client = { set: async (...a) => { calls.push(['set', ...a]); return 'OK' }, eval: async (...a) => { calls.push(['eval', ...a]); return 1 }, del: async (...a) => { calls.push(['del', ...a]) } }
  const store = redisStore(client)
  const token = await store.lease('sweep', 900_000)
  assert.deepEqual(calls[0], ['set', 'sweep', token, { NX: true, PX: 900_000 }])
  await store.release('sweep', token)
  assert.deepEqual(calls[1], ['eval', "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", { keys: ['sweep'], arguments: [token] }])
  assert.equal(calls.length, 2)
  client.set = async () => null
  assert.equal(await store.lease('sweep', 900_000), false, 'held by another')
})

test('redis store: withLock answers once its work is done, without waiting for the release, and logs a release that fails', { timeout: 5_000 }, async () => {
  const logs = []; let release = () => new Promise(() => {})
  const store = redisStore({ set: async () => 'OK', eval: (...a) => release(...a) }, { log: (l) => logs.push(JSON.parse(l)) })
  assert.equal(await store.withLock('user:a@x.com', 5_000, async () => 'done'), 'done', 'a release that never answers holds nothing up')
  release = async () => { throw new Error('store down') }
  await store.withLock('user:a@x.com', 5_000, async () => {})
  await new Promise(r => setImmediate(r))
  assert.deepEqual(logs, [{ edge: 'store', level: 'warn', msg: 'lock release failed', lock: 'user:a@x.com', error: 'store down' }])
})

// Flushes the database: only a disposable Redis named by TEST_REDIS_URL, never REDIS_URL (the edge's, as offboarding exports it).
test('redis store: incrementBy, getCount, deleteDoc, removeFromSet, and incrementBy sets a millisecond expiry', { skip: !process.env.TEST_REDIS_URL && 'set TEST_REDIS_URL to a disposable Redis to run' }, async () => {
  const { createClient } = await import('redis')
  // Database 1: node --test runs files in parallel, and edge.test.mjs flushes database 0.
  const client = createClient({ url: process.env.TEST_REDIS_URL, database: 1 }); await client.connect(); await client.flushDb()
  const store = redisStore(client)
  try {
    await contract(store)
    const ttl = await client.pTTL('tokens:a')
    assert.ok(ttl > 0 && ttl <= 60_000, `pttl ${ttl}`)
  } finally { await store.close() }
})

/** Two edge tasks over one fake Redis, each with its read cache on and subscribed (`opts` as redisStore's), and the keys of
 *  the GETs each sent. */
async function twoTasks(opts = {}) {
  const redis = fakeRedis()
  const gets = { a: [], b: [] }
  const task = async (name) => {
    const store = redisStore(redis.client((cmd, key, run) => { if (cmd === 'GET') gets[name].push(key); return Promise.resolve(run()) }), { cacheMs: 60_000, log: () => {}, ...opts })
    await subscribed(store)
    return store
  }
  return { redis, gets, a: await task('a'), b: await task('b') }
}
/** Lets every message published so far land (the fake delivers each on a timer). */
const landed = () => new Promise(r => setTimeout(r, 5))

test('read cache: a key revoked through one edge task is refused by another once the message lands; expiry is checked against the copy', async () => {
  const { a, b, gets } = await twoTasks()
  let now = Date.now()
  const keysOf = (store) => doorKeys({ store, projects: projects({ store, admitted: () => true, log: () => {} }), admitted: () => true, now: () => now, log: () => {} })
  const [ka, kb] = [keysOf(a), keysOf(b)]
  const { key, record } = await ka.mint('a@x.com', { name: 'laptop', scopes: ['read'], expiresInDays: 7 })
  await landed()
  assert.equal((await kb.verify(key)).id, record.id)
  const reads = gets.b.length
  assert.equal((await kb.verify(key)).id, record.id)
  assert.equal(gets.b.length, reads, 'the second verify reads nothing')
  try {
    await ka.revoke('a@x.com', record.id)
    assert.equal((await kb.verify(key)).id, record.id, 'until its message lands, the other task has its copy')
    await landed()
    await assert.rejects(kb.verify(key), (e) => e.code === 'key_revoked')
    await assert.rejects(ka.verify(key), (e) => e.code === 'key_revoked', 'the revoking task dropped its own copy')
    const { key: other } = await ka.mint('a@x.com', { name: 'phone', scopes: ['read'], expiresInDays: 7 })
    await kb.verify(other)
    const before = gets.b.length
    now += 7 * 86_400_000
    await assert.rejects(kb.verify(other), (e) => e.code === 'key_expired')
    assert.equal(gets.b.length, before, 'expiry needs no read')
  } finally { await Promise.all([a.close(), b.close()]) }
})

test('read cache: with the subscription dropped or silent, every read goes through and nothing stale is served; resubscribed, it caches again', async () => {
  let now = Date.now()
  const { redis, a, b, gets } = await twoTasks({ now: () => now })
  const [ha, hb] = [haltService({ store: a }), haltService({ store: b })]
  const halted = async (expected, reads) => { assert.equal(await hb.get('a@x.com'), expected); assert.equal(gets.b.length, reads) }
  try {
    await halted(false, 1); await halted(false, 1)
    redis.drop()
    assert.equal(b.cacheLive(), false)
    await ha.set('a@x.com', true)  // its message is lost with the subscription
    await landed()
    await halted(true, 2); await halted(true, 3)
    redis.reconnect()
    assert.equal(b.cacheLive(), true)
    await halted(true, 4); await halted(true, 4)
    // A half-open subscription: no event, no message, and the heartbeat's ping is never answered.
    redis.silence()
    await ha.set('a@x.com', false)
    await landed()
    await halted(true, 4)
    now += 10_000  // two heartbeats unanswered
    assert.equal(b.cacheLive(), false)
    await halted(false, 5)
  } finally { await Promise.all([a.close(), b.close()]) }
})

test('read cache: PUBLISH all, or any message that names no record, empties every task\'s cache; a hand edit alone does not', async () => {
  const { redis, a, b } = await twoTasks()
  const raw = redis.client()
  const region = async (r) => { await raw.set('doc:person:a@x.com', JSON.stringify({ region: r })) }
  try {
    for (const message of ['all', JSON.stringify({ kind: 'all' }), JSON.stringify({ kind: 'person' }), '{']) {
      await region('us-east-1')
      await raw.publish(INVALIDATE, 'all'); await landed()
      assert.equal((await b.getDoc('person:a@x.com')).region, 'us-east-1')
      await region('ap-south-1')
      assert.equal((await b.getDoc('person:a@x.com')).region, 'us-east-1', 'a hand edit publishes nothing, so the copy stays')
      await raw.publish(INVALIDATE, message); await landed()
      assert.equal((await b.getDoc('person:a@x.com')).region, 'ap-south-1', message)
    }
  } finally { await Promise.all([a.close(), b.close()]) }
})

test('read cache: each cached record\'s write publishes { kind, id } after it, in its transaction; activity and backup times on a box publish nothing', async () => {
  const sent = []
  const redis = fakeRedis()
  const store = redisStore(redis.client((cmd, key, run) => { sent.push([cmd, key]); return Promise.resolve(run()) }))
  const published = () => sent.splice(0)
  await store.putDoc('key:h', { id: 'k' }); await store.putDoc('person:a@x.com', {}); await store.putDoc('project:p1', {}); await store.putDoc('halt:a@x.com', {})
  await store.deleteDoc('halt:a@x.com')
  assert.deepEqual(published(), [...['doc:key:h', 'doc:person:a@x.com', 'doc:project:p1', 'doc:halt:a@x.com'].map(k => ['MULTI SET PUBLISH', k]), ['MULTI DEL PUBLISH', 'doc:halt:a@x.com']])
  await store.putDoc('key-used:k', {}); await store.putDoc('approval:x', {}); await store.putDoc('project-session:p1', {})
  assert.deepEqual(published().map(c => c[0]), ['SET', 'SET', 'SET'])
  await store.putBox('b1', { email: 'a@x.com' })
  await store.patchBox('b1', { active: 1, extended: 1 }); await store.patchBox('b1', { backedUp: 1, restored: undefined })
  await store.patchBox('b1', { paused: true }); await store.deleteBox('b1')
  // A patch is one EVAL, which publishes inside the script (below).
  assert.deepEqual(published(), [['MULTI SET SADD PUBLISH', 'box:b1'], ['EVAL', 'box:b1'], ['EVAL', 'box:b1'], ['EVAL', 'box:b1'], ['MULTI DEL SREM PUBLISH', 'box:b1']])
  // The message names the record and the writing task.
  const raw = redis.client(); const heard = []
  const sub = raw.duplicate(); await sub.connect(); await sub.subscribe(INVALIDATE, (m) => heard.push(JSON.parse(m)))
  await store.putDoc('key:h', { id: 'k' }); await store.invalidate('box', 'b2')
  await raw.set('box:b3', '{}'); await store.patchBox('b3', { active: 1 }); await store.patchBox('b3', { paused: true }); await landed()
  assert.deepEqual(heard.map(({ kind, id, from }) => [kind, id, typeof from]), [['key', 'h', 'string'], ['box', 'b2', 'undefined'], ['box', 'b3', 'string']])
  await sub.quit()
})

/** The patchBox contract, for memoryStore and redisStore alike. */
async function patches(store) {
  const first = { email: 'a@x.com', active: 1, extended: 1, restored: 'v1', ports: { dsh: '880', live: '881' } }
  await store.putBox('b1', first)
  assert.deepEqual(await store.patchBox('b1', { active: 5, restored: undefined }), first, 'it answers the record as it was')
  assert.deepEqual(await store.getBox('b1', { fresh: true }), { email: 'a@x.com', active: 5, extended: 1, ports: { dsh: '880', live: '881' } }, 'merged; an undefined field removed')
  const now = 1_762_000_000_123
  const extended = async (active) => { await store.patchBox('b1', { active }, 60_000); return (await store.getBox('b1', { fresh: true })).extended }
  assert.equal(await extended(now), now, 'extended moves once it is the given age')
  assert.equal(await extended(now + 59_999), now, 'and not before')
  assert.equal(await extended(now + 60_000), now + 60_000)
  assert.equal(await store.patchBox('none', { active: 1 }), undefined)
  assert.equal(await store.getBox('none'), undefined, 'a patch of no record writes nothing')
}

test('patchBox merges into the record and answers it as it was; with an age, touch\'s extension; memory and Redis alike', async () => {
  await patches(memoryStore())
  await patches(redisStore(fakeRedis().client()))
})

test('redis store: two patches of different fields at once both land (one EVAL each, no read-then-write)', async () => {
  // Each round trip answers after 5 ms, as a read-then-write would interleave.
  const redis = fakeRedis({ send: (name, key, run) => new Promise(r => setTimeout(r, 5)).then(run) })
  const store = redisStore(redis.client())
  await store.putBox('b1', { email: 'a@x.com', active: 1, paused: false })
  await Promise.all([store.patchBox('b1', { paused: true, wakeAt: 9 }), store.patchBox('b1', { active: 2 })])
  assert.deepEqual(await store.getBox('b1'), { email: 'a@x.com', active: 2, paused: true, wakeAt: 9 })
})

// Flushes database 2: only a disposable Redis named by TEST_REDIS_URL, never REDIS_URL. Runs store.mjs's PATCH, cjson and all.
test('redis store: PATCH on a real Redis merges, removes, extends, publishes and answers as the fake does', { skip: !process.env.TEST_REDIS_URL && 'set TEST_REDIS_URL to a disposable Redis to run' }, async () => {
  const { createClient } = await import('redis')
  const client = createClient({ url: process.env.TEST_REDIS_URL, database: 2 }); await client.connect(); await client.flushDb()
  const store = redisStore(client)
  const sub = client.duplicate(); await sub.connect(); const heard = []
  await sub.subscribe(INVALIDATE, (m) => heard.push(JSON.parse(m)))
  try {
    await patches(store)
    await store.patchBox('b1', { paused: true, wakeAt: 9 }); await store.patchBox('b1', { backedUp: 3 })
    await new Promise(r => setTimeout(r, 50))
    assert.deepEqual(heard.map(({ kind, id }) => [kind, id]), [['box', 'b1'], ['box', 'b1']], 'the putBox and the pause; activity and backups are quiet')
    assert.deepEqual(await store.getBox('b1', { fresh: true }), { email: 'a@x.com', active: 1_762_000_060_123, extended: 1_762_000_060_123, ports: { dsh: '880', live: '881' }, paused: true, wakeAt: 9, backedUp: 3 })
  } finally { await sub.quit(); await store.close() }
})
