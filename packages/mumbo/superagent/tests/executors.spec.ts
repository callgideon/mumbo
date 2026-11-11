/**
 * In Mumbo, the Executor port (`UPSTREAM.md` S11): `Executors` routes each Ticket's calls to the Executor of its kind and
 * reaches every kind with lifecycle calls; on a Runtime's start, only local Tickets are resumed; and schema 12 opens a schema
 * 11 database without rewriting a record.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Ticket } from '../src/core/index.ts'
import { Executors, heldExecutor } from '../src/mumbo/executors.ts'
import { SCHEMA_VERSION, Store } from '../src/app/store.ts'
import { KV } from '../src/kv.ts'
import { startRuntime } from './fixtures/host.ts'

/** An open Ticket with one Assignment in `state`, created at `at`. */
const ticket = (id: string, state: 'pending' | 'running', at: string, executor?: 'external'): Ticket => ({
  id, title: id, decisionId: '', channels: [], inputs: [], undelivered: [], createdAt: at, updatedAt: at,
  mandate: { strength: 'explicit', policyVersion: '', basis: { via: 'listed' }, actor: { source: 'feishu', id: 'ou_alice' }, scope: '' },
  assignments: [{ id: `${id}-1`, state, createdAt: at, ...state === 'running' ? { startedAt: at } : {} }],
  origin: { triggerId: '', triggerIds: [] }, ...executor ? { executor } : {} })
const plugin = () => ({ start: vi.fn(), deliver: vi.fn(), stop: vi.fn(), install: vi.fn(), resume: vi.fn(),
  shutdown: vi.fn(async () => {}), dispose: vi.fn() })

describe('Executors', () => {
  it('sends the calls for a Ticket without `executor` to the local Executor, and for an external one to the external Executor', () => {
    const local = plugin(), external = plugin()
    const executors = new Executors({ local, external })
    const mine = ticket('a', 'running', '1'), theirs = ticket('b', 'running', '2', 'external')
    for (const item of [mine, theirs]) {
      const assignment = item.assignments[0]!
      executors.start(item, assignment); executors.deliver(item, assignment); executors.stop(item, assignment, 'stopped')
    }
    for (const [executor, item] of [[local, mine], [external, theirs]] as const) {
      expect(executor.start.mock.calls).toEqual([[item, item.assignments[0]]])
      expect(executor.deliver.mock.calls).toEqual([[item, item.assignments[0]]])
      expect(executor.stop.mock.calls).toEqual([[item, item.assignments[0], 'stopped']])
    }
  })

  it('installs, shuts down and disposes every kind, and resumes each kind with only its own Tickets', async () => {
    const local = plugin(), external = plugin()
    const executors = new Executors({ local, external })
    const tickets = [ticket('a', 'running', '1'), ticket('b', 'pending', '2', 'external'), ticket('c', 'pending', '3')]
    executors.install()
    executors.resume(tickets)
    await executors.shutdown()
    executors.dispose()
    expect(local.resume.mock.calls).toEqual([[[tickets[0], tickets[2]]]])
    expect(external.resume.mock.calls).toEqual([[[tickets[1]]]])
    for (const executor of [local, external]) {
      for (const call of [executor.install, executor.shutdown, executor.dispose]) expect(call).toHaveBeenCalledOnce()
    }
  })

  it('lets every kind finish its shutdown when one fails, then fails with that failure', async () => {
    const failure = new Error('stuck worker')
    const local = { ...plugin(), shutdown: vi.fn(async () => { throw failure }) }
    let finished = false
    const external = { ...plugin(), shutdown: vi.fn(async () => { await new Promise(resolve => setTimeout(resolve, 10)); finished = true }) }
    await expect(new Executors({ local, external }).shutdown()).rejects.toBe(failure)
    expect(finished).toBe(true)
  })

  it('holds external Tickets while no external-worker Executor exists: no call does anything', async () => {
    const item = ticket('b', 'pending', '1', 'external'), assignment = item.assignments[0]!
    heldExecutor.install()
    heldExecutor.start(item, assignment); heldExecutor.deliver(item, assignment); heldExecutor.stop(item, assignment, 'stopped')
    heldExecutor.resume([item])
    await expect(heldExecutor.shutdown()).resolves.toBeUndefined()
    heldExecutor.dispose()
    expect(item).toEqual(ticket('b', 'pending', '1', 'external'))
  })
})

it('on a host start, interrupts a running local Assignment as before, neither interrupts nor launches an external one, and later sends the Engine\'s calls on an external Ticket to no DshExecutor', async () => {
  // Paused, so the queued launches stay in the effect queue for the test to read.
  const host = await startRuntime(store => {
    store.saveSettings({ ...store.settings(), paused: true })
    for (const item of [ticket('local', 'running', '2026-11-01T00:00:00.000Z'), ticket('leased', 'running', '2026-11-01T00:00:01.000Z', 'external'),
      ticket('queued', 'pending', '2026-11-01T00:00:02.000Z', 'external')]) store.tickets.save(item)
  })
  try {
    const { store } = host.runtime
    const local = store.tickets.get('local')!
    expect(local.assignments.map(item => [item.id, item.state, item.endedReason])).toEqual([['local-1', 'ended', 'hostRestarted'],
      [local.assignments[1]!.id, 'pending', undefined]])
    expect(store.tickets.get('leased')).toEqual(ticket('leased', 'running', '2026-11-01T00:00:01.000Z', 'external'))
    expect(store.tickets.get('queued')).toEqual(ticket('queued', 'pending', '2026-11-01T00:00:02.000Z', 'external'))
    expect(store.db.prepare("SELECT key FROM effect WHERE kind = 'launch'").all().map(row => row.key)).toEqual([local.assignments[1]!.id])
    // The Engine's own calls route by kind: an Input to a pending (start) or a running (deliver) Assignment, and a stop.
    const { engine, executor } = host.runtime
    const dsh = { start: vi.spyOn(executor, 'start'), deliver: vi.spyOn(executor, 'deliver'), stop: vi.spyOn(executor, 'stop') }
    engine.note('queued', 'held'); engine.note('leased', 'held'); engine.stopTicket('leased')
    engine.note('local', 'launched')
    expect([dsh.start.mock.calls.map(([item]) => item.id), dsh.deliver.mock.calls, dsh.stop.mock.calls]).toEqual([['local'], [], []])
  } finally { await host.stop() }
})

describe('schema 12', () => {
  let directory: string
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'orchestrator-executors-')) })
  afterEach(() => { rmSync(directory, { recursive: true, force: true }) })
  /** Every `kv` record but the schema, and every Ticket row. */
  const records = (store: Store) => ({ kv: store.db.prepare("SELECT * FROM kv WHERE key <> 'schema' ORDER BY key").all(),
    ticket: store.db.prepare('SELECT * FROM ticket ORDER BY id').all() })

  it('opens a schema 12 database as it is', () => {
    expect(SCHEMA_VERSION).toBe(12)
    const path = join(directory, 'orchestrator.sqlite')
    const created = new Store(path)
    created.tickets.save(ticket('queued', 'pending', '1', 'external'))
    const before = records(created)
    created.close()
    const store = new Store(path)
    expect([store.get(KV.store.schema), records(store)]).toEqual([12, before])
    store.close()
  })

  it('opens a schema 11 database as schema 12 without running the schema 11 migration or changing a record', () => {
    const path = join(directory, 'orchestrator.sqlite')
    const created = new Store(path)
    created.tickets.save(ticket('local', 'running', '1'))
    // Records the schema 11 migration would delete or rename.
    created.set('prompt-version-read:worker-a:3', true)
    created.set('task/old', 'kept')
    created.set(KV.store.schema, 11)
    const before = records(created)
    created.close()
    const store = new Store(path)
    expect([store.get(KV.store.schema), records(store)]).toEqual([12, before])
    store.close()
  })
})
