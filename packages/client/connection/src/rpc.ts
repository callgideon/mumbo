/** Generic unary RPC contracts shared by the Host and Client Connection halves. */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { PeerScope, Principal, RemoteAccessResource, TypertResourceKind } from '@deepseek-ai/dsh-typert-protocol'

/** Correlation id minted by a caller and echoed by the Connection response. */
export type RpcId = Branded<'rpc-id'>

/**
 * Brand one validated string as a Connection correlation id.
 * @param id - validated wire identity.
 * @returns the same string with the correlation-id brand.
 */
export function RpcId(id: string): RpcId {
  return id as RpcId
}

/** Carrier-neutral failure returned by one logical RPC endpoint. */
export interface ConnectionRpcFailure {
  readonly code: string
  readonly message: string
  readonly details: object
}

/** Carrier-neutral result returned by one logical RPC endpoint. */
export type ConnectionRpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ConnectionRpcFailure }

/** One binary value separated from a successful RPC result before transport framing. */
export interface ConnectionRpcAttachment {
  /** Result-relative path occupied by the attachment's `null` placeholder. */
  readonly path: readonly (string | number)[]
  /** Byte view carried outside the JSON response metadata. */
  readonly bytes: Uint8Array
}

/** Successful or failed handler result ready for Connection transport framing. */
export type ConnectionRpcHandlerResult =
  | {
    readonly ok: true
    readonly value: unknown
    /** Binary fields already projected by the handler that owns the result protocol. */
    readonly attachments?: readonly ConnectionRpcAttachment[]
  }
  | { readonly ok: false; readonly error: ConnectionRpcFailure }

/** Historical short name for a generic Connection result. */
export type RpcResult<T> = ConnectionRpcResult<T>

/**
 * Convert a rejected transport operation into a generic failure result.
 * @param error - rejected transport value.
 * @returns an `internal` failure preserving the available message.
 */
export function transportError<T>(error: unknown): RpcResult<T> {
  return {
    ok: false,
    error: {
      code: 'gateway/internal',
      message: error instanceof Error ? error.message : String(error),
      details: {},
    },
  }
}

/** Narrow request form used by direct fixture adapters. */
export interface RpcRequest<P> {
  readonly rpcId: RpcId
  readonly payload: P
}

/** Narrow response form used by direct fixture adapters. */
export interface RpcResponse<T> {
  readonly rpcId: RpcId
  readonly result: RpcResult<T>
}

/** Full request envelope carried by Connection RPC transports. */
export interface ClientRequest {
  readonly type: 'client-request'
  readonly rpcId: RpcId
  readonly method: string
  readonly payload: unknown
}

/** Full response envelope carried by Connection RPC transports. */
export interface ServerResponse {
  readonly type: 'server-response'
  readonly rpcId: RpcId
  readonly result: ConnectionRpcResult<unknown>
}

/** Complete Connection RPC envelope union. */
export type RpcMessage = ClientRequest | ServerResponse

/** HTTP request facts consumed by browser trust and authentication. */
export interface ConnectionTrustRequest {
  /** Request headers supplied by either the Fetch or node:http representation. */
  readonly headers: Headers | Readonly<Record<string, string | readonly string[] | undefined>>
}

/** HTTP status returned before dispatch, or undefined when the request may proceed. */
export type ConnectionRequestRejection = 401 | 403 | undefined

/** Root/index request facts used by the browser-token exchange. */
export interface ConnectionIndexRequest extends ConnectionTrustRequest {
  readonly method?: string | undefined
  readonly url?: string | undefined
}

/** Root/index response operations owned by the browser-token exchange. */
export interface ConnectionIndexResponse {
  writeHead(status: number, headers?: Readonly<Record<string, string>>): unknown
  end(body?: string): unknown
}

/** Outcome of admitting one request: the Peer it speaks for, or the status refusing it. */
export type PeerAdmission =
  | { readonly peer: PeerScope }
  | { readonly rejection: 401 | 403 }

/** Socket admission claims API ownership until its carrier calls release, including failed upgrades. */
export type ConnectionAdmission =
  | {
    readonly peer: PeerScope
    /** Remove and dispose an API Peer; browser releases leave the shared browser Peer intact. */
    readonly release: () => Promise<void>
  }
  | { readonly rejection: 401 | 403 | 409 }

/**
 * Handler invoked after Connection has decoded the transport envelope.
 * `peer` is the Peer the carrier admitted or the in-process caller supplied.
 */
export type ConnectionRpcHandler = (
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
  peer: PeerScope,
) => Promise<ConnectionRpcHandlerResult>

/** Synchronous ownership test for one endpoint on a shared RPC channel. */
export type ConnectionRpcEndpointMatcher = (endpoint: string) => boolean

/** HTTP methods supported by exact Fetch routes on the shared API channel. */
export type ConnectionFetchMethod = 'GET' | 'HEAD' | 'POST'

/** How the node:http bridge presents one request body to its Fetch route. */
export type ConnectionRequestBodyMode = 'buffered' | 'streaming'

/**
 * The remote-access action and resources a non-owner request to one exact
 * Fetch route is checked against before the route runs.
 */
export interface ConnectionFetchRouteAccess {
  /**
   * Action a policy role must list on every resource: the Remote endpoint the
   * route mirrors, or a route-specific `<namespace>/<name>` that names no
   * Remote endpoint, such as `fileUploads/uploadBinary`. Registration rejects
   * `remoteAccess/follow`, which remote access allows for every principal.
   */
  readonly action: `${string}/${string}`
  /**
   * The query parameter naming each resource the request touches, keyed by
   * resource kind. A non-owner request is refused unless it carries each
   * listed parameter exactly once with a non-empty value. An empty map means
   * the route touches the `global` resource.
   */
  readonly resources: { readonly [Kind in TypertResourceKind]?: string }
}

/** One exact, transport-independent Fetch route owned by a Host feature. */
export interface ConnectionFetchRoute {
  /** Absolute path below `/api`; query parameters remain available on the request URL. */
  readonly path: string
  /** Methods this route owns. Other methods continue through normal shared-channel dispatch. */
  readonly methods: readonly ConnectionFetchMethod[]
  /** Buffered requests obey the configured JSON cap; streaming requests arrive with backpressure and no aggregate cap. */
  readonly requestBody: ConnectionRequestBodyMode
  /**
   * How a non-owner Peer may reach this route. Without it, or without an
   * installed authorizer, the shared handler answers 403 to every non-owner.
   * The route's own `fetch` must read each resource from the same query
   * parameter, so the checked resource is the one it serves.
   */
  readonly access?: ConnectionFetchRouteAccess
  /**
   * Handle one request after the physical carrier has applied its trust and
   * authentication policy: an owner request, or a non-owner request that
   * `access` and the installed authorizer allowed. A non-owner request's
   * signal also aborts once its Peer is disposed.
   */
  readonly fetch: (request: Request) => Promise<Response>
}

/** One non-owner request to an exact Fetch route, with the resources its query names. */
export interface ConnectionFetchAccessRequest {
  /** The admitted Peer's principal; never the owner. */
  readonly principal: Principal
  /** The route's declared `access.action`. */
  readonly action: `${string}/${string}`
  /** Every resource the request touches; never empty. */
  readonly resources: readonly RemoteAccessResource[]
}

/**
 * Decide one non-owner request to an exact Fetch route; called synchronously
 * before the route runs, without call arguments.
 * @param request - the caller's principal, the route's action, and the resources its query names.
 * @returns true only when the principal may take the action on every resource.
 */
export type ConnectionFetchAuthorizer = (request: ConnectionFetchAccessRequest) => boolean

/** Host registry for exact Fetch routes that cannot use JSON Remote invocation. */
export interface HostConnectionFetch {
  /**
   * Register one exact route on the shared API channel.
   * @param route - path, methods, optional non-owner access, and Fetch-shaped implementation.
   * @returns asynchronous disposer removing this exact contribution.
   */
  register(route: ConnectionFetchRoute): () => Promise<void>
  /**
   * Install the one authorizer that decides non-owner requests to routes
   * declaring `access`; a second installation throws, and an authorizer that
   * throws is logged and refuses the request.
   * @param authorizer - synchronous access decision, such as the Gateway's remote-access check.
   * @returns asynchronous disposer removing the authorizer.
   */
  authorize(authorizer: ConnectionFetchAuthorizer): () => Promise<void>
}

/**
 * Admit one trusted request as a non-owner Peer from a credential the
 * authenticator owns, such as a signed proxy header.
 *
 * Connection calls it synchronously after its Host/Origin fence and before
 * browser and API credentials. Returning undefined passes the request on to
 * the next authenticator and then to owner authentication; an authenticator
 * never refuses a request, and one that throws is logged and passed over. The
 * returned Peer must carry a non-owner principal; its creator owns its
 * disposal, and a disposed Peer is refused at dispatch. Of Connection's own
 * routes, only the Gateway and exact Fetch routes that declare `access` serve
 * non-owner Peers; other exact routes, dedicated RPC channels, and routes
 * guarded by `requestRejection` answer them 403. A route that calls
 * {@link HostConnectionHandle.admit} itself decides which principals it serves
 * and must refuse a Peer whose `signal` has aborted.
 * @param request - request headers from the HTTP or upgrade request.
 * @returns the Peer this credential speaks for, or undefined when the request carries none.
 */
export type ConnectionAuthenticator = (request: ConnectionTrustRequest) => PeerScope | undefined

/** Host registry for non-owner authenticators consulted by admission. */
export interface HostConnectionAuthenticators {
  /**
   * Register one authenticator; registration order decides which one answers first.
   * @param authenticator - synchronous credential check returning a non-owner Peer.
   * @returns asynchronous disposer removing this authenticator.
   */
  register(authenticator: ConnectionAuthenticator): () => Promise<void>
}

/** Host registry for logical RPC channels carried by the current transport. */
export interface HostConnectionRpc {
  /**
   * Register one authenticated absolute channel prefix.
   * @param channel - absolute logical channel such as `/rpc`.
   * @param handler - decoded endpoint handler returning the existing RPC result shape.
   * @returns asynchronous disposer removing the channel and its physical route.
   */
  handle(
    channel: string,
    handler: ConnectionRpcHandler,
  ): () => Promise<void>

  /**
   * Intercept owned endpoints on the shared `/api` channel before its fallback.
   * @param channel - reserved shared channel; currently `/api`.
   * @param matches - synchronous endpoint ownership test.
   * @param handler - decoded endpoint handler returning the existing RPC result shape.
   * @returns asynchronous disposer removing the interceptor.
   */
  intercept(
    channel: '/api',
    matches: ConnectionRpcEndpointMatcher,
    handler: ConnectionRpcHandler,
  ): () => Promise<void>
}

/** Host `ctx.connection` members consumed by transport-independent adapters. */
export interface HostConnectionHandle {
  /** Generic RPC channel registry. */
  readonly rpc: HostConnectionRpc
  /** Exact Fetch routes for streaming or browser-native responses. */
  readonly fetch: HostConnectionFetch
  /** Non-owner authenticators consulted before browser and API credentials. */
  readonly authenticators: HostConnectionAuthenticators
  /** The owner Peer every authenticated browser connection shares. */
  readonly browserPeer: PeerScope

  /**
   * Whether this deployment accepts authorities beyond loopback: true only
   * when a validated `trustedHosts` entry names a non-loopback hostname.
   */
  readonly allowsRemoteAuthorities: boolean

  /**
   * Compose exact Fetch routes and the shared-channel RPC interceptor.
   * @param channel - shared channel mounted by Connection.
   * @returns Fetch handler for trusted, authenticated requests.
   */
  createSharedFetchHandler(channel: '/api'): ConnectionFetchHandler

  /**
   * Apply Connection's Host/Origin checks and owner authentication to another
   * Web route. Such routes bypass Gateway access checks, so a request an
   * authenticator admits as a non-owner is refused with 403.
   * @param request - request headers from the HTTP or upgrade request.
   * @returns rejection status, or undefined when the route may accept the request.
   */
  requestRejection(request: ConnectionTrustRequest): ConnectionRequestRejection

  /**
   * Admit an HTTP request: the first registered authenticator that names a
   * Peer wins; otherwise the signed browser or API credential and its live Peer.
   * @param request - request headers from the HTTP or upgrade request.
   * @returns the admitted Peer, or the rejection status.
   */
  admit(request: ConnectionTrustRequest): PeerAdmission

  /**
   * Create an independent in-process Peer, disposed with the Context that read `ctx.connection`.
   * @param options - fixed principal and optional interaction participation (default `answer`).
   * @returns a new Peer distinct from every other Peer.
   */
  createPeer(options: { readonly principal: Principal; readonly interactions?: 'answer' | 'none' }): PeerScope

  /**
   * Claim a physical socket for an API Peer; browser sockets share their owner Peer.
   * @param request - authenticated upgrade request headers.
   * @returns the Peer and idempotent release, or 409 for duplicate API ownership.
   * The carrier releases on socket termination or failed upgrade; release removes
   * API admission synchronously without cancelling independent HTTP calls.
   */
  admitConnection(request: ConnectionTrustRequest): ConnectionAdmission

  /**
   * Authenticate one frontend index request for the owner, owning a token
   * redirect or 401. Authenticators are not consulted, so a route that serves
   * only the owner can rely on a true result. The cookie this mints is
   * `Secure` when the mounted Web carrier serves TLS, which only that
   * listener's protocol decides.
   * @param request - root or configured-index HTTP request.
   * @param response - response owned when the result is false.
   * @returns true only when the frontend may serve index.html to the owner.
   */
  authorizeIndex(request: ConnectionIndexRequest, response: ConnectionIndexResponse): boolean

  /**
   * Admit one frontend index request for any principal: a trusted request a
   * registered authenticator admits renders for that Peer without a cookie;
   * every other request goes through {@link authorizeIndex} and renders for
   * `browserPeer`.
   * @param request - root or configured-index HTTP request.
   * @param response - response owned when the result is undefined.
   * @returns the Peer the index renders for, or undefined when the response was written.
   */
  admitIndex(request: ConnectionIndexRequest, response: ConnectionIndexResponse): PeerScope | undefined

  /**
   * Add the fresh process token to an ordinary Web application URL.
   * @param baseUrl - clean application URL whose authority and mount are preserved.
   * @returns tokenized URL for initial login; a mount proxy strips its prefix before {@link authorizeIndex}.
   */
  authenticatedUrl(baseUrl: string): string
}

/** Transport-independent Fetch handler used by HTTP and worker carriers. */
export interface ConnectionFetchHandler {
  /**
   * Resolve body handling before the bridge reads any request bytes.
   * @param request - request method and URL available from node:http headers.
   * @returns the registered route's body handling mode.
   */
  requestBodyMode(request: { readonly method: string; readonly url: URL }): ConnectionRequestBodyMode

  /**
   * Dispatch one already-authenticated request.
   * @param request - Fetch request below the shared channel.
   * @param peer - Peer to dispatch as; required, never defaulted.
   * @returns the registered response, a 403 response for an exact route that refuses a non-owner Peer, or a 404 response.
   */
  fetch(request: Request, peer: PeerScope): Promise<Response>
}

/** Client caller for logical RPC channels carried by the current transport. */
export interface ClientConnectionRpc {
  /**
   * Call one endpoint through an already registered logical channel.
   * @param channel - absolute logical channel such as `/api`.
   * @param endpoint - channel-relative endpoint such as `goals/create`.
   * @param payload - channel-owned request payload.
   * @param signal - optional caller cancellation.
   * @returns the endpoint-owned success/error result; correlation stays inside Connection.
   */
  call(
    channel: string,
    endpoint: string,
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<ConnectionRpcResult<unknown>>

  /**
   * Open an in-process logical stream when the selected carrier supplies one.
   * Browser transports omit this method; API Gateway owns their WebSocket mux.
   * @param channel - absolute logical channel such as `/api`.
   * @param endpoint - channel-relative endpoint such as `session/follow`.
   * @param payload - channel-owned request payload.
   * @param signal - caller cancellation for this logical stream.
   * @param uplink - Client uplink items the Host method reads through `invocation.uplink()`.
   * @returns decoded stream values from the in-process carrier.
   */
  readonly open?: (
    channel: string,
    endpoint: string,
    payload: unknown,
    signal: AbortSignal,
    uplink?: AsyncIterable<unknown>,
  ) => AsyncIterable<unknown>
}
