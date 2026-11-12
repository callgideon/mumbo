/** The Client half with the real Workspace navigation: Mumbo opens only when startup restoration has nothing saved. */
import { Context } from '@deepseek-ai/cordis'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { LayoutController } from '@deepseek-ai/dsh-client-ui-layout/client'
import { StaticRemoteAccess } from '@deepseek-ai/dsh-client-test-runtime'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { en } from '@deepseek-ai/dsh-client-ui-workspace/src/client/locales.ts'
import { UiWorkspaceService } from '@deepseek-ai/dsh-client-ui-workspace/src/client/navigation.ts'
import { createWorkspaceViewStore } from '@deepseek-ai/dsh-client-ui-workspace/src/client/stores.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { afterEach, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import { MUMBO_SESSION_ID } from '../src/session.ts'

const roots: Context[] = []
afterEach(async () => {
  for (const ctx of roots.splice(0)) await ctx.fiber.dispose()
  vi.unstubAllGlobals()
})

const sid = (id: string) => id as SessionId
const summary = (id: string, cwd: string, blank: boolean): SessionSummary =>
  ({ id: sid(id), displayTitle: id, running: false, blank, updatedAt: 1, cwd, retainedBy: {} })
const workspace = (id: string, sessionIds: string[], createdAt: string): WorkspaceView => ({
  workspaceId: id as WorkspaceId, path: `/w/${id}`, title: id, sessionIds: sessionIds.map(sid), createdAt, updatedAt: createdAt,
})

interface PageOptions {
  /** Saved main-view selection from an earlier visit. */
  readonly saved?: string
  readonly rows: SessionSummary[]
  readonly workspaces: WorkspaceView[]
  /** Sessions archived on the Host. */
  readonly archived?: string[]
  /** Load the plugin, or leave it out as a control. */
  readonly plugin?: boolean
  /** Hold the Host's Session creation until released. */
  readonly creation?: Promise<undefined>
}

/**
 * A page with the real Workspace navigation and this plugin loaded; `ready()` delivers both Host lists. The fake Session
 * service publishes `retainedBy.mainView` on retain, as the shipped one does.
 * @returns list delivery, the settled main-view Sessions and persisted selection, the plugin fiber, and the service.
 */
async function page(options: PageOptions) {
  const storage = new Map<string, string>()
  if (options.saved !== undefined) storage.set('dsh.sessions.current', JSON.stringify({ sessionId: options.saved }))
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value) },
    removeItem: (key: string) => { storage.delete(key) },
  })
  const ctx = new Context()
  roots.push(ctx)
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('en')
  ctx.effect(() => locale.register('workspace', { en }))
  ctx.provide('locale', locale)
  // The sidebar never declares its panel list here, so the entry stays pending.
  await ctx.plugin(SlotRegistry)
  const layout = new LayoutController({ selectPanel: vi.fn() } as never, () => true, createSnapshotStore({ activePanelId: null }))
  ctx.provide('layout', layout)
  const list = createSnapshotStore<SessionListState>({ ids: [], byId: {}, phase: 'pending', projectionsBySession: {} }, { flush: 'sync' })
  const mainView = new Map<SessionId, number>()
  const publish = (id: SessionId) => {
    const state = list.getSnapshot()
    const row = state.byId[id]
    if (row === undefined) return
    list.set({ ...state, byId: { ...state.byId, [id]: { ...row, retainedBy: { mainView: mainView.get(id) ?? 0 } } } })
  }
  const sessions = {
    list,
    refreshProjections: vi.fn(() => Promise.resolve()),
    create: vi.fn(async (request: { sessionId?: SessionId; workspaceId: string }) => {
      await options.creation
      return request.sessionId ?? sid(`created-${request.workspaceId}`)
    }),
    subagentAddress: vi.fn(() => undefined),
    retain: vi.fn((target: SessionId) => {
      mainView.set(target, (mainView.get(target) ?? 0) + 1)
      publish(target)
      const release = () => { mainView.set(target, (mainView.get(target) ?? 1) - 1); publish(target) }
      return { sessionId: target, binding: { sessionId: target }, ready: Promise.resolve(), release, [Symbol.dispose]: release }
    }),
  }
  const workspaces = createSnapshotStore<WorkspaceSnapshot>({
    items: [], archivedSessionIds: [], pinnedSessionIds: [], phase: 'pending', state: 'loading', error: null,
  }, { flush: 'sync' })
  const workspacesService = { list: workspaces, initializeDefault: vi.fn(() => Promise.resolve(undefined)) }
  ctx.provide('sessions', sessions as never)
  ctx.provide('workspaces', workspacesService as never)
  const view = createWorkspaceViewStore().create()
  // The owner's page: every access answer allows.
  new StaticRemoteAccess(ctx)
  // The service provides `uiWorkspace` on the root, as ui-workspace's apply does.
  const service = new UiWorkspaceService(ctx, {} as never, workspacesService as never, sessions as never, view.actions, vi.fn())
  const plugin = options.plugin === false ? undefined : await ctx.plugin({ inject, apply })
  const ready = () => {
    workspaces.set({
      items: options.workspaces, archivedSessionIds: (options.archived ?? []).map(sid), pinnedSessionIds: [MUMBO_SESSION_ID],
      phase: 'ready', state: 'idle', error: null,
    })
    list.set({ ids: options.rows.map(row => row.id), byId: Object.fromEntries(options.rows.map(row => [row.id, row])), phase: 'ready', projectionsBySession: {} })
  }
  const settled = async () => {
    await new Promise(resolve => setTimeout(resolve, 10))
    return {
      open: [...mainView].filter(([, count]) => count > 0).map(([id]) => id),
      saved: (JSON.parse(storage.get('dsh.sessions.current') ?? '{}') as { sessionId?: string }).sessionId,
    }
  }
  /** Start the plugin again on the same page, as an HMR rebuild of its bundle does. */
  const reapply = async () => ctx.plugin({ inject, apply }).await()
  return { ready, settled, plugin, service, reapply, create: sessions.create }
}

const MUMBO = summary('mumbo', '/w/home', true)
// The newer Workspace is where navigation alone would open a New Session.
const HOME = workspace('home', ['mumbo'], '2026-01-01T00:00:00.000Z')
const ELSEWHERE = workspace('a', [], '2026-02-01T00:00:00.000Z')

it('opens Mumbo when nothing is saved, superseding the blank navigation would open in the newest Workspace', async () => {
  const { ready, settled, service, create } = await page({ rows: [MUMBO], workspaces: [HOME, ELSEWHERE] })
  ready()
  expect(await settled()).toEqual({ open: [MUMBO_SESSION_ID], saved: MUMBO_SESSION_ID })
  expect(service.restoration.getSnapshot()).toBe('fresh')
  // Navigation still prepared its blank on the Host before Mumbo superseded it.
  expect(create).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'a' })
})

it('leaves a saved Session with a turn open', async () => {
  const { ready, settled, service } = await page({
    saved: 'side', rows: [MUMBO, summary('side', '/w/a', false)], workspaces: [HOME, { ...ELSEWHERE, sessionIds: [sid('side')] }],
  })
  ready()
  expect(await settled()).toEqual({ open: ['side'], saved: 'side' })
  expect(service.restoration.getSnapshot()).toBe('saved')
})

it('leaves a saved blank Session open, which navigation restores asynchronously', async () => {
  const creation = Promise.withResolvers<undefined>()
  const { ready, settled, service } = await page({
    saved: 'draft', rows: [MUMBO, summary('draft', '/w/a', true)], workspaces: [HOME, { ...ELSEWHERE, sessionIds: [sid('draft')] }],
    creation: creation.promise,
  })
  ready()
  expect(service.restoration.getSnapshot()).toBe('saved')
  await new Promise(resolve => setTimeout(resolve, 10))
  creation.resolve(undefined)
  expect(await settled()).toEqual({ open: ['draft'], saved: 'draft' })
})

it('opens Mumbo when the saved blank was archived, since navigation would open a new blank instead', async () => {
  const { ready, settled, service } = await page({
    saved: 'draft', rows: [MUMBO, summary('draft', '/w/a', true)], workspaces: [HOME, { ...ELSEWHERE, sessionIds: [sid('draft')] }],
    archived: ['draft'],
  })
  ready()
  expect(service.restoration.getSnapshot()).toBe('fresh')
  expect(await settled()).toEqual({ open: [MUMBO_SESSION_ID], saved: MUMBO_SESSION_ID })
})

it('keeps a Session the person opened when the plugin starts again on the same page', async () => {
  const { ready, settled, plugin, service, reapply } = await page({
    rows: [MUMBO, summary('side', '/w/a', false)], workspaces: [HOME, { ...ELSEWHERE, sessionIds: [sid('side')] }],
  })
  ready()
  expect((await settled()).open).toEqual([MUMBO_SESSION_ID])
  // Mumbo itself open: a restart does not open it again.
  await plugin!.dispose()
  const opens = vi.spyOn(service, 'openSession')
  const again = await reapply()
  await settled()
  expect(opens).not.toHaveBeenCalled()
  service.openSession(sid('side'))
  await again.dispose()
  await reapply()
  expect(await settled()).toEqual({ open: ['side'], saved: 'side' })
  expect(opens).toHaveBeenCalledExactlyOnceWith('side')
})

it('opens nothing of its own when the Host did not list Mumbo', async () => {
  const { ready, settled } = await page({ rows: [], workspaces: [ELSEWHERE] })
  ready()
  expect(await settled()).toEqual({ open: ['created-a'], saved: 'created-a' })
})

it('leaves navigation alone after unload, and leaves restoration alone in a page without the plugin', async () => {
  const unloaded = await page({ rows: [MUMBO], workspaces: [HOME, ELSEWHERE] })
  await unloaded.plugin!.dispose()
  unloaded.ready()
  expect(await unloaded.settled()).toEqual({ open: ['created-a'], saved: 'created-a' })
  const without = await page({ rows: [MUMBO], workspaces: [HOME, ELSEWHERE], plugin: false })
  without.ready()
  expect(await without.settled()).toEqual({ open: ['created-a'], saved: 'created-a' })
})

it('hides Mumbo from the Workspace browser through Workspace navigation until the plugin unloads', async () => {
  const { plugin, service } = await page({ rows: [MUMBO], workspaces: [HOME] })
  expect(service.hiddenSessionIds.getSnapshot()).toEqual([MUMBO_SESSION_ID])
  await plugin!.dispose()
  expect(service.hiddenSessionIds.getSnapshot()).toEqual([])
})
