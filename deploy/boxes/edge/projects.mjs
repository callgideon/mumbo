// Shared projects (deploy/boxes/ASSISTANT.md, option B). A project has its own box, owned by the principal
// `project:<id>` and running dsh as the coordinator; its members are signed-in users. Membership lives in the edge
// store: doc `project:<id>` = { id, name, owner, members, createdAt } and set `projects:<email>` = ids.
import { randomBytes } from 'node:crypto'

const fail = (status, message) => Object.assign(new Error(message), { status })
/** Project ids are lowercase letters and digits, so they fit a hostname label (`p-<id>.<public host>`). */
export const projectId = () => randomBytes(8).toString('hex')
export const isProjectId = (id) => typeof id === 'string' && /^[a-z0-9]{16}$/.test(id)
export const projectPrincipal = (id) => `project:${id}`

/** Project records and membership. `admitted(email)` is the edge allowlist; a member must pass it too. */
export function projects({ store, admitted, log = console.log }) {
  const say = (fields) => log(JSON.stringify({ edge: 'project', ...fields }))
  const get = (id) => (isProjectId(id) ? store.getDoc(`project:${id}`) : undefined)
  return {
    get,
    async isMember(email, id) { return (await get(id))?.members.includes(email) ?? false },
    async create(owner, name) {
      if (typeof name !== 'string' || !name.trim() || name.length > 80) throw fail(400, 'a project needs a name of 1 to 80 characters')
      const id = projectId()
      await store.putDoc(`project:${id}`, { id, name: name.trim(), owner, members: [owner], createdAt: new Date().toISOString() })
      await store.addToSet(`projects:${owner}`, id)
      say({ msg: 'created', project: id, owner })
      return { id, name: name.trim() }
    },
    async list(email) {
      const out = []
      for (const id of await store.setMembers(`projects:${email}`)) {
        const p = await get(id)
        if (p?.members.includes(email)) out.push({ id, name: p.name, owner: p.owner, members: p.members })
      }
      return out
    },
    async addMember(by, id, email) {
      const p = await get(id)
      if (!p?.members.includes(by)) throw fail(404, `no project ${id} of yours`)
      if (p.owner !== by) throw fail(403, 'only the project owner adds members')
      email = String(email).trim().toLowerCase()
      if (!admitted(email)) throw fail(400, `${email} is not allowed to use mumbo yet`)
      if (!p.members.includes(email)) {
        p.members.push(email)
        await store.putDoc(`project:${id}`, p)
        await store.addToSet(`projects:${email}`, id)
        say({ msg: 'member added', project: id, member: email, by })
      }
      return { id, members: p.members }
    },
  }
}
