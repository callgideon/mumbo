/** Mumbo's ensure, prompt section, and archive veto over the real Workspace registry, Session store, and Agent registry. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import WorkspaceRegistry, { type WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import * as Assistant from '../src/index.ts'

const INSTRUCTIONS = 'You are Mumbo, this person\'s assistant. Keep {{this}} literal.'
const contexts: Context[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

/** A Web Host stand-in: real registries and Session store, with a session controller over them that records its calls. */
async function host() {
  const workspace = await mkdtemp(join(tmpdir(), 'mumbo-assistant-'))
  dirs.push(workspace)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend())
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  ctx.provide('sessionPersistence', { list: () => Promise.resolve([]) } as never)
  await ctx.plugin(SessionStore)
  await ctx.plugin(WorkspaceRegistry)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(NativeToolExecutor)

  const calls: string[] = []
  const titles = new Map<SessionId, string>()
  const unregister = new Map<SessionId, () => unknown>()
  const resume = async (id: SessionId): Promise<Agent> => {
    const agent = { id, session: ctx.sessions.get(id)!, status: 'idle', ctx } as Agent
    const dispose = ctx.agents.register(agent)
    unregister.set(id, dispose)
    await dispose
    return agent
  }
  const remove = async (id: SessionId): Promise<void> => { await unregister.get(id)?.() }
  let resolveError: Error | undefined
  ctx.provide('sessionController', {
    resolveAgent: async (id: SessionId) => {
      calls.push(`resolve:${id}`)
      if (resolveError !== undefined) return { error: resolveError }
      const live = ctx.agents.get(id)
      if (live !== undefined) return { agent: live }
      if (ctx.sessions.get(id) === undefined) return { error: Object.assign(new Error('not found'), { code: 'session/not-found' }) }
      return { agent: await resume(id) }
    },
    create: async (request: { sessionId: SessionId; workspaceId: WorkspaceId; agentPreset?: string }) => {
      calls.push(`create:${request.sessionId}:${String(request.agentPreset)}`)
      const target = ctx.workspaceRegistry.get(request.workspaceId)!
      ctx.sessions.create(request.sessionId, { meta: { cwd: target.path } })
      await target.attachSession(request.sessionId)
      await resume(request.sessionId)
      return { sessionId: request.sessionId }
    },
    rename: async (request: { sessionId: SessionId; title: string }) => {
      calls.push(`rename:${request.sessionId}:${request.title}`)
      titles.set(request.sessionId, request.title)
      return { title: request.title, seq: 0 }
    },
  } as never)
  const start = (instructions = INSTRUCTIONS): Promise<Fiber> =>
    ctx.plugin(Assistant, { instructions, workspace }).await()
  const prompt = async () => renderPrompt(await ctx.systemPrompt.assemble())
  return {
    ctx, workspace, calls, titles, start, prompt, resume, remove,
    failResolve: (code: string) => { resolveError = Object.assign(new Error(code), { code }) },
  }
}

const MUMBO = Assistant.MUMBO_SESSION_ID

describe('ensuring Mumbo at start', () => {
  it('creates, titles, and pins Mumbo in the configured Workspace on a fresh store', async () => {
    const { ctx, workspace, calls, titles, start } = await host()
    await start()
    expect(calls).toEqual(['resolve:mumbo', 'create:mumbo:undefined', 'rename:mumbo:Mumbo'])
    expect(titles.get(MUMBO)).toBe('Mumbo')
    expect(ctx.workspaceRegistry.list().map(item => [item.path, item.sessionIds])).toEqual([[workspace, [MUMBO]]])
    expect(ctx.workspaceRegistry.pinnedSessionIds).toEqual([MUMBO])
  })

  it('neither duplicates nor retitles Mumbo on a restart, so the person\'s title stays', async () => {
    const { ctx, calls, titles, start } = await host()
    const first = await start()
    titles.set(MUMBO, 'My desk')
    await first.dispose()
    calls.length = 0
    await start()
    expect(calls).toEqual(['resolve:mumbo'])
    expect(titles.get(MUMBO)).toBe('My desk')
    expect(ctx.sessions.list().map(session => session.id)).toEqual([MUMBO])
  })

  it('pins an unpinned Mumbo again at the next start, ahead of other pins', async () => {
    const { ctx, start } = await host()
    const first = await start()
    ctx.sessions.create(SessionId('side'), {})
    await ctx.workspaceRegistry.unpinSession(MUMBO)
    await ctx.workspaceRegistry.pinSession(SessionId('side'))
    await first.dispose()
    await start()
    expect(ctx.workspaceRegistry.pinnedSessionIds).toEqual([MUMBO, 'side'])
  })

  it('unarchives and pins an archived Mumbo at the next start', async () => {
    const { ctx, start } = await host()
    const first = await start()
    await first.dispose()
    await ctx.workspaceRegistry.archiveSession(MUMBO)
    expect(ctx.workspaceRegistry.pinnedSessionIds).toEqual([])
    await start()
    expect(ctx.workspaceRegistry.archivedSessionIds).toEqual([])
    expect(ctx.workspaceRegistry.pinnedSessionIds).toEqual([MUMBO])
  })

  it('fails the start without creating anything when Mumbo cannot be resolved for another reason', async () => {
    const { ctx, calls, start, failResolve } = await host()
    failResolve('session/writer-held')
    await expect(start()).rejects.toMatchObject({ code: 'session/writer-held' })
    expect(calls).toEqual(['resolve:mumbo'])
    expect(ctx.sessions.list()).toEqual([])
  })

  it('fails the start when the configured Workspace directory does not exist', async () => {
    const { ctx, workspace } = await host()
    await expect(ctx.plugin(Assistant, { instructions: INSTRUCTIONS, workspace: join(workspace, 'missing') }).await())
      .rejects.toThrow(/missing/)
    expect(ctx.sessions.list()).toEqual([])
  })

  it('rejects blank instructions and a relative Workspace at load', () => {
    expect(() => Assistant.Config({ instructions: ' \n', workspace: '/root/projects' })).toThrow()
    expect(() => Assistant.Config({ instructions: INSTRUCTIONS, workspace: 'projects' })).toThrow()
    expect(() => Assistant.Config({} as Assistant.Config)).toThrow()
    // The edge may omit the Workspace.
    expect(Assistant.Config({ instructions: INSTRUCTIONS } as Assistant.Config)).toEqual({ instructions: INSTRUCTIONS, workspace: '/root/projects' })
  })

  it('accepts the example person-box row the edge copies', () => {
    const example = fileURLToPath(new URL('../examples/person.overlay.yml', import.meta.url))
    const [row] = loadOverlayPatches('mumbo-assistant-test', example).flatMap(patch => patch.insert ?? [])
    expect(row?.name).toBe('@mumbo/assistant')
    const config = Assistant.Config(row?.config as Assistant.Config)
    expect(config.workspace).toBe('/root/projects')
    expect(config.instructions).toMatch(/^You are Mumbo/)
  })
})

describe('Mumbo\'s prompt section', () => {
  it('adds the instructions verbatim to Mumbo on create and resume, never to another Session, and removes them on unload', async () => {
    const { ctx, start, prompt, resume, remove } = await host()
    const fiber = await start()
    expect(await prompt()).toContain(INSTRUCTIONS)
    // Every Agent here shares the root prompt layer: instructing another Agent would register the section twice and fail.
    ctx.sessions.create(SessionId('side'), {})
    await resume(SessionId('side'))
    // A resumed Agent replaces its predecessor's section instead of duplicating it.
    await remove(MUMBO)
    await resume(MUMBO)
    expect((await prompt()).split(INSTRUCTIONS)).toHaveLength(2)

    await fiber.dispose()
    expect(await prompt()).not.toContain('You are Mumbo')
  })

  it('instructs a Mumbo Agent resumed before the plugin started', async () => {
    const { ctx, start, prompt, resume, remove } = await host()
    const first = await start('First instructions.')
    await first.dispose()
    expect(ctx.agents.get(MUMBO)).toBeDefined()
    await start()
    expect(await prompt()).toContain(INSTRUCTIONS)
    expect(await prompt()).not.toContain('First instructions.')
    await remove(MUMBO)
    await resume(MUMBO)
    expect(await prompt()).toContain(INSTRUCTIONS)
  })
})

describe('the archive veto', () => {
  it.each([
    ['without', {}],
    ['with', { stopActivity: true }],
  ])('refuses to archive Mumbo %s stopActivity and stops none of its work', async (_label, options) => {
    const { ctx, start } = await host()
    const fiber = await start()
    const stopped: SessionId[] = []
    ctx.on('workspace/session-stop', ({ sessionId }) => { stopped.push(sessionId) })
    await expect(ctx.workspaceRegistry.archiveSession(MUMBO, options))
      .rejects.toThrow(`cannot archive session 'mumbo': ${Assistant.ARCHIVE_REFUSAL}`)
    expect(stopped).toEqual([])
    expect(ctx.workspaceRegistry.archivedSessionIds).toEqual([])
    expect(ctx.workspaceRegistry.pinnedSessionIds).toEqual([MUMBO])

    // Other Sessions archive as before, and the veto goes with the plugin.
    ctx.sessions.create(SessionId('side'), {})
    await ctx.workspaceRegistry.archiveSession(SessionId('side'), options)
    await fiber.dispose()
    await ctx.workspaceRegistry.archiveSession(MUMBO, options)
    expect(ctx.workspaceRegistry.archivedSessionIds).toEqual(['side', MUMBO])
  })
})
