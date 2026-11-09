// The sign-in page's consent decision (index.html), a classic script; auth-ui.test.mjs runs the same file.
/**
 * What the page does with Supabase's authorization details (GET /oauth/authorizations/{id}).
 * - A pending request names its client: 'approve' only for one of Mumbo's own client ids (exact match).
 * - A request Supabase approved itself from an earlier consent carries only redirect_url: 'follow' it only when it
 *   leads to one of Mumbo's own redirect URIs (origin and path), which deliver the code to Mumbo alone.
 * - Anything else: 'refuse'.
 * @param {{ client?: { id?: string }, redirect_url?: string } | null | undefined} details the response's data
 * @param {{ clientIds: string[], redirectUris: string[] }} allowed MUMBO from config.js
 * @returns {'approve' | 'follow' | 'refuse'}
 */
function consentDecision(details, allowed) {
  if (details?.client) return allowed.clientIds.includes(details.client.id) ? 'approve' : 'refuse'
  if (typeof details?.redirect_url !== 'string') return 'refuse'
  let url
  try { url = new URL(details.redirect_url) } catch { return 'refuse' }
  return allowed.redirectUris.includes(`${url.origin}${url.pathname}`) ? 'follow' : 'refuse'
}
