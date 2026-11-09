/** Host registry and HTTP adapter for generic Connection RPC channels. */

import { Context, Service } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { PeerId, PeerScope, Principal, RemoteAccessResource } from '@deepseek-ai/dsh-typert-protocol'
import type { ConnectionInteractions } from './connect-protocol.ts'
import {
  RpcId,
  type ClientRequest,
  type RpcId as RpcIdType,
} from './rpc.ts'
import { clientRequestSchema } from './rpc-schema.ts'
import { bridge } from './http-bridge.ts'
import { isRemoteAuthority, isTrustedApiRequest } from './api-request-trust.ts'
import { API_PATH } from './api-path.ts'
import type { BrowserAuth } from './browser-auth.ts'
import { Peer } from './peer.ts'
import type {
  ConnectionAuthenticator,
  HostConnectionAuthenticators,
  PeerAdmission,
  ConnectionAdmission,
  ConnectionFetchAuthorizer,
  ConnectionFetchRouteAccess,
  ConnectionIndexRequest,
  ConnectionIndexResponse,
  ConnectionFetchRoute,
  ConnectionFetchHandler,
  HostConnectionFetch,
  ConnectionRpcEndpointMatcher,
  ConnectionRpcFailure,
  ConnectionRpcHandler,
  ConnectionRpcResult,
  ConnectionRequestRejection,
  ConnectionTrustRequest,
  HostConnectionHandle,
  HostConnectionRpc,
} from './rpc.ts'

const INVALID_REQUEST_RPC_ID = RpcId('invalid-request')
const CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/
const UNIVERSAL_ACTION = 'remoteAccess/follow'
const GLOBAL_RESOURCES: readonly RemoteAccessResource[] = Object.freeze([Object.freeze({ kind: 'global' })])

interface PeerRecord {
  readonly peer: Peer
  ownsSocket: boolean
}

interface ConnectionRpcInterceptor {
  readonly matches: ConnectionRpcEndpointMatcher
  readonly fetchHandler: ConnectionFetchHandler
}

interface RegisteredFetchRoute {
  readonly methods: ReadonlySet<string>
  readonly requestBody: ConnectionFetchRoute['requestBody']
  readonly access: ConnectionFetchRoute['access']
  readonly fetch: ConnectionFetchRoute['fetch']
}

interface ConnectionServerResponse {
  readonly type: 'server-response'
  readonly rpcId: RpcIdType
  readonly result: ConnectionRpcResult<unknown>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host Connection transport and RPC registrations. */
    connection: HostConnectionHandle
  }
}

/** Host Connection service whose channel registrations belong to the caller fiber. */
export class HostConnectionService extends Service implements HostConnectionHandle {
  /** The Peer every authenticated browser connection shares. */
  readonly browserPeer: PeerScope
  private readonly peers = new Map<PeerId, PeerRecord>()
  private readonly owner: Context
  private disposed = false
  private readonly interceptors = new Map<string, ConnectionRpcInterceptor>()
  private readonly fetchRoutes = new Map<string, RegisteredFetchRoute>()
  private fetchAuthorizer: ConnectionFetchAuthorizer | undefined
  private readonly authenticatorList: ConnectionAuthenticator[] = []

  readonly allowsRemoteAuthorities: boolean

  /**
   * Provide the Host half over the active HTTP server.
   * @param ctx - owning Connection plugin context.
   * @param trustedHosts - deployment authorities accepted by the Host/Origin fence.
   * @param browserAuth - process token and persistent browser-session owner.
   */
  constructor(
    ctx: Context,
    private readonly trustedHosts: readonly string[],
    private readonly browserAuth: BrowserAuth,
  ) {
    super(ctx, 'connection')
    this.owner = ctx
    this.browserPeer = new Peer(ctx, { principal: { kind: 'owner' } })
    ctx.effect(() => async () => {
      this.disposed = true
      const peers = [this.browserPeer, ...Array.from(this.peers.values(), record => record.peer)]
      this.peers.clear()
      await Promise.all(peers.map(peer => peer.dispose()))
    }, 'client-connection: Peer scopes')
    this.allowsRemoteAuthorities = trustedHosts.some(isRemoteAuthority)
  }

  /** Generic channel registry scoped to the Context reading this service. */
  get rpc(): HostConnectionRpc {
    const owner = this.ctx
    return {
      handle: (channel, handler) => this.register(owner, channel, handler),
      intercept: (channel, matches, handler) =>
        this.registerInterceptor(owner, channel, matches, handler),
    }
  }

  /** Exact Fetch-route registry scoped to the Context reading this service. */
  get fetch(): HostConnectionFetch {
    const owner = this.ctx
    return {
      register: route => this.registerFetchRoute(owner, route),
      authorize: authorizer => owner.effect(() => {
        if (this.fetchAuthorizer !== undefined) {
          throw new Error('connection: an exact Fetch route authorizer is already installed')
        }
        this.fetchAuthorizer = authorizer
        return () => { this.fetchAuthorizer = undefined }
      }, 'client-connection: exact Fetch route authorizer'),
    }
  }

  /** Non-owner authenticator registry scoped to the Context reading this service. */
  get authenticators(): HostConnectionAuthenticators {
    const owner = this.ctx
    return {
      register: authenticator => owner.effect(() => {
        this.authenticatorList.push(authenticator)
        return () => {
          this.authenticatorList.splice(this.authenticatorList.indexOf(authenticator), 1)
        }
      }, 'client-connection: authenticator'),
    }
  }

  /** Apply the Host/Origin fence and require an authenticated live owner Peer. */
  requestRejection(request: ConnectionTrustRequest): ConnectionRequestRejection {
    const admission = this.admit(request)
    if ('rejection' in admission) return admission.rejection
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- other packages merge non-owner kinds into PrincipalMap.
    return admission.peer.principal.kind === 'owner' ? undefined : 403
  }

  /** Authenticators first; browser requests share an owner Peer; API HTTP does not depend on an attached socket. */
  admit(request: ConnectionTrustRequest): PeerAdmission {
    if (!this.isTrusted(request)) return { rejection: 403 }
    if (this.disposed) return { rejection: 401 }
    const authenticated = this.authenticate(request)
    if (authenticated !== undefined) return { peer: authenticated }
    const secure = this.owner.get('webServer')?.protocol === 'https:'
    if (this.browserAuth.isAuthenticated(request, secure)) return { peer: this.browserPeer }
    const id = this.browserAuth.authenticateApi(request, secure)
    const record = id === undefined ? undefined : this.peers.get(id)
    return record === undefined ? { rejection: 401 } : { peer: record.peer }
  }

  /** Create one in-process Peer owned by the Context that read this service. */
  createPeer(options: { readonly principal: Principal; readonly interactions?: ConnectionInteractions }): PeerScope {
    return new Peer(this.ctx, options)
  }

  /** Claim API socket ownership synchronously; callers release on termination or failed upgrade. */
  admitConnection(request: ConnectionTrustRequest): ConnectionAdmission {
    const admission = this.admit(request)
    if ('rejection' in admission) return admission
    const record = this.peers.get(admission.peer.id)
    if (record === undefined) return { ...admission, release: () => Promise.resolve() }
    if (record.ownsSocket) return { rejection: 409 }
    record.ownsSocket = true
    let released: Promise<void> | undefined
    return {
      peer: record.peer,
      release: () => {
        if (released !== undefined) return released
        this.peers.delete(record.peer.id)
        released = record.peer.dispose()
        return released
      },
    }
  }

  private authenticate(request: ConnectionTrustRequest): PeerScope | undefined {
    for (const authenticator of this.authenticatorList) {
      let peer: PeerScope | undefined
      try {
        peer = authenticator(request)
      } catch (error) {
        // A faulty authenticator must not break owner admission; the request continues to the next check.
        this.owner.logger.warn('client-connection: an authenticator failed; passing the request on', error)
        continue
      }
      if (peer !== undefined) return peer
    }
    return undefined
  }

  private isTrusted(request: ConnectionTrustRequest): boolean {
    const carrier = this.owner.get('webServer')
    return isTrustedApiRequest(request, this.trustedHosts, carrier?.host, carrier?.protocol ?? 'http:')
  }

  private publishPeer(interactions: ConnectionInteractions): PeerId {
    const peer = new Peer(this.owner, { principal: { kind: 'owner' }, interactions })
    this.peers.set(peer.id, { peer, ownsSocket: false })
    return peer.id
  }

  /**
   * Authenticate and publish a credential before sending the connect redirect.
   * @param request - launch-token request on /connect.
   * @param response - response owned to completion.
   */
  authorizeConnect(request: ConnectionIndexRequest, response: ConnectionIndexResponse): void {
    if (!this.isTrusted(request) || this.disposed) {
      response.writeHead(this.disposed ? 401 : 403)
      response.end(this.disposed ? 'unauthorized' : 'forbidden')
      return
    }
    this.browserAuth.authorizeConnect(request, response,
      this.owner.get('webServer')?.protocol === 'https:', interactions => this.publishPeer(interactions))
  }

  /**
   * Authenticate an owner index request; native TLS listeners mint Secure cookies.
   */
  authorizeIndex(request: ConnectionIndexRequest, response: ConnectionIndexResponse): boolean {
    return this.browserAuth.authorizeIndex(request, response, this.ctx.get('webServer')?.protocol === 'https:')
  }

  /** Admit an index request for an authenticator's Peer, else for the owner's browser Peer. */
  admitIndex(request: ConnectionIndexRequest, response: ConnectionIndexResponse): PeerScope | undefined {
    if (!this.disposed && this.isTrusted(request)) {
      const authenticated = this.authenticate(request)
      if (authenticated !== undefined) return authenticated
    }
    return this.authorizeIndex(request, response) ? this.browserPeer : undefined
  }

  /** Add this process's launch token to the clean application URL. */
  authenticatedUrl(baseUrl: string): string {
    return this.browserAuth.authenticatedUrl(baseUrl)
  }

  /**
   * Compose one shared-channel Fetch handler from exact routes and its interceptor.
   * @param channel - shared channel mounted by Connection.
   * @returns Fetch handler that selects one owner or returns 404.
   */
  createSharedFetchHandler(
    channel: '/api',
  ): ConnectionFetchHandler {
    return {
      requestBodyMode: ({ method, url }) => {
        const route = this.fetchRoutes.get(url.pathname)
        return route?.methods.has(method) === true ? route.requestBody : 'buffered'
      },
      fetch: (request, peer) => {
        const pathname = new URL(request.url).pathname
        const route = this.fetchRoutes.get(pathname)
        if (route?.methods.has(request.method) === true) {
          // Exact routes bypass the Gateway; a non-owner reaches only a route whose declared access allows it.
          // oxlint-disable-next-line typescript/no-unnecessary-condition -- other packages merge non-owner kinds into PrincipalMap.
          if (peer.principal.kind === 'owner') return route.fetch(request)
          if (!this.allowsRoute(route.access, request, peer)) {
            return Promise.resolve(new Response('forbidden', { status: 403 }))
          }
          // A non-owner's route work ends with its Peer, as its Gateway streams do.
          return route.fetch(new Request(request, { signal: AbortSignal.any([request.signal, peer.signal]) }))
        }
        const endpoint = endpointFromPath(channel, pathname)
        const interceptor = this.interceptors.get(channel)
        if (endpoint === undefined || interceptor === undefined || !interceptor.matches(endpoint)) {
          return Promise.resolve(new Response('not found', { status: 404 }))
        }
        return interceptor.fetchHandler.fetch(request, peer)
      },
    }
  }

  /** Default deny: no access, no authorizer, a disposed Peer, or an unresolvable resource refuses. */
  private allowsRoute(access: ConnectionFetchRouteAccess | undefined, request: Request, peer: PeerScope): boolean {
    const authorizer = this.fetchAuthorizer
    if (access === undefined || authorizer === undefined || peer.signal.aborted) return false
    const resources = queryResources(access, new URL(request.url).searchParams)
    if (resources === undefined) return false
    try {
      return authorizer({ principal: peer.principal, action: access.action, resources })
    } catch (error) {
      // A faulty authorizer cannot allow a request; the caller answers 403.
      this.owner.logger.warn('client-connection: the exact Fetch route authorizer failed; refusing the request', error)
      return false
    }
  }

  private registerFetchRoute(
    owner: Context,
    route: ConnectionFetchRoute,
  ): () => Promise<void> {
    assertFetchRoute(route)
    const registered: RegisteredFetchRoute = {
      methods: new Set(route.methods),
      requestBody: route.requestBody,
      access: route.access,
      fetch: route.fetch,
    }
    return owner.effect(() => {
      if (this.fetchRoutes.has(route.path)) {
        throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} is already registered`)
      }
      this.fetchRoutes.set(route.path, registered)
      return () => { this.fetchRoutes.delete(route.path) }
    }, `client-connection: ${route.path} Fetch route`)
  }

  private register(
    owner: Context,
    channel: string,
    handler: ConnectionRpcHandler,
  ): () => Promise<void> {
    assertChannel(channel)
    const fetchHandler = rpcFetchHandler(channel, handler)
    const route: WebRoute = {
      kind: 'prefix',
      path: channel,
      handler: async (req, res) => {
        const admission = this.admit(req)
        if ('rejection' in admission) {
          res.writeHead(admission.rejection)
          res.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden')
          return
        }
        // Dedicated channels bypass Gateway access checks, so only the owner reaches them.
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- other packages merge non-owner kinds into PrincipalMap.
        if (admission.peer.principal.kind !== 'owner') {
          res.writeHead(403)
          res.end('forbidden')
          return
        }
        await bridge(req, res, fetchHandler, admission.peer)
      },
    }
    return owner.effect(
      () => owner.webServer.register(route),
      `client-connection: ${channel} rpc channel`,
    )
  }

  private registerInterceptor(
    owner: Context,
    channel: string,
    matches: ConnectionRpcEndpointMatcher,
    handler: ConnectionRpcHandler,
  ): () => Promise<void> {
    if (channel !== API_PATH) {
      throw new Error(`connection: invalid shared RPC channel ${JSON.stringify(channel)}`)
    }
    const interceptor: ConnectionRpcInterceptor = {
      matches,
      fetchHandler: rpcFetchHandler(channel, handler),
    }
    return owner.effect(() => {
      if (this.interceptors.has(channel)) {
        throw new Error(`connection: shared RPC channel ${JSON.stringify(channel)} already has an interceptor`)
      }
      this.interceptors.set(channel, interceptor)
      return () => {
        this.interceptors.delete(channel)
      }
    }, `client-connection: ${channel} rpc interceptor`)
  }
}

function rpcFetchHandler(
  channel: string,
  handler: ConnectionRpcHandler,
): ConnectionFetchHandler {
  return {
    requestBodyMode: () => 'buffered',
    async fetch(request: Request, peer: PeerScope): Promise<Response> {
      const endpoint = endpointFromPath(channel, new URL(request.url).pathname)
      if (request.method !== 'POST' || endpoint === undefined) {
        return new Response('not found', { status: 404 })
      }

      const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
      if (mediaType !== 'application/json') {
        return new Response('content type must be application/json', { status: 415 })
      }

      let body: unknown
      try {
        body = await request.json()
      } catch {
        return new Response('body is not JSON', { status: 400 })
      }

      const envelope = clientRequestSchema.safeParse(body)
      if (!envelope.success) {
        return invalidEnvelopeResponse(body, envelope.error.issues)
      }
      const message: ClientRequest = envelope.data
      if (message.method !== endpoint) {
        return errorResponse(message.rpcId, {
          code: 'gateway/bad-request',
          message: `method ${JSON.stringify(message.method)} does not match endpoint ${JSON.stringify(endpoint)}`,
          details: { issues: [] },
        })
      }

      try {
        const result = await handler(endpoint, message.payload, request.signal, peer)
        return fullResponse(message.rpcId, result)
      } catch (error) {
        return new Response(`handler failure: ${String(error)}`, { status: 500 })
      }
    },
  }
}

function invalidEnvelopeResponse(body: unknown, issues: readonly object[]): Response {
  const rawId = (body as { rpcId?: unknown } | null)?.rpcId
  const rpcId = typeof rawId === 'string' ? RpcId(rawId) : INVALID_REQUEST_RPC_ID
  return errorResponse(rpcId, {
    code: 'gateway/bad-request',
    message: 'invalid client-request message',
    details: { issues },
  })
}

function endpointFromPath(channel: string, pathname: string): string | undefined {
  if (!pathname.startsWith(`${channel}/`)) return undefined
  const endpoint = pathname.slice(channel.length + 1)
  const segments = endpoint.split('/')
  if (segments.some(segment =>
    segment === '' || segment === '.' || segment === '..' || !ENDPOINT_SEGMENT_PATTERN.test(segment))) {
    return undefined
  }
  return endpoint
}

/**
 * Read the resources one exact-route request names in its query.
 * @returns the global resource alone for an empty map; `undefined` when a
 *   listed parameter is missing, empty, or repeated.
 */
function queryResources(access: ConnectionFetchRouteAccess, query: URLSearchParams): readonly RemoteAccessResource[] | undefined {
  const resources: RemoteAccessResource[] = []
  for (const [kind, parameter] of Object.entries<string>(access.resources)) {
    const values = query.getAll(parameter)
    if (values.length !== 1 || values[0] === '') return undefined
    // Kinds are keys of the merged resource map that the route's declaration was typed against.
    resources.push({ kind, id: values[0] } as RemoteAccessResource)
  }
  return resources.length === 0 ? GLOBAL_RESOURCES : resources
}

function errorResponse(rpcId: RpcIdType, error: ConnectionRpcFailure): Response {
  return fullResponse(rpcId, { ok: false, error })
}

function fullResponse(rpcId: RpcIdType, result: Awaited<ReturnType<ConnectionRpcHandler>>): Response {
  if (!result.ok) {
    const body: ConnectionServerResponse = { type: 'server-response', rpcId, result }
    return Response.json(body)
  }
  const { attachments, ...success } = result
  const body: ConnectionServerResponse = { type: 'server-response', rpcId, result: success }
  if (attachments === undefined || attachments.length === 0) return Response.json(body)
  const parts = new FormData()
  const attachmentMetadata = attachments.map((attachment, index) => {
    const part = `bytes-${index}`
    // FileSystem bytes may have SharedArrayBuffer backing, which BlobPart excludes.
    parts.set(part, new Blob([new Uint8Array(attachment.bytes)]))
    return { path: [...attachment.path], codec: 'bytes' as const, part }
  })
  parts.set('metadata', JSON.stringify({ ...body, attachments: attachmentMetadata }))
  return new Response(parts)
}

function assertChannel(channel: string): void {
  if (!CHANNEL_PATTERN.test(channel) || channel === '/api') {
    throw new Error(`connection: invalid or reserved RPC channel ${JSON.stringify(channel)}`)
  }
}

function assertFetchRoute(route: ConnectionFetchRoute): void {
  if (endpointFromPath(API_PATH, route.path) === undefined) {
    throw new Error(`connection: invalid exact Fetch route ${JSON.stringify(route.path)}`)
  }
  if (route.methods.length === 0) {
    throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} declares no methods`)
  }
  const methods = new Set(route.methods)
  if (methods.size !== route.methods.length) {
    throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} repeats a method`)
  }
  // Remote access allows its snapshot endpoint for every principal, so it would open the route to every non-owner.
  if (route.access?.action === UNIVERSAL_ACTION) {
    throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} declares the universally allowed action ${UNIVERSAL_ACTION}`)
  }
}
