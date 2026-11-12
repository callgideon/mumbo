// Shared projects (deploy/boxes/ASSISTANT.md, option B). A project has its own box, owned by the principal
// `project:<id>` and running dsh as the coordinator; its members are signed-in users. Membership lives in the edge
// store: doc `project:<id>` = { id, name, owner, members, createdAt, region, repos? } and set `projects:<email>` = ids.
// `region` is the cell its box runs in (cells.mjs), the creator's at creation; a doc without one (created before cells)
// is in us-east-1. Every write here keeps fields it does not set.
// `repos` (`owner/name`) are the GitHub repositories the project may use through the edge; set `projects:with-repos`
// lists every project that has one, for the approvals poller. Docs `project-session:<id>` and the project doc's
// `coordinatorSessionId` name the plain coordinator Session that relayed messages went to before the relay route; nothing
// reads them now.
import { createHash, randomBytes } from 'node:crypto'
import { placementKey, regionOf } from './cells.mjs'

const fail = (status, message) => Object.assign(new Error(message), { status })
/** Project ids are lowercase letters and digits, so they fit a hostname label (`p-<id>.<public host>`). */
export const projectId = () => randomBytes(8).toString('hex')
export const isProjectId = (id) => typeof id === 'string' && /^[a-z0-9]{16}$/.test(id)
export const projectPrincipal = (id) => `project:${id}`
/** The project doc, from the edge's read cache (store.mjs) unless `fresh`: a doc read to be written back is read fresh. */
const projectDoc = (store, id, fresh = false) => (isProjectId(id) ? store.getDoc(`project:${id}`, { fresh }) : undefined)

/** The project's repositories (`owner/name`); [] when it has none or does not exist. `fresh` as projectDoc. */
export const getRepos = async (store, projectId, fresh = false) => (await projectDoc(store, projectId, fresh))?.repos ?? []
const REPO_NAME = /^(?!\.+\/)[A-Za-z0-9_.-]+\/(?!\.+$)[A-Za-z0-9_.-]+$/  // owner/name; neither part is only dots
/** The project for a repository change by `by`, under the bindings lock: 403 unless `by` is in `approvers` and owns it. */
async function ownedProject(store, projectId, by, approvers) {
  if (!approvers.includes(by)) throw fail(403, 'only an approver binds or unbinds repositories')
  const p = await projectDoc(store, projectId, true)
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
      if (other !== projectId && (await getRepos(store, other, true)).some(same)) throw Object.assign(fail(409, `${repo} already belongs to another project`), { code: 'repo_bound' })
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
      const region = regionOf(await store.getDoc(placementKey(owner)))
      await store.putDoc(`project:${id}`, { id, name: name.trim(), owner, members: [owner], createdAt: new Date().toISOString(), region })
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
      const p = await projectDoc(store, id, true)
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
/** Superagent's 403 text for a member who is neither the box's owner nor a panel admin (packages/mumbo/superagent
 *  src/app/http.ts registerHttp); it sends no code, and its other 403s mean a misconfigured box or edge. */
export const NOT_PANEL_ADMIN = 'Management requires the owner or a panel admin'
/** `s` when it is a string of MESSAGE_ID's form (an id, a stage or kind name, an ISO time), else undefined: how the edge
 *  passes on a box's ids and names, which a box steered by untrusted input could otherwise fill with any text. */
export const token = (s) => (typeof s === 'string' && MESSAGE_ID.test(s) ? s : undefined)

/**
 * Wraps text from a box in a tag whose name the text does not contain, so the text cannot close it (as @mumbo/mcp's
 * fence.ts): `<untrusted-N>`, a newline, the text, a newline, `</untrusted-N>`. With `seed`, N is derived from it, so the
 * same seed and text give the same fence: a retried report then repeats its request_id with the same text, which
 * @mumbo/mcp answers with the first result instead of refusing the id as reused. Without, N is random.
 * @param {string} text - the box's text
 * @param {string} [seed] - the report's request_id
 * @returns {string} the fenced text
 */
export const fence = (text, seed) => {
  let tag
  for (let i = 0; tag === undefined || text.includes(tag); i++) {
    tag = `untrusted-${(seed === undefined ? randomBytes(8) : createHash('sha256').update(`fence:${seed}:${i}`).digest()).toString('hex').slice(0, 16)}`
  }
  return `<${tag}>\n${text}\n</${tag}>`
}

/** How long an edge call on a person's behalf waits for a box to be ready, and the most the call takes in all: the ALB
 *  and CloudFront drop a response that sends nothing for 60 s. */
export const BOX_READY_MS = 20_000, CALL_MS = 50_000
/**
 * box.ensure(principal, placed), awaited at most `ms`. `placed` is the principal's placement doc when the caller has read
 * it (a project's doc), so that ensure reads it no more.
 * @returns {Promise<object | undefined>} the box, or undefined when it is not ready by then: its start goes on, and a
 *   later failure goes to `late(error)`. Rejects as box.ensure does.
 */
export async function ensureWithin(box, principal, ms, late, placed) {
  const ensuring = box.ensure(principal, placed)
  let timer
  const target = await Promise.race([ensuring, new Promise((r) => { timer = setTimeout(r, ms) })]).finally(() => clearTimeout(timer))
  if (!target) ensuring.catch(late)
  return target
}

/**
 * The edge's way into a project box as a member, through the client-proxy: the project box is ensured (created or resumed)
 * and every request carries the member's signed x-mumbo-member header. `boxFetch(target, siteHost, path, init)` sends one
 * request to the box through the client-proxy and resolves { status, setCookie, body }; `edgeHost` names this edge in the
 * relay path. A project the member is not in fails with 404 before the box is ensured; a box not ready within `readyMs`
 * (default BOX_READY_MS) with 503 (`code: 'box_unavailable'`) while its start goes on; a box whose image has no member
 * sign-in, or no relay route for message(), with 409 (`code: 'relay_unavailable'`). Each box request may go quiet for
 * what remains of CALL_MS from the call's start, so a call ends within the ALB's and CloudFront's 60 s.
 *
 * Both methods take `doc`, the project's doc when the caller has just read it (the door's dispatcher), and then read it no
 * more, neither for the membership check nor for the box's placement.
 *
 * message(member, id, text, { kind, messageId, via, door, worker, doc }) delivers a message to the project's Superagent relay route,
 * which receives it as a Trigger from the member. `kind` is 'context' (the default) or 'request'. `worker: 'external'` asks
 * for a Ticket that an outside worker takes with the door's task_claim (B37); it is sent only then, and a box whose relay
 * does not know it refuses it (`invalid_request`). `messageId`, required, is the
 * caller's idempotency key: a retry with the same id and content is answered `duplicate` and creates nothing, so a caller that
 * timed out retries with the id it chose. The relay path is the member, then `via`, the box id of the member's assistant
 * (hop `mumbo`), or `door`, the name of the door key that sent it (hop `door`), then this edge. Resolves { delivered, project,
 * kind, messageId, result, trigger, thread, waiting? } with the relay's result and its Trigger and Thread ids, each kept only
 * in MESSAGE_ID's form (token). Fails with 400 for an empty message, an unknown kind or a missing or malformed id, and
 * otherwise with the box's 400 or 409 and its code (`invalid_request`, `id_reused`, `relay_off`), or 502, also for an
 * answer whose Trigger id is not of that form.
 *
 * api(member, id, doc) ensures the box once and resolves `(method, path, body?) => Promise<object>`, which calls Superagent's
 * management API (`/orchestrator/api/<path>`) as the member, who must be one of the box's panel admins, with `body`, when
 * given, as JSON (`content-type: application/json`), and resolves its JSON answer.
 * It fails with 403 (`code: 'owner_only'`) when the box refuses the member as no panel admin (NOT_PANEL_ADMIN), with the
 * box's 400, 404 or 409 and its message (`code` the box's, else `not_found` for 404 and `invalid_request` for 400 and 409),
 * and 502 (`code: 'box_refused'`, with the box's text) for any other answer, other 403s included (a Host or Origin fence,
 * a missing `x-orchestrator-request`). A box's refusal text is cut to 500 characters in either method, logged as it is with
 * the `api refused` line, and put in an error's message only fenced (`fence`), because every caller passes it to a model.
 */
export function projectRelay({ projects, box, boxFetch, siteHostOf, edgeHost, readyMs = BOX_READY_MS, log = console.log }) {
  const say = (fields) => log(JSON.stringify({ edge: 'relay', ...fields }))
  // No fallback to the plain coordinator Session: it would take context as a work request and a retry as a second message.
  const unavailable = (id) => Object.assign(fail(409, `project ${id} runs an older build without the relay, so nothing was sent; its owner moves the box to the current build (RUNBOOK "Moving a box to a new template build")`), { code: 'relay_unavailable' })
  /** The box's refusal text, cut to 500 characters; undefined when it sent none. */
  const said = (out) => (typeof out?.error === 'string' ? out.error.slice(0, 500) : undefined)
  /** The box's refusal text, fenced, for an error's message; the HTTP status when it sent none. */
  const why = (out, status) => (said(out) === undefined ? `HTTP ${status}` : fence(said(out)))
  /** The project's box, ensured, for a member of the project, and `timeoutMs()`, what remains of CALL_MS. `doc` is the
   *  project's doc when the caller has it. */
  async function reach(member, id, doc) {
    const p = doc ?? await projects.get(id)
    if (!p?.members.includes(member)) throw fail(404, `no project ${id} of yours`)
    const deadline = Date.now() + CALL_MS
    const principal = projectPrincipal(id)
    const target = await ensureWithin(box, principal, readyMs, (e) => say({ level: 'warn', msg: 'box unavailable', project: id, error: e.message }), p)
    if (!target) throw Object.assign(fail(503, `project ${id}'s box is starting, so nothing was sent; try again in a minute`), { code: 'box_unavailable' })
    if (!target.member) throw unavailable(id)
    return { target, host: siteHostOf(principal), member: target.member(member), timeoutMs: () => Math.max(1000, deadline - Date.now()) }
  }
  return {
    async message(member, id, text, { kind = 'context', messageId, via, door, worker, doc } = {}) {
      if (typeof text !== 'string' || !text.trim()) throw fail(400, 'the message is empty')
      if (!MESSAGE_KINDS.includes(kind)) throw fail(400, `kind is one of ${MESSAGE_KINDS.join(', ')}`)
      if (typeof messageId !== 'string' || !MESSAGE_ID.test(messageId)) throw fail(400, 'messageId is 1 to 128 letters, digits and . _ : -')
      const { target, host, member: signed, timeoutMs } = await reach(member, id, doc)
      const hops = [{ node: 'member', id: member }, ...(via ? [{ node: 'mumbo', id: via }] : []), ...(door ? [{ node: 'door', id: door }] : []), { node: 'edge', id: edgeHost }]
      const r = await boxFetch(target, host, RELAY_PATH, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: messageId, kind, text: text.trim(), hops, ...(worker ? { worker } : {}) }), member: signed, timeoutMs: timeoutMs() })
      if (r.status === 404 || r.status === 405) throw unavailable(id)
      let out
      try { out = JSON.parse(r.body) } catch { out = undefined }  // a body that is not JSON is a refusal like any other
      if (r.status !== 200 || !token(out?.trigger)) {
        say({ level: 'warn', msg: 'refused', project: id, member, status: r.status, code: token(out?.code) })
        const status = r.status === 400 || r.status === 409 ? r.status : 502
        throw Object.assign(fail(status, `the project box refused the message: ${why(out, r.status)}`), token(out?.code) ? { code: out.code } : {})
      }
      const result = token(out.result)
      say({ msg: 'delivered', project: id, member, kind, messageId, result })
      return { delivered: true, project: id, kind, messageId, result, trigger: out.trigger, thread: token(out.thread),
        ...(out.waiting ? { waiting: 'the project\'s coordinator is not set up yet; the message waits for it' } : {}) }
    },
    async api(member, id, doc) {
      const { target, host, member: signed, timeoutMs } = await reach(member, id, doc)
      return async (method, path, body) => {
        const r = await boxFetch(target, host, `/orchestrator/api/${path}`, { method, member: signed, timeoutMs: timeoutMs(),
          headers: { 'x-orchestrator-request': '1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) })
        let out
        try { out = JSON.parse(r.body) } catch { out = undefined }
        if (r.status === 200 && out && typeof out === 'object') return out
        say({ level: 'warn', msg: 'api refused', project: id, member, path: path.split('?')[0], status: r.status, error: said(out) })
        if (r.status === 403 && out?.error === NOT_PANEL_ADMIN) throw Object.assign(fail(403, 'only the project\'s owners can read its status, stop its Tickets or take them'), { code: 'owner_only' })
        if ([400, 404, 409].includes(r.status) && typeof out?.error === 'string') {
          throw Object.assign(fail(r.status, `the project box refused: ${why(out, r.status)}`), { code: token(out.code) ?? (r.status === 404 ? 'not_found' : 'invalid_request') })
        }
        throw Object.assign(fail(502, `the project box did not answer its management API: ${why(out, r.status)}`), { code: 'box_refused' })
      }
    },
  }
}
