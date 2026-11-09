import { Context } from '@deepseek-ai/cordis'
import type { PeerScope, Principal } from '@deepseek-ai/dsh-typert-protocol'
import { describe, expect, it, vi } from 'vitest'
import type { BrowserAuth } from '../src/browser-auth.ts'
import type { ConnectionFetchAccessRequest, ConnectionFetchRoute } from '../src/rpc.ts'
import { HostConnectionService } from '../src/rpc-host.ts'

async function mounted(): Promise<{
  readonly connection: HostConnectionService
  readonly dispose: () => Promise<void>
}> {
  const ctx = new Context()
  const fiber = ctx.plugin((pluginCtx) => {
    new HostConnectionService(pluginCtx, [], {} as BrowserAuth)
  })
  await fiber.await()
  return {
    connection: ctx.get('connection') as HostConnectionService,
    dispose: () => fiber.dispose(),
  }
}

const GUEST: Principal = { kind: 'test-guest', guest: 'connection' }

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    /** Test-only non-owner caller shared by the access specs. */
    'test-guest': { readonly kind: 'test-guest'; readonly guest: string }
  }
}

describe('Connection exact Fetch routes', () => {
  it('dispatches owned methods and returns 404 for unclaimed requests', async () => {
    const { connection, dispose: disposeFiber } = await mounted()
    const route = vi.fn(async (request: Request) =>
      Response.json({ query: new URL(request.url).searchParams.get('sessionId') }))
    const dispose = connection.fetch.register({
      path: '/api/session.export',
      methods: ['GET', 'HEAD', 'POST'],
      requestBody: 'streaming',
      fetch: route,
    })
    const shared = connection.createSharedFetchHandler('/api')

    const response = await shared.fetch(new Request(
      'http://host/api/session.export?sessionId=session-1',
    ), connection.browserPeer)
    expect(shared.requestBodyMode({
      method: 'POST', url: new URL('http://host/api/session.export'),
    })).toBe('streaming')
    expect(shared.requestBodyMode({
      method: 'DELETE', url: new URL('http://host/api/session.export'),
    })).toBe('buffered')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ query: 'session-1' })
    expect(route).toHaveBeenCalledOnce()
    const post = await shared.fetch(new Request('http://host/api/session.export', { method: 'POST' }), connection.browserPeer)
    expect(post.status).toBe(200)
    expect(route).toHaveBeenCalledTimes(2)

    await dispose()
    const withdrawn = await shared.fetch(new Request('http://host/api/session.export'), connection.browserPeer)
    expect(withdrawn.status).toBe(404)
    await disposeFiber()
  })

  it('rejects invalid and duplicate registrations', async () => {
    const { connection, dispose: disposeFiber } = await mounted()
    const fetch = async (): Promise<Response> => new Response()

    expect(() => connection.fetch.register({ path: '/outside', methods: ['GET'], requestBody: 'buffered', fetch }))
      .toThrow('invalid exact Fetch route')
    expect(() => connection.fetch.register({ path: '/api/session.export', methods: [], requestBody: 'buffered', fetch }))
      .toThrow('declares no methods')
    expect(() => connection.fetch.register({
      path: '/api/session.export', methods: ['GET', 'GET'], fetch,
      requestBody: 'buffered',
    })).toThrow('repeats a method')
    const dispose = connection.fetch.register({
      path: '/api/session.export', methods: ['GET'], fetch,
      requestBody: 'buffered',
    })
    expect(() => connection.fetch.register({
      path: '/api/session.export', methods: ['HEAD'], fetch,
      requestBody: 'buffered',
    })).toThrow('already registered')
    await dispose()
    expect(() => connection.fetch.register({
      path: '/api/session.export', methods: ['HEAD'], fetch,
      requestBody: 'buffered',
    })).not.toThrow()
    await disposeFiber()
  })

  it('refuses exact routes to non-owner Peers while the RPC interceptor still receives them', async () => {
    const { connection, dispose: disposeFiber } = await mounted()
    const route = vi.fn(async () => new Response('route'))
    const disposeRoute = connection.fetch.register({
      path: '/api/session.export', methods: ['GET'], requestBody: 'buffered', fetch: route,
    })
    const peers: PeerScope[] = []
    const disposeInterceptor = connection.rpc.intercept('/api', () => true, async (_endpoint, _payload, _signal, peer) => {
      peers.push(peer)
      return { ok: true, value: null }
    })
    const guest = connection.createPeer({ principal: GUEST })
    const shared = connection.createSharedFetchHandler('/api')

    const refused = await shared.fetch(new Request('http://host/api/session.export'), guest)
    expect(refused.status).toBe(403)
    expect(route).not.toHaveBeenCalled()
    expect((await shared.fetch(new Request('http://host/api/session.export'), connection.browserPeer)).status).toBe(200)

    const rpc = await shared.fetch(new Request('http://host/api/goals/get', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'rpc-1', method: 'goals/get', payload: { args: {} } }),
    }), guest)
    expect(rpc.status).toBe(200)
    expect(peers).toEqual([guest])
    await disposeInterceptor()
    await disposeRoute()
    await disposeFiber()
  })
})

describe('Connection exact Fetch route access', () => {
  const SESSION_ACCESS = { action: 'fileUploads/upload', resources: { session: 'sessionId' } } as const

  async function guarded(access: ConnectionFetchRoute['access']): Promise<{
    readonly connection: HostConnectionService
    readonly route: ReturnType<typeof vi.fn<(request: Request) => Promise<Response>>>
    readonly get: (query: string, peer: PeerScope) => Promise<number>
    readonly dispose: () => Promise<void>
  }> {
    const { connection, dispose } = await mounted()
    const route = vi.fn(async (_request: Request) => new Response('served'))
    connection.fetch.register({
      path: '/api/session/uploadFileBinary', methods: ['GET'], requestBody: 'buffered', fetch: route,
      ...access === undefined ? {} : { access },
    })
    const shared = connection.createSharedFetchHandler('/api')
    const get = async (query: string, peer: PeerScope): Promise<number> =>
      (await shared.fetch(new Request(`http://host/api/session/uploadFileBinary${query}`), peer)).status
    return { connection, route, get, dispose }
  }

  it('asks the authorizer with the principal, action, and query resources, and serves only an allowed request', async () => {
    const { connection, route, get, dispose } = await guarded(SESSION_ACCESS)
    const authorizer = vi.fn((request: ConnectionFetchAccessRequest) =>
      request.resources.every(resource => resource.kind === 'session' && resource.id === 'granted'))
    connection.fetch.authorize(authorizer)
    const guest = connection.createPeer({ principal: GUEST })

    expect(await get('?sessionId=granted', guest)).toBe(200)
    expect(authorizer).toHaveBeenLastCalledWith({
      principal: GUEST, action: 'fileUploads/upload', resources: [{ kind: 'session', id: 'granted' }],
    })
    expect(await get('?sessionId=other', guest)).toBe(403)
    expect(route).toHaveBeenCalledOnce()
    await dispose()
  })

  it('refuses a request whose query does not name exactly one non-empty resource without asking the authorizer', async () => {
    const { connection, route, get, dispose } = await guarded(SESSION_ACCESS)
    const authorizer = vi.fn(() => true)
    connection.fetch.authorize(authorizer)
    const guest = connection.createPeer({ principal: GUEST })

    for (const query of ['', '?sessionId=', '?sessionId=granted&sessionId=other', '?session=granted']) {
      expect(await get(query, guest), query).toBe(403)
    }
    expect(authorizer).not.toHaveBeenCalled()
    expect(route).not.toHaveBeenCalled()
    await dispose()
  })

  it('names the global resource for an empty resource map', async () => {
    const { connection, get, dispose } = await guarded({ action: 'mediaReferences/read', resources: {} })
    const authorizer = vi.fn(() => true)
    connection.fetch.authorize(authorizer)

    expect(await get('?path=/tmp/a.png', connection.createPeer({ principal: GUEST }))).toBe(200)
    expect(authorizer).toHaveBeenCalledWith({ principal: GUEST, action: 'mediaReferences/read', resources: [{ kind: 'global' }] })
    await dispose()
  })

  it('serves the owner without asking the authorizer, even with an unresolvable query', async () => {
    const { connection, route, get, dispose } = await guarded(SESSION_ACCESS)
    const authorizer = vi.fn(() => false)
    connection.fetch.authorize(authorizer)

    expect(await get('', connection.browserPeer)).toBe(200)
    expect(authorizer).not.toHaveBeenCalled()
    expect(route).toHaveBeenCalledOnce()
    await dispose()
  })

  it('keeps a route without access, a route without an installed authorizer, and a disposed Peer owner-only', async () => {
    const undeclared = await guarded(undefined)
    const authorizer = vi.fn(() => true)
    undeclared.connection.fetch.authorize(authorizer)
    expect(await undeclared.get('?sessionId=granted', undeclared.connection.createPeer({ principal: GUEST }))).toBe(403)
    expect(authorizer).not.toHaveBeenCalled()
    await undeclared.dispose()

    const declared = await guarded(SESSION_ACCESS)
    const guest = declared.connection.createPeer({ principal: GUEST })
    expect(await declared.get('?sessionId=granted', guest)).toBe(403)
    const removeAuthorizer = declared.connection.fetch.authorize(authorizer)
    await guest.dispose()
    expect(await declared.get('?sessionId=granted', guest)).toBe(403)
    expect(authorizer).not.toHaveBeenCalled()
    await removeAuthorizer()
    expect(await declared.get('?sessionId=granted', declared.connection.createPeer({ principal: GUEST }))).toBe(403)
    expect(declared.route).not.toHaveBeenCalled()
    await declared.dispose()
  })

  it('installs one authorizer at a time and removes it with its registering fiber', async () => {
    const ctx = new Context()
    const provider = ctx.plugin((pluginCtx) => { new HostConnectionService(pluginCtx, [], {} as BrowserAuth) })
    await provider.await()
    const connection = ctx.get('connection') as HostConnectionService
    connection.fetch.register({
      path: '/api/session.markdown', methods: ['GET'], requestBody: 'buffered',
      access: { action: 'sessionLog/markdown', resources: { session: 'sessionId' } },
      fetch: async () => new Response('served'),
    })
    const consumer = ctx.plugin({
      inject: ['connection'],
      apply: (consumerCtx: Context) => { consumerCtx.connection.fetch.authorize(() => true) },
    })
    await consumer.await()
    expect(() => connection.fetch.authorize(() => true)).toThrow('already installed')
    const shared = connection.createSharedFetchHandler('/api')
    const guest = connection.createPeer({ principal: GUEST })
    const markdown = async (): Promise<number> =>
      (await shared.fetch(new Request('http://host/api/session.markdown?sessionId=s1'), guest)).status
    expect(await markdown()).toBe(200)
    await consumer.dispose()
    expect(await markdown()).toBe(403)
    expect(() => connection.fetch.authorize(() => true)).not.toThrow()
    await provider.dispose()
  })
})

describe('Connection in-process Peers', () => {
  it('creates independent Peers that keep their principal and leave with the reading Context', async () => {
    const { connection, dispose } = await mounted()
    const first = connection.createPeer({ principal: GUEST })
    const second = connection.createPeer({ principal: GUEST })
    const owner = connection.createPeer({ principal: { kind: 'owner' } })
    expect(new Set([first.id, second.id, owner.id, connection.browserPeer.id]).size).toBe(4)
    expect(first.principal).toBe(GUEST)
    expect(owner.principal).toEqual({ kind: 'owner' })
    expect(first.ctx).not.toBe(second.ctx)

    const released = vi.fn()
    first.ctx.effect(() => released, 'first Peer registration')
    await first.dispose()
    expect(released).toHaveBeenCalledOnce()
    expect(() => first.ctx.effect(() => () => {})).toThrow()
    // Disposing one Peer leaves the others usable.
    expect(() => second.ctx.effect(() => () => {})()).not.toThrow()

    await dispose()
  })

  it('disposes a created Peer with the plugin that read the Connection', async () => {
    const ctx = new Context()
    const provider = ctx.plugin((pluginCtx) => { new HostConnectionService(pluginCtx, [], {} as BrowserAuth) })
    await provider.await()
    let created: PeerScope | undefined
    const consumer = ctx.plugin({
      inject: ['connection'],
      apply: (consumerCtx: Context) => { created = consumerCtx.connection.createPeer({ principal: GUEST }) },
    })
    await consumer.await()
    const lingering = vi.fn()
    created!.ctx.effect(() => lingering, 'consumer Peer registration')
    await consumer.dispose()
    expect(lingering).toHaveBeenCalledOnce()
    expect(() => created!.ctx.effect(() => () => {})).toThrow()
    await provider.dispose()
  })
})
