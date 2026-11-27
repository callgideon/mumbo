/** Ordered credential verification, independent of Connection's transport and source policy. */
import { Context, Service } from '@deepseek-ai/cordis'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import type { AuthenticationProvider, AuthenticationRegistrationOptions, ConnectionTrustRequest, PeerAdmission } from './rpc.ts'

/** Credential verifier registry whose registrations belong to the calling plugin. */
export class ConnectionAuthentication extends Service {
  /** Verification order: the first entry whose Provider returns a live Peer decides the request. */
  private providers: readonly { readonly provider: AuthenticationProvider }[] = []
  private readonly owner: Context
  private disposed = false

  /** @param ctx - scope owning the credential registry and its lifetime. */
  constructor(ctx: Context) {
    super(ctx, 'connection.authentication')
    this.owner = ctx
    ctx.effect(() => () => {
      this.disposed = true
      this.providers = []
    }, 'client-connection: authentication registry')
  }

  /**
   * Add a credential verifier after the existing registrations, or ahead of them with `precedence: 'first'`.
   * @param provider - verifier owning its credential and Peer selection.
   * @param options - placement among the existing registrations; omitted appends.
   * @returns disposer withdrawing this registration; the calling scope also withdraws it on unload.
   */
  register(provider: AuthenticationProvider, options?: AuthenticationRegistrationOptions): () => Promise<void> {
    return this.ctx.effect(() => {
      if (this.disposed || this.owner.fiber.uid === null) throw new Error('connection: authentication registry is disposed')
      const entry = { provider }
      this.providers = options?.precedence === 'first' ? [entry, ...this.providers] : [...this.providers, entry]
      return () => { this.providers = this.providers.filter(other => other !== entry) }
    }, 'client-connection: authentication provider')
  }

  /**
   * Verify credentials without applying an HTTP response or source policy.
   * @param request - current carrier headers and cancellation facts.
   * @returns the first live Peer, 401 if no provider accepts, or 503 when verification failed without success.
   */
  authenticate(request: ConnectionTrustRequest): PeerAdmission {
    if (this.disposed || this.owner.fiber.uid === null || request.signal?.aborted || request.socket?.destroyed) return { rejection: 401 }
    let failed = false
    for (const entry of this.providers) {
      if (!this.providers.includes(entry)) continue
      let peer: PeerScope | undefined
      try { peer = entry.provider.authenticate(request) } catch (error) {
        this.owner.logger.warn('Connection authentication provider failed', error)
        failed = true
      }
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- verification may reenter and dispose the owner.
      if (this.disposed || this.owner.fiber.uid === null || request.signal?.aborted || request.socket?.destroyed) return { rejection: 401 }
      if (this.providers.includes(entry) && peer !== undefined && !peer.signal.aborted) return { peer }
    }
    return { rejection: failed ? 503 : 401 }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Credential verification shared by Host transports and authentication plugins. */
    'connection.authentication': ConnectionAuthentication
  }
}

declare module './rpc.ts' {
  interface HostConnectionHandle {
    /** Credential verifier sub-service; consumers inject `connection.authentication`. */
    readonly authentication: ConnectionAuthentication
  }
}

export default ConnectionAuthentication
