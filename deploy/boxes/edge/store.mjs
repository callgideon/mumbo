// Shared state for edge replicas: box records, per-user locks, daily budgets and token counters, the sweep and poll
// leaders, and small documents and sets (projects, their members and repositories, approvals, door key hashes). TTLs are milliseconds,
// except increment's seconds.
// memoryStore serves tests and a single replica; redisStore serves production (ElastiCache, TLS), with the read cache.
//
// The read cache (spec R6b): redisStore given `cacheMs` keeps, per edge task, what it reads of the records on the request
// paths: door key records (`doc:key:<sha256>`), person placement docs (`doc:person:<email>`), project docs
// (`doc:project:<id>`), halt switches (`doc:halt:<email>`) and box records (`box:<id>`), a missing record included. Every
// write of one of them through any redisStore publishes `{ kind, id, from }` on INVALIDATE in the write's own transaction
// (for patchBox, its script), after the write (kind `key`, `person`, `project`, `halt` or `box`; id the rest of the key;
// from the writing task, which drops its own copy when the write answers or fails and so skips its own message), and
// every other task that receives it drops its copy. A task serves its copies only while its subscription to INVALIDATE is
// confirmed and answering; on a disconnect or an error it empties the cache and reads through until it is subscribed
// again.
// `cacheMs` is each copy's backstop lifetime.
import { randomUUID } from 'node:crypto'

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/** The channel of the read cache's invalidations: JSON `{ kind, id, from? }`. Any other message, the bare word `all`
 *  included (RUNBOOK "The edge's read cache"), empties every subscribed task's cache. */
export const INVALIDATE = 'edge:invalidate'
/** patchBox's script. KEYS[1] is the box record; ARGV[1] the fields as JSON, null for a field to remove; ARGV[2] '' or,
 *  for touch, how old `extended` may get before it moves to the new `active` too; ARGV[3] '' or the invalidation to
 *  publish after the write. Merges the fields into the stored record in one step and returns the record as it was before,
 *  or nil, writing nothing, when there is none. The record goes through cjson, which writes an empty array as `{}`;
 *  box records hold no arrays, and a field that does would need its own handling here. */
const PATCH = `local v = redis.call('get', KEYS[1])
if not v then return false end
local b, fields = cjson.decode(v), cjson.decode(ARGV[1])
local extended = tonumber(b.extended) or 0
for k, x in pairs(fields) do if x == cjson.null then b[k] = nil else b[k] = x end end
if ARGV[2] ~= '' and fields.active - extended >= tonumber(ARGV[2]) then b.extended = fields.active end
redis.call('set', KEYS[1], cjson.encode(b))
if ARGV[3] ~= '' then redis.call('publish', '${INVALIDATE}', ARGV[3]) end
return v`
/** The kinds a message names one record of; every other message empties the whole cache. */
const KINDS = ['key', 'person', 'project', 'halt', 'box']
/** Box record fields no cached reader uses: a patch of only these (activity, keepalive and backup times) sends no message. */
const QUIET = new Set(['active', 'extended', 'backedUp', 'restored'])
/** How often a subscribed task pings its subscription; one that has not answered for twice this serves no copy. */
const HEARTBEAT_MS = 5_000
/** The most copies a task keeps; past it the cache starts again empty (format-valid door keys cost a read each). */
const MAX_ENTRIES = 10_000
/** `{ kind, id }` of a cached Redis key, or undefined for any other key. */
const cachedKind = (key) => { const m = /^(?:doc:(key|person|project|halt)|(box)):(.+)$/.exec(key); return m ? { kind: m[1] ?? m[2], id: m[3] } : undefined }
const keyOf = ({ kind, id }) => (kind === 'box' ? `box:${id}` : `doc:${kind}:${id}`)

/** In-process store with the same contract as redisStore. One replica, so there is nothing to invalidate: reads are always
 *  the latest write, `cacheLive` is always true, and no invalidation is ever reported. */
export function memoryStore() {
  const boxes = new Map()
  const counters = new Map()
  const leases = new Map()
  const docs = new Map()
  const sets = new Map()
  const take = (key, ttlMs) => {
    const now = Date.now()
    if ((leases.get(key)?.until ?? 0) > now) return false
    const token = randomUUID()
    leases.set(key, { until: now + ttlMs, token })
    return token
  }
  return {
    async getBox(id) { const b = boxes.get(id); return b && { ...b } },
    async putBox(id, record) { boxes.set(id, { ...record }) },
    async patchBox(id, fields, extendMs) {
      const b = boxes.get(id)
      if (!b) return undefined
      const next = { ...b, ...fields }
      for (const [k, v] of Object.entries(fields)) if (v === undefined) delete next[k]
      if (extendMs !== undefined && fields.active - (Number(b.extended) || 0) >= extendMs) next.extended = fields.active
      boxes.set(id, next)
      return { ...b }
    },
    async deleteBox(id) { boxes.delete(id) },
    async listBoxes() { return [...boxes].map(([id, b]) => ({ id, ...b })) },
    async increment(key, ttlSeconds) { const n = (counters.get(key) ?? 0) + 1; counters.set(key, n); void ttlSeconds; return n },
    async incrementBy(key, n, ttlMs) { const v = (counters.get(key) ?? 0) + n; counters.set(key, v); void ttlMs; return v },
    async getCount(key) { return counters.get(key) ?? 0 },
    async lease(key, ttlMs) { return take(key, ttlMs) },
    async release(key, token) { if (leases.get(key)?.token === token) leases.delete(key) },
    async withLock(key, ttlMs, fn) {
      for (let waited = 0; !take(`lock:${key}`, ttlMs); waited += 50) {
        if (waited > ttlMs) throw Object.assign(new Error(`lock ${key} busy`), { status: 503 })
        await sleep(50)
      }
      try { return await fn() } finally { leases.delete(`lock:${key}`) }
    },
    async getDoc(key) { const v = docs.get(key); return v && structuredClone(v) },
    async putDoc(key, value) { docs.set(key, structuredClone(value)) },
    async deleteDoc(key) { docs.delete(key) },
    async addToSet(key, member) { if (!sets.has(key)) sets.set(key, new Set()); sets.get(key).add(member) },
    async removeFromSet(key, member) { sets.get(key)?.delete(member) },
    async setMembers(key) { return [...(sets.get(key) ?? [])] },
    cacheLive: () => true,
    onInvalidate() {},
    async invalidate() {},
    async close() {},
  }
}

/**
 * The read cache of one edge task over `client`, and its subscription (a duplicate client) when `cacheMs` > 0.
 * @returns {{ get(key: string, fresh?: boolean): Promise<string | null>, drop(key: string): void, live(): boolean, self: string,
 *   onInvalidate(fn: (m: { kind: string, id?: string }, remote: boolean) => void): void, close(): Promise<void> }}
 *   `get` answers a cached key from the cache while live, unless `fresh`; a read keeps its answer only while live and when
 *   no invalidation arrived during it. `drop` forgets one key after this task's own write; `onInvalidate` is told every
 *   drop, `remote` false for this task's own writes (`{ kind: 'all' }`, remote, when the whole cache goes). `self` is the
 *   `from` of this task's messages.
 */
function readCache(client, { cacheMs, now, log }) {
  const entries = new Map()  // Redis key -> { value: the raw reply, until }
  const watchers = []
  const self = randomUUID()
  let gen = 0, subscribed = false, up = false, heardAt = 0, pinging = false, sub, timer
  const say = (fields) => log(JSON.stringify({ edge: 'store', ...fields }))
  const tell = (m, remote) => { for (const w of watchers) w(m, remote) }
  const flush = () => { entries.clear(); gen++; tell({ kind: 'all' }, true) }
  const forget = (key, remote) => { entries.delete(key); gen++; tell(cachedKind(key), remote) }
  const live = () => up && now() - heardAt < 2 * HEARTBEAT_MS
  if (cacheMs > 0) {
    const down = (why) => { if (up) say({ level: 'warn', msg: 'read cache off', why }); up = false; flush() }
    sub = client.duplicate()
    sub.on('error', (e) => down(e.message)).on('reconnecting', () => down('reconnecting')).on('end', () => down('closed'))
    // node-redis emits ready after a reconnect only once its resubscription is confirmed.
    sub.on('ready', () => { if (subscribed) { up = true; heardAt = now(); say({ msg: 'read cache on' }) } })
    const onMessage = (message) => {
      heardAt = now()
      let m
      try { m = JSON.parse(message) } catch { m = undefined }  // `all`, or anything unreadable: everything goes
      if (m?.from === self) return
      if (KINDS.includes(m?.kind) && typeof m.id === 'string') forget(keyOf(m), true); else flush()
    }
    sub.connect().then(() => sub.subscribe(INVALIDATE, onMessage)).then(() => { subscribed = up = true; heardAt = now(); say({ msg: 'read cache on' }) },
      (e) => say({ level: 'error', msg: 'read cache subscription failed', error: e.message }))
    // A half-open connection never errors: an unanswered ping takes the cache off within 2 * HEARTBEAT_MS. One ping at a
    // time; a dropped connection rejects the one in flight (and emits its error).
    timer = setInterval(() => {
      if (!up || pinging) return
      pinging = true
      sub.ping().then(() => { heardAt = now() }, () => {}).finally(() => { pinging = false })
    }, HEARTBEAT_MS)
    timer.unref?.()
  }
  return {
    async get(key, fresh) {
      if (!live() || !cachedKind(key)) return client.get(key)
      const hit = entries.get(key)
      if (!fresh && hit && hit.until > now()) return hit.value
      const at = gen, value = await client.get(key)
      if (at === gen && live()) {
        if (entries.size >= MAX_ENTRIES) entries.clear()
        entries.set(key, { value, until: now() + cacheMs })
      }
      return value
    },
    drop: (key) => forget(key, false),
    live,
    self,
    onInvalidate(fn) { watchers.push(fn) },
    async close() { clearInterval(timer); up = false; if (sub) await sub.quit().catch(() => {}) },
  }
}

/**
 * Redis-backed store. Box records are JSON under `box:<id>` plus the set `boxes`; locks are SET NX PX with a
 * per-holder token released by compare-and-delete; counters expire on their own.
 * @param {import('redis').RedisClientType} client - a connected node-redis v4 client.
 * @param {{ cacheMs?: number, now?: () => number, log?: (line: string) => void }} [opts] - `cacheMs` > 0 turns the read
 *   cache on (file comment), with copies kept at most that long; 0 (the default, as in operator scripts) reads every
 *   record from Redis and opens no subscription. Writes of cached records publish either way.
 * Beyond memoryStore's methods: `getDoc(key, { fresh: true })` and `getBox(id, { fresh: true })` read Redis whatever the
 * cache holds (a read before a write under a lock); `cacheLive()` is true while the cache may serve copies;
 * `onInvalidate(fn)` calls `fn({ kind, id }, remote)` for every copy dropped, `remote` false for this task's own writes, and
 * `fn({ kind: 'all' }, true)` when the cache empties;
 * `invalidate(kind, id)` publishes a message without a write (a box killed outside the edge).
 */
export function redisStore(client, { cacheMs = 0, now = Date.now, log = console.log } = {}) {
  const RELEASE = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end"
  const cache = readCache(client, { cacheMs, now, log })
  const read = async (id, fresh) => { const v = await cache.get(`box:${id}`, fresh); return v ? JSON.parse(v) : undefined }
  /** Writes `key` with `op`; a cached record's write is a transaction that publishes its message after the write, and
   *  drops this task's own copy once it answers or fails: a lost reply may follow a write Redis applied, whose message this
   *  task skips. `kind` null writes without a message. */
  async function commit(key, op, kind = cachedKind(key)) {
    if (!kind) return op(client)
    try { await op(client.multi()).publish(INVALIDATE, JSON.stringify({ ...kind, from: cache.self })).exec() } finally { cache.drop(key) }
  }
  return {
    getBox: (id, opts) => read(id, opts?.fresh),
    async putBox(id, record) { await commit(`box:${id}`, (m) => m.set(`box:${id}`, JSON.stringify(record)).sAdd('boxes', id)) },
    /** Merges `fields` into the stored record in one EVAL (PATCH), so concurrent patches never lose each other's fields;
     *  only a putBox replaces the whole record. A field given as undefined is removed. With `extendMs` (touch), `extended`
     *  also moves to `fields.active` once the stored one is at least that old. Resolves the record as it was before the
     *  patch, or undefined, writing nothing, when there is none. A patch of only QUIET fields publishes nothing. */
    async patchBox(id, fields, extendMs) {
      const quiet = Object.keys(fields).every(f => QUIET.has(f))
      let v
      // As in commit, the copy goes even when the EVAL fails.
      try {
        v = await client.eval(PATCH, { keys: [`box:${id}`], arguments: [JSON.stringify(fields, (k, x) => (x === undefined ? null : x)),
          extendMs === undefined ? '' : String(extendMs), quiet ? '' : JSON.stringify({ kind: 'box', id, from: cache.self })] })
      } finally { if (!quiet) cache.drop(`box:${id}`) }
      return v ? JSON.parse(v) : undefined
    },
    async deleteBox(id) { await commit(`box:${id}`, (m) => m.del(`box:${id}`).sRem('boxes', id)) },
    async listBoxes() {
      const ids = await client.sMembers('boxes')
      const out = []
      for (const id of ids) { const b = await read(id, true); if (b) out.push({ id, ...b }); else await client.sRem('boxes', id) }
      return out
    },
    async increment(key, ttlSeconds) {
      const [n] = await client.multi().incr(key).expire(key, ttlSeconds).exec()
      return Number(n)
    },
    /** Adds n and returns the new total; the key expires ttlMs after its last increment. */
    async incrementBy(key, n, ttlMs) {
      const [v] = await client.multi().incrBy(key, n).pExpire(key, ttlMs).exec()
      return Number(v)
    },
    async getCount(key) { return Number(await client.get(key) ?? 0) },
    /** The holder's token, or false while another holder has the lease. */
    async lease(key, ttlMs) { const token = randomUUID(); return (await client.set(key, token, { NX: true, PX: ttlMs })) === 'OK' && token },
    /** Deletes the lease only while `token` still holds it (compare-and-delete), never a later holder's. */
    async release(key, token) { await client.eval(RELEASE, { keys: [key], arguments: [token] }) },
    async withLock(key, ttlMs, fn) {
      const token = randomUUID()
      for (let waited = 0; (await client.set(`lock:${key}`, token, { NX: true, PX: ttlMs })) !== 'OK'; waited += 100) {
        if (waited > ttlMs) throw Object.assign(new Error(`lock ${key} busy`), { status: 503 })
        await sleep(100)
      }
      // The release is not awaited: fn's caller goes on at once, and a release that fails leaves the lock to expire.
      try { return await fn() } finally {
        client.eval(RELEASE, { keys: [`lock:${key}`], arguments: [token] })
          .catch((e) => log(JSON.stringify({ edge: 'store', level: 'warn', msg: 'lock release failed', lock: key, error: e.message })))
      }
    },
    async getDoc(key, opts) { const v = await cache.get(`doc:${key}`, opts?.fresh); return v ? JSON.parse(v) : undefined },
    async putDoc(key, value) { await commit(`doc:${key}`, (c) => c.set(`doc:${key}`, JSON.stringify(value))) },
    async deleteDoc(key) { await commit(`doc:${key}`, (c) => c.del(`doc:${key}`)) },
    async addToSet(key, member) { await client.sAdd(`set:${key}`, member) },
    async removeFromSet(key, member) { await client.sRem(`set:${key}`, member) },
    async setMembers(key) { return client.sMembers(`set:${key}`) },
    cacheLive: () => cache.live(),
    onInvalidate: (fn) => cache.onInvalidate(fn),
    async invalidate(kind, id) { await client.publish(INVALIDATE, JSON.stringify({ kind, id })) },
    async close() { await cache.close(); await client.quit() },
  }
}
