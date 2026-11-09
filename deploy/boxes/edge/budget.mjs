// Daily model budgets per principal, shared by every edge replica through the store (store.mjs): a request count
// (budget) and a token count read from the model's responses (tokenBudget).

/** Per-user daily request budget. Returns `(email, now?) => Promise<boolean>`: true while today's count is within `limit`. */
export function budget(store, limit) {
  return async (email, now = new Date()) => (await store.increment(`budget:${now.toISOString().slice(0, 10)}:${email}`, 2 * 86_400)) <= limit
}

const USAGE_FIELDS = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']
const TWO_DAYS_MS = 2 * 86_400_000

/**
 * Daily token budget per principal: `limits.project` for `project:*` principals, `limits.user` otherwise.
 * @param {{ store: object, limits: { user: number, project: number }, now: () => number }} deps - `now` is epoch ms.
 * @returns {{ allow(principal: string): Promise<boolean>, meter(principal: string, webBody: ReadableStream, contentType: string | null): ReadableStream }}
 *   `allow` is false once today's tokens reach the limit; `meter` passes every byte through and counts the usage it reads.
 */
export function tokenBudget({ store, limits, now }) {
  const key = (principal) => `tokens:${new Date(now()).toISOString().slice(0, 10)}:${principal}`
  return {
    async allow(principal) {
      return (await store.getCount(key(principal))) < (principal.startsWith('project:') ? limits.project : limits.user)
    },
    meter(principal, webBody, contentType) {
      const type = (contentType ?? '').split(';')[0].trim().toLowerCase()
      if (type !== 'text/event-stream' && type !== 'application/json') return webBody
      const k = key(principal)
      const add = async (n) => {
        if (n <= 0) return
        try { await store.incrementBy(k, n, TWO_DAYS_MS) } catch (err) { console.error('edge: token count failed', err.message) }
      }
      const decoder = new TextDecoder()
      let pending = ''
      if (type === 'application/json') {
        return webBody.pipeThrough(new TransformStream({
          transform(chunk, controller) { pending += decoder.decode(chunk, { stream: true }); controller.enqueue(chunk) },
          async flush() {
            try {
              const usage = JSON.parse(pending + decoder.decode()).usage
              await add(USAGE_FIELDS.reduce((sum, f) => sum + (Number.isSafeInteger(usage?.[f]) ? usage[f] : 0), 0))
            } catch (err) { console.error('edge: token usage unreadable', err.message) }
          },
        }))
      }
      // SSE: the last value seen of each field wins, so message_start and message_delta usage do not double count.
      const last = Object.fromEntries(USAGE_FIELDS.map((f) => [f, 0]))
      let counted = 0
      const event = async (line) => {
        if (!line.startsWith('data:')) return
        try {
          const data = JSON.parse(line.slice(5))
          const usage = data.type === 'message_start' ? data.message?.usage : data.type === 'message_delta' ? data.usage : null
          if (!usage) return
          for (const f of USAGE_FIELDS) if (Number.isSafeInteger(usage[f]) && usage[f] >= 0) last[f] = usage[f]
        } catch (err) { console.error('edge: token usage unreadable', err.message); return }
        const total = USAGE_FIELDS.reduce((sum, f) => sum + last[f], 0)
        const increase = total - counted
        counted = total
        await add(increase)
      }
      const lines = async (final) => {
        const parts = pending.split('\n')
        pending = final ? '' : parts.pop()
        for (const line of parts) await event(line.replace(/\r$/, ''))
      }
      return webBody.pipeThrough(new TransformStream({
        async transform(chunk, controller) {
          pending += decoder.decode(chunk, { stream: true })
          await lines(false)
          controller.enqueue(chunk)
        },
        async flush() { pending += decoder.decode(); await lines(true) },
      }))
    },
  }
}
