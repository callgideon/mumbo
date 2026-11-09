// Repository tokens for the mumbo-bot GitHub App, the only identity that merges: an RS256 app JWT, the repository's
// installation, then an installation token scoped to that one repository and the requested permissions.

/**
 * Stub until B2: throws.
 * @param {{ appId: string, privateKey: string, repo: string, permissions: Record<string, string>, fetchImpl: typeof fetch, now: () => number }} request
 *   `repo` is `owner/name`; `privateKey` is the App's PEM; `now` is epoch ms.
 * @returns {Promise<{ token: string, revoke(): Promise<void> }>} a token for `repo` only, with no permission beyond
 *   `permissions` plus `metadata: read`; `revoke` invalidates it.
 */
export async function mintRepoToken({ appId, privateKey, repo, permissions, fetchImpl, now }) {
  throw new Error('not implemented')
}
