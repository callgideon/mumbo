// Workers outside the boxes (spec section 8, B37): a person's own agent, such as Claude Code on their laptop, takes an
// external Ticket with the door's task_claim and gets a worker token for it, which fetches and pushes that Ticket's one
// agent/* branch through the worker git route as mumbo-bot, only while its lease on the project box is live.
// The token is stateless: `mwt.<body>.<mac>`, body the base64url JSON { p: project id, t: Ticket, a: Assignment, l: lease
// id, repo: 'owner/name' (lowercased by mint), ref: 'refs/heads/agent/<name>', k: door key id, o: key owner, x: expiry,
// epoch ms }, mac the base64url HMAC-SHA256(edge key, "worker-token:" + body). The domain prefix and the `mwt.` prefix keep it from
// passing as a box token (`mbx.`), a door key or a member header. Liveness is the lease, which Superagent holds: every git
// request asks the project box (the fence) before anything reaches GitHub, so nothing is stored here and no box calls the
// edge to revoke a token.
import { createHmac, timingSafeEqual } from 'node:crypto'
import { projectPrincipal } from './projects.mjs'

const HOUR_MS = 3_600_000
/** A path segment the route takes: GitHub's owner and repository name characters, which git's own paths also use. */
const SEGMENT = /^[A-Za-z0-9_.-]+$/
/** The only query the route passes on: a ref advert's. */
const SERVICE = /^\?service=git-(upload|receive)-pack$/
const refusal = (status, code, message) => Object.assign(new Error(message), { status, code })

/**
 * Where the worker git route is served: `https://<host><prefix><owner>/<name>.git`. modelServer routes by it and the door's
 * task_claim names it to the worker. The host and prefix live only here, so moving the route changes this function, the
 * ALB rule and a DNS record.
 * @param {{ publicHost: string }} cfg
 * @returns {{ host: string, prefix: string }}
 */
export const workerGitRoute = (cfg) => ({ host: cfg.publicHost, prefix: '/mcp/git/' })

/**
 * Worker tokens signed with the edge key.
 * @param {{ edgeKey: string, hours: number, now?: () => number }} deps - `hours` is WORKER_TOKEN_HOURS, the token's
 *   lifetime from its mint; the lease ends a worker's access long before, so this only bounds a box that keeps a stale
 *   lease current.
 * @returns {{ mint(claims: { p: string, t: string, a: string, l: string, repo: string, ref: string, k: string, o: string }): string,
 *   verify(token: string): object }} `mint` lowercases `repo`, adds `x` and signs; `verify` returns the claims, or throws
 *   401 `invalid_token` (no `mwt.` token, or its MAC does not match) or 401 `token_expired`.
 */
export function workerTokens({ edgeKey, hours, now = () => Date.now() }) {
  const mac = (body) => createHmac('sha256', edgeKey).update(`worker-token:${body}`).digest('base64url')
  return {
    mint(claims) {
      const body = Buffer.from(JSON.stringify({ ...claims, repo: claims.repo.toLowerCase(), x: now() + hours * HOUR_MS })).toString('base64url')
      return `mwt.${body}.${mac(body)}`
    },
    verify(token) {
      const [prefix, body, sig, extra] = typeof token === 'string' ? token.split('.') : []
      const invalid = refusal(401, 'invalid_token', 'not a worker token from task_claim')
      if (prefix !== 'mwt' || !body || !sig || extra !== undefined) throw invalid
      const expected = Buffer.from(mac(body))
      if (Buffer.byteLength(sig) !== expected.length || !timingSafeEqual(Buffer.from(sig), expected)) throw invalid
      const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))  // the edge signed it, so it parses
      if (!(claims.x > now())) throw refusal(401, 'token_expired', 'the worker token expired; repeat task_claim with the same request_id and your ticket')
      return claims
    },
  }
}

/**
 * The worker git route (modelServer sends it the requests workerGitRoute names): git smart HTTP for one worker token, as
 * mumbo-bot, through the GitHub forwarder's worker mode. In order:
 * 1. any `Origin` header is refused 403 `origin_refused`; exactly one `Authorization: Bearer <token>` is read (cookies
 *    never), else 403 `invalid_token`;
 * 2. a path that is not `<prefix><owner>/<name>.git/<rest>`, each segment of SEGMENT's characters and none `.` or `..`
 *    (so no `%`, no empty segment), or a query other than SERVICE, is refused 400 `invalid_path` before any rewrite;
 * 3. the token's MAC and expiry (403 `invalid_token`, `token_expired`);
 * 4. keys.live(o, k): 403 `invalid_api_key`, `key_revoked`, `key_expired`, `user_disabled`;
 * 5. keys.requireProject: the key still lists project `p` and `o` is still a member, else 403 `project_not_allowed`; the
 *    path's `owner/name` must be the token's `repo`, else 403 `wrong_repository`;
 * 6. the request goes to `github` as `/github/github.com/<owner>/<name>.git/<rest>` with the claim
 *    `{ u: 'project:<p>', worker: { ref, fence } }`.
 * The fence POSTs `workers/<a>/fence` to the project box's Superagent management API as `o` (relay.api) with
 * `{ lease: l, worker: { key: k }, updates? }`. It passes on 200 `{ ok: true }`; a 400, 403, 404 or 409 refusal rejects
 * with 403 `fenced: <the box's code>`, and any other failure with a status or code (a box not ready within 20 s, a
 * connection error, another status, a 200 without `ok: true`) with 503. A failure with neither (a box request that
 * timed out, an edge bug) rejects as it is, which modelServer answers 502 as an edge error. Either logs `{ edge:
 * 'worker-git', msg: 'fence failed', principal, ticket, assignment, key, error, code }` first. No box text reaches the
 * worker, only its code.
 * Refusals here are `text/plain` `<code>: <message>`, which git shows to its user. None is 401: git answers any 401 by
 * asking a credential helper or the terminal for a password, and never shows the body. Each request logs one line
 * `{ edge: 'worker-git', principal, ticket, assignment, key, method, path, outcome, status }` (the token's fields once
 * verified), never the token; `outcome` is a refusal code, `fenced: <code>`, `fence_unavailable`, `ok`, or
 * `http_<status>` otherwise (the forwarder's own refusals, an edge error).
 * @param {{ cfg: { publicHost: string }, tokens: ReturnType<typeof workerTokens>, keys: ReturnType<typeof import('./keys.mjs').doorKeys>,
 *   relay: ReturnType<typeof import('./projects.mjs').projectRelay>, github: ReturnType<typeof import('./github.mjs').githubForwarder>,
 *   log?: (line: string) => void }} deps
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function workerGit({ cfg, tokens, keys, relay, github, log = console.log }) {
  const { prefix } = workerGitRoute(cfg)
  return async (req, res) => {
    const q = req.url.indexOf('?')
    const path = q < 0 ? req.url : req.url.slice(0, q), query = q < 0 ? '' : req.url.slice(q)
    const who = {}
    let outcome
    res.on('close', () => log(JSON.stringify({ edge: 'worker-git', ...who, method: req.method, path, outcome: outcome ?? (res.statusCode < 400 ? 'ok' : `http_${res.statusCode}`), status: res.statusCode })))
    const refuse = (status, code, message) => {
      outcome = code
      res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }).end(`${code}: ${message}\n`)
    }
    if (req.headers.origin !== undefined) return refuse(403, 'origin_refused', 'the worker git route does not serve browsers')
    const auth = req.headersDistinct.authorization ?? []
    const token = auth.length === 1 ? /^Bearer +(\S+)$/i.exec(auth[0])?.[1] : undefined
    if (!token) return refuse(403, 'invalid_token', 'send the worker token from task_claim as one Authorization: Bearer header')
    const segs = path.startsWith(prefix) ? path.slice(prefix.length).split('/') : []
    if (segs.length < 3 || !segs.every(s => SEGMENT.test(s) && s !== '.' && s !== '..') || !segs[1].endsWith('.git') || (query && !SERVICE.test(query))) {
      return refuse(400, 'invalid_path', `the worker git route is ${prefix}<owner>/<name>.git`)
    }
    let c
    try {
      c = tokens.verify(token)
      await keys.requireProject(await keys.live(c.o, c.k), c.p)
    } catch (e) {
      if (!e.code) throw e
      return refuse(e.status === 401 ? 403 : e.status, e.code, e.message)  // git shows no 401's body (see above)
    }
    Object.assign(who, { principal: projectPrincipal(c.p), ticket: c.t, assignment: c.a, key: c.k })
    if (`${segs[0]}/${segs[1].slice(0, -'.git'.length)}`.toLowerCase() !== c.repo) return refuse(403, 'wrong_repository', 'this worker token reaches its Ticket\'s repository only')
    const fence = async (updates) => {
      let failed
      try {
        const out = await (await relay.api(c.o, c.p))('POST', `workers/${c.a}/fence`, { lease: c.l, worker: { key: c.k }, ...(updates ? { updates } : {}) })
        if (out.ok === true) return
        failed = { message: 'the box answered 200 without ok: true', status: 200 }
      } catch (e) {
        if ([400, 403, 404, 409].includes(e.status)) {
          outcome = `fenced: ${e.code ?? 'refused'}`
          throw refusal(403, 'fenced', outcome)
        }
        failed = e
      }
      log(JSON.stringify({ edge: 'worker-git', msg: 'fence failed', ...who, error: failed.message, code: failed.code }))
      if (failed.status === undefined && failed.code === undefined) throw failed  // no outage the box reported: an edge error
      outcome = 'fence_unavailable'
      throw refusal(503, 'fence_unavailable', `the project box did not answer the fence${failed.code ? ` (${failed.code})` : ''}; try again`)
    }
    req.url = `/github/github.com/${segs.join('/')}${query}`
    return github(req, res, { u: projectPrincipal(c.p), worker: { ref: c.ref, fence } })
  }
}
