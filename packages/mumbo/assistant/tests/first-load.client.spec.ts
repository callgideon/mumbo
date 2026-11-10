/** The Client half opens Mumbo once, on first load, only when no Session is open. */
import { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import { MUMBO_SESSION_ID } from '../src/session.ts'

interface Row { readonly id: SessionId; readonly retainedBy: { readonly mainView?: number } }
interface Lists { ids: SessionId[]; byId: Record<string, Row>; phase: 'pending' | 'ready' }

const roots: Context[] = []
afterEach(async () => { for (const ctx of roots.splice(0)) await ctx.fiber.dispose() })

/**
 * A page whose Workspace navigation, like the shipped one, subscribes before this plugin and opens the saved selection
 * synchronously in the notification that makes both lists ready.
 */
async function page(options: { ids?: string[]; saved?: string } = {}) {
  const ids = (options.ids ?? ['side', MUMBO_SESSION_ID]) as SessionId[]
  const rows = (open?: string) => Object.fromEntries(ids.map(id => [id, { id, retainedBy: id === open ? { mainView: 1 } : {} }]))
  const sessions = createSnapshotStore<Lists>({ ids: [], byId: {}, phase: 'pending' })
  const workspaces = createSnapshotStore<{ phase: 'pending' | 'ready' }>({ phase: 'pending' })
  const openSession = vi.fn<(id: SessionId) => void>()
  const restore = () => {
    if (sessions.getSnapshot().phase !== 'ready' || workspaces.getSnapshot().phase !== 'ready') return
    if (options.saved !== undefined && sessions.getSnapshot().byId[options.saved]?.retainedBy.mainView === undefined) {
      sessions.set({ ...sessions.getSnapshot(), byId: rows(options.saved) })
    }
  }
  sessions.subscribe(restore)
  workspaces.subscribe(restore)
  const ctx = new Context()
  roots.push(ctx)
  ctx.provide('sessions', { list: sessions } as never)
  ctx.provide('workspaces', { list: workspaces } as never)
  ctx.provide('uiWorkspace', { openSession } as never)
  const plugin = ctx.plugin({ inject, apply })
  await plugin
  const settle = async () => {
    sessions.set({ ids, byId: rows(), phase: 'ready' })
    workspaces.set({ phase: 'ready' })
    await Promise.resolve()
  }
  return { openSession, plugin, settle, sessions }
}

it('opens Mumbo when the lists settle with no Session open', async () => {
  const { openSession, settle, sessions } = await page()
  await settle()
  expect(openSession.mock.calls).toEqual([[MUMBO_SESSION_ID]])
  // Later list changes are the person's navigation, not a first load.
  sessions.set({ ...sessions.getSnapshot(), byId: {} })
  await Promise.resolve()
  expect(openSession).toHaveBeenCalledOnce()
})

it('leaves a Session the person chose open', async () => {
  const { openSession, settle } = await page({ saved: 'side' })
  await settle()
  expect(openSession).not.toHaveBeenCalled()
})

it('does nothing when the Host did not list Mumbo', async () => {
  const { openSession, settle } = await page({ ids: ['side'] })
  await settle()
  expect(openSession).not.toHaveBeenCalled()
})

it('decides immediately when the lists were ready before the plugin loaded', async () => {
  const ids = [MUMBO_SESSION_ID]
  const ctx = new Context()
  roots.push(ctx)
  const openSession = vi.fn()
  ctx.provide('sessions', { list: createSnapshotStore({ ids, byId: { mumbo: { id: MUMBO_SESSION_ID, retainedBy: {} } }, phase: 'ready' }) } as never)
  ctx.provide('workspaces', { list: createSnapshotStore({ phase: 'ready' }) } as never)
  ctx.provide('uiWorkspace', { openSession } as never)
  await ctx.plugin({ inject, apply })
  await Promise.resolve()
  expect(openSession.mock.calls).toEqual([[MUMBO_SESSION_ID]])
})

it('neither listens nor opens after unload', async () => {
  const { openSession, plugin, settle } = await page()
  await plugin.dispose()
  await settle()
  expect(openSession).not.toHaveBeenCalled()
})
