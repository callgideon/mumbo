// Child sandboxes for agents (PRODUCTION.md stage 8). A box's agent reaches these tools over MCP on the model host
// with its box token; the E2B key stays in the edge. Children are small E2B sandboxes owned by the box's user
// (metadata `owner`, never `user`, so the router never mistakes one for the user's box), capped per user, and killed
// when their timeout ends. Projects run here, never in the box that holds the user's signed-in accounts.
import { z } from 'zod'
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server'
import { toNodeHandler } from '@modelcontextprotocol/node'
import { UNITS, atCapacity } from './capacity.mjs'
import { MESSAGE_ID, MESSAGE_KINDS } from './projects.mjs'

const MAX_OUTPUT = 64 * 1024
const clip = (s) => (s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n[… ${s.length - MAX_OUTPUT} more characters cut]` : s)
const fail = (status, message) => Object.assign(new Error(message), { status })

/** The child-sandbox operations, each scoped to one user. `e2b` is the SDK module. */
export function children({ e2b, cfg, log = console.log }) {
  const say = (fields) => log(JSON.stringify({ edge: 'child', ...fields }))
  async function mine(user) {
    const pager = e2b.Sandbox.list({ query: { metadata: { owner: user }, state: ['running'] } })
    const found = []
    while (pager.hasNext) found.push(...await pager.nextItems())
    return found
  }
  async function owned(user, id) {
    const info = await e2b.Sandbox.getInfo(id).catch(() => undefined)
    if (info?.metadata?.owner !== user) throw fail(404, `no sandbox ${id} of yours`)
    return e2b.Sandbox.connect(id)
  }
  return {
    async create(user, parent, { template = cfg.childTemplates[0], timeoutMinutes = 30 } = {}) {
      if (!cfg.childTemplates.includes(template)) throw fail(400, `template must be one of ${cfg.childTemplates.join(', ')}`)
      if ((await mine(user)).length >= cfg.maxChildren) throw fail(429, `you already run ${cfg.maxChildren} sandboxes; kill one first`)
      if (await atCapacity(e2b, cfg, UNITS.child)) throw fail(503, 'mumbo is at capacity right now; try again in a few minutes')
      const box = await e2b.Sandbox.create(template, {
        timeoutMs: Math.min(Math.max(timeoutMinutes, 1), 240) * 60_000,
        metadata: { owner: user, parent },
        network: { allowPublicTraffic: false },
      })
      say({ msg: 'created', user, parent, child: box.sandboxId, template })
      return { id: box.sandboxId, template, timeoutMinutes }
    },
    async list(user) {
      return (await mine(user)).map(s => ({ id: s.sandboxId, template: s.templateId, startedAt: s.startedAt, endAt: s.endAt }))
    },
    async run(user, id, { command, timeoutSeconds = 120, cwd }) {
      const box = await owned(user, id)
      const r = await box.commands.run(command, { timeoutMs: Math.min(timeoutSeconds, 1800) * 1000, cwd })
        .catch((e) => (typeof e.exitCode === 'number' ? e : Promise.reject(e)))  // a non-zero exit is a result, not a failure
      return { exitCode: r.exitCode, stdout: clip(r.stdout ?? ''), stderr: clip(r.stderr ?? '') }
    },
    async write(user, id, { path, content }) {
      await (await owned(user, id)).files.write(path, content)
      return { path, bytes: Buffer.byteLength(content) }
    },
    async read(user, id, { path }) {
      return { path, content: clip(await (await owned(user, id)).files.read(path)) }
    },
    async kill(user, id) {
      await owned(user, id)
      await e2b.Sandbox.kill(id)
      say({ msg: 'killed', user, child: id })
      return { id, killed: true }
    },
  }
}

/**
 * Node request handler for the MCP endpoint. `claimOf(req)` returns the caller's verified {u, b}; the model host
 * checks the token, ownership and source address before calling this. `projectDomain` (config PROJECT_DOMAIN) names
 * where project boxes are served, p-<id>.<projectDomain>.
 */
export function mcpServer({ ops, projects, relay, projectDomain, claimOf }) {
  const tool = (claim, fn) => async (args) => {
    try {
      return { content: [{ type: 'text', text: JSON.stringify(await fn(claim, args), null, 2) }] }
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: e.message }] }
    }
  }
  const id = z.string().describe('Sandbox id from sandbox_create or sandbox_list')
  const handler = createMcpHandler(({ requestInfo }) => {
    const claim = claimOf(requestInfo)
    const mcp = new McpServer({ name: 'mumbo-sandboxes', version: '1.0.0' }, {
      capabilities: { tools: {} },
      instructions: 'Isolated Linux sandboxes for running projects, builds and experiments away from this box. Each starts in seconds with the same tools as this box, has internet access, and is killed when its timeout ends; nothing in it is backed up. Use several to work in parallel.',
    })
    mcp.registerTool('sandbox_create', {
      description: 'Start a new sandbox. Returns its id.',
      inputSchema: z.object({ timeoutMinutes: z.number().int().min(1).max(240).optional().describe('Minutes until the sandbox is killed (default 30)') }),
    }, tool(claim, (c, a) => ops.create(c.u, c.b, a)))
    mcp.registerTool('sandbox_list', { description: 'List your running sandboxes.', inputSchema: z.object({}) }, tool(claim, (c) => ops.list(c.u)))
    mcp.registerTool('sandbox_run', {
      description: 'Run a shell command in a sandbox and return its exit code, stdout and stderr.',
      inputSchema: z.object({ id, command: z.string(), timeoutSeconds: z.number().int().min(1).max(1800).optional(), cwd: z.string().optional() }),
    }, tool(claim, (c, a) => ops.run(c.u, a.id, a)))
    mcp.registerTool('sandbox_write_file', {
      description: 'Write a text file in a sandbox, creating parent directories.',
      inputSchema: z.object({ id, path: z.string(), content: z.string() }),
    }, tool(claim, (c, a) => ops.write(c.u, a.id, a)))
    mcp.registerTool('sandbox_read_file', {
      description: 'Read a text file from a sandbox.',
      inputSchema: z.object({ id, path: z.string() }),
    }, tool(claim, (c, a) => ops.read(c.u, a.id, a)))
    mcp.registerTool('sandbox_kill', { description: 'Kill a sandbox now.', inputSchema: z.object({ id }) }, tool(claim, (c, a) => ops.kill(c.u, a.id)))
    // Shared projects (projects.mjs): a person's assistant creates and lists projects and adds members; a project's
    // own box (principal project:<id>) does not get these tools.
    if (projects && claim && !claim.u.startsWith('project:')) {
      const pid = z.string().describe('Project id from project_create or project_list')
      mcp.registerTool('project_create', {
        description: `Create a shared project. It gets its own box with a coordinator agent at https://p-<id>.${projectDomain}/; you are its owner and first member.`,
        inputSchema: z.object({ name: z.string().min(1).max(80) }),
      }, tool(claim, (c, a) => projects.create(c.u, a.name)))
      mcp.registerTool('project_list', { description: 'List the projects you are a member of.', inputSchema: z.object({}) }, tool(claim, (c) => projects.list(c.u)))
      mcp.registerTool('project_add_member', {
        description: 'Add a person (by email) to a project you own.',
        inputSchema: z.object({ id: pid, email: z.string() }),
      }, tool(claim, (c, a) => projects.addMember(c.u, a.id, a.email)))
      if (relay) {
        mcp.registerTool('project_message', {
          description: "Send a message to a project's coordinator, as you. kind 'context' (the default) tells it something to keep in mind and never asks for work; kind 'request' asks it for work. The project's policy decides whether it acts. It starts the project's box if needed. Give each new message a new messageId, such as a fresh UUID; if a send fails or times out, retry it with the same messageId, so the coordinator receives it once. Replies do not come back here yet; the project's page shows its work.",
          inputSchema: z.object({ id: pid, message: z.string().min(1).max(20000),
            kind: z.enum(MESSAGE_KINDS).default('context').describe("'context': information, never a work request; 'request': asks for work"),
            messageId: z.string().regex(MESSAGE_ID).describe('A new id for each message (letters, digits and . _ : -, up to 128); reuse it only to retry the same message') }),
        }, tool(claim, (c, a) => relay.message(c.u, a.id, a.message, { kind: a.kind, messageId: a.messageId, via: c.b })))
      }
    }
    return mcp
  })
  return toNodeHandler(handler)
}
