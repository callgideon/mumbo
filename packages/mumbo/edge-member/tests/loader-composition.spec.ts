/**
 * The member plugin in a real Loader composition: Web carrier, Connection, Gateway, remote access, and the browser
 * upload and Session log routes. A request carrying the edge-signed header reaches Remote methods and those routes
 * as the `edge-member` principal on the Sessions the box stores, lists, or runs, including the terminal controller's
 * methods; a tampered, expired, or missing header is not a member, and a member reaches no settings method.
 */

import { randomBytes } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { Context, FiberState } from '@deepseek-ai/cordis'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import RemoteAccessService, { type RemoteAccessRole } from '@deepseek-ai/dsh-api-remote-access'
import TerminalController from '@deepseek-ai/dsh-api-terminal-controller'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import FileUploads from '@deepseek-ai/dsh-client-file-upload'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { SESSION_FORMAT_VERSION, type SessionHeader } from '@deepseek-ai/dsh-session'
import * as SessionLogExport from '@deepseek-ai/dsh-session-log-export'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { afterEach, describe, expect, it, vi } from 'vitest'
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

let context: Context | undefined
/** The Session list Workspace `w1` holds; a test may commit a new one. */
let workspaceSessions: string[] = []
/** Names of the files the upload route stored. */
let storedFiles: string[] = []

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  vi.unstubAllEnvs()
})

/**
 * Provide the root services and start the fixture's Loader.
 * @param listed - holds the stored-Session listing until it resolves.
 * @returns the Loader and its settlement.
 */
async function start(listed?: Promise<void>): ReturnType<typeof startLoader> {
  vi.stubEnv('MUMBO_MEMBER_KEY', KEY.toString('base64url'))
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
    ['@deepseek-ai/dsh-client-file-upload', FileUploads],
    ['@deepseek-ai/dsh-session-log-export', SessionLogExport],
    ['@mumbo/edge-member', EdgeMember],
  ])
  return startLoader(context, CONFIG, modules)
}

async function boot(): Promise<{ readonly origin: string; readonly probe: PromptProbe }> {
  const { loader, settled } = await start()
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

/** Exchange the Host's launch token for the owner's browser cookie. */
function ownerCookie(origin: string): string {
  const target = new URL(context!.connection.authenticatedUrl(origin))
  let setCookie: string | undefined
  context!.connection.authorizeIndex({ method: 'GET', url: `${target.pathname}${target.search}`, headers: { host: target.host } }, {
    writeHead(_status, headers) { setCookie = headers?.['set-cookie'] },
    end() {},
  })
  if (setCookie === undefined) throw new Error('no owner cookie')
  return setCookie.split(';', 1)[0]!
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

  it('lets a member open a terminal on a Session they reach and refuses one on a Session they do not', { timeout: 60_000 }, async () => {
    const { origin } = await boot()
    const ctx = context!
    // The Session's execution providers: a shell that runs until the controller ends it.
    const spawned: string[] = []
    ctx.provide('subprocess', {
      terminalEnvironment: async () => ({ platform: 'posix', defaultShell: '/bin/bash' }),
      resolveExecutable: async (path: string) => path,
      spawnTerminal: async (spec: { readonly env: { readonly DSH_SESSION_ID: string } }) => {
        spawned.push(spec.env.DSH_SESSION_ID)
        const output = new PassThrough()
        const done = Promise.withResolvers<{ exitCode: number; signal: null }>()
        return {
          pid: 1, output, done: done.promise, write: async () => {}, resize: async () => {},
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
      'terminal/environment', 'terminal/create', 'terminal/attach', 'terminal/retain',
    ]))
    expect(s1?.actions).not.toContain('session/updateQueue')
    const global = 'grants' in snapshot ? snapshot.grants.find(grant => grant.resource.kind === 'global') : undefined
    expect(global?.actions).not.toContain('hostFiles/readAny')
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
    const cookie = ownerCookie(origin)
    const expired = signMemberHeader(KEY, 'ann@example.com', now() - 1)
    const owner = await call(origin, 'session/prompt', { request: { sessionId: 's2', text: 'hi' } }, expired, { cookie })
    expect(owner.body).toMatchObject({ result: { ok: true } })
    expect(probe.callers).toEqual([undefined])
    const valid = signMemberHeader(KEY, 'ann@example.com', now() + 300)
    await expect(callWithRepeatedHeader(origin, [valid, valid])).resolves.toBe(401)
    expect(probe.callers).toEqual([undefined])
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
