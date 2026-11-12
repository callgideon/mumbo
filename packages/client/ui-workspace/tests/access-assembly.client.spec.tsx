// @vitest-environment jsdom
/**
 * Workspace header actions and the sidebar's New Session controls under a non-owner access snapshot, through the
 * assembled renderer.
 *
 * Hand-built row props spread allow-all access Hooks, so they cannot show that the browsing region
 * reads the Hooks a page actually binds. This spec replaces the runtime's allow-all access row with the
 * remote-access snapshot owner itself and renders the real slot tree, so the global and Workspace
 * access Hooks, and the access New Session follows, are the renderer's bindings over one snapshot.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, screen, within } from '@testing-library/react'
import type { Context } from '@deepseek-ai/cordis'
import type { AccessEffect, RemoteEndpoint, TypertResourceKind } from '@deepseek-ai/dsh-api-remote-access/client'
import { ClientAccessState } from '@deepseek-ai/dsh-api-remote-access/src/client/state.ts'
import { whenAllowed } from '@deepseek-ai/dsh-api-remote-access/src/client/when-allowed.ts'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { allowAllAccessPlugin, SlotTestRuntime, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as applyMenus, inject as injectMenus } from '@deepseek-ai/dsh-client-ui-context-menu/client'
import { apply as applySidebar, inject as injectSidebar } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-workspace/client'
import { SECTION_HOOK_CONTEXT, SECTION_INJECT } from './section-scroller.client.ts'

usePinnedBrowserLanguages('en-US')

afterEach(cleanup)
beforeEach(() => { localStorage.clear() })

/** Test-owned sidebar shell role: declares and renders the browsing region. */
type FrameProps = PropsRenderSlots<'sidebar.workspaces'>
function SidebarFrame({ renderSlot }: FrameProps) {
  return <>{renderSlot('sidebar.workspaces', { wide: true, expandSidebar: () => {} }, { hookContext: SECTION_HOOK_CONTEXT })}</>
}

const WORKSPACE = 'w1' as WorkspaceId

/**
 * The runtime with the services ui-workspace injects, whose `remoteAccess` service and global access Hook answer
 * from one snapshot owner, as the remote-access Client row's do.
 * @param access - Snapshot owner every access answer reads.
 * @returns The runtime, with no Workspace UI mounted yet.
 */
async function services(access: ClientAccessState) {
  const runtime = await SlotTestRuntime.create()
  await Promise.all([...runtime.ctx.registry.get(allowAllAccessPlugin)?.fibers ?? []].map(fiber => fiber.dispose()))
  await runtime.ctx.plugin({
    name: 'access-assembly:snapshot-access',
    inject: ['slots'],
    apply(ctx: Context) {
      ctx.provide('remoteAccess', {
        source: (kind: TypertResourceKind, id: string, action: string) => access.resource(kind, id, action),
        whenAccess: (action: RemoteEndpoint, callback: () => AccessEffect) => whenAllowed(ctx, access.global(action), callback, action),
        whenResourceAccess: (kind: TypertResourceKind, id: string, action: RemoteEndpoint, callback: () => AccessEffect) =>
          whenAllowed(ctx, access.resource(kind, id, action), callback, `${kind}:${id}:${action}`),
      })
      ctx.slots.provideRoot({ keyedHooks: { remoteAccess: action => access.global(action) } })
    },
  }).await()
  runtime.ctx.provide('shortcuts', { register: () => () => {}, catalog: createSnapshotStore([]) })
  runtime.ctx.provide('uiConversation', {})
  runtime.ctx.provide('layout', { selectPanel: vi.fn(), toggleSidebar: vi.fn(), beginNavigation: () => new AbortController().signal })
  runtime.releaseWorkspaceSource()
  runtime.remote.provideNamespaces({ directoryPicker: {} })
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  return runtime
}

/**
 * The assembled browsing region over one Workspace, answering access from one snapshot owner.
 * @param access - Snapshot owner the page's access Hooks read.
 * @returns The runtime.
 */
async function bench(access: ClientAccessState, options: { ungroupedSession?: SessionId } = {}) {
  const runtime = await services(access)
  if (options.ungroupedSession !== undefined) {
    await runtime.sessions.add({
      id: options.ungroupedSession,
      summary: { title: 'Loose', displayTitle: 'Loose', cwd: '/elsewhere' },
    })
  }
  await runtime.workspaces.update((draft) => {
    draft.items = [{
      workspaceId: WORKSPACE, title: 'Project', path: '/projects/project',
      sessionIds: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    }] as never
  })
  await runtime.root.declare(
    { 'sidebar.workspaces': { kind: 'single', scope: 'root', inject: SECTION_INJECT } } as never,
    SidebarFrame as never,
  )
  await runtime.mount({ inject: [...injectMenus], apply: applyMenus })
  await runtime.mount({ inject: [...inject], apply })
  return runtime
}

describe('Workspace header actions under the page access snapshot', () => {
  it('offers New Session, the Workspace menu, and the drag handle only where the snapshot grants them', async () => {
    const access = new ClientAccessState({
      type: 'baseline',
      owner: false,
      grants: [{ resource: { kind: 'workspace', id: WORKSPACE }, actions: ['workspace/follow'] }],
    })
    const runtime = await bench(access)
    try {
      runtime.renderRoot()
      const header = await screen.findByRole('treeitem')
      expect(screen.queryByRole('button', { name: 'New session in Project' })).toBeNull()
      expect(screen.getByRole('button', { name: 'Workspace actions for Project' })).toBeTruthy()
      const target = { kind: 'workspace' as const, value: { workspaceId: WORKSPACE, path: '/projects/project', displayTitle: 'Project' } }
      const deniedMenu = runtime.ctx.contextMenus.resolve(target)
      await deniedMenu.ready
      expect(deniedMenu.source.getSnapshot()).toEqual([])
      deniedMenu.dispose()
      expect(header.getAttribute('draggable')).toBe('false')

      // The Workspace's own grant moves its actions; the global answer is never consulted for them.
      act(() => {
        access.update({
          type: 'upsert',
          grant: {
            resource: { kind: 'workspace', id: WORKSPACE },
            actions: ['session/create', 'workspace/follow', 'workspace/insertBefore', 'workspace/rename'],
          },
        })
      })
      expect(screen.getByRole('button', { name: 'New session in Project' })).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Workspace actions for Project' })).toBeTruthy()
      expect(screen.getByRole('treeitem').getAttribute('draggable')).toBe('true')

      const grantedMenu = runtime.ctx.contextMenus.resolve(target)
      await grantedMenu.ready
      expect(grantedMenu.source.getSnapshot().map(item => item.id)).toEqual(['workspace.rename/rename'])
      act(() => { access.replace({ type: 'baseline', owner: false, grants: [] }) })
      grantedMenu.select('workspace.rename/rename')
      expect(screen.queryByRole('dialog')).toBeNull()
      grantedMenu.dispose()

      // The owner's snapshot answers every action.
      act(() => { access.replace({ type: 'baseline', owner: true }) })
      expect(screen.getByRole('button', { name: 'New session in Project' })).toBeTruthy()
    } finally {
      await runtime.dispose()
    }
  })

  it('asks the global resource before the Ungrouped header offers New Session', async () => {
    const access = new ClientAccessState({ type: 'baseline', owner: false, grants: [] })
    const runtime = await bench(access, { ungroupedSession: 'loose' as SessionId })
    try {
      runtime.renderRoot()
      await screen.findByText('Ungrouped')
      expect(screen.queryByRole('button', { name: 'New session in Ungrouped' })).toBeNull()
      act(() => {
        access.update({ type: 'upsert', grant: { resource: { kind: 'global' }, actions: ['session/create'] } })
      })
      expect(screen.getByRole('button', { name: 'New session in Ungrouped' })).toBeTruthy()
    } finally {
      await runtime.dispose()
    }
  })
})

/** Test-owned frame role: the sidebar column and the window-chrome seat, as the layout frame renders them. */
function ShellFrame({ renderSlot }: PropsRenderSlots<'sidebar' | 'shell.leading'>) {
  return (
    <>
      <div data-testid="column">{renderSlot('sidebar', { collapsed: false, width: 300, drawer: false })}</div>
      <div data-testid="titlebar">{renderSlot('shell.leading', {})}</div>
    </>
  )
}

/**
 * The real sidebar over the real Workspace UI on Desktop, where the window-chrome seat also offers New Session.
 * @param access - Snapshot owner the page's access answers read.
 * @returns The runtime.
 */
async function shellBench(access: ClientAccessState) {
  const runtime = await services(access)
  await runtime.root.declare(
    { 'sidebar': { kind: 'single', scope: 'root' }, 'shell.leading': { kind: 'single', scope: 'root' } } as never,
    ShellFrame as never,
  )
  await runtime.mount({ inject: [...injectMenus], apply: applyMenus })
  await runtime.mount({ inject: [...inject], apply })
  await runtime.mount({ inject: [...injectSidebar], apply: applySidebar })
  return runtime
}

/** @returns how many New Session controls the expanded column (brand and button) and the window-chrome seat render. */
function newSessionControls(): { readonly column: number; readonly titlebar: number } {
  const count = (testId: string) => within(screen.getByTestId(testId)).queryAllByRole('button', { name: 'New session' }).length
  return { column: count('column'), titlebar: count('titlebar') }
}

const OFFERED = { column: 2, titlebar: 1 }
const ABSENT = { column: 0, titlebar: 0 }
const PROJECT = 'project' as WorkspaceId
const OTHER = 'other' as WorkspaceId

/** A Workspace row with no Session, created at `createdAt`. */
function workspaceRow(workspaceId: WorkspaceId, createdAt: string) {
  return { workspaceId, title: workspaceId, path: `/projects/${workspaceId}`, sessionIds: [] as SessionId[], createdAt, updatedAt: createdAt }
}

describe('New Session controls under the page access snapshot', () => {
  beforeEach(() => {
    document.documentElement.dataset.platform = 'win32'
    // Startup restoration's Session creation is not stubbed here; it fails and reports to the console.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    delete document.documentElement.dataset.platform
    vi.restoreAllMocks()
  })

  it('offers a member New Session only while it would start in a Workspace granting session/create', async () => {
    const access = new ClientAccessState({
      type: 'baseline',
      owner: false,
      grants: [{ resource: { kind: 'workspace', id: PROJECT }, actions: ['session/create', 'workspace/follow'] }],
    })
    const runtime = await shellBench(access)
    try {
      runtime.renderRoot()
      // With no Workspace, New Session would start none; a member holds no global session/create.
      expect(newSessionControls()).toEqual(ABSENT)
      await runtime.workspaces.update((draft) => { draft.items = [workspaceRow(PROJECT, '2026-01-01T00:00:00.000Z')] as never })
      expect(newSessionControls()).toEqual(OFFERED)

      // A newer Workspace becomes the target, and the member may not create there.
      await runtime.workspaces.update((draft) => {
        draft.items = [workspaceRow(PROJECT, '2026-01-01T00:00:00.000Z'), workspaceRow(OTHER, '2026-02-01T00:00:00.000Z')] as never
      })
      expect(newSessionControls()).toEqual(ABSENT)

      // A Session's activity alone makes the project Workspace the most recent one again.
      const recent = await runtime.sessions.add({ id: 'recent', summary: { cwd: `/projects/${PROJECT}` } })
      await runtime.workspaces.update((draft) => {
        draft.items = [
          { ...workspaceRow(PROJECT, '2026-01-01T00:00:00.000Z'), sessionIds: [recent] },
          workspaceRow(OTHER, '2026-02-01T00:00:00.000Z'),
        ] as never
      })
      expect(newSessionControls()).toEqual(ABSENT)
      await runtime.sessions.updateSummary(recent, { updatedAt: Date.parse('2026-03-01T00:00:00.000Z') })
      expect(newSessionControls()).toEqual(OFFERED)

      // The current Session's Workspace wins over the most recent one.
      const current = await runtime.sessions.add({ id: 'current', summary: { cwd: `/projects/${PROJECT}` } })
      await runtime.workspaces.update((draft) => {
        draft.items = [
          { ...workspaceRow(PROJECT, '2026-01-01T00:00:00.000Z'), sessionIds: [current] },
          workspaceRow(OTHER, '2026-02-01T00:00:00.000Z'),
        ] as never
      })
      expect(newSessionControls()).toEqual(ABSENT)
      act(() => { runtime.ctx.uiWorkspace.openSession(current) })
      expect(newSessionControls()).toEqual(OFFERED)

      // A grant change on the target moves the controls without a navigation.
      act(() => { access.update({ type: 'remove', resource: { kind: 'workspace', id: PROJECT } }) })
      expect(newSessionControls()).toEqual(ABSENT)
    } finally {
      await runtime.dispose()
    }
  })

  it('keeps every New Session control for the owner, with no Workspace and in any Workspace', async () => {
    const runtime = await shellBench(new ClientAccessState({ type: 'baseline', owner: true }))
    try {
      runtime.renderRoot()
      // New Session would clear into the blank New Session page, from which the owner picks a folder.
      expect(newSessionControls()).toEqual(OFFERED)
      await runtime.workspaces.update((draft) => {
        draft.items = [workspaceRow(PROJECT, '2026-01-01T00:00:00.000Z'), workspaceRow(OTHER, '2026-02-01T00:00:00.000Z')] as never
      })
      expect(newSessionControls()).toEqual(OFFERED)
    } finally {
      await runtime.dispose()
    }
  })
})
