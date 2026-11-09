// Shared projects (deploy/boxes/ASSISTANT.md, option B). A project has its own box, owned by the principal
// `project:<id>` and running dsh as the coordinator; its members are signed-in users. Membership lives in the edge
// store: doc `project:<id>` = { id, name, owner, members, createdAt, repos? } and set `projects:<email>` = ids.
// `repos` (`owner/name`) are the GitHub repositories the project may use through the edge; set `projects:with-repos`
// lists every project that has one, for the approvals poller.
import { randomBytes, randomUUID } from 'node:crypto'

const fail = (status, message) => Object.assign(new Error(message), { status })
/** Project ids are lowercase letters and digits, so they fit a hostname label (`p-<id>.<public host>`). */
export const projectId = () => randomBytes(8).toString('hex')
export const isProjectId = (id) => typeof id === 'string' && /^[a-z0-9]{16}$/.test(id)
export const projectPrincipal = (id) => `project:${id}`
const projectDoc = (store, id) => (isProjectId(id) ? store.getDoc(`project:${id}`) : undefined)

/** The project's repositories (`owner/name`); [] when it has none or does not exist. */
export const getRepos = async (store, projectId) => (await projectDoc(store, projectId))?.repos ?? []
/** Gives the project a repository, once (names compare case-insensitively, as on GitHub). A repository belongs to at
 *  most one project, because that project's owners approve its merges. Fails with 404 for an unknown project, 400 for
 *  a name that is not `owner/name`, and 409 (`code: 'repo_bound'`) for a repository another project already has. */
export async function addRepo(store, projectId, repo) {
  if (typeof repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw fail(400, `${repo} is not a repository name (owner/name)`)
  const same = (r) => r.toLowerCase() === repo.toLowerCase()
  // ponytail: one lock for every binding, so two projects cannot both take a repository; adding repositories is rare.
  await store.withLock('projects:repos', 10_000, async () => {
    const p = await projectDoc(store, projectId)
    if (!p) throw fail(404, `no project ${projectId}`)
    for (const other of await projectsWithRepos(store)) {
      if (other !== projectId && (await getRepos(store, other)).some(same)) throw Object.assign(fail(409, `${repo} already belongs to another project`), { code: 'repo_bound' })
    }
    const repos = p.repos ?? []
    if (!repos.some(same)) await store.putDoc(`project:${projectId}`, { ...p, repos: [...repos, repo] })
    await store.addToSet('projects:with-repos', projectId)
  })
}
/** Ids of the projects that have at least one repository. */
export const projectsWithRepos = (store) => store.setMembers('projects:with-repos')
/** The project's owners (one today); [] for an unknown project. */
export const ownersOf = async (store, projectId) => { const p = await projectDoc(store, projectId); return p ? [p.owner] : [] }
/** Ids of the projects the email owns (not those it is only a member of). */
export async function projectsOwnedBy(store, email) {
  const out = []
  for (const id of await store.setMembers(`projects:${email}`)) if ((await projectDoc(store, id))?.owner === email) out.push(id)
  return out
}

/** Project records and membership. `admitted(email)` is the edge allowlist; a member must pass it too. */
export function projects({ store, admitted, log = console.log }) {
  const say = (fields) => log(JSON.stringify({ edge: 'project', ...fields }))
  const get = (id) => projectDoc(store, id)
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
