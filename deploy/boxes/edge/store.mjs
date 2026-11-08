// Shared state for edge replicas: box records, per-user locks, daily budgets and the sweep leader.
// memoryStore serves tests and a single replica; redisStore serves production (ElastiCache, TLS).
import { randomUUID } from 'node:crypto'

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/** In-process store with the same contract as redisStore. */
export function memoryStore() {
  const boxes = new Map()
  const counters = new Map()
  const leases = new Map()
  const take = (key, ttlMs) => {
    const now = Date.now()
    if ((leases.get(key) ?? 0) > now) return false
    leases.set(key, now + ttlMs)
    return true
  }
  return {
    async getBox(id) { const b = boxes.get(id); return b && { ...b } },
    async putBox(id, record) { boxes.set(id, { ...record }) },
    async patchBox(id, fields) { const b = boxes.get(id); if (b) boxes.set(id, { ...b, ...fields }) },
    async deleteBox(id) { boxes.delete(id) },
    async listBoxes() { return [...boxes].map(([id, b]) => ({ id, ...b })) },
    async increment(key, ttlSeconds) { const n = (counters.get(key) ?? 0) + 1; counters.set(key, n); void ttlSeconds; return n },
    async lease(key, ttlMs) { return take(key, ttlMs) },
    async release(key) { leases.delete(key) },
    async withLock(key, ttlMs, fn) {
      for (let waited = 0; !take(`lock:${key}`, ttlMs); waited += 50) {
        if (waited > ttlMs) throw Object.assign(new Error(`lock ${key} busy`), { status: 503 })
        await sleep(50)
      }
      try { return await fn() } finally { leases.delete(`lock:${key}`) }
    },
    async close() {},
  }
}

/**
 * Redis-backed store. Box records are JSON under `box:<id>` plus the set `boxes`; locks are SET NX PX with a
 * per-holder token released by compare-and-delete; counters expire on their own.
 * @param {import('redis').RedisClientType} client - a connected node-redis v4 client.
 */
export function redisStore(client) {
  const RELEASE = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end"
  const read = async (id) => { const v = await client.get(`box:${id}`); return v ? JSON.parse(v) : undefined }
  return {
    getBox: read,
    async putBox(id, record) { await client.multi().set(`box:${id}`, JSON.stringify(record)).sAdd('boxes', id).exec() },
    async patchBox(id, fields) {
      // Last writer wins per field group; every caller holds the user's lock or writes timestamps only.
      const b = await read(id)
      if (b) await client.set(`box:${id}`, JSON.stringify({ ...b, ...fields }))
    },
    async deleteBox(id) { await client.multi().del(`box:${id}`).sRem('boxes', id).exec() },
    async listBoxes() {
      const ids = await client.sMembers('boxes')
      const out = []
      for (const id of ids) { const b = await read(id); if (b) out.push({ id, ...b }); else await client.sRem('boxes', id) }
      return out
    },
    async increment(key, ttlSeconds) {
      const [n] = await client.multi().incr(key).expire(key, ttlSeconds).exec()
      return Number(n)
    },
    async lease(key, ttlMs) { return (await client.set(key, randomUUID(), { NX: true, PX: ttlMs })) === 'OK' },
    async release(key) { await client.del(key) },
    async withLock(key, ttlMs, fn) {
      const token = randomUUID()
      for (let waited = 0; (await client.set(`lock:${key}`, token, { NX: true, PX: ttlMs })) !== 'OK'; waited += 100) {
        if (waited > ttlMs) throw Object.assign(new Error(`lock ${key} busy`), { status: 503 })
        await sleep(100)
      }
      try { return await fn() } finally { await client.eval(RELEASE, { keys: [`lock:${key}`], arguments: [token] }).catch(() => {}) }
    },
    async close() { await client.quit() },
  }
}
