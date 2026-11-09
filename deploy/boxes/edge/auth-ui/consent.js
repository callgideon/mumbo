// The sign-in page's consent decision (index.html), a classic script; auth-ui.test.mjs runs the same file.
/**
 * True when `url` is an absolute URL whose origin and path are one of Mumbo's own redirect URIs (any query), which
 * deliver a code to Mumbo alone.
 * @param {unknown} url
 * @param {{ redirectUris: string[] }} allowed MUMBO from config.js
 * @returns {boolean}
 */
function toMumbo(url, allowed) {
  if (typeof url !== 'string') return false
  try {
    const u = new URL(url)
    return allowed.redirectUris.includes(`${u.origin}${u.pathname}`)
  } catch { return false }
}
/**
 * What the page does with Supabase's authorization details (GET /oauth/authorizations/{id}).
 * - A pending request names its client: 'approve' only for one of Mumbo's own client ids (exact match) whose
 *   redirect_uri is toMumbo.
 * - A request Supabase approved itself from an earlier consent carries only redirect_url: 'follow' it only when toMumbo.
 * - Anything else: 'refuse'.
 * The page navigates only to a redirect_url that is toMumbo, the one approving returns included.
 * @param {{ client?: { id?: string }, redirect_uri?: string, redirect_url?: string } | null | undefined} details the response's data
 * @param {{ clientIds: string[], redirectUris: string[] }} allowed MUMBO from config.js
 * @returns {'approve' | 'follow' | 'refuse'}
 */
function consentDecision(details, allowed) {
  if (details?.client) return allowed.clientIds.includes(details.client.id) && toMumbo(details.redirect_uri, allowed) ? 'approve' : 'refuse'
  return toMumbo(details?.redirect_url, allowed) ? 'follow' : 'refuse'
}
