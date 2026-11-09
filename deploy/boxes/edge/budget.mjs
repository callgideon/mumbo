// Daily model budgets per principal, shared by every edge replica through the store (store.mjs): a request count
// (budget) and a token count read from the model's responses (tokenBudget).

/** Per-user daily request budget. Returns `(email, now?) => Promise<boolean>`: true while today's count is within `limit`. */
export function budget(store, limit) {
  return async (email, now = new Date()) => (await store.increment(`budget:${now.toISOString().slice(0, 10)}:${email}`, 2 * 86_400)) <= limit
}

/**
 * Daily token budget per principal: `limits.project` for `project:*` principals, `limits.user` otherwise.
 * Stub until B5: allows everything and returns the body unchanged.
 * @param {{ store: object, limits: { user: number, project: number }, now: () => number }} deps - `now` is epoch ms.
 * @returns {{ allow(principal: string): Promise<boolean>, meter(principal: string, webBody: ReadableStream, contentType: string | null): ReadableStream }}
 *   `allow` is false once today's tokens reach the limit; `meter` passes every byte through and counts the usage it reads.
 */
export function tokenBudget({ store, limits, now }) {
  return {
    async allow(principal) { return true },
    meter(principal, webBody, contentType) { return webBody },
  }
}
