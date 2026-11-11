// node --test: counters, documents and sets added for the M1 edge services, on both stores.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { memoryStore, redisStore } from './store.mjs'

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
