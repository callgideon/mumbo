// GitHub for project boxes, on the model host at /github/<host>/<path and query> (host: github.com, api.github.com,
// codeload.github.com or objects.githubusercontent.com). The box authenticates with its box token, already verified
// by modelServer; the edge holds the agent token and forwards only what its rules allow (design section 9): reads on
// the project's repositories, comments and pull requests short of merging or retargeting, and pushes to agent/* only.
import { Readable, pipeline } from 'node:stream'
import { Kind, parse, print, valueFromASTUntyped, visit } from 'graphql'
import { getRepos, isProjectId } from './projects.mjs'

// content-length is left to fetch, which frames the body actually sent (GraphQL and pull request edits are re-serialized).
const REQUEST_HEADERS = ['accept', 'content-type', 'user-agent', 'x-github-api-version', 'git-protocol']
// The set modelServer drops: fetch has decoded the body, the edge frames its own reply, and GitHub sets no box cookies.
const RESPONSE_DROP = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'set-cookie'])
// Pushes carry packs. JSON bodies (GraphQL, REST writes) are small, and graphql-js parse() costs about 240 bytes of heap
// per source byte (10 MB of `query { a a a … }` took 2.4 GB), so their cap keeps one request far inside the edge's 2 GB.
const PUSH_MAX = 256 * 1024 * 1024
const JSON_MAX = 1024 * 1024
// Buffered pushes in flight on one replica, any project: 3 × PUSH_MAX = 768 MB of the 2048 MB edge task.
const MAX_CONCURRENT_PUSHES = 3
// parse() aborts past this many tokens, a few MB of heap; the documents gh and superagent send have a few hundred.
const GRAPHQL_MAX_TOKENS = 50_000
// Node ids one request's mutations may name, all resolved in one nodes(ids:) lookup (GitHub takes at most 100).
const MAX_NODE_IDS = 50
// REST writes on a project repository, as `<METHOD> <path after /repos/{owner}/{name}>`.
const WRITES = [
  /^POST \/issues\/\d+\/comments$/,
  /^PATCH \/issues\/comments\/\d+$/,
  /^POST \/pulls$/,
  /^PATCH \/pulls\/\d+$/,
  /^POST \/pulls\/\d+\/comments$/,
  /^POST \/pulls\/\d+\/comments\/\d+\/replies$/,
  /^POST \/pulls\/\d+\/requested_reviewers$/,
  /^POST \/issues\/\d+\/reactions$/,
  /^POST \/issues\/comments\/\d+\/reactions$/,
]
const PULL_EDIT = /^PATCH \/pulls\/\d+$/
const MUTATIONS = new Set(['createPullRequest', 'updatePullRequest', 'markPullRequestReadyForReview', 'convertPullRequestToDraft', 'addComment', 'updateIssueComment', 'addReaction', 'requestReviews'])
// A mutation's input keys, classified by name: these scalars, or node ids (`id`, `ids`, `*Id`, `*Ids`, as GitHub's
// schema names every ID input). Any other key is refused, so an id under a key this list does not know is never
// forwarded unchecked.
const SCALAR_INPUTS = new Set(['clientMutationId', 'title', 'body', 'baseRefName', 'headRefName', 'draft', 'maintainerCanModify', 'state', 'content', 'union'])
const ID_KEY = /^(id|ids)$|Ids?$/
// requestReviews only: these name people, teams and bots, not repository objects, so they are not resolved; the
// mutation is scoped by its pullRequestId alone. Everywhere else such ids resolve and are refused.
const REVIEWER_IDS = new Set(['userIds', 'teamIds', 'botIds'])
// The node types a mutation may touch, each with its repository; any other type resolves to no repository.
const NODE_REPOS = `query($ids: [ID!]!) { nodes(ids: $ids) { __typename ... on Repository { nameWithOwner } ${['PullRequest', 'Issue', 'IssueComment', 'PullRequestReviewComment'].map(t => `... on ${t} { repository { nameWithOwner } }`).join(' ')} } }`
const STOPPED = 'stopped by the founder'

/**
 * The GitHub forwarder. Refusals answer 403 (400 for a GraphQL document that does not parse, 413 past a body cap,
 * 415 for GraphQL not sent as application/json, 429 for a second push from a project or past MAX_CONCURRENT_PUSHES) and
 * log one line
 * `{ edge: 'github', refused, principal, method, host, path }`. While `halt.isHalted(principal)`, only GET and HEAD,
 * git-upload-pack and GraphQL documents without a mutation pass. Every node id a GraphQL mutation names must resolve,
 * through one `nodes(ids:)` lookup with the agent token, to an object in one of the project's repositories.
 * @param {{ store: object, halt: { isHalted(principal: string): Promise<boolean> }, agentToken: string | undefined, fetchImpl: typeof fetch, log?: (line: string) => void }} deps
 *   `agentToken` unset answers 503 to every request.
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, claim: { u: string, b: string }) => Promise<void>}
 *   handles one request; `claim` is the verified box token (`u` the principal, `b` the box id).
 */
export function githubForwarder({ store, halt, agentToken, fetchImpl, log = console.log }) {
  // Principals with a receive-pack in flight on this replica: one buffered push each.
  const pushing = new Set()

  /** Resolves `ids`; returns a refusal `{ reason, status? }` unless each is an object in one of `repos`. */
  async function outsideRepos(ids, repos) {
    const r = await fetchImpl('https://api.github.com/graphql', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `token ${agentToken}` }, body: JSON.stringify({ query: NODE_REPOS, variables: { ids } }) })
    if (!r.ok) return { reason: `the node id lookup failed (HTTP ${r.status})`, status: 502 }
    const nodes = (await r.json())?.data?.nodes
    for (const [i, id] of ids.entries()) {
      const n = nodes?.[i]
      const repo = n?.__typename === 'Repository' ? n.nameWithOwner : n?.repository?.nameWithOwner
      if (typeof repo !== 'string' || !repos.includes(repo.toLowerCase())) return { reason: `node ${id} (${n?.__typename ?? 'not found'}) is not in this project's repositories` }
    }
  }

  return async (req, res, claim) => {
    const { method } = req
    const url = new URL(req.url, 'http://edge')
    const [, , host, ...segs] = url.pathname.split('/')
    const path = `/${segs.join('/')}`
    const graphql = host === 'api.github.com' && path === '/graphql'
    const refuse = (reason, status = 403) => {
      log(JSON.stringify({ edge: 'github', refused: reason ?? 'not an allowed operation', principal: claim.u, method, host, path }))
      const message = `Mumbo edge refused ${method} ${path}${reason ? `: ${reason}` : ''}`
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...(status === 413 ? { connection: 'close' } : {}) })
        .end(JSON.stringify(graphql ? { errors: [{ message }] } : { message }))
    }
    const id = claim.u.startsWith('project:') ? claim.u.slice('project:'.length) : undefined
    if (!isProjectId(id)) return refuse('GitHub is only for project boxes')
    if (!agentToken) return void res.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ message: 'Mumbo edge: GitHub is not configured' }))
    // Parsed once and forwarded as parsed; a path the parser rewrites (dot segments, escapes, backslashes) is refused.
    // Each branch below names its host, so any other host is refused.
    if (url.pathname !== req.url.split('?')[0] || url.pathname.split('/').slice(1).some(s => !s || s.includes('%'))) return refuse()
    const repos = (await getRepos(store, id)).map(r => r.toLowerCase())
    const ours = (owner, name) => name !== undefined && repos.includes(`${owner}/${name}`.toLowerCase().replace(/\.git$/, ''))
    const gitService = host === 'github.com' && method === 'POST' && segs.length === 3 && ours(segs[0], segs[1]) ? segs[2] : undefined
    const headers = {}
    for (const k of REQUEST_HEADERS) if (req.headers[k] !== undefined) headers[k] = req.headers[k]
    let body
    const read = method === 'GET' || method === 'HEAD'
    // GitHub may merge query parameters into a write's parameters (base, variables), past the body checks below.
    if (!read && url.search) return refuse('a write may not carry a query string')
    if (read) {
      if (!readable(host, segs, url, ours)) return refuse()
    } else if (graphql && method === 'POST') {
      if (String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') return refuse('GraphQL takes application/json', 415)
      const raw = await readBody(req, JSON_MAX)
      if (!raw) return refuse('body over 1 MiB', 413)
      const checked = checkGraphql(raw.toString('utf8'))
      if (checked.refused) return refuse(checked.refused, checked.status)
      // Only mutations name node ids (each must name one), so a document with none is reads only.
      if (checked.ids.length) {
        if (await halt.isHalted(claim.u)) return refuse(STOPPED)
        const outside = await outsideRepos(checked.ids, repos)
        if (outside) return refuse(outside.reason, outside.status)
      }
      body = checked.body
      headers['content-type'] = 'application/json'
    } else if (host === 'api.github.com' && segs[0] === 'repos' && ours(segs[1], segs[2])) {
      const rule = `${method} /${segs.slice(3).join('/')}`
      if (!WRITES.some(w => w.test(rule))) return refuse()
      if (await halt.isHalted(claim.u)) return refuse(STOPPED)
      body = await readBody(req, JSON_MAX)
      if (!body) return refuse('body over 1 MiB', 413)
      if (PULL_EDIT.test(rule) && !(body = pullEdit(body))) return refuse('a pull request edit may change only title, body and state "closed"')
    } else if (gitService === 'git-upload-pack') {
      // Streamed unread; git gzips fetch requests over 1 KB.
      body = Readable.toWeb(req)
      if (req.headers['content-encoding'] !== undefined) headers['content-encoding'] = req.headers['content-encoding']
    } else if (gitService === 'git-receive-pack') {
      if (req.headers['content-encoding'] !== undefined) return refuse('an encoded push is refused')
      if (await halt.isHalted(claim.u)) return refuse(STOPPED)
      if (pushing.has(claim.u)) return refuse('another push from this project is in progress', 429)
      if (pushing.size >= MAX_CONCURRENT_PUSHES) return refuse(`the edge is taking ${MAX_CONCURRENT_PUSHES} other pushes; try again shortly`, 429)
      pushing.add(claim.u)
      res.once('close', () => pushing.delete(claim.u))
      body = await readBody(req, PUSH_MAX)
      if (!body) return refuse('body over 256 MB', 413)
      const why = body.length === 4 && body.toString('latin1') === '0000' ? undefined : pushRefusal(body)
      if (why) return refuse(why)
    } else return refuse()

    if (host === 'api.github.com') headers.authorization = `token ${agentToken}`
    else if (host === 'github.com') headers.authorization = `Basic ${Buffer.from(`x-access-token:${agentToken}`).toString('base64')}`
    // A client that leaves aborts the upstream request, so an abandoned push frees its buffer with its slot.
    const left = new AbortController()
    res.once('close', () => left.abort())
    const upstream = await fetchImpl(`https://${host}${path}${url.search}`, { method, headers, body, duplex: 'half', redirect: 'manual', signal: left.signal })
    const out = {}
    for (const [k, v] of upstream.headers) if (!RESPONSE_DROP.has(k)) out[k] = v
    res.writeHead(upstream.status, out)
    if (upstream.body === null) return void res.end()
    // pipeline cancels the upstream body when the client leaves; once headers are sent there is no one to tell.
    pipeline(Readable.fromWeb(upstream.body), res, () => {})
  }
}

/** Whether a GET or HEAD may pass. `ours(owner, name)` says whether that is one of the project's repositories. */
function readable(host, segs, url, ours) {
  const path = `/${segs.join('/')}`
  switch (host) {
    case 'api.github.com':
      return /^\/(user|rate_limit|notifications)$/.test(path) || /^\/users\/[A-Za-z0-9-]+(\[bot\])?$/.test(path) || (segs[0] === 'repos' && ours(segs[1], segs[2]))
    case 'codeload.github.com': return segs.length >= 3 && ours(segs[0], segs[1])
    case 'objects.githubusercontent.com': return true
    case 'github.com': return segs.length === 4 && segs[2] === 'info' && segs[3] === 'refs' && ours(segs[0], segs[1]) && ['git-upload-pack', 'git-receive-pack'].includes(url.searchParams.get('service'))
  }
  return false
}

/** Resolves the body, or undefined past `max` bytes (the rest is read and dropped until the 413 closes the connection). */
function readBody(req, max) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length']) > max) return resolve(undefined)
    const chunks = []; let size = 0
    req.on('data', (c) => { size += c.length; if (size <= max) chunks.push(c); else resolve(undefined) })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** A `PATCH /pulls/{n}` body re-serialized when it changes only title, body and state "closed"; otherwise undefined. */
function pullEdit(buf) {
  let v
  try { v = JSON.parse(buf.toString('utf8')) } catch { return undefined }  // not JSON: refused like any other body
  const ok = isObject(v) && Object.keys(v).every(k => k === 'title' || k === 'body' || (k === 'state' && v.state === 'closed'))
  return ok ? JSON.stringify(v) : undefined
}

/**
 * Checks a GraphQL request: every operation, whatever operationName picks. No input object repeats a field name and no
 * operation repeats a variable name (400 otherwise). A mutation may hold only allowed top-level
 * fields, by field name (never alias), and no fragments. Each field's `input`, with variables and their defaults
 * resolved, holds only known keys and names at least one node id; updatePullRequest may not set baseRefName or reopen.
 * Returns `{ refused, status? }` or `{ ids, body }`: the node ids to resolve, and the printed document with variables
 * and operationName, so GitHub runs exactly what was checked.
 */
function checkGraphql(text) {
  let req, doc
  try { req = JSON.parse(text) } catch { return { refused: 'the body is not JSON' } }
  if (!isObject(req) || typeof req.query !== 'string') return { refused: 'the body must be a JSON object with a string query' }
  // A string would reach GitHub unread, its escapes hiding names from the checks below.
  if (req.variables != null && !isObject(req.variables)) return { refused: 'variables must be a JSON object' }
  if (req.operationName != null && typeof req.operationName !== 'string') return { refused: 'operationName must be a string' }
  try { doc = parse(req.query, { maxTokens: GRAPHQL_MAX_TOKENS }) } catch (e) { return { refused: `the query does not parse (${e.message})`, status: 400 } }
  // GraphQL requires these names unique; parse() keeps repeats and the input below would read the last, so the edge
  // refuses them rather than rely on GitHub to.
  let repeated
  const once = (names, what) => { if (new Set(names).size !== names.length) repeated = what }
  visit(doc, {
    ObjectValue: (n) => once(n.fields.map(f => f.name.value), 'an input object repeats a field name'),
    OperationDefinition: (n) => once(n.variableDefinitions.map(v => v.variable.name.value), 'an operation repeats a variable name'),
  })
  if (repeated) return { refused: repeated, status: 400 }
  const ids = new Set()
  for (const def of doc.definitions) {
    if (def.kind !== Kind.OPERATION_DEFINITION || def.operation === 'query') continue
    if (def.operation !== 'mutation') return { refused: `a ${def.operation} is not allowed` }
    // What GitHub binds: each declared default, replaced by any value sent (null included).
    const vars = { ...Object.fromEntries(def.variableDefinitions.filter(v => v.defaultValue).map(v => [v.variable.name.value, valueFromASTUntyped(v.defaultValue)])), ...req.variables }
    for (const sel of def.selectionSet.selections) {
      if (sel.kind !== Kind.FIELD) return { refused: 'a mutation may not use fragments' }
      const name = sel.name.value
      if (!MUTATIONS.has(name)) return { refused: `mutation ${name} is not allowed` }
      if (sel.arguments.length > 1 || sel.arguments.some(a => a.name.value !== 'input')) return { refused: `${name} takes only input` }
      const input = (sel.arguments[0] && valueFromASTUntyped(sel.arguments[0].value, vars)) ?? {}
      if (!isObject(input)) return { refused: `${name} input must be an object` }
      let named = 0
      for (const [k, v] of Object.entries(input)) {
        if (SCALAR_INPUTS.has(k)) continue
        if (!ID_KEY.test(k)) return { refused: `${name} input ${k} is not allowed` }
        const list = v === null ? [] : [v].flat()
        if (!list.every(x => typeof x === 'string')) return { refused: `${name} ${k} must hold node ids` }
        if (name === 'requestReviews' && REVIEWER_IDS.has(k)) continue
        for (const x of list) ids.add(x)
        named += list.length
      }
      if (name === 'requestReviews' && typeof input.pullRequestId !== 'string') return { refused: 'requestReviews needs a pullRequestId' }
      if (!named) return { refused: `${name} names no node id` }
      if (name === 'updatePullRequest' && (req.query.includes('baseRefName') || JSON.stringify(req.variables ?? null).includes('baseRefName'))) return { refused: 'updatePullRequest may not change baseRefName' }
      if (name === 'updatePullRequest' && input.state != null && input.state !== 'CLOSED') return { refused: 'updatePullRequest may set state only to CLOSED' }
    }
  }
  if (ids.size > MAX_NODE_IDS) return { refused: `mutations may name at most ${MAX_NODE_IDS} node ids` }
  return { ids: [...ids], body: JSON.stringify({ query: print(doc), variables: req.variables, operationName: req.operationName }) }
}

/**
 * Checks a receive-pack request body: optional `shallow` lines, then one or more `<old> <new> <ref>` commands (the
 * first may carry capabilities after NUL) up to a flush packet. Every ref is under refs/heads/agent/ and none is
 * deleted. Returns the refusal reason, or undefined when the push may pass; the pack after the flush is not read.
 */
function pushRefusal(buf) {
  let at = 0, commands = 0
  for (;;) {
    const hex = buf.toString('latin1', at, at + 4)
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) return 'malformed pkt-line'
    const len = parseInt(hex, 16)
    if (len === 0) return commands ? undefined : 'no commands'
    if (len < 4 || at + len > buf.length) return 'malformed pkt-line'
    let line = buf.toString('latin1', at + 4, at + len).replace(/\n$/, '')
    at += len
    if (commands === 0 && /^shallow [0-9a-f]{40}$/.test(line)) continue
    if (commands === 0) line = line.split('\0')[0]
    const m = /^[0-9a-f]{40} ([0-9a-f]{40}) refs\/heads\/agent\/(?!.*\.\.)[^\x00-\x20\x7f]+$/.exec(line)
    if (!m) return 'only refs/heads/agent/* may be updated'
    if (/^0{40}$/.test(m[1])) return 'a branch may not be deleted'
    commands++
  }
}
