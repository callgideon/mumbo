// Door keys (spec section 10, B31): `mumbo_pat_` keys a person mints, lists and revokes on the approve host's key
// manager, for the MCP door (B32), which calls verify, requireScope and requireProject before any tool.
// The format is jumbo's (platform-api core/db/key_format.py) with this prefix: PREFIX, 32 base62 characters, then the
// CRC32 of PREFIX and those 32 as 6 base62 digits, most significant first, padded with '0'; 48 characters in all.
// The edge store holds only each key's SHA-256: doc `key:<sha256 hex>` = { id, owner, name, scopes, projects, createdAt,
// expiresAt?, revokedAt? } (times in epoch ms), set `keys:<email>` = the hashes of that person's keys, and doc
// `key-used:<id>` = { at }, the last verified use, written at most once a minute per key and edge process (as jumbo
// does). Key records come from the edge's read cache (store.mjs): a revocation's write publishes its invalidation, so it
// holds on every edge task once that message lands, and expiry is checked against the record's expiresAt on every call.
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { crc32 } from 'node:zlib'
import { checkedForm, csrfTokens, hidden, STYLE } from './approve-page.mjs'
import { esc, PAGE_SECURITY } from './edge.mjs'

export const PREFIX = 'mumbo_pat_'
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
/** What a key may do on the door: read (status), prompt (talk to Mumbo, answer its questions), workspace (start and stop tasks). */
export const SCOPES = ['read', 'prompt', 'workspace']
/** The lifetimes a key may be given, in days; a key without one never expires. */
export const EXPIRY_DAYS = [7, 30, 90, 365]
const DAY_MS = 86_400_000
const LAST_USE_MS = 60_000

/** The 6-character base62 CRC32 of PREFIX + body. */
export function checksum(body) {
  let value = crc32(PREFIX + body), out = ''
  for (let i = 0; i < 6; i++) { out = ALPHABET[value % 62] + out; value = Math.floor(value / 62) }
  return out
}
/** A new key: PREFIX, 32 uniformly random base62 characters and their checksum. */
export function generateKey() {
  const body = Array.from({ length: 32 }, () => ALPHABET[randomInt(62)]).join('')
  return PREFIX + body + checksum(body)
}
/** True for a string of the key format whose checksum matches, compared in constant time. Reads no store. */
export function isKey(value) {
  if (typeof value !== 'string' || value.length !== 48 || !value.startsWith(PREFIX) || !/^[0-9A-Za-z]{38}$/.test(value.slice(10))) return false
  return timingSafeEqual(Buffer.from(value.slice(42)), Buffer.from(checksum(value.slice(10, 42))))
}
/** The SHA-256 (hex) a key is stored under. */
export const keyHash = (key) => createHash('sha256').update(key).digest('hex')

/** A refusal with the HTTP `status` and the error `code` callers see (jumbo's codes, plus project_not_allowed). */
const refusal = (status, code, message) => Object.assign(new Error(message), { status, code })

/**
 * The door keys in the edge store (store.mjs docs and sets).
 * @param {{ store: object, projects?: ReturnType<typeof import('./projects.mjs').projects>, admitted?: (email: string) => boolean, now?: () => number, log?: (line: string) => void }} deps
 *   `projects` is needed by mint and requireProject, `admitted` (the edge allowlist) by verify and live; list and revoke
 *   need neither.
 */
export function doorKeys({ store, projects, admitted, now = () => Date.now(), log = console.log }) {
  const say = (fields) => log(JSON.stringify({ edge: 'key', ...fields }))
  const bad = (message) => refusal(400, 'invalid_request', message)
  const lastWrite = new Map()  // key id -> when this process last wrote its key-used doc
  /** [hash, record] of each of the owner's keys; a hash whose record is gone is skipped. */
  async function own(owner) {
    const out = []
    for (const hash of await store.setMembers(`keys:${owner}`)) { const k = await store.getDoc(`key:${hash}`); if (k) out.push([hash, k]) }
    return out
  }
  /** Throws unless the stored key record `k` is neither revoked nor expired and its owner is admitted. */
  function usable(k) {
    if (k.revokedAt !== undefined) throw refusal(401, 'key_revoked', 'mumbo key revoked')
    if (k.expiresAt !== undefined && k.expiresAt <= now()) throw refusal(401, 'key_expired', 'mumbo key expired')
    if (!admitted(k.owner)) throw refusal(403, 'user_disabled', 'mumbo user disabled')
  }
  return {
    /**
     * Mints a key for `owner`, the signed-in person. `projects` must be projects the owner is a member of now.
     * @returns {Promise<{ key: string, record: object }>} the key, which nothing keeps, and its stored record.
     */
    async mint(owner, { name, scopes = [], projects: ids = [], expiresInDays }) {
      name = typeof name === 'string' ? name.trim() : ''
      if (!name || name.length > 80) throw bad('A key needs a name of 1 to 80 characters.')
      if (!scopes.length || !scopes.every(s => SCOPES.includes(s))) throw bad(`A key needs one or more of the scopes ${SCOPES.join(', ')}.`)
      if (expiresInDays !== undefined && !EXPIRY_DAYS.includes(expiresInDays)) throw bad(`A key expires in ${EXPIRY_DAYS.join(', ')} days, or never.`)
      ids = [...new Set(ids)]
      const member = new Set((await projects.list(owner)).map(p => p.id))
      if (!ids.every(id => member.has(id))) throw refusal(403, 'not_a_member', 'A key may reach only projects you are a member of.')
      const key = generateKey(), hash = keyHash(key), at = now()
      const record = { id: randomBytes(8).toString('hex'), owner, name, scopes: SCOPES.filter(s => scopes.includes(s)), projects: ids, createdAt: at,
        ...(expiresInDays === undefined ? {} : { expiresAt: at + expiresInDays * DAY_MS }) }
      // The set first: a failed write then leaves an entry list() skips, never a key its owner cannot see or revoke.
      await store.addToSet(`keys:${owner}`, hash)
      await store.putDoc(`key:${hash}`, record)
      say({ msg: 'minted', owner, key: record.id, name, scopes: record.scopes, projects: ids, expiresAt: record.expiresAt })
      return { key, record }
    },
    /** The owner's key records, newest first, each with `lastUsedAt` (epoch ms, or undefined). Never a key or its hash. */
    async list(owner) {
      const out = []
      for (const [, k] of await own(owner)) out.push({ ...k, lastUsedAt: (await store.getDoc(`key-used:${k.id}`))?.at })
      return out.sort((a, b) => b.createdAt - a.createdAt)
    },
    /** Revokes the owner's key `id`, on every edge task once the write's invalidation lands. 404 (`not_found`) for an id
     *  that is not one of the owner's keys. */
    async revoke(owner, id) {
      const found = (await own(owner)).find(([, k]) => k.id === id)
      if (!found) throw refusal(404, 'not_found', 'No such key of yours.')
      const [hash, k] = found
      if (k.revokedAt !== undefined) return
      await store.putDoc(`key:${hash}`, { ...k, revokedAt: now() })
      say({ msg: 'revoked', owner, key: k.id })
    },
    /**
     * The record of a bearer `token`, checked as jumbo's MCP server does. Format and checksum are checked before any store
     * read; the record comes from the read cache, and revocation, expiry and the allowlist are checked on every call.
     * Records the use in `key-used:<id>` at most once a minute per key and process, without waiting for the write (a failed
     * write is logged, never fatal, and not retried within that minute).
     * @throws 403 user_key_required for a box token (a person's assistant or a project's coordinator); 401
     *   invalid_api_key for anything else that is not a stored key; 401 key_revoked; 401 key_expired from expiresAt on;
     *   403 user_disabled once the owner is off the allowlist.
     */
    async verify(token) {
      if (typeof token === 'string' && token.startsWith('mbx.')) throw refusal(403, 'user_key_required', 'Only a person\'s own mumbo key may use the door, never an assistant, session or box token.')
      const invalid = refusal(401, 'invalid_api_key', 'Invalid mumbo key')
      if (!isKey(token)) throw invalid
      const k = await store.getDoc(`key:${keyHash(token)}`)
      if (!k) throw invalid
      usable(k)
      const at = now(), last = lastWrite.get(k.id)
      if (last === undefined || at - last >= LAST_USE_MS) {
        lastWrite.set(k.id, at)
        store.putDoc(`key-used:${k.id}`, { at }).catch((e) => say({ level: 'warn', msg: 'last use not written', key: k.id, error: e.message }))
      }
      return k
    },
    /**
     * The record of `owner`'s key `id`, checked as verify checks a bearer key, for a worker token minted from it
     * (workers.mjs): checked on every call against the read cache, so a revocation holds from the next git request after
     * its invalidation lands.
     * @throws 401 invalid_api_key when the owner has no such key; 401 key_revoked; 401 key_expired; 403 user_disabled.
     */
    async live(owner, id) {
      const k = (await own(owner)).find(([, r]) => r.id === id)?.[1]
      if (!k) throw refusal(401, 'invalid_api_key', 'Invalid mumbo key')
      usable(k)
      return k
    },
    /** @throws 403 insufficient_scope unless the verified `key` has `scope`. */
    requireScope(key, scope) {
      if (!key.scopes.includes(scope)) throw refusal(403, 'insufficient_scope', 'Insufficient scope')
    },
    /**
     * @returns {Promise<object>} the project's doc, read once here so that the caller can pass it on.
     * @throws 403 project_not_allowed unless the verified `key` lists the project and its owner is still a member.
     */
    async requireProject(key, projectId) {
      const p = key.projects.includes(projectId) ? await projects.get(projectId) : undefined
      if (!p?.members.includes(key.owner)) throw refusal(403, 'project_not_allowed', 'This key may not reach that project.')
      return p
    },
  }
}

/**
 * The key manager on the approve host (https://<approve host>/keys), an origin no box serves: a page on the public host,
 * which the person's own box serves, could otherwise open the manager in a popup, mint a key and read it. Only the
 * signed-in person, userServer's identity and never a header a box sets, mints, lists and revokes, and only their own
 * keys. Every answer has COOP same-origin and PAGE_SECURITY (frame-ancestors 'none', cache-control no-store).
 * @param {{ cfg: { approveHost: string }, keys: ReturnType<typeof doorKeys>, projects: ReturnType<typeof import('./projects.mjs').projects>, csrfKey: Buffer, now?: () => number }} deps
 *   `csrfKey` is HMAC-SHA256(edge key, 'keys-csrf'); `projects` lists the person's projects for the form.
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, email: string) => Promise<void>}
 *   handles one request on the approve host (userServer sends it KEY_PATHS there): `GET /keys` shows the keys and the
 *   create form; `POST /keys` mints and answers 200 with the page showing the new key, the only place it ever appears
 *   (nothing logs it); `POST /keys/revoke` answers 303 to /keys. A POST must be a top-level form navigation with
 *   `Origin: https://<approve host>` and the person's CSRF token for the day (approve-page.mjs checkedForm).
 */
export function keyManager({ cfg, keys, projects, csrfKey, now = () => Date.now() }) {
  const origin = `https://${cfg.approveHost}`
  const csrf = csrfTokens(csrfKey, now)
  const when = (ms) => (ms === undefined ? 'never' : `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`)
  const refuse = (res, status, message) => res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' }).end(message)

  async function page(res, email, shown) {
    const mine = await projects.list(email)
    const names = new Map(mine.map(p => [p.id, p.name]))
    const token = csrf.token(email)
    const rows = (await keys.list(email)).map(k => `<li><strong>${esc(k.name)}</strong> <small>${esc(k.scopes.join(', '))} · projects: ${k.projects.length ? k.projects.map(id => esc(names.get(id) ?? id)).join(', ') : 'none'} · created ${when(k.createdAt)} · expires ${when(k.expiresAt)} · last used ${when(k.lastUsedAt)}${k.revokedAt === undefined
      ? `</small><form method="post" action="/keys/revoke">${hidden({ id: k.id, csrf: token })}<button>Revoke</button></form>`
      : ` · revoked ${when(k.revokedAt)}</small>`}</li>`).join('')
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>mumbo door keys</title>
<style>${STYLE}</style>
<main>
<div class="row"><h1>Door keys</h1><span class="muted">${esc(email)}</span></div>
<p class="muted">For your own AI tools, such as Claude Code, to reach mumbo over MCP. A key acts as you, with the scopes and projects you pick.</p>
${shown ? `<p class="notice"><strong>New key ${esc(shown.record.name)}.</strong> Copy it now: it is not shown again.<br><code>${esc(shown.key)}</code></p>\n` : ''}<ul>${rows || '<li><small>None yet.</small></li>'}</ul>
<form method="post" action="/keys" class="card">${hidden({ csrf: token })}
<p><label>Name <input name="name" required maxlength="80" placeholder="laptop Claude Code"></label></p>
<p>Scopes: ${SCOPES.map(s => `<label><input type="checkbox" name="scope" value="${s}"${s === 'read' ? ' checked' : ''}> ${s}</label>`).join(' ')}<br><small>read: status; prompt: talk to Mumbo and answer its questions; workspace: start and stop tasks</small></p>
<p>Projects: ${mine.length ? mine.map(p => `<label><input type="checkbox" name="project" value="${esc(p.id)}"> ${esc(p.name)}</label>`).join(' ') : '<small>none yet</small>'}</p>
<p><label>Expires <select name="expires"><option value="">never</option>${EXPIRY_DAYS.map(d => `<option value="${d}"${d === 90 ? ' selected' : ''}>in ${d} days</option>`).join('')}</select></label></p>
<p><button class="primary">Create key</button></p></form>
</main>`)
  }

  return async (req, res, email) => {
    // Set before anything is written, so every answer has them, userServer's 500 for a handler that throws included.
    res.setHeader('cross-origin-opener-policy', 'same-origin')
    for (const [h, v] of Object.entries(PAGE_SECURITY)) res.setHeader(h, v)
    const path = req.url.split('?')[0]
    if (req.method === 'GET' && path === '/keys') return page(res, email)
    if (req.method !== 'POST') return refuse(res, 405, 'Method Not Allowed')
    // Only a top-level form navigation, so no script, not even the approve host's own sign-in scripts, reads the answer.
    if (req.headers['sec-fetch-mode'] !== 'navigate' || req.headers['sec-fetch-dest'] !== 'document') return refuse(res, 403, 'Forbidden')
    const form = await checkedForm(req, res, email, origin, csrf)
    if (!form) return
    try {
      if (path === '/keys/revoke') {
        await keys.revoke(email, form.get('id'))
        return void res.writeHead(303, { location: '/keys' }).end()
      }
      const expires = form.get('expires')
      return await page(res, email, await keys.mint(email, { name: form.get('name'), scopes: form.getAll('scope'), projects: form.getAll('project'), expiresInDays: expires ? Number(expires) : undefined }))
    } catch (e) {
      if ([400, 403, 404].includes(e.status)) return refuse(res, e.status, e.message)
      throw e
    }
  }
}
