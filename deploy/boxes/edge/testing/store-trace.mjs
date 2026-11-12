// Test support: a store that records its round trips. Outside the image and never run as a test: imageCheck and the
// Dockerfile take only .mjs files directly in the edge directory, and node --test matches no file name here.
// It is redisStore (store.mjs) over an in-memory stand-in for the node-redis client: each client call (GET, SET, EVAL, one
// MULTI…EXEC) is one round trip, recorded with its key and the edge code that issued it, and answered after `latencyMs`.
import { AsyncLocalStorage } from 'node:async_hooks'
import { redisStore } from '../store.mjs'

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
 * @returns {{ store: ReturnType<typeof redisStore>, offPath: <T>(fn: () => T) => T,
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

  // The node-redis v4 calls redisStore makes. ponytail: no key expiry (PX, EXPIRE); the traced paths release their locks.
  const strings = new Map(), sets = new Map()
  const members = (k) => sets.get(k) ?? sets.set(k, new Set()).get(k)
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
    eval: (_script, { keys: [k], arguments: [token] }) => (strings.get(k) === token ? ops.del(k) : 0),  // store.mjs RELEASE only
  }
  const keyOf = (name, a) => (name === 'eval' ? a[1].keys[0] : a[0])
  const client = { quit: async () => {} }
  for (const [name, op] of Object.entries(ops)) client[name] = (...a) => send(`${name.toUpperCase()}${a[2]?.NX ? ' NX' : ''}`, keyOf(name, a), () => op(...a))
  client.multi = () => {
    const queued = []
    const chain = { exec: () => send(`MULTI ${queued.map(q => q.name).join(' ')}`, queued[0].key, () => queued.map(q => q.run())) }
    for (const [name, op] of Object.entries(ops)) chain[name] = (...a) => { queued.push({ name: name.toUpperCase(), key: a[0], run: () => op(...a) }); return chain }
    return chain
  }

  return {
    store: redisStore(client),
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
