// The MCP door (spec section 10, B32): https://<public host>/mcp, which the ALB rule R-door sends to the model listener
// past the sign-in proxy. A person's own AI tools reach mumbo here as them with a door key (keys.mjs), over MCP's
// Streamable HTTP through the same SDK plumbing as the boxes' endpoint (sandboxes.mjs).
// The gate, in order: the path is /mcp; no Origin header (browsers send one on every POST and cross-origin request; MCP
// clients such as Claude Code send none), and no CORS header is ever sent; exactly one `Authorization: Bearer <key>`
// (cookies are never read), checked by doorKeys.verify; the key's rate limit; one JSON-RPC message per POST. Then the
// dispatcher: a tools/call names a declared tool, the key has its scope and, for a tool that takes a project, reaches
// that project, and a tool that causes model turns finds the owner's daily budgets open. Only then does the tool run.
// Every request logs one line {"edge":"door"} with the key id and name, owner, method, tool, outcome, status and ms;
// never the key, its hash or any argument.
import { z } from 'zod'
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server'
import { toNodeHandler } from '@modelcontextprotocol/node'
import { readBody } from './edge.mjs'
import { SCOPES } from './keys.mjs'

/** The largest POST body the door reads; a larger one gets 413. */
const MAX_BODY = 1024 * 1024
const refusal = (status, code, message) => Object.assign(new Error(message), { status, code })

/**
 * The door's own tools. A door tool is { name, description, input (a zod object), scope (one of keys.mjs SCOPES),
 * project (true: it takes the project id in its `project` argument, and the key must reach that project), turns (true:
 * it causes model turns, so it is charged to the owner's daily budget), run(key, args) }. scope, project and turns must
 * all be declared: the dispatcher refuses a tool missing any of them (`tool_undeclared`).
 * @param {{ projects: ReturnType<typeof import('./projects.mjs').projects> }} deps
 */
export const doorTools = ({ projects }) => [
  {
    name: 'whoami', scope: 'read', project: false, turns: false, input: z.object({}),
    description: 'Who this key acts as: its name, scopes, the projects it may reach, its owner\'s email and when it expires.',
    run: async (key) => ({ id: key.id, name: key.name, owner: key.owner, scopes: key.scopes, projects: key.projects, expiresAt: key.expiresAt === undefined ? null : new Date(key.expiresAt).toISOString() }),
  },
  {
    name: 'project_list', scope: 'read', project: false, turns: false, input: z.object({}),
    description: 'List the projects this key may reach: those it names that its owner is still a member of.',
    run: async (key) => (await projects.list(key.owner)).filter(p => key.projects.includes(p.id)),
  },
]

/**
 * The door's request handler for the model listener (modelServer sends it every request whose Host is the public host).
 * @param {{ keys: ReturnType<typeof import('./keys.mjs').doorKeys>, tools: object[], allow: (email: string) => Promise<boolean>,
 *   tokens?: { allow(principal: string): Promise<boolean> }, rate: { perMinute: number, burst: number }, now?: () => number,
 *   log?: (line: string) => void }} deps
 *   `allow` is the daily request budget (budget.mjs budget), charged once per call to a `turns` tool; `tokens` the daily
 *   token budget, which such a call must find open (the turns' own model calls are metered on the model host). `rate`:
 *   each key id has a bucket of `burst` calls, refilled at `perMinute`, in this process.
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 *   Refusals answer a JSON-RPC error `{ code: -32001, message: '<code>: <text>', data: { code } }` with the HTTP status:
 *   401 invalid_api_key, key_revoked, key_expired (with `WWW-Authenticate: Bearer realm="mumbo"`); 403 origin_refused,
 *   user_key_required, user_disabled, insufficient_scope, project_not_allowed, tool_undeclared; 429 rate_limited (with
 *   Retry-After in seconds) and budget_exhausted; 400 parse_error and invalid_request; 413 body_too_large; 404 not_found.
 */
export function door({ keys, tools, allow, tokens, rate, now = () => Date.now(), log = console.log }) {
  // ponytail: per edge process, so with N replicas a key gets up to N times the rate; move the bucket into the store if
  // that ever matters. Entries are a few numbers per key id, and key ids are few.
  const buckets = new Map()  // key id -> { tokens, at }
  /** Takes one call from the key's bucket: 0 when taken, else the seconds until one is free. */
  const take = (id) => {
    const at = now(), b = buckets.get(id) ?? { tokens: rate.burst, at }
    b.tokens = Math.min(rate.burst, b.tokens + (at - b.at) * rate.perMinute / 60_000)
    b.at = at
    buckets.set(id, b)
    if (b.tokens >= 1) { b.tokens -= 1; return 0 }
    return Math.ceil((1 - b.tokens) * 60 / rate.perMinute)
  }
  /** Throws the refusal for a call of `tool` with `args` by `key`. */
  async function admit(key, tool, args) {
    if (!SCOPES.includes(tool.scope) || typeof tool.project !== 'boolean' || typeof tool.turns !== 'boolean') throw refusal(403, 'tool_undeclared', `The door does not run ${tool.name}: it declares no scope, project or turns.`)
    keys.requireScope(key, tool.scope)
    if (tool.project) await keys.requireProject(key, args?.project)
  }

  const mcp = toNodeHandler(createMcpHandler(({ authInfo }) => {
    const { key, call } = authInfo.extra
    const server = new McpServer({ name: 'mumbo', version: '1.0.0' }, {
      capabilities: { tools: {} },
      instructions: 'Your own mumbo, as you, through a door key: whoami shows the key, project_list the projects it may reach.',
    })
    for (const tool of tools) {
      server.registerTool(tool.name, { description: tool.description, inputSchema: tool.input }, async (args) => {
        // Only the call the dispatcher admitted runs, with the project it checked.
        if (call.admitted !== tool.name || (tool.project && args.project !== call.project)) {
          call.outcome = 'tool_undeclared'
          return { isError: true, content: [{ type: 'text', text: 'tool_undeclared: the door did not admit this call.' }] }
        }
        try {
          const out = await tool.run(key, args)
          call.outcome = 'ok'
          return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
        } catch (e) {
          call.outcome = e.code ?? 'tool_error'
          return { isError: true, content: [{ type: 'text', text: e.code ? `${e.code}: ${e.message}` : e.message }] }
        }
      })
    }
    return server
  }))

  return async (req, res) => {
    const started = now()
    const call = { outcome: 'error' }  // what the log line says; refusals and the tool wrapper set outcome
    res.on('close', () => {
      const { admitted, project, ...fields } = call
      log(JSON.stringify({ edge: 'door', ...fields, status: res.statusCode, ms: now() - started }))
    })
    const refuse = (status, code, message, { id = null, rpc = -32001, headers = {} } = {}) => {
      call.outcome = code
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers })
        .end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: rpc, message: `${code}: ${message}`, data: { code } } }))
    }
    if (new URL(req.url, 'http://x').pathname !== '/mcp') return refuse(404, 'not_found', 'The door is at /mcp.')
    if (req.headers.origin !== undefined) return refuse(403, 'origin_refused', 'The door does not serve browsers; MCP clients send no Origin header.')
    const auth = req.headersDistinct.authorization ?? []
    const token = auth.length === 1 ? /^Bearer +(\S+)$/i.exec(auth[0])?.[1] : undefined
    let key
    try {
      key = await keys.verify(token)
    } catch (e) {
      if (!e.code) throw e
      const challenge = auth.length ? 'Bearer realm="mumbo", error="invalid_token"' : 'Bearer realm="mumbo"'
      return refuse(e.status, e.code, e.message, { headers: e.status === 401 ? { 'www-authenticate': challenge } : {} })
    }
    Object.assign(call, { key: key.id, name: key.name, owner: key.owner })
    const wait = take(key.id)
    if (wait) return refuse(429, 'rate_limited', `This key may make ${rate.perMinute} calls a minute.`, { headers: { 'retry-after': String(wait) } })
    let msg
    if (req.method === 'POST') {
      const raw = await readBody(req, MAX_BODY)
      if (raw === null) return refuse(413, 'body_too_large', `Request bodies are limited to ${MAX_BODY} bytes here.`, { headers: { connection: 'close' } })
      try { msg = JSON.parse(raw) } catch { return refuse(400, 'parse_error', 'The body is not JSON.', { rpc: -32700 }) }
      if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) return refuse(400, 'invalid_request', 'The door takes one JSON-RPC message per request.', { rpc: -32600 })
      if (typeof msg.method === 'string') call.method = msg.method.slice(0, 64)
      const tool = msg.method === 'tools/call' ? tools.find(t => t.name === msg.params?.name) : undefined
      if (tool) {
        call.tool = tool.name
        const args = msg.params.arguments
        try { await admit(key, tool, args) } catch (e) {
          if (!e.code) throw e
          return refuse(e.status, e.code, e.message, { id: msg.id ?? null })
        }
        if (tool.turns && !((await allow(key.owner)) && (!tokens || await tokens.allow(key.owner)))) return refuse(429, 'budget_exhausted', `The daily model budget of ${key.owner} is spent.`, { id: msg.id ?? null })
        Object.assign(call, { admitted: tool.name, project: args?.project })
      }
    }
    // A tools/call that reaches the SDK but runs no tool (unknown name, invalid arguments) logs not_run.
    call.outcome = call.method === 'tools/call' ? 'not_run' : 'ok'
    req.auth = { token: key.id, clientId: key.id, scopes: key.scopes, extra: { key, call } }
    return mcp(req, res, msg)
  }
}
