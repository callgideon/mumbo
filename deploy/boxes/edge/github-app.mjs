// Repository tokens for the mumbo-bot GitHub App, the only identity that merges: an RS256 app JWT, the repository's
// installation, then an installation token scoped to that one repository and the requested permissions.
// GitHub's answer is checked, not trusted: a token wider than asked is revoked and never returned.
import { sign } from 'node:crypto'

const API = 'https://api.github.com'
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
 * @returns {Promise<any>} rejects with `status` set for a non-2xx answer; the message names the method and path only.
 */
export async function githubJson(fetchImpl, method, path, token, body) {
  const r = await githubRequest(fetchImpl, method, path, token, body)
  if (!r.ok) throw Object.assign(new Error(`GitHub ${method} ${path}: HTTP ${r.status}`), { status: r.status })
  return r.status === 204 ? undefined : r.json()
}

/**
 * Mints an installation token for one repository.
 * @param {{ appId: string, privateKey: string, repo: string, permissions: Record<string, string>, fetchImpl: typeof fetch, now: () => number }} request
 *   `repo` is `owner/name`; `privateKey` is the App's PEM; `now` is epoch ms.
 * @returns {Promise<{ token: string, revoke(): Promise<void> }>} a token for `repo` only, with no permission beyond
 *   `permissions` plus `metadata: read`; `revoke` invalidates it. Rejects, after revoking, when GitHub grants another
 *   repository or a permission that was not asked for.
 */
export async function mintRepoToken({ appId, privateKey, repo, permissions, fetchImpl, now }) {
  const t = Math.floor(now() / 1000)
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iat: t - 60, exp: t + 540, iss: String(appId) })}`
  const jwt = `${unsigned}.${sign('sha256', Buffer.from(unsigned), privateKey).toString('base64url')}`
  const { id } = await githubJson(fetchImpl, 'GET', `/repos/${repo}/installation`, jwt)
  const grant = await githubJson(fetchImpl, 'POST', `/app/installations/${id}/access_tokens`, jwt, { repositories: [repo.split('/')[1]], permissions })
  const revoke = async () => { await githubJson(fetchImpl, 'DELETE', '/installation/token', grant.token) }
  // The request names the repository without its owner, so the answer's full name is compared, owner included.
  const repos = (grant.repositories ?? []).map(r => String(r.full_name).toLowerCase())
  const wider = Object.entries(grant.permissions ?? {}).some(([k, v]) => permissions[k] !== v && !(k === 'metadata' && v === 'read'))
  if (repos.length !== 1 || repos[0] !== repo.toLowerCase() || wider) {
    await revoke().catch((e) => { throw new Error(`mumbo-bot token for ${repo} was wider than asked, and revoking it failed: ${e.message}`) })
    throw new Error(`mumbo-bot token for ${repo} was wider than asked (repositories or permissions); revoked`)
  }
  return { token: grant.token, revoke }
}
