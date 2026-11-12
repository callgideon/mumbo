/**
 * The project Workspace in a real Loader composition over the real Workspace registry and a held in-memory store:
 * the Host registers the Workspace before the Loader settles, keeps it through a restart and an owner's deletion,
 * members follow and start Sessions only in it, and every stored Session stays reachable to members.
 */

import { randomBytes } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as tick, setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { Context, FiberState } from '@deepseek-ai/cordis'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import WorkspaceController from '@deepseek-ai/dsh-api-workspace-controller'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import Storage, { type StorageBackend } from '@deepseek-ai/dsh-storage'
import { DomainFacility, type DomainChanged } from '@deepseek-ai/dsh-storage-domain'
import type { PeerId, Principal, RemoteInvocation } from '@deepseek-ai/dsh-typert-protocol'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import WorkspaceRegistry, { type WorkspaceDomainState } from '@deepseek-ai/dsh-workspace'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { signMemberHeader } from '../src/header.ts'
import * as EdgeMember from '../src/index.ts'
import * as ProjectWorkspace from '../src/project-workspace.ts'
import { PromptProbe, call, now, provideCredentials, startLoader } from './helpers/composition.ts'

const CONFIG = fileURLToPath(new URL('./fixtures/project.cordis.yml', import.meta.url))
const KEY = randomBytes(32)
const MEMBER: Principal = { kind: 'edge-member', email: 'ann@example.com' }
/** The Workspace domain's stored version. */
const DOMAIN_VERSION = 2
const MODULES = new Map<string, object>([
  ['@deepseek-ai/dsh-typert-registry', TypertRegistry],
  ['@deepseek-ai/dsh-api-remote-access', RemoteAccessService],
  ['@deepseek-ai/dsh-api-gateway', TypertGatewayService],
  ['@deepseek-ai/dsh-host-webserver', WebServer],
  ['@deepseek-ai/dsh-client-connection', Connection],
  ['@mumbo/edge-member', EdgeMember],
  ['@deepseek-ai/dsh-api-workspace-controller', WorkspaceController],
  ['@mumbo/edge-member/project-workspace', ProjectWorkspace],
])

const contexts: Context[] = []
const directories: string[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

/** @returns a new directory in the canonical spelling the registry stores. */
function directory(): string {
  const path = realpathSync.native(mkdtempSync(join(tmpdir(), 'mumbo-project-workspace-')))
  directories.push(path)
  return path
}

const header = (id: string, cwd: string): SessionHeader => ({
  version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: 1, isSeeded: false, cwd, delegationDepth: 0,
})

/** The bitlane box's Workspace store: initialized, with no Workspace. */
function initializedEmptyStore(): MemoryMediaPool {
  const pool = new MemoryMediaPool()
  pool.versions.set('workspace', DOMAIN_VERSION)
  pool.media.set('workspace', { tables: new Map([['workspaces', new Map<string, unknown>()]]), global: { initialized: true, workspaceIds: [] } })
  return pool
}

interface BoxOptions {
  readonly pool: MemoryMediaPool
  /** The value both rows' `workspace` read. */
  readonly workspace: string
  /** Session headers the store lists; none are live. */
  readonly stored?: readonly SessionHeader[]
  /** Holds every store access from the Loader's start until it settles. */
  readonly hold?: Promise<void>
  /** While it returns true, every Workspace-registry commit rejects. */
  readonly failCommits?: () => boolean
}

/**
 * @returns `backend`, except that a write of the Workspace domain's global state that lists a Workspace and names no
 *   pending mutation, the registry's commit of a create, rejects while `failing` returns true.
 */
function failingCommits(backend: MemoryStorageBackend, failing: () => boolean): StorageBackend {
  return {
    kv: {
      open: async (descriptor) => {
        const unit = await backend.kv.open(descriptor)
        if (descriptor.name !== 'workspace') return unit
        return {
          loadAll: () => unit.loadAll(),
          putRecord: (table, key, value) => unit.putRecord(table, key, value),
          deleteRecord: (table, key) => unit.deleteRecord(table, key),
          deleteRecords: (table, keys) => unit.deleteRecords(table, keys),
          setGlobal: async (value) => {
            const state = value as WorkspaceDomainState
            if (failing() && state.pendingMutation === undefined && state.workspaceIds.length > 0) throw new Error('commit rejected')
            await unit.setGlobal(value)
          },
          close: () => unit.close(),
        }
      },
    },
    close: () => backend.close(),
  }
}

/**
 * Start a project box Host: real live Sessions, storage, and Workspace registry on the root, then the fixture's rows
 * through the Loader.
 * @returns the root Context, the Loader, its settlement, and every Workspace-domain write from the registry's load on.
 */
async function startBox(options: BoxOptions) {
  vi.stubEnv('MUMBO_MEMBER_KEY', KEY.toString('base64url'))
  vi.stubEnv('MUMBO_PROJECT_WORKSPACE', options.workspace)
  const ctx = new Context()
  contexts.push(ctx)
  const changes: DomainChanged[] = []
  ctx.on('domain/changed', (change) => { if (change.domain === 'workspace') changes.push(change) })
  await ctx.plugin(SessionStore)
  await ctx.plugin(Storage)
  const memory = new MemoryStorageBackend(options.pool)
  ctx.storage.backend.register('memory', options.failCommits === undefined ? memory : failingCommits(memory, options.failCommits))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const stored = options.stored ?? []
  ctx.provide('sessionPersistence', {
    list: async () => stored.map(item => ({ header: item, revision: SessionPersistenceRevision(`rev-${item.id}`) })),
  } as never)
  provideCredentials(ctx)
  await ctx.plugin(WorkspaceRegistry)
  options.pool.gate = options.hold
  const { loader, settled } = await startLoader(ctx, CONFIG, MODULES)
  const entry = (id: string) => [...loader.entries()].find(item => item.options.id === id)
  return { ctx, changes, entry, settled }
}

/**
 * Wait for the box to settle, then serve the stand-in Session methods.
 * @returns the Web carrier's origin.
 */
async function serve(box: Awaited<ReturnType<typeof startBox>>): Promise<string> {
  await box.settled
  box.ctx.typert.resources.register('session', { field: 'sessionId' })
  await box.ctx.plugin(PromptProbe)
  return `http://127.0.0.1:${String(box.ctx.webServer.port)}`
}

/** @returns the paths and ids of the registry's Workspaces, in registry order. */
function workspaces(ctx: Context): { readonly id: string; readonly path: string; readonly title: string }[] {
  return ctx.workspaceRegistry.list().map(({ id, path, title }) => ({ id, path, title }))
}

/** @returns the first frame of the member's `workspace/follow` stream, as the Gateway would dispatch it. */
async function memberBaseline(ctx: Context) {
  const invocation: RemoteInvocation = {
    request: { namespace: 'workspace', method: 'follow', args: {} },
    service: 'workspaceController',
    peer: { id: 'member-peer' as PeerId, ctx, principal: MEMBER, interactions: 'answer', signal: new AbortController().signal, dispose: async () => {} },
    signal: new AbortController().signal,
    uplink: <In>(): AsyncIterable<In> => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) }),
  }
  const abort = new AbortController()
  const iterator = ctx.extend({ invocation }).workspaceController.follow(abort.signal)[Symbol.asyncIterator]()
  const first = await iterator.next()
  abort.abort()
  await iterator.return?.()
  if (first.done === true || first.value.type !== 'baseline') throw new Error('the follow stream opened without a baseline')
  return first.value.value
}

/** @returns the member's access grants by resource, as the index injects them. */
function memberGrants(ctx: Context): Map<string, readonly string[]> {
  const snapshot = ctx.remoteAccess.snapshotFor(MEMBER)
  const grants = 'grants' in snapshot ? snapshot.grants : []
  return new Map(grants.map(grant => [grant.resource.kind === 'global' ? 'global' : `${grant.resource.kind}:${grant.resource.id}`, grant.actions]))
}

describe('the project Workspace at start', () => {
  it('registers it on a store holding initialized:true and no Workspace before the Loader settles, with no client call', { timeout: 60_000 }, async () => {
    const project = directory()
    const initializeDefault = vi.spyOn(WorkspaceController.prototype, 'initializeDefault')
    const create = vi.spyOn(WorkspaceController.prototype, 'create')
    const hold = Promise.withResolvers<undefined>()
    const pool = initializedEmptyStore()
    const box = await startBox({ pool, workspace: project, stored: [header('ungrouped', '/src')], hold: hold.promise })
    let settled = false
    void box.settled.then(() => { settled = true })
    await vi.waitFor(() => { expect(box.entry('mumbo-project-workspace')?.fiber?.state).toBe(FiberState.LOADING) })
    for (let turn = 0; turn < 5; turn += 1) await tick()
    expect(settled).toBe(false)
    expect(box.changes).toEqual([])
    expect(workspaces(box.ctx)).toEqual([])
    pool.gate = undefined
    hold.resolve(undefined)
    await box.settled
    expect(workspaces(box.ctx)).toEqual([expect.objectContaining({ path: project })])
    const [workspace] = workspaces(box.ctx)
    const baseline = await memberBaseline(box.ctx)
    expect(baseline.items).toEqual([expect.objectContaining({ workspaceId: workspace!.id, path: project })])
    expect(initializeDefault).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })

  it('registers it on a fresh box after the registry marks the store initialized', { timeout: 60_000 }, async () => {
    const project = directory()
    const pool = new MemoryMediaPool()
    const box = await startBox({ pool, workspace: project })
    await box.settled
    expect(box.changes[0]).toMatchObject({ table: '', operation: 'put', value: { initialized: true, workspaceIds: [] } })
    const [workspace] = workspaces(box.ctx)
    expect(workspaces(box.ctx)).toEqual([expect.objectContaining({ path: project })])
    expect(pool.media.get('workspace')!.global).toMatchObject({ initialized: true, workspaceIds: [workspace!.id] })
  })

  it('writes nothing on a second start over the same store and keeps the Workspace\'s id and title', { timeout: 60_000 }, async () => {
    const project = directory()
    const pool = initializedEmptyStore()
    const first = await startBox({ pool, workspace: project })
    await first.settled
    const before = workspaces(first.ctx)
    expect(before).toEqual([expect.objectContaining({ path: project })])
    await first.ctx.fiber.dispose()
    const second = await startBox({ pool, workspace: project })
    await second.settled
    expect(second.changes).toEqual([])
    expect(workspaces(second.ctx)).toEqual(before)
  })

  it.each([
    ['a missing directory', () => join(directory(), 'absent')],
    ['a relative path', () => 'projects'],
  ])('fails only its own row for %s, and members are still admitted', { timeout: 60_000 }, async (_case, path) => {
    const box = await startBox({ pool: initializedEmptyStore(), workspace: path(), stored: [header('ungrouped', '/src')] })
    const origin = await serve(box)
    expect(box.entry('mumbo-project-workspace')?.fiber?.state).toBe(FiberState.FAILED)
    expect(box.entry('mumbo-edge-member')?.fiber?.state).toBe(FiberState.ACTIVE)
    const member = signMemberHeader(KEY, 'ann@example.com', now() + 300)
    const answer = await call(origin, 'session/prompt', { request: { sessionId: 'ungrouped', text: 'hi' } }, member)
    expect(answer.body).toMatchObject({ result: { ok: true, value: 'queued' } })
    expect(workspaces(box.ctx)).toEqual([])
  })
})

describe('the project Workspace while the box runs', () => {
  it('registers it again once after each deletion by the owner, and then writes nothing more', { timeout: 60_000 }, async () => {
    const project = directory()
    const box = await startBox({ pool: initializedEmptyStore(), workspace: project })
    await box.settled
    const create = vi.spyOn(WorkspaceRegistry.prototype, 'create')
    const ids = [workspaces(box.ctx)[0]!.id]
    for (const deleted of [1, 2]) {
      await box.ctx.workspaceController.delete({ workspaceId: ids.at(-1) as never })
      await vi.waitFor(() => { expect(workspaces(box.ctx)).toEqual([expect.objectContaining({ path: project })]) })
      ids.push(workspaces(box.ctx)[0]!.id)
      expect(create, `deletion ${String(deleted)}`).toHaveBeenCalledTimes(deleted)
    }
    expect(new Set(ids).size).toBe(3)
    const writes = box.changes.length
    for (let turn = 0; turn < 5; turn += 1) await tick()
    expect(box.changes).toHaveLength(writes)
    expect(create.mock.calls).toEqual([[project], [project]])
  })

  it('registers it once after a deletion while the registry cannot commit it, and logs the failure', { timeout: 60_000 }, async () => {
    const project = directory()
    let failing = false
    const box = await startBox({ pool: initializedEmptyStore(), workspace: project, failCommits: () => failing })
    await box.settled
    const error = vi.spyOn(box.ctx.logger, 'error').mockImplementation(() => {})
    const create = vi.spyOn(WorkspaceRegistry.prototype, 'create')
    const [deleted] = workspaces(box.ctx)
    failing = true
    await box.ctx.workspaceController.delete({ workspaceId: deleted!.id as never })
    await vi.waitFor(() => { expect(error).toHaveBeenCalled() })
    // The registry's rollback deletes the uncommitted record, which must not start another create.
    await delay(100)
    expect(create).toHaveBeenCalledOnce()
    expect(error).toHaveBeenCalledExactlyOnceWith(
      `mumbo-project-workspace: registering ${project} again after a deletion failed`, expect.objectContaining({ message: 'commit rejected' }),
    )
    expect(workspaces(box.ctx)).toEqual([])
  })

  it('logs a failed registration after a deletion', { timeout: 60_000 }, async () => {
    const project = directory()
    const box = await startBox({ pool: initializedEmptyStore(), workspace: project })
    await box.settled
    const error = vi.spyOn(box.ctx.logger, 'error').mockImplementation(() => {})
    const [deleted] = workspaces(box.ctx)
    rmSync(project, { recursive: true })
    await box.ctx.workspaceController.delete({ workspaceId: deleted!.id as never })
    await vi.waitFor(() => {
      expect(error).toHaveBeenCalledWith(`mumbo-project-workspace: registering ${project} again after a deletion failed`, expect.any(Error))
    })
    expect(workspaces(box.ctx)).toEqual([])
  })

  it('shows members only the project Workspace when a newer one holds a live Session, which they may still follow', { timeout: 60_000 }, async () => {
    const project = directory()
    const coordinator = directory()
    const box = await startBox({ pool: initializedEmptyStore(), workspace: project })
    await box.settled
    const superagent = await box.ctx.workspaceRegistry.create(coordinator)
    const session = box.ctx.sessions.create(SessionId('coordinator'), { meta: { cwd: coordinator } })
    await superagent.attachSession(session.id)
    await tick()
    const baseline = await memberBaseline(box.ctx)
    expect(baseline.items.map(item => item.path)).toEqual([project])
    const grants = memberGrants(box.ctx)
    expect(grants.get(`workspace:${superagent.id}`)).toBeUndefined()
    expect(grants.get(`workspace:${workspaces(box.ctx).find(item => item.path === project)!.id}`)).toEqual(['session/create', 'workspace/follow'])
    expect(grants.get('session:coordinator')).toContain('session/follow')
  })

  it('lets members start a Session only in the project Workspace, refusing a create that names none', { timeout: 60_000 }, async () => {
    const project = directory()
    const box = await startBox({ pool: initializedEmptyStore(), workspace: project, stored: [header('blank', project)] })
    const origin = await serve(box)
    const [projectWorkspace] = workspaces(box.ctx)
    const member = signMemberHeader(KEY, 'ann@example.com', now() + 300)
    const create = async (request: object) => (await call(origin, 'session/create', { request }, member)).body
    // A create that names no Workspace or Session is decided on the global resource, even for the project directory.
    for (const request of [{}, { cwd: project }, { cwd: '/elsewhere' }]) {
      expect(await create(request), JSON.stringify(request)).toMatchObject({ result: { ok: false, error: { code: 'remote-access/denied' } } })
    }
    // One that names a reachable Session and no Workspace is decided on that Session, whose binding requires a Workspace.
    for (const request of [{ sessionId: 'blank' }, { sessionId: 'blank', cwd: project }]) {
      expect(await create(request), JSON.stringify(request)).toMatchObject({
        result: { ok: false, error: { code: 'remote-access/denied', details: { reason: 'workspace-required' } } },
      })
    }
    expect(await create({ workspaceId: projectWorkspace!.id })).toMatchObject({ result: { ok: true, value: 'new' } })
    expect(await create({ workspaceId: projectWorkspace!.id, sessionId: 'blank' })).toMatchObject({ result: { ok: true, value: 'blank' } })
  })

  it('lets members open a stored Session with no Workspace, and one created later after it stops', { timeout: 60_000 }, async () => {
    const box = await startBox({ pool: initializedEmptyStore(), workspace: directory(), stored: [header('ungrouped', '/src')] })
    const origin = await serve(box)
    expect(box.ctx.sessions.get(SessionId('ungrouped'))).toBeUndefined()
    expect(memberGrants(box.ctx).get('session:ungrouped')).toEqual(expect.arrayContaining(['session/follow', 'session/page', 'session/prompt']))
    const member = signMemberHeader(KEY, 'ann@example.com', now() + 300)
    const opened = await call(origin, 'session/page', { request: { sessionId: 'ungrouped' } }, member)
    expect(opened.body).toMatchObject({ result: { ok: true, value: 'page of ungrouped' } })
    const owner = box.ctx.plugin({
      inject: ['sessions'],
      apply: (child: Context) => { child.sessions.create(SessionId('later'), { meta: { cwd: '/src' } }) },
    })
    await owner.await()
    await owner.dispose()
    expect(box.ctx.sessions.get(SessionId('later'))).toBeUndefined()
    const later = await call(origin, 'session/page', { request: { sessionId: 'later' } }, member)
    expect(later.body).toMatchObject({ result: { ok: true, value: 'page of later' } })
  })
})
