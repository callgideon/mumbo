import { expect, it, vi } from 'vitest'
import { Config, type Machine } from '../src/deployment.ts'
import { apply } from '../src/index.ts'

// Stub Runtime to capture the resolved Machine settings and restart callback; `next.ready` is the next Runtime's start.
const runtimes = vi.hoisted(() => [] as { machine: Machine; restart: () => void }[])
const next = vi.hoisted(() => ({}) as { ready?: Promise<void> })
vi.mock('../src/app/runtime.ts', () => ({ Runtime: class {
  ready = next.ready ?? Promise.resolve()
  readonly stopped = new AbortController()
  get lifetime() { return this.stopped.signal }
  constructor(_ctx: unknown, readonly machine: Machine, readonly restart: () => void) { runtimes.push(this) }
  configured() { return true }
  async stop() {}
} }))
/** Simulate the Cordis loader updating a volatile configuration reference in place. */
const commit = (reference: unknown, value: unknown) => { (reference as Record<symbol, (value: unknown) => void>)[Symbol.for('cosmokit.volatile.write')]!(value) }

function context(childIdentity?: { uid: number; gid: number; groups: number[] }) {
  const handlers = new Map<string, () => void>()
  const configure = vi.fn(() => () => {})
  const describe = vi.fn(() => [])
  const ctx = {
    on: vi.fn((name: string, handler: () => void) => { handlers.set(name, handler) }),
    inject: vi.fn((_services: string[], callback: (child: unknown) => void) => { callback({ effect: (effect: () => unknown) => effect(), settings: { configure } }) }),
    effect: vi.fn(),
    fiber: { restart: vi.fn(async () => {}) },
    get: vi.fn((name: string) => name === 'settings' ? { describe } : undefined),
    logger: { info: vi.fn(), error: vi.fn() },
    subprocess: { childIdentity },
  }
  return { ctx, handlers, configure, describe }
}

it('reads a limit DSH commits a new value of without a restart, and asks DSH to generate no settings page', async () => {
  const { ctx, handlers, configure } = context()
  const config = Config({ stateDir: '/srv/state', promptMaxChars: 5000 })
  await apply(ctx as never, config)
  expect(configure).toHaveBeenCalledExactlyOnceWith({ auto: false }, ctx.fiber)
  const { machine } = runtimes.at(-1)!
  expect(machine.promptMaxChars.get()).toBe(5000)
  commit(config.promptMaxChars, 8000)
  expect(machine.promptMaxChars.get()).toBe(8000)
  expect(handlers.has('loader/volatile-update')).toBe(false)
  expect(ctx.fiber.restart).not.toHaveBeenCalled()
})

it('asks DSH to read its settings entry again once a restart it started finished', async () => {
  const { ctx, describe } = context()
  let finish = () => {}
  ctx.fiber.restart.mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
  await apply(ctx as never, Config({ stateDir: '/srv/state' }))
  // Saving a Source account change restarts dsh-superagent, which re-runs setup and refreshes the settings descriptor.
  runtimes.at(-1)!.restart()
  await Promise.resolve()
  expect(describe).not.toHaveBeenCalled()
  finish()
  await vi.waitFor(() => { expect(describe).toHaveBeenCalledTimes(1) })
})

it('refuses to start under a run-as subprocess provider without a worker directory or the orchestrator\'s gh configuration', async () => {
  const { ctx } = context({ uid: 1001, gid: 1001, groups: [] })
  await expect(apply(ctx as never, Config({ stateDir: '/srv/state' }))).rejects.toThrow('workerDirectory must be set under a run-as subprocess provider')
  expect(ctx.on).not.toHaveBeenCalled()
})

it('refuses keys of the previous configuration before registering anything', async () => {
  const { ctx } = context()
  await expect(apply(ctx as never, Config({ stateDir: '/srv/state', github: { cli: 'gh' } } as never))).rejects.toThrow('github (now on the GitHub Source)')
  expect(ctx.on).not.toHaveBeenCalled()
  expect(ctx.inject).not.toHaveBeenCalled()
})

it('registers the relay Source as an effect of the entry, after the Runtime\'s stop', async () => {
  const { ctx } = context()
  await apply(ctx as never, Config({ stateDir: '/srv/state' }))
  expect(ctx.effect).toHaveBeenCalledTimes(2)
  expect(ctx.effect).toHaveBeenLastCalledWith(expect.any(Function), 'dsh-superagent: relay Source')
})

it('starts without waiting for the Runtime, and logs its start once it settles, unless it stopped first', async () => {
  const { ctx } = context()
  const ready = Promise.withResolvers<void>()
  next.ready = ready.promise
  await apply(ctx as never, Config({ stateDir: '/srv/state' }))
  expect(ctx.logger.info).not.toHaveBeenCalled()
  ready.resolve()
  await vi.waitFor(() => { expect(ctx.logger.info).toHaveBeenCalledWith(expect.stringMatching(/^dsh-superagent ready/)) })

  const failing = Promise.withResolvers<void>()
  next.ready = failing.promise
  await apply(ctx as never, Config({ stateDir: '/srv/state' }))
  failing.reject(new Error('preset refused'))
  await vi.waitFor(() => { expect(ctx.logger.error).toHaveBeenCalledWith('dsh-superagent could not start: %s', 'Error: preset refused') })

  // A Runtime stopped before its start settled reports neither.
  for (const settle of ['resolve', 'reject'] as const) {
    const stopping = Promise.withResolvers<void>()
    next.ready = stopping.promise
    await apply(ctx as never, Config({ stateDir: '/srv/state' }))
    ;(runtimes.at(-1) as unknown as { stopped: AbortController }).stopped.abort()
    if (settle === 'resolve') stopping.resolve()
    else stopping.reject(new Error('aborted'))
    await stopping.promise.catch(() => undefined)
    await Promise.resolve()
  }
  delete next.ready
  expect(ctx.logger.info).toHaveBeenCalledTimes(1)
  expect(ctx.logger.error).toHaveBeenCalledTimes(1)
})
