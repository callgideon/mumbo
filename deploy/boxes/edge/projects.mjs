// Shared projects (deploy/boxes/ASSISTANT.md, option B). A project has its own box, owned by the principal
// `project:<id>` and running dsh as the coordinator; its members are signed-in users. Membership lives in the edge
// store: doc `project:<id>` = { id, name, owner, members, createdAt } and set `projects:<email>` = ids.
import { randomBytes, randomUUID } from 'node:crypto'

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

/**
 * Delivers a member's message into the project's coordinator session. The project box is ensured (created or
 * resumed); the edge signs in to its dsh with the box's launch token like a browser, keeps the cookie, creates the
 * coordinator session once (its id lives on the project record) and prompts it over dsh's unary RPC
 * (`POST api/session/prompt`). The member is named in the message text; per-member dsh principals come later.
 * `boxFetch(target, siteHost, path, init)` sends one request to the box through the client-proxy and resolves
 * { status, setCookie, body }.
 */
export function projectRelay({ store, projects, box, boxFetch, siteHostOf, log = console.log }) {
  const cookies = new Map()  // box id -> dsh cookie
  const say = (fields) => log(JSON.stringify({ edge: 'relay', ...fields }))
  async function signIn(target, host) {
    const r = await boxFetch(target, host, `/?token=${target.token}`, { method: 'GET' })
    const cookie = (r.setCookie ?? []).map(c => c.split(';')[0]).find(c => c.startsWith('dsh-auth-'))
    if (!cookie) throw fail(502, `project box sign-in failed (${r.status})`)
    cookies.set(target.id, cookie)
    return cookie
  }
  async function rpc(target, host, method, request, member) {
    const call = async (cookie) => boxFetch(target, host, `/api/${method}`, {
      method: 'POST',
      headers: { ...(cookie ? { cookie } : {}), 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args: { request } } }),
      // A member-capable box gets the member themselves (dsh records them as the principal), not the owner.
      ...(target.member ? { member: target.member(member) } : {}),
    })
    if (target.member) {
      const r = await call()
      const out = r.status === 200 ? JSON.parse(r.body).result : undefined
      if (!out?.ok) throw fail(502, `${method} failed: ${out?.error?.message ?? `HTTP ${r.status}`}`)
      return out.value
    }
    let r = await call(cookies.get(target.id) ?? await signIn(target, host))
    if (r.status === 401) r = await call(await signIn(target, host))
    const out = r.status === 200 ? JSON.parse(r.body).result : undefined
    if (!out?.ok) throw fail(502, `${method} failed: ${out?.error?.message ?? `HTTP ${r.status}`}`)
    return out.value
  }
  return {
    async message(member, id, text) {
      if (typeof text !== 'string' || !text.trim()) throw fail(400, 'the message is empty')
      const p = await projects.get(id)
      if (!p?.members.includes(member)) throw fail(404, `no project ${id} of yours`)
      const principal = projectPrincipal(id)
      const target = await box.ensure(principal)
      const host = siteHostOf(principal)
      let sessionId = p.coordinatorSessionId
      if (!sessionId) {
        sessionId = (await rpc(target, host, 'session/create', { cwd: '/root/projects' }, member)).sessionId
        await store.putDoc(`project:${id}`, { ...(await projects.get(id)), coordinatorSessionId: sessionId })
      }
      await rpc(target, host, 'session/prompt', { requestId: randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text: `[from ${member}] ${text.trim()}` }] }, member)
      say({ msg: 'delivered', project: id, member, session: sessionId })
      return { delivered: true, project: id, coordinatorSession: sessionId }
    },
  }
}
