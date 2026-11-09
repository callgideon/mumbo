/**
 * Project members as Host principals: requests the mumbo edge signs for a project member are admitted as an
 * `edge-member` Peer that may read, follow, prompt, and create Sessions in this Host, and nothing else.
 *
 * @module @mumbo/edge-member
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionTrustRequest, PeerScope } from '@deepseek-ai/dsh-client-connection'
import type { RemoteAccessBinding, RemoteAccessRole } from '@deepseek-ai/dsh-api-remote-access'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-storage-domain'
import { workspaceDomainSpec } from '@deepseek-ai/dsh-workspace'
import z from '@deepseek-ai/schemastery'
import { MEMBER_HEADER, decodeMemberKey, verifyMemberHeader } from './header.ts'

export { MAX_FUTURE_SECONDS, MEMBER_HEADER, signMemberHeader, verifyMemberHeader } from './header.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    /** One project member, as the mumbo edge signed it. */
    'edge-member': EdgeMemberPrincipal
  }
}

/** One project member; persisted in Session logs as the `principal` of each message the member sends. */
export interface EdgeMemberPrincipal {
  readonly kind: 'edge-member'
  /** Lowercased address the edge signed in. */
  readonly email: string
}

/** Cordis function-plugin name. */
export const name = 'mumbo-edge-member'
/** Admission, the access policy, and the Workspace list the policy grants over. */
export const inject = ['connection', 'remoteAccess', 'workspaceRegistry']

/** Edge member configuration. */
export interface Config {
  /** This box's member key in unpadded base64url, at least 32 bytes; the edge derives it from the box id. */
  readonly key: string
}

export const Config: z<Config> = z.object({
  key: z.string().required(),
})

/** Host-wide reads a collaborator's page needs; list and follow results are filtered per Session and Workspace. */
const MEMBER_GLOBAL_ROLE: RemoteAccessRole<'global'> = {
  name: 'mumbo:member-global',
  resource: 'global',
  actions: [
    'commands/list',
    'llm/listConfigurableProviders',
    'llm/listProviders',
    'session/control',
    'session/list',
    'session/modelCatalog',
    'session/search',
    'workspace/follow',
  ],
}

/** Reading, following, prompting, and stopping one Session. */
const MEMBER_SESSION_ROLE: RemoteAccessRole<'session'> = {
  name: 'mumbo:member-session',
  resource: 'session',
  actions: [
    'commands/list',
    'fileUploads/upload',
    'goals/get',
    'session/attachment',
    'session/cancel',
    'session/control',
    'session/events',
    'session/follow',
    'session/list',
    'session/observeEvent',
    'session/observeProjections',
    'session/observeState',
    'session/page',
    'session/projections',
    'session/prompt',
    'session/search',
    'session/state',
    'session/updateQueue',
    'session/wait',
    'skills/list',
    'toolResults/watch',
    'workspace/follow',
    'event:api-session/activity',
    'event:api-session/added',
    'event:api-session/error',
    'event:api-session/removed',
    'event:api-session/status',
  ],
}

/** Following one Workspace and starting a Session in it. */
const MEMBER_WORKSPACE_ROLE: RemoteAccessRole<'workspace'> = {
  name: 'mumbo:member-workspace',
  resource: 'workspace',
  actions: ['workspace/follow', 'session/create'],
}

/**
 * Verify the member header and register the authenticator and the `edge-member` access policy.
 * @param ctx - plugin context carrying Connection, remote access, and the Workspace registry.
 * @param config - validated configuration.
 * @throws when the key is not unpadded base64url of at least 32 bytes.
 */
export function apply(ctx: Context, config: Config): void {
  const key = decodeMemberKey(config.key)
  // One Peer per member, shared by every connection that member opens, as browser connections share the owner's.
  const peers = new Map<string, PeerScope>()
  const peerFor = (email: string): PeerScope => {
    let peer = peers.get(email)
    if (peer === undefined) {
      peer = ctx.connection.createPeer({ principal: { kind: 'edge-member', email } })
      peers.set(email, peer)
    }
    return peer
  }
  ctx.connection.authenticators.register((request) => {
    const value = headerValue(request)
    const email = value === undefined ? undefined : verifyMemberHeader(key, value, Math.floor(Date.now() / 1000))
    return email === undefined ? undefined : peerFor(email)
  })
  ctx.effect(() => ctx.remoteAccess.registerPolicy('edge-member', {
    bindings: () => memberBindings(ctx),
  }), 'mumbo-edge-member: access policy')
  // Grants follow the Workspace list, so every new Session or Workspace changes members' snapshots.
  ctx.on('session/created', () => { ctx.remoteAccess.invalidate() })
  ctx.on('domain/changed', (change) => {
    if (change.domain === workspaceDomainSpec.name) ctx.remoteAccess.invalidate()
  })
}

/**
 * Every member holds the same grants: the global role, and the Workspace and Session roles on every
 * Workspace and every Session a Workspace lists.
 * @param ctx - context carrying the Workspace registry.
 * @returns the bindings of any `edge-member` principal.
 */
function memberBindings(ctx: Context): RemoteAccessBinding[] {
  const bindings: RemoteAccessBinding[] = [{ role: MEMBER_GLOBAL_ROLE, resource: { kind: 'global' } }]
  for (const workspace of ctx.workspaceRegistry.list()) {
    bindings.push({ role: MEMBER_WORKSPACE_ROLE, resource: { kind: 'workspace', id: workspace.id } })
    for (const id of workspace.sessionIds) bindings.push({ role: MEMBER_SESSION_ROLE, resource: { kind: 'session', id } })
  }
  return bindings
}

/**
 * Read the single member header value of one request.
 * @param request - request headers from the HTTP or upgrade request.
 * @returns the value, or undefined when the header is absent or repeated.
 */
function headerValue(request: ConnectionTrustRequest): string | undefined {
  const { headers } = request
  if (headers instanceof Headers) {
    const value = headers.get(MEMBER_HEADER)
    return value === null || value.includes(',') ? undefined : value
  }
  const value = headers[MEMBER_HEADER]
  return typeof value === 'string' ? value : undefined
}
