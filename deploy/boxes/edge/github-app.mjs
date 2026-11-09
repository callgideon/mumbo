// Installation tokens for the mumbo-bot GitHub App, the identity the agent writes as and the only one that merges: an
// RS256 app JWT, the repositories' installation, then a token scoped to those repositories and the requested permissions.
// GitHub's answer is checked, not trusted: a token other than asked is revoked and never returned.
import { sign } from 'node:crypto'

const API = 'https://api.github.com'
// A cached token is replaced this long before GitHub's expires_at, so no request carries one about to lapse.
const REFRESH_BEFORE_MS = 5 * 60_000
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')

/**
 * One GitHub REST request with `token`. The token travels only in the authorization header.
 * @param {typeof fetch} fetchImpl
 * @param {string} method
 * @param {string} path - path and query under https://api.github.com.
 * @param {string} token
 * @param {object} [body] - sent as JSON.
 * @returns {Promise<Response>}
 */
export const githubRequest = (fetchImpl, method, path, token, body) => fetchImpl(`${API}${path}`, {
  method,
  headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'mumbo-edge', ...(body ? { 'content-type': 'application/json' } : {}) },
  ...(body ? { body: JSON.stringify(body) } : {}),
})

/**
 * githubRequest, then the answer's JSON (undefined for 204).
 * @returns {Promise<any>} rejects with `status` and `githubMessage` (the answer's `message`, when it has one) set for a
 *   non-2xx answer; the error message names the method, path and status only.
 */
export async function githubJson(fetchImpl, method, path, token, body) {
  const r = await githubRequest(fetchImpl, method, path, token, body)
  if (!r.ok) {
    const githubMessage = (await r.json().catch(() => undefined))?.message
    throw Object.assign(new Error(`GitHub ${method} ${path}: HTTP ${r.status}`), { status: r.status, githubMessage })
  }
  return r.status === 204 ? undefined : r.json()
}

/**
 * Mints an installation token for `repos`.
 * @param {{ appId: string, privateKey: string, repos: string[], permissions: Record<string, string>, fetchImpl: typeof fetch, now: () => number }} request
 *   `repos` are `owner/name`, all of one owner; `privateKey` is the App's PEM; `now` is epoch ms.
 * @returns {Promise<{ token: string, expiresAt: number, revoke(): Promise<void> }>} a token for exactly `repos` with
 *   exactly `permissions` plus `metadata: read`; `expiresAt` is GitHub's expires_at in epoch ms; `revoke` invalidates
 *   it. Rejects before any request when `repos` is empty or spans owners; rejects with `notApproved: true` and the
 *   message `mumbo-bot App permissions not approved: <GitHub's message>` when GitHub answers the mint 403 or 422 (the
 *   installation has not accepted a permission asked for); rejects, after revoking, when GitHub grants other
 *   repositories or other permissions, or names no permissions.
 */
export async function mintToken({ appId, privateKey, repos, permissions, fetchImpl, now }) {
  if (new Set(repos.map(r => r.split('/')[0].toLowerCase())).size !== 1) throw new Error(`mumbo-bot tokens cover one owner's repositories, not [${repos.join(', ')}]`)
  const t = Math.floor(now() / 1000)
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iat: t - 60, exp: t + 540, iss: String(appId) })}`
  const jwt = `${unsigned}.${sign('sha256', Buffer.from(unsigned), privateKey).toString('base64url')}`
  const { id } = await githubJson(fetchImpl, 'GET', `/repos/${repos[0]}/installation`, jwt)
  const grant = await githubJson(fetchImpl, 'POST', `/app/installations/${id}/access_tokens`, jwt, { repositories: repos.map(r => r.split('/')[1]), permissions })
    .catch((e) => { throw [403, 422].includes(e.status) ? Object.assign(new Error(`mumbo-bot App permissions not approved: ${e.githubMessage ?? e.message}`), { notApproved: true }) : e })
  const revoke = async () => { await githubJson(fetchImpl, 'DELETE', '/installation/token', grant.token) }
  // The request names repositories without their owner, so the answer's full names are compared, owner included.
  const same = (a, b) => JSON.stringify(a.map(r => String(r).toLowerCase()).sort()) === JSON.stringify(b.map(r => String(r).toLowerCase()).sort())
  // GitHub adds metadata: read to every token. An answer that names no permissions cannot be shown to match.
  const want = { metadata: 'read', ...permissions }, got = { metadata: 'read', ...grant.permissions }
  const exact = grant.permissions && Object.keys({ ...want, ...got }).every(k => want[k] === got[k])
  if (!same((grant.repositories ?? []).map(r => r.full_name), repos) || !exact) {
    await revoke().catch((e) => { throw new Error(`mumbo-bot token for ${repos.join(', ')} differed from what was asked, and revoking it failed: ${e.message}`) })
    throw new Error(`mumbo-bot token for ${repos.join(', ')} differs from what was asked (repositories or permissions); revoked`)
  }
  return { token: grant.token, expiresAt: Date.parse(grant.expires_at), revoke }
}

/**
 * Installation tokens with fixed `permissions`, one per key, each reused until 5 minutes before it expires.
 * @param {{ app: { appId: string | undefined, privateKey: string | undefined }, permissions: Record<string, string>, fetchImpl: typeof fetch, now: () => number }} deps
 * @returns {(key: string, repos: string[]) => Promise<string>} the key's token for `repos`; a key asked for other
 *   repositories than its cached token covers gets a new one. Rejects as mintToken does, and caches no failure.
 */
export function tokenCache({ app, permissions, fetchImpl, now }) {
  const cache = new Map()
  return async (key, repos) => {
    const covers = repos.join()
    const hit = cache.get(key)
    if (hit?.covers === covers && now() < hit.expiresAt - REFRESH_BEFORE_MS) return hit.token
    // ponytail: concurrent misses for one key each mint; share the in-flight mint if GitHub's rate limit notices.
    const { token, expiresAt } = await mintToken({ appId: app.appId, privateKey: app.privateKey, repos, permissions, fetchImpl, now })
    cache.set(key, { covers, token, expiresAt })
    return token
  }
}
