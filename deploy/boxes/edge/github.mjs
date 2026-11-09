// GitHub for project boxes, on the model host at /github/<host>/<path and query> (host: github.com, api.github.com,
// codeload.github.com or objects.githubusercontent.com). The box authenticates with its box token, already verified
// by modelServer; the edge holds the agent token and forwards only what its rules allow (design section 9): reads on
// the project's repositories, comments and pull requests short of merging or retargeting, and pushes to agent/* only.
import { Readable } from 'node:stream'
import { Kind, parse, print } from 'graphql'
import { getRepos, isProjectId } from './projects.mjs'

// content-length is left to fetch, which frames the body actually sent (GraphQL and pull request edits are re-serialized).
const REQUEST_HEADERS = ['accept', 'content-type', 'user-agent', 'x-github-api-version', 'git-protocol']
// The set modelServer drops: fetch has decoded the body, the edge frames its own reply, and GitHub sets no box cookies.
const RESPONSE_DROP = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'set-cookie'])
const MAX_BODY = 256 * 1024 * 1024
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
const STOPPED = 'stopped by the founder'

/**
 * The GitHub forwarder. Refusals answer 403 (415 for GraphQL not sent as application/json, 413 past 256 MB) and log one
 * line `{ edge: 'github', refused, principal, method, host, path }`. While `halt.isHalted(principal)`, only GET and
 * HEAD, git-upload-pack and GraphQL documents without a mutation pass.
 * @param {{ store: object, halt: { isHalted(principal: string): Promise<boolean> }, agentToken: string | undefined, fetchImpl: typeof fetch, log?: (line: string) => void }} deps
 *   `agentToken` unset answers 503 to every request.
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, claim: { u: string, b: string }) => Promise<void>}
 *   handles one request; `claim` is the verified box token (`u` the principal, `b` the box id).
 */
export function githubForwarder({ store, halt, agentToken, fetchImpl, log = console.log }) {
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
      const raw = await readBody(req)
      if (!raw) return refuse('body over 256 MB', 413)
      const checked = checkGraphql(raw.toString('utf8'))
      if (checked.refused) return refuse(checked.refused)
      if (checked.mutates && await halt.isHalted(claim.u)) return refuse(STOPPED)
      body = checked.body
      headers['content-type'] = 'application/json'
    } else if (host === 'api.github.com' && segs[0] === 'repos' && ours(segs[1], segs[2])) {
      const rule = `${method} /${segs.slice(3).join('/')}`
      if (!WRITES.some(w => w.test(rule))) return refuse()
      if (await halt.isHalted(claim.u)) return refuse(STOPPED)
      body = await readBody(req)
      if (!body) return refuse('body over 256 MB', 413)
      if (PULL_EDIT.test(rule) && !(body = pullEdit(body))) return refuse('a pull request edit may change only title, body and state "closed"')
    } else if (gitService === 'git-upload-pack') {
      body = await readBody(req)
      if (!body) return refuse('body over 256 MB', 413)
      // git gzips fetch requests over 1 KB; the body is passed through unread.
      if (req.headers['content-encoding'] !== undefined) headers['content-encoding'] = req.headers['content-encoding']
    } else if (gitService === 'git-receive-pack') {
      if (req.headers['content-encoding'] !== undefined) return refuse('an encoded push is refused')
      if (await halt.isHalted(claim.u)) return refuse(STOPPED)
      body = await readBody(req)
      if (!body) return refuse('body over 256 MB', 413)
      const why = body.length === 4 && body.toString('latin1') === '0000' ? undefined : pushRefusal(body)
      if (why) return refuse(why)
    } else return refuse()

    if (host === 'api.github.com') headers.authorization = `token ${agentToken}`
    else if (host === 'github.com') headers.authorization = `Basic ${Buffer.from(`x-access-token:${agentToken}`).toString('base64')}`
    const upstream = await fetchImpl(`https://${host}${path}${url.search}`, { method, headers, body, redirect: 'manual' })
    const out = {}
    for (const [k, v] of upstream.headers) if (!RESPONSE_DROP.has(k)) out[k] = v
    res.writeHead(upstream.status, out)
    if (upstream.body === null) return void res.end()
    Readable.fromWeb(upstream.body).on('error', () => res.destroy()).pipe(res)
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

/** Resolves the body, or undefined past MAX_BODY (the rest is read and dropped until the 413 closes the connection). */
function readBody(req) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length']) > MAX_BODY) return resolve(undefined)
    const chunks = []; let size = 0
    req.on('data', (c) => { size += c.length; if (size <= MAX_BODY) chunks.push(c); else resolve(undefined) })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** A `PATCH /pulls/{n}` body re-serialized when it changes only title, body and state "closed"; otherwise undefined. */
function pullEdit(buf) {
  let v
  try { v = JSON.parse(buf.toString('utf8')) } catch { return undefined }  // not JSON: refused like any other body
  const ok = v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every(k => k === 'title' || k === 'body' || (k === 'state' && v.state === 'closed'))
  return ok ? JSON.stringify(v) : undefined
}

/**
 * Checks a GraphQL request: every operation, whatever operationName picks. Mutations may hold only allowed top-level
 * fields, by field name (never alias), and no fragments. Returns `{ refused }` or `{ body, mutates }`, where `body` is
 * the printed document with variables and operationName, so GitHub runs exactly what was checked.
 */
function checkGraphql(text) {
  let req, doc
  try { req = JSON.parse(text) } catch { return { refused: 'the body is not JSON' } }
  if (req === null || typeof req !== 'object' || Array.isArray(req) || typeof req.query !== 'string') return { refused: 'the body must be a JSON object with a string query' }
  try { doc = parse(req.query) } catch (e) { return { refused: `the query does not parse (${e.message})` } }
  let mutates = false
  for (const def of doc.definitions) {
    if (def.kind !== Kind.OPERATION_DEFINITION || def.operation === 'query') continue
    if (def.operation !== 'mutation') return { refused: `a ${def.operation} is not allowed` }
    mutates = true
    for (const sel of def.selectionSet.selections) {
      if (sel.kind !== Kind.FIELD) return { refused: 'a mutation may not use fragments' }
      if (!MUTATIONS.has(sel.name.value)) return { refused: `mutation ${sel.name.value} is not allowed` }
      if (sel.name.value === 'updatePullRequest' && (req.query.includes('baseRefName') || JSON.stringify(req.variables ?? null).includes('baseRefName'))) return { refused: 'updatePullRequest may not change baseRefName' }
    }
  }
  return { mutates, body: JSON.stringify({ query: print(doc), variables: req.variables, operationName: req.operationName }) }
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
