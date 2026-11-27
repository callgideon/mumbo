/**
 * The member plugin in a real Loader composition: Web carrier, Connection, Gateway, remote access, and the browser
 * upload and Session log routes. A request carrying the edge-signed header reaches Remote methods and those routes
 * as the `edge-member` principal on the Sessions the box stores, lists, or runs, including the terminal controller's
 * methods; a tampered, expired, or missing header is not a member, and a member reaches no settings method, no
 * dedicated RPC channel, no exact Fetch route without declared access, and no Web route or upgrade that does not
 * admit non-owners. A valid member header decides the Peer even beside the owner's cookie.
 */

import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { request as httpRequest } from 'node:http'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { Context, FiberState } from '@deepseek-ai/cordis'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import RemoteAccessService, { type RemoteAccessRole } from '@deepseek-ai/dsh-api-remote-access'
import TerminalController from '@deepseek-ai/dsh-api-terminal-controller'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import FileUploads from '@deepseek-ai/dsh-client-file-upload'
import * as AuthenticationToken from '@deepseek-ai/dsh-host-authentication-token'
import * as FrontendStatic from '@deepseek-ai/dsh-host-frontend-static'
import WebServer, { type WebEntryUrl } from '@deepseek-ai/dsh-host-webserver'
import { SESSION_FORMAT_VERSION, type SessionHeader } from '@deepseek-ai/dsh-session'
import * as SessionLogExport from '@deepseek-ai/dsh-session-log-export'
import { Remote, TypertRemoteService, type Principal } from '@deepseek-ai/dsh-typert-protocol'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket, { type RawData } from 'ws'
import * as EdgeMember from '../src/index.ts'
import { signMemberHeader } from '../src/header.ts'
import { PromptProbe, call, now, provideCredentials, startLoader } from './helpers/composition.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    /** Test-only non-owner caller shared by the access specs. */
    'test-guest': { readonly kind: 'test-guest'; readonly guest: string }
  }
}

const CONFIG = fileURLToPath(new URL('./fixtures/cordis.yml', import.meta.url))
const DIST_INDEX = fileURLToPath(new URL('./fixtures/dist/index.html', import.meta.url))
const KEY = randomBytes(32)
const MEMBER = { kind: 'edge-member', email: 'ann@example.com' } as const

/** Stands in for a settings write. */
class SettingsProbe extends TypertRemoteService {
  constructor(ctx: Context) {
    super(ctx, 'settingsProbe', { namespace: 'settings' })
  }

  @Remote('update')
  update(ns: string, value: string): string {
    return `${ns}=${value}`
  }
}

/** The plugin, market, and permission preset methods that reached a stand-in. */
let managed: string[] = []

/** Stands in for the plugin manager. */
class PluginManagerProbe extends TypertRemoteService {
  constructor(ctx: Context) { super(ctx, 'pluginManagerProbe', { namespace: 'pluginManager' }) }
  @Remote('listBundles') listBundles(): null { managed.push('pluginManager/listBundles'); return null }
  @Remote('setBundleEnabled') setBundleEnabled(): null { managed.push('pluginManager/setBundleEnabled'); return null }
  @Remote('setPluginEnabled') setPluginEnabled(): null { managed.push('pluginManager/setPluginEnabled'); return null }
  @Remote('installBundle') installBundle(): null { managed.push('pluginManager/installBundle'); return null }
  @Remote('removeBundle') removeBundle(): null { managed.push('pluginManager/removeBundle'); return null }
}

/** Stands in for the plugin market. */
class PluginMarketProbe extends TypertRemoteService {
  constructor(ctx: Context) { super(ctx, 'pluginMarketProbe', { namespace: 'pluginMarket' }) }
  @Remote('setIndexes') setIndexes(): null { managed.push('pluginMarket/setIndexes'); return null }
  @Remote('search') search(): null { managed.push('pluginMarket/search'); return null }
}

/** Stands in for the permission preset service. */
class PermissionPresetsProbe extends TypertRemoteService {
  constructor(ctx: Context) { super(ctx, 'permissionPresetsProbe', { namespace: 'permissionPresets' }) }
  @Remote('set') set(): null { managed.push('permissionPresets/set'); return null }
}

let context: Context | undefined
/** The Session list Workspace `w1` holds; a test may commit a new one. */
let workspaceSessions: string[] = []
/** Names of the files the upload route stored. */
let storedFiles: string[] = []

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  managed = []
  vi.unstubAllEnvs()
})

/**
 * Provide the root services and start the fixture's Loader.
 * @param listed - holds the stored-Session listing until it resolves.
 * @returns the Loader and its settlement.
 */
async function start(listed?: Promise<void>): ReturnType<typeof startLoader> {
  vi.stubEnv('MUMBO_MEMBER_KEY', KEY.toString('base64url'))
  vi.stubEnv('MUMBO_TEST_DIST_INDEX', DIST_INDEX)
  workspaceSessions = ['s1', 'blank']
  context = new Context()
  provideCredentials(context)
  // The project Workspace holding two Sessions, and another Workspace members may not follow or start Sessions in.
  context.provide('workspaceRegistry', {
    list: () => [{ id: 'w1', path: '/projects/project', sessionIds: workspaceSessions }, { id: 'w2', path: '/srv/other', sessionIds: [] }],
  } as never)
  // One live subagent child Session that no Workspace lists.
  context.provide('sessions', { list: () => [{ id: 'child' }], get: () => undefined } as never)
  // Every Session id names a stored, empty Session, so only access decides which log is exported.
  const header = (id: string): SessionHeader => ({
    version: SESSION_FORMAT_VERSION, id: id as SessionHeader['id'], createdAt: 1, isSeeded: false, cwd: '/workspace', delegationDepth: 0,
  })
  context.provide('sessionQuery', {
    traceSession: async () => ({ descendants: [] }),
    readSession: async (id: string) => ({ session: header(id), inheritedEventCount: 0, events: [] }),
  } as never)
  // The store lists the Workspace's Sessions and one with no Workspace; stat and open answer every id.
  context.provide('sessionPersistence', {
    list: async () => {
      await listed
      return ['s1', 'blank', 'loose'].map(id => ({ header: header(id) }))
    },
    stat: async (id: string) => ({ header: header(id) }),
    open: async (id: string) => ({
      id, header: header(id), access: 'read', read: async () => ({ eventState: 'detached', events: [] }), close: async () => {},
    }),
  } as never)
  // Every Session id resolves to a live ordinary Agent, so only access decides which upload is stored.
  const agents = new Map<string, object>()
  context.provide('agents', {
    get: (id: string) => {
      if (!agents.has(id)) agents.set(id, { id, session: { header: {} } })
      return agents.get(id)
    },
  } as never)
  storedFiles = []
  context.provide('attachments', {
    // Connection checks its request-body cap against the aggregate image limit.
    imageLimits: { maxMessageImageBytes: 1024 },
    async saveFileStream(input: { readonly data: AsyncIterable<Uint8Array>; readonly name?: string }) {
      let bytes = 0
      for await (const chunk of input.data) bytes += chunk.byteLength
      storedFiles.push(input.name ?? 'file')
      return { attachmentId: 'file-1', name: input.name ?? 'file', bytes }
    },
    readImage: async () => { throw new Error('fixture has no images') },
  } as never)
  context.provide('commands', { registerFileReceiptResolver: () => () => {}, register: () => () => {} } as never)
  const modules = new Map<string, object>([
    ['@deepseek-ai/dsh-typert-registry', TypertRegistry],
    ['@deepseek-ai/dsh-api-remote-access', RemoteAccessService],
    ['@deepseek-ai/dsh-api-gateway', TypertGatewayService],
    ['@deepseek-ai/dsh-host-webserver', WebServer],
    ['@deepseek-ai/dsh-client-connection', Connection],
    ['@deepseek-ai/dsh-host-authentication-token', AuthenticationToken],
    ['@deepseek-ai/dsh-host-frontend-static', FrontendStatic],
    ['@deepseek-ai/dsh-client-file-upload', FileUploads],
    ['@deepseek-ai/dsh-session-log-export', SessionLogExport],
    ['@mumbo/edge-member', EdgeMember],
  ])
  return startLoader(context, CONFIG, modules)
}

/**
 * Boot the fixture and the stand-in Session and settings methods.
 * @param tokenFirst - hold the member plugin's load until the Token Provider has registered, the order a box is
 *   expected to load them in.
 * @returns the Web carrier's origin and the Session method probe.
 */
async function boot(tokenFirst = false): Promise<{ readonly origin: string; readonly probe: PromptProbe }> {
  const listed = Promise.withResolvers<undefined>()
  if (!tokenFirst) listed.resolve(undefined)
  const { loader, settled } = await start(listed.promise)
  // The Token row turns active once its Provider is registered.
  await vi.waitFor(() => {
    expect([...loader.entries()].find(entry => entry.options.id === 'authentication-token')?.fiber?.state).toBe(FiberState.ACTIVE)
  })
  listed.resolve(undefined)
  await settled
  const entries = [...loader.entries()]
  expect(entries.filter(entry => entry.fiber === undefined && !entry.disabled).map(entry => entry.options.id)).toEqual([])
  const ctx = context!
  ctx.typert.resources.register('session', { field: 'sessionId' })
  ctx.typert.resources.register('workspace', { field: 'workspaceId' })
  await ctx.plugin(PromptProbe)
  await ctx.plugin(SettingsProbe)
  const probe = ctx.get('promptProbe') as PromptProbe
  return { origin: `http://127.0.0.1:${String(ctx.webServer.port)}`, probe }
}

/** Exchange the Token plugin's entry URL for the owner's browser cookie over HTTP. */
async function ownerCookie(origin: string): Promise<string> {
  const entries: WebEntryUrl[] = []
  context!.emit(context!.webServer, 'webserver/entry-url', origin, entries)
  const entry = entries[0]
  if (entry === undefined) throw new Error('no entry URL')
  const response = await fetch(entry.url, { redirect: 'manual' })
  const setCookie = response.headers.get('set-cookie')
  if (setCookie === null) throw new Error('no owner cookie')
  return setCookie.split(';', 1)[0]!
}

/** Exchange the Token plugin's launch token at `/connect` for the owner's API cookie, as an API client does. */
async function ownerApiCookie(origin: string): Promise<string> {
  const entries: WebEntryUrl[] = []
  context!.emit(context!.webServer, 'webserver/entry-url', origin, entries)
  const token = new URL(entries[0]!.url).searchParams.get('token')
  const response = await fetch(`${origin}/connect?token=${String(token)}`, { redirect: 'manual' })
  const setCookie = response.headers.get('set-cookie')
  if (setCookie === null) throw new Error('no owner API cookie')
  return setCookie.split(';', 1)[0]!
}

/**
 * Register a dedicated RPC channel and an exact Fetch route that declares no member access.
 * @returns the calls that reached either handler.
 */
function ownerOnlyRoutes(): string[] {
  const reached: string[] = []
  context!.connection.rpc.handle('/owner-rpc', async (endpoint) => {
    reached.push(endpoint)
    return { ok: true, value: null }
  })
  context!.connection.fetch.register({
    path: '/api/owner.only', methods: ['GET'], requestBody: 'buffered',
    fetch: async () => {
      reached.push('owner.only')
      return new Response('served')
    },
  })
  return reached
}

/** POST with the member header sent twice, which node:http forwards as two header lines. */
function callWithRepeatedHeader(origin: string, headers: readonly string[]): Promise<number> {
  const body = JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'session/prompt', payload: { args: { request: { sessionId: 's1', text: 'hi' } } } })
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(`${origin}/api/session/prompt`, { method: 'POST' }, (response) => {
      response.resume()
      resolve(response.statusCode ?? 0)
    })
    outgoing.setHeader('content-type', 'application/json')
    outgoing.setHeader('x-mumbo-member', [...headers])
    outgoing.on('error', reject)
    outgoing.end(body)
  })
}

/**
 * Send one GET with exactly these headers, Host included, as an upgrade request when `upgrade` names a protocol.
 * @returns the response status and body; a switched protocol answers 101 with an empty body.
 */
function raw(origin: string, path: string, headers: Record<string, string>, upgrade?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(`${origin}${path}`, { headers: { ...headers, ...upgrade === undefined ? {} : { connection: 'Upgrade', upgrade } } })
    outgoing.on('response', (response) => {
      let body = ''
      response.setEncoding('utf8').on('data', (chunk: string) => { body += chunk })
      response.on('end', () => { resolve({ status: response.statusCode ?? 0, body }) })
    })
    outgoing.on('upgrade', (response, socket) => {
      socket.destroy()
      resolve({ status: response.statusCode ?? 0, body: '' })
    })
    outgoing.on('error', reject)
    outgoing.end()
  })
}

/** Dispose and load one fixture row again, which registers its Provider anew, after every Provider still registered. */
async function reload(id: string): Promise<void> {
  const entry = [...context!.loader.entries()].find(item => item.options.id === id)
  if (entry?.fiber === undefined) throw new Error(`no loaded row ${id}`)
  await entry.fiber.restart()
  await context!.loader.await()
  expect(entry.fiber.state, id).toBe(FiberState.ACTIVE)
}

/** @returns a header the edge signed for the member, valid for five minutes. */
const signed = (): string => signMemberHeader(KEY, MEMBER.email, now() + 300)

describe('real Loader composition', () => {
  it('admits a signed member and records the member as the caller of a prompt', { timeout: 60_000 }, async () => {
    const { origin, probe } = await boot()
    const header = signMemberHeader(KEY, 'ann@example.com', now() + 300)
    const answer = await call(origin, 'session/prompt', { request: { sessionId: 's1', text: 'hi' } }, header)
    expect(answer).toEqual({ status: 200, body: { type: 'server-response', rpcId: 'r1', result: { ok: true, value: 'queued' } } })
    expect(probe.callers).toEqual([{ kind: 'edge-member', email: 'ann@example.com' }])
  })

  it('lets a member upload through the browser binary route to a granted Session only', { timeout: 60_000 }, async () => {
    const { origin } = await boot()
    const header = signMemberHeader(KEY, 'ann@example.com', now() + 300)
    const upload = (sessionId: string, name: string) => fetch(
      `${origin}/api/session/uploadFileBinary?sessionId=${sessionId}&name=${name}`,
      { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-mumbo-member': header }, body: Uint8Array.of(1, 2, 3) },
    )
    const granted = await upload('s1', 'notes.txt')
    expect(await granted.json()).toMatchObject({ ok: true, value: { file: { name: 'notes.txt', bytes: 3 } } })
    const ungranted = await upload('s2', 'elsewhere.txt')
    expect(ungranted.status).toBe(403)
    expect(storedFiles).toEqual(['notes.txt'])
  })

  it('refuses the binary upload route to a principal that holds only the encoded upload action', { timeout: 60_000 }, async () => {
    await boot()
    const encodedOnly: RemoteAccessRole<'session'> = { name: 'test:encoded-upload', resource: 'session', actions: ['fileUploads/upload'] }
    context!.remoteAccess.registerPolicy('test-guest', { bindings: () => [{ role: encodedOnly, resource: { kind: 'session', id: 's1' as SessionHeader['id'] } }] })
    const guest = context!.connection.createPeer({ principal: { kind: 'test-guest', guest: 'viewer' } })
    const response = await context!.connection.createSharedFetchHandler('/api').fetch(new Request(
      'http://127.0.0.1/api/session/uploadFileBinary?sessionId=s1&name=viewer.bin',
      { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: Uint8Array.of(1) },
    ), guest)
    expect(response.status).toBe(403)
    expect(storedFiles).toEqual([])
  })

  it('lets a member download and copy only a granted Session log, by GET and HEAD', { timeout: 60_000 }, async () => {
    const { origin } = await boot()
    const header = signMemberHeader(KEY, 'ann@example.com', now() + 300)
    const request = (route: string, sessionId: string, method = 'GET') =>
      fetch(`${origin}/api/${route}?sessionId=${sessionId}&includeDescendants=true`, { method, headers: { 'x-mumbo-member': header } })
    const archive = await request('session.export', 's1')
    expect(archive.headers.get('content-type')).toBe('application/zip')
    expect((await archive.arrayBuffer()).byteLength).toBeGreaterThan(0)
    const markdown = await request('session.markdown', 's1')
    expect(markdown.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
    await markdown.text()
    const head = await request('session.export', 's1', 'HEAD')
    expect(head.status).toBe(200)
    for (const [route, method] of [['session.export', 'GET'], ['session.markdown', 'GET'], ['session.markdown', 'HEAD']] as const) {
      expect((await request(route, 's2', method)).status, `${method} ${route}`).toBe(403)
    }
  })

  it('refuses a member a Session the box neither stores nor runs, and every settings method', { timeout: 60_000 }, async () => {
    const { origin, probe } = await boot()
    const header = signMemberHeader(KEY, 'ann@example.com', now() + 300)
    const elsewhere = await call(origin, 'session/prompt', { request: { sessionId: 's2', text: 'hi' } }, header)
    expect(elsewhere.body).toMatchObject({ result: { ok: false, error: { code: 'remote-access/denied' } } })
    const settings = await call(origin, 'settings/update', { ns: 'llm', value: 'x' }, header)
    expect(settings.body).toMatchObject({ result: { ok: false, error: { code: 'remote-access/denied' } } })
    expect(probe.callers).toEqual([])
  })

  it('refuses a member every plugin, plugin market, permission preset, and settings action, and serves the owner', { timeout: 60_000 }, async () => {
    const { origin } = await boot()
    for (const probe of [PluginManagerProbe, PluginMarketProbe, PermissionPresetsProbe]) await context!.plugin(probe)
    const actions = [
      'pluginManager/listBundles', 'pluginManager/setBundleEnabled', 'pluginManager/setPluginEnabled', 'pluginManager/installBundle',
      'pluginManager/removeBundle', 'pluginMarket/setIndexes', 'pluginMarket/search', 'permissionPresets/set', 'settings/update',
    ]
    const header = signMemberHeader(KEY, 'ann@example.com', now() + 300)
    for (const action of actions) {
      const answer = await call(origin, action, action === 'settings/update' ? { ns: 'llm', value: 'x' } : {}, header)
      expect(answer.body, action).toMatchObject({ result: { ok: false, error: { code: 'remote-access/denied' } } })
    }
    expect(managed).toEqual([])
    const cookie = await ownerCookie(origin)
    for (const action of actions.filter(action => action !== 'settings/update')) {
      expect((await call(origin, action, {}, undefined, { cookie })).body, action).toMatchObject({ result: { ok: true } })
    }
    expect(managed).toEqual(actions.filter(action => action !== 'settings/update'))
    // No member role lists an action of these services, whatever methods they have.
    const roles = [EdgeMember.MEMBER_GLOBAL_ROLE, EdgeMember.MEMBER_SESSION_ROLE, EdgeMember.MEMBER_WORKSPACE_ROLE]
    const listed = roles.flatMap(role => [...role.actions])
    expect(listed.filter(action => /^(?:pluginManager|pluginMarket|permissionPresets|settings)\//u.test(action))).toEqual([])
  })

  it('lets a member open, attach to, and type into a terminal on a Session they reach and refuses one on a Session they do not', { timeout: 60_000 }, async () => {
    const { origin } = await boot()
    const ctx = context!
    // The Session's execution providers: a shell that runs until the controller ends it.
    const spawned: string[] = []
    const typed: string[] = []
    ctx.provide('subprocess', {
      terminalEnvironment: async () => ({ platform: 'posix', defaultShell: '/bin/bash' }),
      resolveExecutable: async (path: string) => path,
      spawnTerminal: async (spec: { readonly env: { readonly DSH_SESSION_ID: string } }) => {
        spawned.push(spec.env.DSH_SESSION_ID)
        const output = new PassThrough()
        const done = Promise.withResolvers<{ exitCode: number; signal: null }>()
        return {
          pid: 1, output, done: done.promise, write: async (data: string) => { typed.push(data) }, resize: async () => {},
          inspectActivity: async () => ({ state: 'unknown', revision: 0 }), inspectForeground: async () => undefined,
          signalForeground: async () => 1, terminate: async () => { output.end(); done.resolve({ exitCode: 0, signal: null }) },
        }
      },
    } as never)
    ctx.provide('sandboxPolicy', {} as never)
    ctx.provide('workingDirectory', { get: () => '/projects/project', ensure: async () => '/projects/project' } as never)
    // The Agent lookup the Agent registry registers: every Session id resolves to an Agent running on this context.
    ctx.typert.lookups.register('agent', {
      parameter: 'agent', wire: 'agentId', resource: 'session',
      hostTypeSymbol: '@deepseek-ai/dsh-agent#Agent', wireTypeSymbol: '@deepseek-ai/dsh-session/types#SessionId',
      resolve: (id: string) => ({ id, ctx, session: { id, header: {} } }),
    } as never)
    await ctx.plugin(TerminalController)
    const header = signMemberHeader(KEY, 'ann@example.com', now() + 300)
    const request = (agentId: string) => ({ agentId, request: { id: `t-${agentId}`, cols: 80, rows: 24 } })
    const environment = await call(origin, 'terminal/environment', { agentId: 's1' }, header)
    expect(environment.body).toMatchObject({ result: { ok: true, value: { cwd: '/projects/project' } } })
    const opened = await call(origin, 'terminal/create', request('s1'), header)
    expect(opened.body).toMatchObject({ result: { ok: true, value: { id: 't-s1', state: 'running', shell: { path: '/bin/bash' } } } })
    for (const [method, args] of [['terminal/environment', { agentId: 's2' }], ['terminal/create', request('s2')]] as const) {
      const refused = await call(origin, method, args, header)
      expect(refused.body, method).toMatchObject({
        result: { ok: false, error: { code: 'remote-access/denied', details: { action: method, reason: 'no-allow' } } },
      })
    }
    expect(spawned).toEqual(['s1'])
    // The Terminal tab retains and attaches over the WebSocket mux, then sends keyboard input on the attach uplink.
    const socket = new WebSocket(`${origin.replace(/^http/u, 'ws')}/api/remote.mux`, { headers: { 'x-mumbo-member': header } })
    type Frame = { readonly type: string; readonly streamId: string; readonly value?: unknown; readonly error?: unknown }
    const frames: Frame[] = []
    socket.on('message', (data: RawData) => { frames.push(JSON.parse((data as Buffer).toString('utf8')) as Frame) })
    await once(socket, 'open')
    const send = (message: object): void => { socket.send(JSON.stringify(message)) }
    const streams = (sessionId: string) => [
      ['retain', { sessionId, id: `t-${sessionId}` }],
      ['attach', { agentId: sessionId, id: `t-${sessionId}` }],
    ] as const
    for (const sessionId of ['s1', 's2']) {
      for (const [method, args] of streams(sessionId)) send({ type: 'open', streamId: `${method}-${sessionId}`, endpoint: `terminal/${method}`, payload: { args } })
    }
    send({ type: 'item', streamId: 'attach-s1', value: { type: 'write', sequence: 1, data: 'id\r' } })
    await vi.waitFor(() => {
      expect(frames).toContainEqual({ type: 'item', streamId: 'attach-s1', value: { type: 'ack', sequence: 1 } })
      expect(frames.filter(frame => frame.type === 'error')).toHaveLength(2)
    })
    socket.close()
    expect(typed).toEqual(['id\r'])
    const first = (streamId: string) => frames.find(frame => frame.streamId === streamId)
    expect(first('retain-s1')).toEqual({ type: 'item', streamId: 'retain-s1', value: { type: 'retained' } })
    expect(first('attach-s1')).toMatchObject({ type: 'item', value: { type: 'snapshot', writable: true, info: { id: 't-s1' } } })
    for (const [method] of streams('s2')) {
      expect(first(`${method}-s2`), method).toMatchObject({
        type: 'error', error: { code: 'remote-access/denied', details: { action: `terminal/${method}`, reason: 'no-allow' } },
      })
    }
  })

  it('reuses a listed blank Session, prompts a live child Session, and refuses queue edits', { timeout: 60_000 }, async () => {
    const { origin, probe } = await boot()
    const header = signMemberHeader(KEY, 'ann@example.com', now() + 300)
    const reused = await call(origin, 'session/create', { request: { workspaceId: 'w1', sessionId: 'blank' } }, header)
    expect(reused.body).toMatchObject({ result: { ok: true, value: 'blank' } })
    const fresh = await call(origin, 'session/create', { request: { workspaceId: 'w1' } }, header)
    expect(fresh.body).toMatchObject({ result: { ok: true, value: 'new' } })
    const child = await call(origin, 'session/prompt', { request: { sessionId: 'child', text: 'hi' } }, header)
    expect(child.body).toMatchObject({ result: { ok: true } })
    const edit = await call(origin, 'session/updateQueue', { request: { sessionId: 's1' } }, header)
    expect(edit.body).toMatchObject({ result: { ok: false, error: { code: 'remote-access/denied' } } })
    expect(probe.callers).toHaveLength(3)
  })

  it('snapshots the member grants on the project Workspace and every stored, listed, and live Session', { timeout: 60_000 }, async () => {
    await boot()
    const snapshot = context!.remoteAccess.snapshotFor({ kind: 'edge-member', email: 'ann@example.com' })
    expect(snapshot).toMatchObject({ type: 'baseline', owner: false })
    const resources = 'grants' in snapshot ? snapshot.grants.map(grant => grant.resource) : []
    expect(resources).toEqual(expect.arrayContaining([
      { kind: 'global' },
      { kind: 'workspace', id: 'w1' },
      { kind: 'session', id: 's1' },
      { kind: 'session', id: 'blank' },
      { kind: 'session', id: 'loose' },
      { kind: 'session', id: 'child' },
    ]))
    expect(resources).not.toContainEqual({ kind: 'workspace', id: 'w2' })
    const s1 = 'grants' in snapshot ? snapshot.grants.find(grant => grant.resource.kind === 'session' && grant.resource.id === 's1') : undefined
    expect(s1?.actions).toEqual(expect.arrayContaining([
      'session/prompt', 'fileUploads/upload', 'fileUploads/uploadBinary', 'sessionLog/export', 'sessionLog/markdown',
    ]))
    expect(s1?.actions.filter(action => action.startsWith('terminal/')).toSorted()).toEqual([
      'terminal/attach', 'terminal/close', 'terminal/create', 'terminal/environment',
      'terminal/list', 'terminal/rename', 'terminal/retain', 'terminal/shells',
    ])
    expect(s1?.actions).not.toContain('session/updateQueue')
    const global = 'grants' in snapshot ? snapshot.grants.find(grant => grant.resource.kind === 'global') : undefined
    expect(global?.actions).not.toContain('hostFiles/readAny')
    // Members read no file contents, so Office previews are withheld too.
    const granted = 'grants' in snapshot ? snapshot.grants.flatMap(grant => grant.actions) : []
    expect(granted.filter(action => action.startsWith('officeKit/'))).toEqual([])
  })

  it('registers the member policy only after the stored Sessions are listed', { timeout: 60_000 }, async () => {
    const listed = Promise.withResolvers<undefined>()
    const { loader, settled } = await start(listed.promise)
    const entry = () => [...loader.entries()].find(item => item.options.id === 'mumbo-edge-member')
    const sessionsOf = () => {
      const snapshot = context!.remoteAccess.snapshotFor(MEMBER)
      return 'grants' in snapshot ? snapshot.grants.flatMap(grant => grant.resource.kind === 'session' ? [grant.resource.id] : []) : []
    }
    await vi.waitFor(() => { expect(entry()?.fiber?.state).toBe(FiberState.LOADING) })
    for (let turn = 0; turn < 5; turn += 1) await new Promise(resolve => setImmediate(resolve))
    expect(entry()?.fiber?.state).toBe(FiberState.LOADING)
    expect(context!.remoteAccess.snapshotFor(MEMBER)).toEqual({ type: 'baseline', owner: false, grants: [] })
    listed.resolve(undefined)
    await settled
    expect(entry()?.fiber?.state).toBe(FiberState.ACTIVE)
    expect(sessionsOf()).toContain('loose')
  })

  it('rebuilds member grants after a Workspace change has committed', { timeout: 60_000 }, async () => {
    await boot()
    const member = { kind: 'edge-member', email: 'ann@example.com' } as const
    const sessionsOf = () => {
      const snapshot = context!.remoteAccess.snapshotFor(member)
      return 'grants' in snapshot ? snapshot.grants.flatMap(grant => grant.resource.kind === 'session' ? [grant.resource.id] : []) : []
    }
    expect(sessionsOf()).not.toContain('fresh')
    // Another domain's change keeps the grants already built.
    workspaceSessions = [...workspaceSessions, 'fresh']
    context!.emit('domain/changed', { domain: 'settings', table: '', key: '', operation: 'put', value: {} })
    await new Promise(resolve => setImmediate(resolve))
    expect(sessionsOf()).not.toContain('fresh')
    workspaceSessions = workspaceSessions.filter(id => id !== 'fresh')
    // The registry emits the change before its entity holds the new list, which it commits a microtask later.
    context!.emit('domain/changed', { domain: 'workspace', table: 'workspaces', key: 'w1', operation: 'put', value: {} })
    queueMicrotask(() => { workspaceSessions = [...workspaceSessions, 'fresh'] })
    expect(sessionsOf()).not.toContain('fresh')
    await new Promise(resolve => setImmediate(resolve))
    expect(sessionsOf()).toContain('fresh')
  })

  it('lets an owner cookie through when the member header is invalid, and refuses a repeated header', { timeout: 60_000 }, async () => {
    const { origin, probe } = await boot()
    const cookie = await ownerCookie(origin)
    const expired = signMemberHeader(KEY, 'ann@example.com', now() - 1)
    const owner = await call(origin, 'session/prompt', { request: { sessionId: 's2', text: 'hi' } }, expired, { cookie })
    expect(owner.body).toMatchObject({ result: { ok: true } })
    expect(probe.callers).toEqual([undefined])
    const valid = signMemberHeader(KEY, 'ann@example.com', now() + 300)
    await expect(callWithRepeatedHeader(origin, [valid, valid])).resolves.toBe(401)
    expect(probe.callers).toEqual([undefined])
  })

  it('refuses a member on a dedicated RPC channel and serves the owner', { timeout: 60_000 }, async () => {
    const { origin } = await boot()
    const reached = ownerOnlyRoutes()
    const post = (headers: Record<string, string>) => fetch(`${origin}/owner-rpc/probe/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'probe/run', payload: {} }),
    })
    const member = await post({ 'x-mumbo-member': signMemberHeader(KEY, 'ann@example.com', now() + 300) })
    expect({ status: member.status, body: await member.text() }).toEqual({ status: 403, body: 'forbidden' })
    expect(reached).toEqual([])
    const owner = await post({ cookie: await ownerCookie(origin) })
    expect(await owner.json()).toMatchObject({ result: { ok: true, value: null } })
    expect(reached).toEqual(['probe/run'])
  })

  it('answers a member on a dedicated RPC channel from the Web carrier\'s admission, before the channel\'s own owner check', { timeout: 60_000 }, async () => {
    const { origin } = await boot()
    ownerOnlyRoutes()
    const member = await fetch(`${origin}/owner-rpc/probe/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mumbo-member': signed() },
      body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'probe/run', payload: {} }),
    })
    // Only the carrier's admission refusal is marked non-cacheable; the channel's own refusal carries no such header.
    expect({ status: member.status, cache: member.headers.get('cache-control') }).toEqual({ status: 403, cache: 'no-store' })
  })

  it('refuses a member on an exact Fetch route that declares no access and serves the owner', { timeout: 60_000 }, async () => {
    const { origin } = await boot()
    const reached = ownerOnlyRoutes()
    const member = await fetch(`${origin}/api/owner.only`, { headers: { 'x-mumbo-member': signMemberHeader(KEY, 'ann@example.com', now() + 300) } })
    expect({ status: member.status, body: await member.text() }).toEqual({ status: 403, body: 'forbidden' })
    expect(reached).toEqual([])
    const owner = await fetch(`${origin}/api/owner.only`, { headers: { cookie: await ownerCookie(origin) } })
    expect(await owner.text()).toBe('served')
    expect(reached).toEqual(['owner.only'])
  })

  it('admits no member Peer for an expired or badly signed header', { timeout: 60_000 }, async () => {
    await boot()
    const admit = (header: string) => context!.connection.admit({ headers: { host: '127.0.0.1', 'x-mumbo-member': header } })
    expect(admit(signMemberHeader(KEY, 'ann@example.com', now() - 1))).toEqual({ rejection: 401 })
    expect(admit(signMemberHeader(randomBytes(32), 'ann@example.com', now() + 300))).toEqual({ rejection: 401 })
    const admitted = admit(signMemberHeader(KEY, 'ann@example.com', now() + 300))
    expect('peer' in admitted ? admitted.peer.principal : admitted).toEqual(MEMBER)
  })

  it('withdraws the authentication Provider with the plugin and keeps the Peer it admitted disposed', { timeout: 60_000 }, async () => {
    const { loader, settled } = await start()
    await settled
    const request = { headers: { host: '127.0.0.1', 'x-mumbo-member': signMemberHeader(KEY, 'ann@example.com', now() + 300) } }
    const admitted = context!.connection.admit(request)
    if (!('peer' in admitted)) throw new Error('member was not admitted')
    await [...loader.entries()].find(entry => entry.options.id === 'mumbo-edge-member')!.fiber!.dispose()
    expect(admitted.peer.signal.aborted).toBe(true)
    expect(context!.connection.admit(request)).toEqual({ rejection: 401 })
  })

  it('reads the member header from Fetch headers too, and refuses a repeated one there', { timeout: 60_000 }, async () => {
    await boot()
    const valid = signMemberHeader(KEY, 'ann@example.com', now() + 300)
    const headers = (...members: string[]): Headers => {
      const result = new Headers({ host: '127.0.0.1' })
      for (const member of members) result.append('x-mumbo-member', member)
      return result
    }
    const admitted = context!.connection.admit({ headers: headers(valid) })
    expect('peer' in admitted ? admitted.peer.principal : admitted).toEqual({ kind: 'edge-member', email: 'ann@example.com' })
    expect(context!.connection.admit({ headers: headers(valid, valid) })).toEqual({ rejection: 401 })
    expect(context!.connection.admit({ headers: headers() })).toEqual({ rejection: 401 })
  })

  it('does not admit a tampered, expired, too-distant, foreign-key, or missing header', { timeout: 60_000 }, async () => {
    const { origin, probe } = await boot()
    const valid = signMemberHeader(KEY, 'ann@example.com', now() + 300)
    const [email, expiry, mac] = valid.split('.') as [string, string, string]
    for (const header of [
      `${Buffer.from('bo@example.com').toString('base64url')}.${expiry}.${mac}`,
      signMemberHeader(KEY, 'ann@example.com', now() - 1),
      signMemberHeader(KEY, 'ann@example.com', now() + 3600),
      signMemberHeader(randomBytes(32), 'ann@example.com', now() + 300),
      `${email}.${expiry}`,
      undefined,
    ]) {
      const answer = await call(origin, 'session/prompt', { request: { sessionId: 's1', text: 'hi' } }, header)
      expect(answer, String(header)).toEqual({ status: 401, body: 'unauthorized' })
    }
    expect(probe.callers).toEqual([])
  })
})

describe('member admission beside the owner credential, and Web routes that admit no non-owner', () => {
  it('admits a valid member header beside the owner cookie as the member on a Remote call, the index, and the mux upgrade, also after either Provider reloads', { timeout: 60_000 }, async () => {
    const { origin, probe } = await boot(true)
    const cookie = await ownerCookie(origin)
    const pages: Principal[] = []
    const upgrades: (Principal | undefined)[] = []
    context!.on('webserver/index-inject', (_table, peer) => { pages.push(peer.principal) })
    context!.on('webserver/upgrade', async (_request, _socket, _head, peer, next) => {
      upgrades.push(peer?.principal)
      await next()
    })
    /** The principal each carrier admitted for one request carrying both credentials. */
    const admitted = async () => {
      probe.callers.length = 0
      pages.length = 0
      upgrades.length = 0
      await call(origin, 'session/prompt', { request: { sessionId: 's1', text: 'hi' } }, signed(), { cookie })
      const index = await fetch(`${origin}/`, { headers: { cookie, 'x-mumbo-member': signed() } })
      const page = await index.text()
      const socket = new WebSocket(`${origin.replace(/^http/u, 'ws')}/api/remote.mux`, { headers: { cookie, 'x-mumbo-member': signed() } })
      await once(socket, 'open')
      socket.close()
      await once(socket, 'close')
      const pageSpeaksForOwner = /"owner":(true|false)/u.exec(page)?.[1]
      return { call: [...probe.callers], index: [...pages], upgrade: [...upgrades], pageSpeaksForOwner }
    }
    const asMember = { call: [MEMBER], index: [MEMBER], upgrade: [MEMBER], pageSpeaksForOwner: 'false' }
    // The member Provider registered after the Token Provider, and is still asked first.
    expect(await admitted(), 'as loaded').toEqual(asMember)

    await reload('authentication-token')
    // The reloaded Token Provider is registered again: the cookie alone is still the owner's.
    const owner = await call(origin, 'session/prompt', { request: { sessionId: 's2', text: 'hi' } }, undefined, { cookie })
    expect(owner.body).toMatchObject({ result: { ok: true } })
    expect(await admitted(), 'after the Token row reloaded').toEqual(asMember)

    await reload('mumbo-edge-member')
    expect(await admitted(), 'after the member row reloaded').toEqual(asMember)
  })

  it('admits a valid member header beside the owner\'s Token API cookie as the member on a Remote call and the mux upgrade', { timeout: 60_000 }, async () => {
    const { origin, probe } = await boot(true)
    const cookie = await ownerApiCookie(origin)
    const upgrades: (Principal | undefined)[] = []
    context!.on('webserver/upgrade', async (_request, _socket, _head, peer, next) => {
      upgrades.push(peer?.principal)
      await next()
    })
    // The API cookie alone is the owner's.
    const owner = await call(origin, 'session/prompt', { request: { sessionId: 's2', text: 'hi' } }, undefined, { cookie })
    expect(owner.body).toMatchObject({ result: { ok: true } })
    await call(origin, 'session/prompt', { request: { sessionId: 's1', text: 'hi' } }, signed(), { cookie })
    expect(probe.callers).toEqual([undefined, MEMBER])
    const socket = new WebSocket(`${origin.replace(/^http/u, 'ws')}/api/remote.mux`, { headers: { cookie, 'x-mumbo-member': signed() } })
    await once(socket, 'open')
    socket.close()
    await once(socket, 'close')
    expect(upgrades).toEqual([MEMBER])
  })

  it('refuses a member header on an untrusted Host, on the index, a Remote call path, and the mux upgrade', { timeout: 60_000 }, async () => {
    const { origin } = await boot()
    const host = new URL(origin).host
    for (const [path, upgrade, served] of [['/', undefined, 200], ['/api/session/page', undefined, 404], ['/api/remote.mux', 'websocket', 400]] as const) {
      const refused = await raw(origin, path, { host: 'evil.example', 'x-mumbo-member': signed() }, upgrade)
      expect(refused, path).toEqual({ status: 403, body: 'forbidden' })
      // The same request on the listener's own authority passes the source policy and reaches its route.
      expect((await raw(origin, path, { host, 'x-mumbo-member': signed() }, upgrade)).status, path).toBe(served)
    }
  })

  it('answers 401 on the index, a Remote call, and the mux upgrade to an expired or badly signed member header with no other credential', { timeout: 60_000 }, async () => {
    const { origin } = await boot()
    const host = new URL(origin).host
    for (const header of [signMemberHeader(KEY, MEMBER.email, now() - 1), signMemberHeader(randomBytes(32), MEMBER.email, now() + 300)]) {
      expect(await raw(origin, '/', { host, 'x-mumbo-member': header })).toEqual({ status: 401, body: 'unauthorized' })
      expect(await raw(origin, '/api/remote.mux', { host, 'x-mumbo-member': header }, 'websocket')).toEqual({ status: 401, body: 'unauthorized' })
      expect(await call(origin, 'session/prompt', { request: { sessionId: 's1', text: 'hi' } }, header)).toEqual({ status: 401, body: 'unauthorized' })
    }
  })

  it('renders the index a member receives for the member Peer, and the owner\'s for the owner', { timeout: 60_000 }, async () => {
    const { origin } = await boot()
    const pages: Principal[] = []
    context!.on('webserver/index-inject', (_table, peer) => { pages.push(peer.principal) })
    /** The remote access snapshot the served page opens with. */
    const snapshot = async (headers: Record<string, string>) => {
      const response = await fetch(`${origin}/`, { headers })
      expect(response.status).toBe(200)
      const state = /<script>globalThis\["__DSH_REMOTE_ACCESS__"\] = (.*?)<\/script>/u.exec(await response.text())?.[1]
      return JSON.parse(state ?? 'null') as { owner: boolean; grants?: { resource: { kind: string; id?: string } }[] }
    }
    const member = await snapshot({ 'x-mumbo-member': signed() })
    expect(member.owner).toBe(false)
    // The member's own grants, which name the Sessions the box stores and no other Workspace.
    expect(member.grants?.map(grant => grant.resource)).toEqual(expect.arrayContaining([{ kind: 'session', id: 's1' }, { kind: 'workspace', id: 'w1' }]))
    expect(member.grants?.map(grant => grant.resource)).not.toContainEqual({ kind: 'workspace', id: 'w2' })
    expect((await snapshot({ cookie: await ownerCookie(origin) })).owner).toBe(true)
    expect(pages).toEqual([MEMBER, { kind: 'owner' }])
  })

  it('refuses a member on a Web route that serves bytes and on an upgrade route when neither admits non-owners, and serves the owner', { timeout: 60_000 }, async () => {
    const { origin } = await boot()
    const host = new URL(origin).host
    const reached: string[] = []
    // The test registers these routes because no shipped route isolates the Web carrier's check: open-in-app checks the
    // owner itself, and attachments and previews use the exact route /api/file. They are registered as an upstream
    // plugin registers a protected route: `required` by default, no `access`, no check of its own.
    context!.webServer.register({
      kind: 'prefix', path: '/attachment-bytes',
      handler: (_request, response) => {
        reached.push('bytes')
        response.end('bytes')
      },
    })
    context!.webServer.registerUpgrade({
      path: '/other.socket',
      handler: (_request, socket) => {
        reached.push('socket')
        socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: probe\r\n\r\n')
      },
    })
    expect(await raw(origin, '/attachment-bytes/a.png', { host, 'x-mumbo-member': signed() })).toEqual({ status: 403, body: 'forbidden' })
    expect(await raw(origin, '/other.socket', { host, 'x-mumbo-member': signed() }, 'probe')).toEqual({ status: 403, body: 'forbidden' })
    expect(managed).toEqual([])
    const cookie = await ownerCookie(origin)
    expect(await raw(origin, '/attachment-bytes/a.png', { host, cookie })).toEqual({ status: 200, body: 'bytes' })
    expect(await raw(origin, '/other.socket', { host, cookie }, 'probe')).toEqual({ status: 101, body: '' })
    expect(reached).toEqual(['bytes', 'socket'])
  })

  it('serves a member the client\'s first load: the index, an asset, a Remote call, and the mux', { timeout: 60_000 }, async () => {
    const { origin, probe } = await boot()
    const headers = { 'x-mumbo-member': signed() }
    const index = await fetch(`${origin}/`, { headers })
    expect({ status: index.status, type: index.headers.get('content-type') }).toEqual({ status: 200, type: 'text/html; charset=utf-8' })
    await index.text()
    const asset = await fetch(`${origin}/app.js`, { headers })
    expect({ status: asset.status, body: await asset.text() }).toEqual({ status: 200, body: 'globalThis.fixtureAsset = true\n' })
    const page = await call(origin, 'session/page', { request: { sessionId: 's1' } }, signed())
    expect(page.body).toMatchObject({ result: { ok: true, value: 'page of s1' } })
    expect(probe.callers).toEqual([MEMBER])
    const socket = new WebSocket(`${origin.replace(/^http/u, 'ws')}/api/remote.mux`, { headers })
    await once(socket, 'open')
    socket.close()
    await once(socket, 'close')
  })
})
