/**
 * Mumbo's ensure, prompt section, and archive veto over the real Workspace registry, Session store, and Agent registry,
 * and its start in a Loader composition whose default preset has a row waiting for a missing service.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context, FiberState, type Fiber } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { createScope } from '@deepseek-ai/dsh-scope'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentPreset from '@deepseek-ai/dsh-agent-preset'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import WorkspaceRegistry, { type WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import * as Assistant from '../src/index.ts'

const INSTRUCTIONS = 'You are Mumbo, this person\'s assistant. Keep {{this}} literal.'
const ENSURED = "mumbo-assistant: ensured Session 'mumbo'"
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
  const unregister = new Map<SessionId, () => Promise<void>>()
  // Like a production Agent, each one owns a prompt layer scoped to it, disposed with it.
  const owner = (await ctx.plugin({ inject: ['systemPrompt'], apply: () => {} })).ctx
  const resume = async (id: SessionId): Promise<Agent> => {
    const agent = { id, session: ctx.sessions.get(id)!, status: 'idle' } as Agent
    const scope = createScope(owner, agent)
    Object.assign(agent, { ctx: scope.ctx })
    const dispose = ctx.agents.register(agent)
    unregister.set(id, async () => { await dispose(); await scope.dispose() })
    await dispose
    return agent
  }
  const remove = async (id: SessionId): Promise<void> => { await unregister.get(id)?.() }
  let resolveError: Error | undefined
  let gate: Promise<unknown> | undefined
  ctx.provide('sessionController', {
    resolveAgent: async (id: SessionId) => {
      calls.push(`resolve:${id}`)
      await gate
      if (resolveError !== undefined) return { error: resolveError }
      const live = ctx.agents.get(id)
      if (live !== undefined) return { agent: live }
      if (ctx.sessions.get(id) === undefined) return { error: Object.assign(new Error('not found'), { code: 'session/not-found' }) }
      return { agent: await resume(id) }
    },
    create: async (request: { sessionId: SessionId; workspaceId: WorkspaceId; agentPreset?: string }) => {
      calls.push(`create:${request.sessionId}:${String(request.agentPreset)}`)
      // Like the real controller, a composed preset registry resolves the Agent's preset first and refuses a broken one.
      const preset = await ctx.get('agentPresets')?.resolve(request.agentPreset)
      if (preset?.broken !== undefined) throw new Error(preset.broken)
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
  // Each ensure ends in one info or error line of the plugin's own.
  const info = vi.spyOn(ctx.logger, 'info')
  const error = vi.spyOn(ctx.logger, 'error')
  const outcomes = (): number => [...info.mock.calls, ...error.mock.calls].filter(([line]) => String(line).startsWith('mumbo-assistant:')).length
  const load = (instructions = INSTRUCTIONS, retryDelaysMs: number[] = []): Promise<Fiber> =>
    ctx.plugin(Assistant, { instructions, workspace, retryDelaysMs }).await()
  /** Load the plugin and wait for its first ensure to end, which the start itself does not wait for. */
  const start = async (instructions = INSTRUCTIONS, retryDelaysMs: number[] = []): Promise<Fiber> => {
    const before = outcomes()
    const fiber = await load(instructions, retryDelaysMs)
    await vi.waitFor(() => { expect(outcomes()).toBeGreaterThan(before) })
    return fiber
  }
  const prompt = async (id: SessionId = MUMBO) => renderPrompt(await ctx.systemPrompt.assemble({ scope: ctx.agents.get(id)! }))
  return {
    ctx, facility, workspace, calls, titles, load, start, outcomes, prompt, resume, remove,
    failResolve: (code: string) => { resolveError = Object.assign(new Error(code), { code }) },
    clearFailure: () => { resolveError = undefined },
    /** Hold every later resolve until `held` settles, as a slow resume would. */
    hold: (held: Promise<unknown> | undefined) => { gate = held },
  }
}

const MUMBO = Assistant.MUMBO_SESSION_ID

/** A box an earlier version of the plugin started: Mumbo exists and is pinned, beside a pin of the person's own. */
async function pinnedEarlier(ctx: Context): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), 'mumbo-assistant-earlier-'))
  dirs.push(workspace)
  const target = await ctx.workspaceRegistry.create(workspace)
  ctx.sessions.create(MUMBO, { meta: { cwd: workspace } })
  await target.attachSession(MUMBO)
  ctx.sessions.create(SessionId('side'), {})
  await ctx.workspaceRegistry.pinSession(SessionId('side'))
  await ctx.workspaceRegistry.pinSession(MUMBO)
}

describe('ensuring Mumbo at start', () => {
  it('creates and titles Mumbo in the configured Workspace on a fresh store, and leaves it unpinned', async () => {
    const { ctx, workspace, calls, titles, start } = await host()
    await start()
    expect(calls).toEqual(['resolve:mumbo', 'create:mumbo:undefined', 'rename:mumbo:Mumbo'])
    expect(titles.get(MUMBO)).toBe('Mumbo')
    expect(ctx.workspaceRegistry.list().map(item => [item.path, item.sessionIds])).toEqual([[workspace, [MUMBO]]])
    expect(ctx.workspaceRegistry.pinnedSessionIds).toEqual([])
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

  it('unpins a Mumbo an earlier version pinned once, and keeps a pin the person sets afterwards', async () => {
    const { ctx, start } = await host()
    await pinnedEarlier(ctx)
    const first = await start()
    expect(ctx.workspaceRegistry.pinnedSessionIds).toEqual(['side'])
    await ctx.workspaceRegistry.pinSession(MUMBO)
    await first.dispose()
    await start()
    expect([...ctx.workspaceRegistry.pinnedSessionIds].sort()).toEqual([MUMBO, 'side'])
  })

  it('retries a failed unpin without unpinning twice, and records it only once it held', async () => {
    const { ctx, start } = await host()
    await pinnedEarlier(ctx)
    const error = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    const registry = ctx.workspaceRegistry
    const unpin = vi.spyOn(registry, 'unpinSession').mockRejectedValueOnce(new Error('disk full'))
    const first = await start(INSTRUCTIONS, [5])
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/retrying in 5 ms: .*disk full/))
    await vi.waitFor(() => { expect(ctx.logger.info).toHaveBeenCalledWith(ENSURED) })
    expect(registry.pinnedSessionIds).toEqual(['side'])
    expect(unpin).toHaveBeenCalledTimes(2)
    await first.dispose()
    await registry.pinSession(MUMBO)
    await start()
    expect(unpin).toHaveBeenCalledTimes(2)
  })

  it('fails the start when its domain does not open, and leaves no veto behind', async () => {
    const { ctx, facility, start } = await host()
    vi.spyOn(facility, 'open').mockRejectedValueOnce(new Error('backend gone'))
    await expect(start()).rejects.toThrow('backend gone')
    ctx.sessions.create(MUMBO, {})
    await ctx.workspaceRegistry.archiveSession(MUMBO)
    expect(ctx.workspaceRegistry.archivedSessionIds).toEqual([MUMBO])
  })

  it('unarchives an archived Mumbo at the next start', async () => {
    const { ctx, start } = await host()
    const first = await start()
    await first.dispose()
    await ctx.workspaceRegistry.archiveSession(MUMBO)
    await start()
    expect(ctx.workspaceRegistry.archivedSessionIds).toEqual([])
    expect(ctx.workspaceRegistry.pinnedSessionIds).toEqual([])
  })

  it('keeps the veto and the section through a failed ensure, reports it, and succeeds on a later retry', async () => {
    const { ctx, calls, start, prompt, failResolve, clearFailure } = await host()
    // A held writer lease: the previous process still owns Mumbo's log.
    const first = await start()
    await first.dispose()
    failResolve('session/writer-held')
    const error = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    calls.length = 0
    await start(INSTRUCTIONS, [20])
    expect(calls).toEqual(['resolve:mumbo'])
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/could not ensure Session 'mumbo'; retrying in 20 ms: .*session\/writer-held/))
    expect(await prompt()).toContain(INSTRUCTIONS)
    const stopped: SessionId[] = []
    ctx.on('workspace/session-stop', ({ sessionId }) => { stopped.push(sessionId) })
    await expect(ctx.workspaceRegistry.archiveSession(MUMBO, { stopActivity: true })).rejects.toThrow(Assistant.ARCHIVE_REFUSAL)
    expect(stopped).toEqual([])
    // The lease is released before the retry, which then ensures as usual.
    clearFailure()
    await vi.waitFor(() => { expect(calls).toEqual(['resolve:mumbo', 'resolve:mumbo']) })
  })

  it('restarts without waiting for a running ensure, which writes nothing once its resolve returns', async () => {
    const { ctx, calls, load, outcomes, hold } = await host()
    const error = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    // Every resolve hangs, as one waiting for the Loader to settle would.
    const slow = Promise.withResolvers<undefined>()
    hold(slow.promise)
    const fiber = await load(INSTRUCTIONS, [5])
    expect(calls).toEqual(['resolve:mumbo'])
    await fiber.restart()
    expect(calls).toEqual(['resolve:mumbo', 'resolve:mumbo'])
    hold(undefined)
    slow.resolve(undefined)
    await vi.waitFor(() => { expect(outcomes()).toBe(1) })
    // Only the restarted start creates Mumbo; the unloaded attempt neither creates, reports, nor retries.
    expect(ctx.logger.info).toHaveBeenCalledWith(ENSURED)
    expect(calls).toEqual(['resolve:mumbo', 'resolve:mumbo', 'create:mumbo:undefined', 'rename:mumbo:Mumbo'])
    expect(ctx.sessions.list().map(session => session.id)).toEqual([MUMBO])
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(calls).toHaveLength(4)
    expect(error).not.toHaveBeenCalled()
  })

  it('stops after the configured retries and cancels a pending retry on unload', async () => {
    const { ctx, workspace, calls } = await host()
    const error = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    // A missing Workspace directory fails creation on every attempt.
    const exhausted = await ctx.plugin(Assistant, { instructions: INSTRUCTIONS, workspace: join(workspace, 'missing'), retryDelaysMs: [5] }).await()
    await vi.waitFor(() => { expect(error).toHaveBeenCalledTimes(2) })
    expect(error).toHaveBeenLastCalledWith(expect.stringMatching(/no retry is left until the next start: .*missing/))
    expect(ctx.sessions.list()).toEqual([])
    expect(calls).toEqual(['resolve:mumbo', 'resolve:mumbo'])
    await exhausted.dispose()

    const pending = await ctx.plugin(Assistant, { instructions: INSTRUCTIONS, workspace: join(workspace, 'missing'), retryDelaysMs: [100] }).await()
    await vi.waitFor(() => {
      expect(error).toHaveBeenLastCalledWith(expect.stringMatching(/retrying in 100 ms: .*missing/))
    }, { interval: 5 })
    await pending.dispose()
    calls.length = 0
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(calls).toEqual([])
  })

  it('rejects blank instructions, a relative Workspace, and a zero retry delay at load', () => {
    expect(() => Assistant.Config({ instructions: ' \n', workspace: '/root/projects' } as Assistant.Config)).toThrow()
    expect(() => Assistant.Config({ instructions: INSTRUCTIONS, workspace: 'projects' } as Assistant.Config)).toThrow()
    expect(() => Assistant.Config({} as Assistant.Config)).toThrow()
    expect(() => Assistant.Config({ instructions: INSTRUCTIONS, retryDelaysMs: [0] } as Assistant.Config)).toThrow()
    // The edge may omit the Workspace and the retry delays.
    expect(Assistant.Config({ instructions: INSTRUCTIONS } as Assistant.Config)).toEqual({
      instructions: INSTRUCTIONS, workspace: '/root/projects', retryDelaysMs: [1000, 2000, 5000, 10000, 30000],
    })
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

describe('starting in a Loader composition', () => {
  it('lets the Loader settle while the default preset has a row waiting for a missing service, then reports the preset', async () => {
    const { ctx, workspace, calls, outcomes } = await host()
    const error = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    await ctx.plugin(Loader)
    await ctx.plugin(AgentPresets, { default: 'standard' })
    ctx.loader.builtins.preset = AgentPreset
    ctx.loader.builtins.needsMissing = { name: 'needs-missing', inject: ['serviceThatDoesNotExist'], apply: () => {} }
    ctx.loader.builtins.assistant = Assistant
    await ctx.loader.create({ name: 'cordis:preset', config: { id: 'standard', plugins: [{ id: 'waiting', name: 'cordis:needsMissing' }] } })
    // The registry's diagnostic of that row waits for the Loader to settle, and the Loader waits for this row's start.
    let row = ''
    const settling = ctx.loader.create({ name: 'cordis:assistant', config: { instructions: INSTRUCTIONS, workspace, retryDelaysMs: [] } })
      .then(async (id) => { row = id; await ctx.loader.await(); return 'settled' })
    let timer: ReturnType<typeof setTimeout> | undefined
    const hung = new Promise<string>((resolve) => { timer = setTimeout(() => { resolve('hung') }, 2000) })
    expect(await Promise.race([settling, hung])).toBe('settled')
    clearTimeout(timer)
    expect(ctx.loader.resolve(row).fiber?.state).toBe(FiberState.ACTIVE)
    // The ensure then gets the registry's report and logs it.
    await vi.waitFor(() => { expect(outcomes()).toBe(1) })
    expect(error).toHaveBeenCalledWith(expect.stringMatching(
      /could not ensure Session 'mumbo'; no retry is left until the next start: .*waiting for serviceThatDoesNotExist/,
    ))
    expect(calls).toEqual(['resolve:mumbo', 'create:mumbo:undefined'])
  })
})

describe('Mumbo\'s prompt section', () => {
  it('adds the instructions verbatim to Mumbo on create and resume, never to another Session, and removes them on unload', async () => {
    const { ctx, start, prompt, resume, remove } = await host()
    const fiber = await start()
    expect(await prompt()).toContain(INSTRUCTIONS)
    ctx.sessions.create(SessionId('side'), {})
    await resume(SessionId('side'))
    expect(await prompt(SessionId('side'))).not.toContain('You are Mumbo')
    expect(await prompt()).toContain(INSTRUCTIONS)
    // The section goes with its Agent, and a resumed Agent gets it again.
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

    // Other Sessions archive as before, and the veto goes with the plugin.
    ctx.sessions.create(SessionId('side'), {})
    await ctx.workspaceRegistry.archiveSession(SessionId('side'), options)
    await fiber.dispose()
    await ctx.workspaceRegistry.archiveSession(MUMBO, options)
    expect(ctx.workspaceRegistry.archivedSessionIds).toEqual(['side', MUMBO])
  })
})
