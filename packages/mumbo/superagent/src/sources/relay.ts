/**
 * Relay Source kind (UPSTREAM.md S9, S10): messages the mumbo edge posts for a project member to `POST /orchestrator/relay`
 * become Triggers from that member, the route that receives them, and the Channel that reports replies back through the edge.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { key, threadKey, type OutboundMessage, type Trigger } from '../core/index.ts'
import { COMMAND_TIMEOUT_MS } from '../infra/commands.ts'
import { sourceContext, type SourceContext, type SourceHost } from './host.ts'
import type { SourceKind } from './kind.ts'

export const SOURCE = 'relay'
/** The exact route the edge posts to; it outranks the `/orchestrator` prefix of the management API. */
export const RELAY_PATH = '/orchestrator/relay'
/** Wire bounds of one relayed message: its text and one hop's `id` in characters, its hop count, and its request body in bytes. */
export const RELAY_LIMITS = { text: 20_000, hops: 8, hop: 200, bodyBytes: 256 * 1024 } as const
/** A lowercased member address, as `@mumbo/edge-member` admits it and `panelAdmins` lists it. */
const MEMBER = /^[^\s*,@A-Z]+@[^\s*,@A-Z]+$/
/** A message or conversation id the edge chooses: no `/`, so `<member>/<conversation>` splits at its last `/`. */
const ID = /^[A-Za-z0-9._:-]{1,128}$/

/** One node a message passed through, from the member first, such as `{ node: 'mumbo', id: '<box id>' }`. */
const HopSchema = z.object({ node: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/), id: z.string().min(1).max(RELAY_LIMITS.hop).regex(/^\P{Cc}+$/u) })
  .strict()
/**
 * The request body: `id` is the edge's message id, its idempotency key per member; `kind` is `request` (an explicit request)
 * or `context` (context, never a request on its own); `hops` is the relay path; `thread` continues an earlier conversation of
 * the same member, named by the `thread` its first message answered, and defaults to `id`, a new conversation.
 */
export const RelayRequestSchema = z.object({
  id: z.string().regex(ID),
  kind: z.enum(['request', 'context']),
  text: z.string().trim().min(1).max(RELAY_LIMITS.text),
  hops: z.array(HopSchema).min(1).max(RELAY_LIMITS.hops),
  thread: z.string().regex(ID).optional(),
}).strict()
export type RelayRequest = z.infer<typeof RelayRequestSchema>

/** The edge's MCP tool for project boxes that delivers one reply to a member. */
export const REPORT_TOOL = 'report_to_member'
/** The code that starts the text of the edge's error result when the address is not a member of the project. */
export const NOT_A_MEMBER = 'not_a_member'

/**
 * Report one Outbox message on a relay Thread to its member by calling the edge's {@link REPORT_TOOL} with
 * `{ member, project, thread, messageId, text }`: the Channel's member and conversation (the `thread` the relay route
 * answered), the project id from `deployment.edge`, the Outbox message id, and the text cut to {@link RELAY_LIMITS}`.text`
 * characters, ending in `…` when cut. The call goes over MCP streamable HTTP to `edge.url` with `Authorization: Bearer <the
 * trimmed content of edge.tokenFile>`, read on each call. The edge reports each `(project, messageId)` pair at most once:
 * Outbox message ids are unique only within one project's box. The whole exchange is aborted when `commands.signal` aborts,
 * as on `Runtime.stop`, and after {@link COMMAND_TIMEOUT_MS}, the time limit of one command.
 * @param host - carries the resolved deployment and the Runtime's lifetime signal.
 * @param message - the Outbox message; with the project, its id is the idempotency key.
 * @returns `'sent'` for any result that is not an error, `'gone'` for an error result whose text starts with
 * `not_a_member:`.
 * @throws when `edge` is unset, the token file is unreadable or empty, the call fails or is aborted, or the edge answers
 * another error, so the Outbox retries.
 */
export async function sendRelay(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { edge } = host.commands.deployment
  if (!edge) throw new Error('dsh-superagent has no `edge` to report relay replies through')
  const { member, thread } = message.channel.address
  if (!member || !thread) throw new Error('Missing relay reply target')
  const token = (await readFile(edge.tokenFile, 'utf8')).trim()
  if (!token) throw new Error(`The edge token file ${edge.tokenFile} is empty`)
  const limit = RELAY_LIMITS.text
  // Drop a high surrogate left alone by the cut, so the text stays well-formed.
  const text = message.text.length <= limit ? message.text : `${message.text.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/, '')}…`
  // Each request's `signal` aborts its fetch; the transport overrides `requestInit.signal` with its own.
  const options = { signal: AbortSignal.any([host.commands.signal, AbortSignal.timeout(COMMAND_TIMEOUT_MS)]), timeout: COMMAND_TIMEOUT_MS }
  const client = new Client({ name: 'dsh-superagent', version: '1.0.0' })
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(edge.url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }), options)
    const result = await client.callTool({ name: REPORT_TOOL, arguments: { member, project: edge.project, thread, messageId: message.id, text } }, options)
    if (!result.isError) return 'sent'
    const answer = result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    if (answer.startsWith(`${NOT_A_MEMBER}:`)) return 'gone'
    throw new Error(`The edge refused the relay reply: ${answer}`)
  } finally {
    await client.close()
  }
}

export const relayKind: SourceKind = {
  kind: SOURCE,
  title: 'Project members',
  description: 'Messages project members send through the mumbo edge, such as from their own assistant: a request, or context.',
  schema: z.object({}).strict(),
  fields: [],
  health: [],
  // A relayed message has one receiving scope, and the Source receives every message there: context reaches the admission table.
  scope: () => ({ listened: true, observed: true, row: SOURCE }),
  channel: { send: sendRelay, link: address => ({ url: '', label: `Project member ${address.member ?? ''}` }) },
  policy: {
    // `allMembers` suits this kind only: its actor is the member DSH admitted, never a name the message gives.
    schema: z.object({
      allowed: z.array(z.object({ id: z.string().regex(MEMBER), name: z.string().trim().max(100).optional() }).strict())
        .refine(members => new Set(members.map(member => member.id)).size === members.length, 'Duplicate members').default([]),
      allMembers: z.boolean().default(true),
    }).strict(),
    fields: [
      { key: 'allowed', type: 'rows', label: 'Project members who may originate work',
        columns: [{ key: 'id', type: 'text', label: 'Email (lowercase)', pattern: '[^\\s*,@A-Z]+@[^\\s*,@A-Z]+' },
          { key: 'name', type: 'text', label: 'Name', optional: true }] },
      { key: 'allMembers', type: 'switch', label: 'Every project member may originate work',
        hint: 'On, every member the mumbo edge admits counts as on the list. Off, only the members on the list may.' },
    ],
    explicit: 'A member who may originate work sends a request; context they send is at most an inferred candidate.',
    rows: () => [{ id: SOURCE, label: 'Relayed messages', note: 'All',
      cells: { listedUnaddressed: true, unlistedAddressed: true, unlistedUnaddressed: true } }],
  },
}

/** A refusal the route answers with its status and a fixed `code`. */
class Refusal extends Error { constructor(readonly status: number, readonly code: string, message: string) { super(message) } }
function answer(res: ServerResponse, status: number, value: Record<string, unknown>): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(JSON.stringify(value))
}
async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk)
    size += bytes.length
    if (size > RELAY_LIMITS.bodyBytes) throw new Refusal(413, 'too_large', `The request exceeds ${RELAY_LIMITS.bodyBytes} bytes`)
    chunks.push(bytes)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  try { return JSON.parse(text) } catch { throw new Refusal(400, 'invalid_request', 'The request body is not JSON') }
}

/**
 * The Trigger of one relayed message: the member as its human actor, addressed `direct` for a request, on the Thread
 * `relay:<member>/<conversation>`, with a Channel to the member, and `meta` `{ kind, message, hops }`.
 * @param member - the admitted member's lowercased address.
 * @param request - the validated request body.
 * @param at - receive time, ISO.
 * @returns the Trigger, whose id derives from the member and the message id.
 */
export function relayTrigger(member: string, request: RelayRequest, at: string): Trigger {
  const conversation = request.thread ?? request.id
  const thread = { source: SOURCE, id: `${member}/${conversation}` }
  return { id: key(SOURCE, member, request.id), source: SOURCE, threads: [thread], actor: { source: SOURCE, id: member }, human: true,
    ...request.kind === 'request' ? { addressed: 'direct' as const } : {}, at, text: request.text,
    channel: { source: SOURCE, thread: threadKey(thread), address: { member, thread: conversation } },
    meta: { kind: request.kind, message: request.id, hops: request.hops } }
}

/** Receive one admitted member's message; answers what the route responds with on success. */
async function relay(source: SourceContext, member: string, request: RelayRequest) {
  await source.ready
  if (!source.config(SOURCE)) throw new Refusal(409, 'relay_off', 'The project\'s relay Source is switched off')
  const trigger = relayTrigger(member, request, new Date().toISOString())
  const result = await source.receive(trigger)
  if (result === 'filtered') throw new Refusal(409, 'relay_off', 'The project\'s relay Source is switched off')
  if (result === 'duplicate') {
    const stored = source.triggers.get(trigger.id)
    const same = stored && stored.text === trigger.text && stored.meta.kind === request.kind && threadKey(stored.threads[0]!) === threadKey(trigger.threads[0]!)
    if (!same) throw new Refusal(409, 'id_reused', `Message ${request.id} was relayed before with other content`)
  } else {
    source.threads.describe(threadKey(trigger.threads[0]!), { facts: { member: { label: 'Member', value: member },
      via: { label: 'Relayed through', value: request.hops.map(hop => `${hop.node} ${hop.id}`).join(' → ') } } })
  }
  return { result, trigger: trigger.id, thread: request.thread ?? request.id, ...source.configured() ? {} : { waiting: 'setup' } }
}

/**
 * Register the relay Source kind and mount `POST /orchestrator/relay`. A request is received only when `ctx.connection.admit`
 * admits it (with DSH's Host and Origin checks) as a live `edge-member` Peer; its body is a {@link RelayRequest} whose first
 * hop is `{ node: 'member', id: <that member> }`. Responses:
 * 200 `{ result: 'stored' | 'duplicate', trigger, thread, waiting? }`, where a repeated message id with the same text, kind and
 * conversation is `duplicate` and `waiting: 'setup'` means evaluation waits for the Superagent setup; and `{ error, code }`
 * with 400 `invalid_request` (`issues` lists the fields, `hops.0` for another first hop), 401 or 403 `unauthenticated` (DSH admission), 403
 * `member_required`, 405 `method`, 409 `id_reused` or `relay_off`, 413 `too_large`, or 500 `failed`.
 * @param ctx - plugin context carrying the web server and Connection.
 * @param host - the runtime the Source receives into.
 * @returns disposer unmounting the route and unregistering the kind.
 */
export function registerRelay(ctx: Pick<Context, 'connection' | 'webServer'>, host: SourceHost): () => void {
  const unregister = host.sources.register(relayKind)
  const source = sourceContext(host, relayKind)
  const unmount = ctx.webServer.register({ kind: 'exact', path: RELAY_PATH, handler: async (req, res) => {
    try {
      if (req.method !== 'POST') throw new Refusal(405, 'method', 'Relay a message with POST')
      const admission = ctx.connection.admit(req)
      if ('rejection' in admission) throw new Refusal(admission.rejection, 'unauthenticated', 'DSH authentication refused this relay request')
      // `edge-member` is declared by `@mumbo/edge-member`, which this package does not import, so the principal is read by its fields.
      const principal: { readonly kind: string; readonly email?: unknown } = admission.peer.principal
      const member = principal.kind === 'edge-member' ? principal.email : undefined
      if (admission.peer.signal.aborted || typeof member !== 'string') throw new Refusal(403, 'member_required', 'Only a project member relays messages')
      const parsed = RelayRequestSchema.safeParse(await body(req))
      const issues = !parsed.success ? parsed.error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message }))
        : parsed.data.hops[0]!.node === 'member' && parsed.data.hops[0]!.id === member ? []
          : [{ path: 'hops.0', message: 'The first hop is not the admitted member' }]
      if (!parsed.success || issues.length) {
        answer(res, 400, { error: `Invalid relay request: ${issues.map(issue => issue.path || '(body)').join(', ')}`, code: 'invalid_request', issues })
        return
      }
      answer(res, 200, await relay(source, member, parsed.data))
    } catch (error) {
      if (error instanceof Refusal) answer(res, error.status, { error: error.message, code: error.code })
      else answer(res, 500, { error: error instanceof Error ? error.message : String(error), code: 'failed' })
    }
  } })
  return () => { unmount(); unregister() }
}
