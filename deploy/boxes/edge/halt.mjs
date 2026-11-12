// Stop everything (design section 5): one switch per person. While it is on, the edge refuses model calls and GitHub
// writes for that person and every project they own, and those projects' reports to members (door.mjs memberReporter).
import { ownersOf } from './projects.mjs'

const key = (email) => `halt:${email.toLowerCase()}`

/**
 * Halt switch stored as doc `halt:<email>` = `{ on, at }`. Reads come from the edge's read cache (store.mjs), which serves
 * copies only while its subscription is live; `set` publishes its invalidation, so a halt stops the next call on every
 * edge task once that message lands.
 * @param {{ store: object }} deps
 * @returns {{ isHalted(principal: string): Promise<boolean>, get(email: string): Promise<boolean>, set(email: string, on: boolean): Promise<void> }}
 *   `isHalted` takes an email or a `project:<id>` principal; a project is halted when any of its owners is.
 *   `get` and `set` read and change one person's switch.
 */
export function haltService({ store }) {
  const get = async (email) => (await store.getDoc(key(email)))?.on === true
  return {
    get,
    async set(email, on) { await store.putDoc(key(email), { on, at: Date.now() }) },
    async isHalted(principal) {
      if (!principal.startsWith('project:')) return get(principal)
      // The owners' switches together: a warm read cache answers the project doc and each switch with no round trip.
      return (await Promise.all((await ownersOf(store, principal.slice('project:'.length))).map(get))).includes(true)
    },
  }
}
