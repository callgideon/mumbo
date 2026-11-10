// Shared projects (deploy/boxes/ASSISTANT.md, option B). A project has its own box, owned by the principal
// `project:<id>` and running dsh as the coordinator; its members are signed-in users. Membership lives in the edge
// store: doc `project:<id>` = { id, name, owner, members, createdAt, repos? } and set `projects:<email>` = ids.
// `repos` (`owner/name`) are the GitHub repositories the project may use through the edge; set `projects:with-repos`
// lists every project that has one, for the approvals poller. Docs `project-session:<id>` and the project doc's
// `coordinatorSessionId` name the plain coordinator Session that relayed messages went to before the relay route; nothing
// reads them now.
import { randomBytes } from 'node:crypto'

const fail = (status, message) => Object.assign(new Error(message), { status })
/** Project ids are lowercase letters and digits, so they fit a hostname label (`p-<id>.<public host>`). */
export const projectId = () => randomBytes(8).toString('hex')
export const isProjectId = (id) => typeof id === 'string' && /^[a-z0-9]{16}$/.test(id)
export const projectPrincipal = (id) => `project:${id}`
const projectDoc = (store, id) => (isProjectId(id) ? store.getDoc(`project:${id}`) : undefined)

/** The project's repositories (`owner/name`); [] when it has none or does not exist. */
export const getRepos = async (store, projectId) => (await projectDoc(store, projectId))?.repos ?? []
const REPO_NAME = /^(?!\.+\/)[A-Za-z0-9_.-]+\/(?!\.+$)[A-Za-z0-9_.-]+$/  // owner/name; neither part is only dots
/** The project for a repository change by `by`, under the bindings lock: 403 unless `by` is in `approvers` and owns it. */
async function ownedProject(store, projectId, by, approvers) {
  if (!approvers.includes(by)) throw fail(403, 'only an approver binds or unbinds repositories')
  const p = await projectDoc(store, projectId)
  if (!p) throw fail(404, `no project ${projectId}`)
  if (p.owner !== by) throw fail(403, 'only the project owner binds or unbinds its repositories')
  return p
}
/** Gives the project a repository, once (names compare case-insensitively, as on GitHub). Only `by` in `approvers`
 *  (APPROVER_EMAILS), owning the project, may do it; a repository belongs to at most one project, because that
 *  project's owner approves its merges. `installationOf(repo)` (github-app.mjs) gives the mumbo-bot App's
 *  installation id for a repository, or undefined; the repository must have one, and the same as the project's
 *  repositories, so that one installation token covers them all. Fails with 400 for a name that is not `owner/name`,
 *  400 (`code: 'repo_not_installed'`) for a repository the App is not installed for, 403 when `by` is not an approver
 *  or not the owner, 404 for an unknown project, 409 (`code: 'repo_bound'`) for a repository another project already
 *  has, 409 (`code: 'repo_other_installation'`) for one in another installation than the project's repositories, 409
 *  (`code: 'repo_changed'`) when the project's first repository changed during the check, and with `installation check
 *  for <repo> failed: …` (no status; `cause` is installationOf's error) when GitHub gives no answer. */
export async function addRepo(store, projectId, repo, { by, approvers = [], installationOf } = {}) {
  if (typeof repo !== 'string' || !REPO_NAME.test(repo)) throw fail(400, `${repo} is not a repository name (owner/name)`)
  if (!approvers.includes(by)) throw fail(403, 'only an approver binds repositories')
  const same = (r) => r.toLowerCase() === repo.toLowerCase()
  // GitHub is asked outside the lock; a first repository that changes meanwhile is refused under it.
  const first = (await getRepos(store, projectId))[0]
  // A GitHub failure is no refusal of the caller: it loses its HTTP status, so the edge logs it as its own error.
  const check = (r) => installationOf(r).catch((e) => { throw new Error(`installation check for ${r} failed: ${e.message}`, { cause: e }) })
  const [installation, firstInstallation] = await Promise.all([check(repo), first && check(first)])
  if (installation === undefined) throw Object.assign(fail(400, `the mumbo-bot App is not installed for ${repo}`), { code: 'repo_not_installed' })
  if (first && firstInstallation !== installation) throw Object.assign(fail(409, `${repo} is in another mumbo-bot installation than ${first}`), { code: 'repo_other_installation' })
  // ponytail: one lock for every binding, so two projects cannot both take a repository; adding repositories is rare.
  await store.withLock('projects:repos', 10_000, async () => {
    const p = await ownedProject(store, projectId, by, approvers)
    if ((p.repos ?? [])[0] !== first) throw Object.assign(fail(409, 'the project\'s repositories changed meanwhile; try again'), { code: 'repo_changed' })
    for (const other of await projectsWithRepos(store)) {
      if (other !== projectId && (await getRepos(store, other)).some(same)) throw Object.assign(fail(409, `${repo} already belongs to another project`), { code: 'repo_bound' })
    }
    const repos = p.repos ?? []
    if (!repos.some(same)) await store.putDoc(`project:${projectId}`, { ...p, repos: [...repos, repo] })
    await store.addToSet('projects:with-repos', projectId)
  })
}
/** Takes a repository from the project (names compare case-insensitively); a project left with none leaves
 *  `projects:with-repos`. Only `by` in `approvers`, owning the project, may do it. Fails with 403 when `by` is not an
 *  approver or not the owner, and 404 for an unknown project or a repository it does not have. */
export async function removeRepo(store, projectId, repo, { by, approvers = [] } = {}) {
  await store.withLock('projects:repos', 10_000, async () => {
    const p = await ownedProject(store, projectId, by, approvers)
    const repos = (p.repos ?? []).filter(r => r.toLowerCase() !== String(repo).toLowerCase())
    if (repos.length === (p.repos ?? []).length) throw fail(404, `${repo} is not a repository of this project`)
    await store.putDoc(`project:${projectId}`, { ...p, repos })
    if (!repos.length) await store.removeFromSet('projects:with-repos', projectId)
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
      // Member gate (B12): until agent containment lands, a member could read the box's secrets; only owners get in.
      if (email !== p.owner) throw Object.assign(fail(403, 'Projects take more members once agent containment lands.'), { code: 'member_gate' })
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

/** The relay route of @mumbo/superagent on a project box (packages/mumbo/superagent UPSTREAM.md S9). */
export const RELAY_PATH = '/orchestrator/relay'
/** What a member sends: `context`, never a work request on its own, or a `request` for work. */
export const MESSAGE_KINDS = ['context', 'request']
/** A message id as the relay route accepts it; a UUID is one. */
export const MESSAGE_ID = /^[A-Za-z0-9._:-]{1,128}$/

/**
 * Delivers a member's message to the project's Superagent, which receives it as a Trigger from the member: the project box
 * is ensured (created or resumed) and the edge posts to its relay route as the member (x-mumbo-member) through the
 * client-proxy. `kind` is 'context' (the default) or 'request'. `messageId`, required, is the caller's idempotency key: a retry with the
 * same id and content is answered `duplicate` and creates nothing, so a caller that timed out retries with the id it chose. `via` is the box id of the member's
 * assistant, a hop of the relay path. Fails with 400 for an empty message, an unknown kind or a missing or malformed id, 404 for a
 * project the member is not in, 409 (`code: 'relay_unavailable'`) when the box's image has no relay route (no member
 * sign-in, or the route answers 404 or 405), and otherwise with the box's 400 or 409 and its code (`invalid_request`,
 * `id_reused`, `relay_off`), or 502. `boxFetch(target, siteHost, path, init)` sends one request to the box through the
 * client-proxy and resolves { status, setCookie, body }; `edgeHost` names this edge in the relay path.
 */
export function projectRelay({ projects, box, boxFetch, siteHostOf, edgeHost, log = console.log }) {
  const say = (fields) => log(JSON.stringify({ edge: 'relay', ...fields }))
  // No fallback to the plain coordinator Session: it would take context as a work request and a retry as a second message.
  const unavailable = (id) => Object.assign(fail(409, `project ${id} runs an older build without the relay, so nothing was sent; its owner moves the box to the current build (RUNBOOK "Moving a box to a new template build")`), { code: 'relay_unavailable' })
  return {
    async message(member, id, text, { kind = 'context', messageId, via } = {}) {
      if (typeof text !== 'string' || !text.trim()) throw fail(400, 'the message is empty')
      if (!MESSAGE_KINDS.includes(kind)) throw fail(400, `kind is one of ${MESSAGE_KINDS.join(', ')}`)
      if (typeof messageId !== 'string' || !MESSAGE_ID.test(messageId)) throw fail(400, 'messageId is 1 to 128 letters, digits and . _ : -')
      const p = await projects.get(id)
      if (!p?.members.includes(member)) throw fail(404, `no project ${id} of yours`)
      const principal = projectPrincipal(id)
      const target = await box.ensure(principal)
      if (!target.member) throw unavailable(id)
      const hops = [{ node: 'member', id: member }, ...(via ? [{ node: 'mumbo', id: via }] : []), { node: 'edge', id: edgeHost }]
      const r = await boxFetch(target, siteHostOf(principal), RELAY_PATH, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: messageId, kind, text: text.trim(), hops }), member: target.member(member) })
      if (r.status === 404 || r.status === 405) throw unavailable(id)
      let out
      try { out = JSON.parse(r.body) } catch { out = undefined }  // a body that is not JSON is a refusal like any other
      if (r.status !== 200 || typeof out?.trigger !== 'string') {
        say({ level: 'warn', msg: 'refused', project: id, member, status: r.status, code: out?.code })
        const status = r.status === 400 || r.status === 409 ? r.status : 502
        throw Object.assign(fail(status, `the project box refused the message: ${out?.error ?? `HTTP ${r.status}`}`), out?.code ? { code: out.code } : {})
      }
      say({ msg: 'delivered', project: id, member, kind, messageId, result: out.result })
      return { delivered: true, project: id, kind, messageId, result: out.result,
        ...(out.waiting ? { waiting: 'the project\'s coordinator is not set up yet; the message waits for it' } : {}) }
    },
  }
}
