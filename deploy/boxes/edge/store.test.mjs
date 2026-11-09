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
}

test('memory store: incrementBy, getCount, deleteDoc, removeFromSet', () => contract(memoryStore()))

test('redis store: incrementBy, getCount, deleteDoc, removeFromSet, and incrementBy sets a millisecond expiry', { skip: !process.env.REDIS_URL && 'set REDIS_URL to run' }, async () => {
  const { createClient } = await import('redis')
  // Database 1: node --test runs files in parallel, and edge.test.mjs flushes database 0.
  const client = createClient({ url: process.env.REDIS_URL, database: 1 }); await client.connect(); await client.flushDb()
  const store = redisStore(client)
  try {
    await contract(store)
    const ttl = await client.pTTL('tokens:a')
    assert.ok(ttl > 0 && ttl <= 60_000, `pttl ${ttl}`)
  } finally { await store.close() }
})
