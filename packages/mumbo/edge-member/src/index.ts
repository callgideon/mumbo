/**
 * Project members as Host principals: requests the mumbo edge signs for a project member are admitted as an
 * `edge-member` Peer that may read, follow, prompt, and create Sessions in this Host, and nothing else, and each
 * member message reaches the model after a notice naming its sender.
 *
 * @module @mumbo/edge-member
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionTrustRequest } from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-api-remote-access'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-storage-domain'
import { workspaceDomainSpec } from '@deepseek-ai/dsh-workspace'
import z from '@deepseek-ai/schemastery'
import { MemberBindings } from './access.ts'
import { attributeMemberMessages } from './attribution.ts'
import { MEMBER_HEADER, decodeMemberKey, verifyMemberHeader } from './header.ts'
import { MemberPeers } from './members.ts'

export { MEMBER_GLOBAL_ROLE, MEMBER_SESSION_ROLE, MEMBER_WORKSPACE_ROLE } from './access.ts'
export { ATTRIBUTION_SOURCE, attributionText } from './attribution.ts'
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
/** Admission, the access policy, and the Workspace and live Session lists the policy grants over. */
export const inject = ['connection', 'remoteAccess', 'workspaceRegistry', 'sessions']

/** Edge member configuration. */
export interface Config {
  /** This box's member key in unpadded base64url, at least 32 bytes; the edge derives it from the box id. */
  readonly key: string
}

export const Config: z<Config> = z.object({
  key: z.string().required(),
})

/**
 * Register the `edge-member` access policy, the member authenticator, and member attribution.
 * @param ctx - plugin context carrying Connection, remote access, and the Workspace and Session registries.
 * @param config - validated configuration.
 * @throws when the key is not unpadded base64url of at least 32 bytes.
 */
export function apply(ctx: Context, config: Config): void {
  const key = decodeMemberKey(config.key)
  const bindings = new MemberBindings(ctx)
  // The policy exists before any member can be admitted, and outlives the authenticator on unload.
  ctx.effect(() => ctx.remoteAccess.registerPolicy('edge-member', {
    bindings: () => bindings.current(),
  }), 'mumbo-edge-member: access policy')
  const changed = (): void => {
    bindings.reset()
    ctx.remoteAccess.invalidate()
  }
  ctx.on('session/created', changed)
  ctx.on('session/disposed', changed)
  // The Workspace registry emits a change before its entity holds the new Session list, so the rebuild waits
  // until the write that emitted it has settled.
  const pending = new Set<ReturnType<typeof setImmediate>>()
  ctx.effect(() => () => {
    for (const handle of pending) clearImmediate(handle)
    pending.clear()
  }, 'mumbo-edge-member: deferred access rebuilds')
  ctx.on('domain/changed', (change) => {
    if (change.domain !== workspaceDomainSpec.name) return
    const handle = setImmediate(() => {
      pending.delete(handle)
      changed()
    })
    pending.add(handle)
  })

  const peers = new MemberPeers(email => ctx.connection.createPeer({ principal: { kind: 'edge-member', email } }))
  ctx.effect(() => () => { peers.clear() }, 'mumbo-edge-member: member Peers')
  ctx.connection.authenticators.register((request) => {
    const value = headerValue(request)
    const member = value === undefined ? undefined : verifyMemberHeader(key, value, Math.floor(Date.now() / 1000))
    return member === undefined ? undefined : peers.admit(member.email, member.expiry)
  })

  attributeMemberMessages(ctx)
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
