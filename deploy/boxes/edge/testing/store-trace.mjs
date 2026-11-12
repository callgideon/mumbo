// Test support: a store that records its round trips. Outside the image and never run as a test: imageCheck and the
// Dockerfile take only .mjs files directly in the edge directory, and node --test matches no file name here.
// It is redisStore (store.mjs) over an in-memory stand-in for the node-redis client: each client call (GET, SET, EVAL, one
// MULTI…EXEC) is one round trip, recorded with its key and the edge code that issued it, and answered after `latencyMs`.
import { AsyncLocalStorage } from 'node:async_hooks'
import { EventEmitter } from 'node:events'
import { INVALIDATE, redisStore } from '../store.mjs'

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/** Where a command came from: the store.mjs method that sent it, and that method's caller, as `keys.mjs:116 verify`. */
function issuer() {
  const limit = Error.stackTraceLimit
  Error.stackTraceLimit = 50
  const stack = new Error().stack
  Error.stackTraceLimit = limit
  // Only modules directly in the edge directory: this file, node_modules and node: frames never match.
  // `at [async ][Object.]name[ [as alias]] (file:///…/edge/file.mjs:line:column)`, or without a name and parentheses.
  const frames = stack.split('\n').map(l => /at (?:async )?(?:([^\s(]+)(?: \[as ([^\]]+)\])? \()?\S*\/edge\/([\w.-]+\.mjs):(\d+):\d+\)?$/.exec(l))
    .filter(f => f && !f[3].endsWith('.test.mjs')).map(([, fn = '', alias, file, line]) => ({ fn: alias ?? fn.replace(/^Object\./, ''), file, line }))
  // The first run of store.mjs frames is the method; a withLock further down only runs the caller.
  let end = frames.findIndex(f => f.file === 'store.mjs')
  while (frames[end + 1]?.file === 'store.mjs') end++
  const caller = frames[end + 1]
  return { method: frames[end]?.fn ?? '', at: caller ? `${caller.file}:${caller.line} ${caller.fn}`.trim() : '?' }
}

/**
 * A traced store.
 * @param {{ latencyMs?: number, names?: [string, string][] }} [opts] - `names` maps literal values in keys (an email, a box
 *   id) to the placeholders the trace shows; a SHA-256 hex and a YYYY-MM-DD date always show as `<sha256>` and `<day>`.
 * @returns {{ store: ReturnType<typeof redisStore>, connect: (opts?: object) => Promise<ReturnType<typeof redisStore>>,
 *   redis: ReturnType<typeof fakeRedis>, offPath: <T>(fn: () => T) => T,
 *   trace: (fn: (mark: (name: string) => void) => Promise<void>) => Promise<{ commands: object[], depth: (mark: string) => number }>}}
 *   Outside `trace` commands are neither recorded nor delayed (setting up). Inside, each command's reply waits
 *   `latencyMs`, and its `level` is one more than the highest level whose reply had arrived when it was issued: commands
 *   issued together before any reply are one level, a command issued after a reply is the next. `offPath(fn)` flags every
 *   command fn issues, also after its awaits, as not awaited by the request (`off: true`): the caller wraps what the code
 *   under test fires and forgets. A command on the path counts only replies on the path; one off it counts every reply.
 *   `trace` resolves once `fn` has and no command is in flight; `depth(mark)` is the highest level of the commands on
 *   the path whose replies had arrived when `fn` called `mark(mark)`: the round trips the request had waited for by then.
 */
export function tracedStore({ latencyMs = 50, names = [] } = {}) {
  const off = new AsyncLocalStorage()
  const pattern = (key) => names.reduce((k, [value, name]) => k.replaceAll(value, name), String(key))
    .replace(/\b[0-9a-f]{64}\b/g, '<sha256>').replace(/\b\d{4}-\d{2}-\d{2}\b/g, '<day>')
  // Levels on the path count only replies on the path, so a fire-and-forget chain never deepens the request's own.
  let log, replies = 0, doneAll = 0, doneOn = 0, pending = 0
  const send = (name, key, run) => {
    const out = run()
    if (!log) return Promise.resolve(out)
    const isOff = off.getStore() === true
    const c = { level: (isOff ? doneAll : doneOn) + 1, name, key: pattern(key), ...issuer(), off: isOff }
    log.push(c)
    pending++
    return sleep(latencyMs).then(() => {
      c.reply = ++replies; pending--
      doneAll = Math.max(doneAll, c.level)
      if (!isOff) doneOn = Math.max(doneOn, c.level)
      return out
    })
  }

  const redis = fakeRedis({ send, deliverMs: latencyMs })
  return {
    store: redisStore(redis.client()),
    /** A new edge task's store over the same data, with its own read cache and subscription (opts as redisStore's), once
     *  its subscription is confirmed. Its subscriber's commands are never traced. */
    async connect(opts) { const s = redisStore(redis.client(), { log: () => {}, ...opts }); await subscribed(s); return s },
    redis,
    offPath: (fn) => off.run(true, fn),
    async trace(fn) {
      log = []; replies = 0; doneAll = 0; doneOn = 0
      const marks = {}
      await fn((name) => { marks[name] = replies })
      do await sleep(latencyMs); while (pending)
      const commands = log
      log = undefined
      const depth = (mark) => Math.max(0, ...commands.filter(c => !c.off && c.reply <= marks[mark]).map(c => c.level))
      return { commands, depth }
    },
  }
}

/** Resolves once `store`'s read cache is live (its subscription confirmed). */
export async function subscribed(store) {
  while (!store.cacheLive()) await new Promise(r => setImmediate(r))
}

/**
 * The node-redis v4 calls redisStore makes, in memory, for any number of clients over one data set: GET, SET (NX), DEL,
 * INCR, INCRBY, EXPIRE, PEXPIRE, SADD, SREM, SMEMBERS, store.mjs's RELEASE and PATCH scripts (PATCH in JavaScript, with
 * the same merge, extension and message), PUBLISH, MULTI…EXEC, and on a
 * subscriber (`duplicate()`) connect, SUBSCRIBE, PING and quit, with node-redis's events (`ready`, `error`,
 * `reconnecting`, `end`). A message reaches each subscriber `deliverMs` after its PUBLISH, unless the subscriber has
 * dropped meanwhile. ponytail: no key expiry (PX, EXPIRE); the paths under test release their locks.
 * @param {{ send?: (name: string, key: string, run: () => unknown) => Promise<unknown>, deliverMs?: number }} [opts] -
 *   `send` carries every command of a client from `client()` (one round trip: its name, key and the operation), never a
 *   subscriber's.
 * @returns {{ client: (send?: Function) => object, drop: () => void, reconnect: () => void, silence: () => void }}
 *   `client(send?)` makes a client, its commands carried by `send` when given (a test's own count). `drop()` cuts every subscriber as a lost socket does (`error`, then `reconnecting`; messages are lost) and
 *   `reconnect()` resubscribes them (`ready`). `silence()` cuts them without a word, as a half-open connection: no message,
 *   no event, and PING never answers.
 */
export function fakeRedis({ send = (name, key, run) => Promise.resolve(run()), deliverMs = 0 } = {}) {
  const strings = new Map(), sets = new Map(), listening = new Set(), cut = new Set()
  const members = (k) => sets.get(k) ?? sets.set(k, new Set()).get(k)
  const patch = (k, fields, extendMs, message) => {
    const old = strings.get(k)
    if (old === undefined) return null
    const b = JSON.parse(old), f = JSON.parse(fields), extended = Number(b.extended) || 0
    for (const [name, value] of Object.entries(f)) { if (value === null) delete b[name]; else b[name] = value }
    if (extendMs !== '' && f.active - extended >= Number(extendMs)) b.extended = f.active
    strings.set(k, JSON.stringify(b))
    if (message) ops.publish(INVALIDATE, message)
    return old
  }
  const ops = {
    get: (k) => strings.get(k) ?? null,
    set: (k, v, o = {}) => { if (o.NX && strings.has(k)) return null; strings.set(k, String(v)); return 'OK' },
    del: (k) => Number(strings.delete(k)),
    incr: (k) => ops.incrBy(k, 1),
    incrBy: (k, n) => { const v = Number(strings.get(k) ?? 0) + n; strings.set(k, String(v)); return v },
    expire: () => 1,
    pExpire: () => 1,
    sAdd: (k, m) => { members(k).add(m); return 1 },
    sRem: (k, m) => Number(members(k).delete(m)),
    sMembers: (k) => [...members(k)],
    eval: (script, { keys: [k], arguments: a }) => (script.includes('cjson') ? patch(k, ...a) : strings.get(k) === a[0] ? ops.del(k) : 0),
    publish: (channel, message) => {
      for (const s of listening) setTimeout(() => { if (listening.has(s)) s.channels.get(channel)?.(message) }, deliverMs)
      return listening.size
    },
  }
  const keyOf = (name, a) => (name === 'eval' ? a[1].keys[0] : a[0])
  const direct = (name, key, run) => Promise.resolve(run())
  function client(carry = send) {
    const c = new EventEmitter()
    for (const [name, op] of Object.entries(ops)) c[name] = (...a) => carry(`${name.toUpperCase()}${a[2]?.NX ? ' NX' : ''}`, keyOf(name, a), () => op(...a))
    c.multi = () => {
      const queued = []
      const chain = { exec: () => carry(`MULTI ${queued.map(q => q.name).join(' ')}`, queued[0].key, () => queued.map(q => q.run())) }
      for (const [name, op] of Object.entries(ops)) chain[name] = (...a) => { queued.push({ name: name.toUpperCase(), key: a[0], run: () => op(...a) }); return chain }
      return chain
    }
    c.channels = new Map()
    c.duplicate = () => client(direct)
    c.connect = async () => { c.emit('ready') }
    c.subscribe = async (channel, listener) => { c.channels.set(channel, listener); listening.add(c) }
    c.ping = () => (cut.has(c) ? new Promise(() => {}) : Promise.resolve('PONG'))
    c.quit = async () => { listening.delete(c); c.emit('end') }
    return c
  }
  return {
    client: (carry) => client(carry),
    drop() { for (const c of listening) { listening.delete(c); cut.add(c); c.emit('error', new Error('Socket closed unexpectedly')); c.emit('reconnecting') } },
    reconnect() { for (const c of cut) { cut.delete(c); listening.add(c); c.emit('ready') } },
    silence() { for (const c of listening) { listening.delete(c); cut.add(c) } },
  }
}
