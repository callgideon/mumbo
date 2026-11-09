// Push notifications to the founder's phone through ntfy (design section 5): the edge posts to a secret topic.
// The topic is a secret: it appears only in the request URL, never in an error or a log line.

/** Header values: printable ASCII only, so agent-written text cannot break or add a header. */
const ascii = (s) => String(s).replace(/[^\x20-\x7e]/g, '?')

/**
 * The ntfy sender.
 * @param {{ topic: string | undefined, fetchImpl: typeof fetch, timeoutMs?: number }} deps - `timeoutMs` bounds each
 *   request (10 s by default).
 * @returns {(message: { title: string, body: string, click: string }) => Promise<void>} posts one notification to
 *   `https://ntfy.sh/<topic>`: `body` (which may hold agent-written text) as the message body, `title` and `click` (the
 *   URL it opens) as ASCII headers. Rejects when the topic is unset, the request fails or times out, or ntfy answers
 *   non-2xx, so the caller can retry.
 */
export function ntfy({ topic, fetchImpl, timeoutMs = 10_000 }) {
  return async ({ title, body, click }) => {
    if (!topic) throw new Error('ntfy: NTFY_TOPIC is not set')
    const r = await fetchImpl(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
      method: 'POST',
      headers: { title: ascii(title), click: ascii(click), 'content-type': 'text/plain; charset=utf-8' },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    }).catch((e) => { throw new Error(`ntfy: request failed (${e.name})`) })
    if (!r.ok) throw new Error(`ntfy: HTTP ${r.status}`)
  }
}
