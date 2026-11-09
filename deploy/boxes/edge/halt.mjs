// Stop everything (design section 5): one switch per person. While it is on, the edge refuses model calls and GitHub
// writes for that person and every project they own.

/**
 * Stub until B4: nothing is halted.
 * @param {{ store: object }} deps
 * @returns {{ isHalted(principal: string): Promise<boolean>, get(email: string): Promise<boolean>, set(email: string, on: boolean): Promise<void> }}
 *   `isHalted` takes an email or a `project:<id>` principal; `get` and `set` read and change that person's switch.
 */
export function haltService({ store }) {
  return {
    async isHalted(principal) { return false },
    async get(email) { throw new Error('not implemented') },
    async set(email, on) { throw new Error('not implemented') },
  }
}
