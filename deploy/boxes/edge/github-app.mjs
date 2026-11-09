// Installation tokens for the mumbo-bot GitHub App, the identity the agent writes as and the only one that merges: an
// RS256 app JWT, the repositories' installation, then a token scoped to those repositories and the requested permissions.
// GitHub's answer is checked, not trusted: a token other than asked is revoked and never returned.
import { sign } from 'node:crypto'

const API = 'https://api.github.com'
// A cached token is replaced this long before GitHub's expires_at, so no request carries one about to lapse.
const REFRESH_BEFORE_MS = 5 * 60_000
// A failed mint is answered from the cache this long, so a box cannot make the edge call GitHub with the App JWT per request.
const FAILURE_HOLD_MS = 30_000
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
 * @returns {Promise<any>} rejects with `status`, `githubMessage` (the answer's `message`, when it has one) and
 *   `rateLimited` (x-ratelimit-remaining 0 or a retry-after header) set for a non-2xx answer; the error message names
 *   the method, path and status only.
 */
export async function githubJson(fetchImpl, method, path, token, body) {
  const r = await githubRequest(fetchImpl, method, path, token, body)
  if (!r.ok) {
    const githubMessage = (await r.json().catch(() => undefined))?.message
    const rateLimited = r.headers.get('x-ratelimit-remaining') === '0' || r.headers.has('retry-after')
    throw Object.assign(new Error(`GitHub ${method} ${path}: HTTP ${r.status}`), { status: r.status, githubMessage, rateLimited })
  }
  return r.status === 204 ? undefined : r.json()
}

/** A 9-minute App JWT; throws when the App's id or key is missing. */
function appJwt(appId, privateKey, now) {
  if (!appId || !privateKey) throw new Error('the mumbo-bot App is not configured (GITHUB_APP_ID, GITHUB_APP_KEY)')
  const t = Math.floor(now() / 1000)
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iat: t - 60, exp: t + 540, iss: String(appId) })}`
  return `${unsigned}.${sign('sha256', Buffer.from(unsigned), privateKey).toString('base64url')}`
}

/**
 * The App's installation for a repository, read with an App JWT; no token is minted.
 * @param {{ appId: string | undefined, privateKey: string | undefined, fetchImpl: typeof fetch, now: () => number }} app
 * @returns {(repo: string) => Promise<number | undefined>} the installation id for `owner/name`, or undefined when GitHub
 *   answers 404 (the App is not installed for it, or there is no such repository); rejects on any other failure.
 */
export const installationOf = ({ appId, privateKey, fetchImpl, now }) => (repo) =>
  githubJson(fetchImpl, 'GET', `/repos/${repo}/installation`, appJwt(appId, privateKey, now)).then(i => i.id, (e) => { if (e.status === 404) return undefined; throw e })

/** GitHub's refusal of a token request, with the `code` and message the edge reports. */
function mintRefusal(e) {
  if (e.status === undefined) return e  // no answer from GitHub
  const why = e.githubMessage ?? 'no message'
  const refusal = (code, message) => Object.assign(new Error(message), { code })
  if (e.rateLimited) return refusal('rate_limited', `mumbo-bot token mint failed: GitHub's rate limit (HTTP ${e.status}); retry later`)
  if (e.status === 422 && /permissions requested are not granted/i.test(why)) return refusal('not_approved', `mumbo-bot App permissions not approved: ${why}`)
  if (e.status === 422 && /not accessible to the parent installation/i.test(why)) return refusal('repo_not_installed', `repo_not_installed: ${why}`)
  return refusal('refused', `mumbo-bot App refused the token (HTTP ${e.status}): ${why}`)
}

/**
 * Mints an installation token for `repos`.
 * @param {{ appId: string, privateKey: string, repos: string[], permissions: Record<string, string>, fetchImpl: typeof fetch, now: () => number }} request
 *   `repos` are `owner/name`, all of one owner; `privateKey` is the App's PEM; `now` is epoch ms.
 * @returns {Promise<{ token: string, expiresAt: number, revoke(): Promise<void> }>} a token for exactly `repos` with
 *   exactly `permissions` plus `metadata: read`; `expiresAt` is GitHub's expires_at in epoch ms; `revoke` invalidates
 *   it. Rejects before any request when `repos` is empty or spans owners, or the App is not configured. A refusal
 *   rejects with `code` and a message for the edge to report: `not_approved` (a 422 saying the installation has not
 *   granted a permission asked for), `repo_not_installed` (no installation for the first repository, or a 422 saying a
 *   repository is not accessible to it), `rate_limited`, or `refused` (any other answer, with its status and message).
 *   Rejects, after revoking, when GitHub grants other repositories or other permissions, or names no permissions.
 */
export async function mintToken({ appId, privateKey, repos, permissions, fetchImpl, now }) {
  if (new Set(repos.map(r => r.split('/')[0].toLowerCase())).size !== 1) throw new Error(`mumbo-bot tokens cover one owner's repositories, not [${repos.join(', ')}]`)
  const jwt = appJwt(appId, privateKey, now)
  const id = await installationOf({ appId, privateKey, fetchImpl, now })(repos[0])
  if (id === undefined) throw Object.assign(new Error(`repo_not_installed: the mumbo-bot App has no installation for ${repos[0]}`), { code: 'repo_not_installed' })
  const grant = await githubJson(fetchImpl, 'POST', `/app/installations/${id}/access_tokens`, jwt, { repositories: repos.map(r => r.split('/')[1]), permissions })
    .catch((e) => { throw mintRefusal(e) })
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
 * Installation tokens with fixed `permissions`, one per key.
 * @param {{ app: { appId: string | undefined, privateKey: string | undefined }, permissions: Record<string, string>, fetchImpl: typeof fetch, now: () => number }} deps
 * @returns {{ get(key: string, repos: string[]): Promise<string>, forget(key: string): void }} `get` gives the key's
 *   token for `repos`: one mint per key at a time, its token reused until 5 minutes before it expires, its failure
 *   answered for FAILURE_HOLD_MS; a key asked for other repositories than its entry covers mints anew. It rejects as
 *   mintToken does. `forget` drops the key's entry, for a token GitHub no longer accepts (401).
 */
export function tokenCache({ app, permissions, fetchImpl, now }) {
  const cache = new Map()  // key -> { covers, pending: Promise<token>, until: epoch ms the entry answers until }
  return {
    get(key, repos) {
      const covers = repos.join()
      let entry = cache.get(key)
      // `until` stays Infinity while the mint is in flight; NaN (an expires_at GitHub did not give) never answers.
      if (!entry || entry.covers !== covers || !(now() < entry.until)) {
        const pending = mintToken({ appId: app.appId, privateKey: app.privateKey, repos, permissions, fetchImpl, now })
        const fresh = { covers, until: Infinity, pending: pending.then(t => t.token) }
        pending.then((t) => { fresh.until = t.expiresAt - REFRESH_BEFORE_MS }, () => { fresh.until = now() + FAILURE_HOLD_MS })
        cache.set(key, entry = fresh)
      }
      return entry.pending
    },
    forget: (key) => { cache.delete(key) },
  }
}
