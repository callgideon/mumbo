import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToolError } from '../src/errors.ts'
import { type Idem, idemKey, mcpDomain, once, prune } from '../src/store.ts'

const DAY = 86_400_000

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Real JSON-backed storage under a temp root. */
async function storage(): Promise<Context> {
  root ??= await mkdtemp(join(tmpdir(), 'mumbo-mcp-store-'))
  context = new Context()
  await context.plugin(Storage)
  await context.plugin(StorageJson, { root })
  await context.plugin(StorageDomain, { backend: 'json' })
  return context
}

describe('idemKey', () => {
  it('is the hex SHA-256 of tool and request id joined by a newline', () => {
    expect(idemKey('agent_send', 'r1')).toBe('11e8cb122ad7586f0886e0c4a5775c577d852125c6238cf610d858ef059aa233')
    expect(idemKey('agent_send', 'r1')).not.toBe(idemKey('agent_read', 'r1'))
  })
})

/** Request-id memory over a fresh domain. */
async function memory(): Promise<Idem> {
  const domain = await (await storage()).storageDomain.open(mcpDomain)
  return { table: domain.table('idem'), running: new Map() }
}

describe('once', () => {
  it('runs once for equal calls and returns the first result', async () => {
    const idem = await memory()
    const run = vi.fn(async () => 'sent')
    expect(await once(idem, 'agent_send', 'ann', 'r1', { text: 'hi', wait: 1 }, run)).toBe('sent')
    expect(await once(idem, 'agent_send', 'ann', 'r1', { wait: 1, text: 'hi' }, run)).toBe('sent')
    expect(run).toHaveBeenCalledOnce()
  })

  it('refuses the same request id with other arguments, naming only the caller\'s id', async () => {
    const idem = await memory()
    await once(idem, 'agent_send', 'ann', 'r1', { text: 'hi' }, async () => 'sent')
    const reused = once(idem, 'agent_send', 'ann', 'r1', { text: 'other' }, async () => 'again')
    await expect(reused).rejects.toBeInstanceOf(ToolError)
    await expect(reused).rejects.toMatchObject({
      code: 'request_id_reused',
      message: 'request_id r1 was already used with other arguments; send a new request_id',
    })
  })

  it('keeps the request ids of different principals apart', async () => {
    const idem = await memory()
    expect(await once(idem, 'agent_send', 'ann', 'r1', {}, async () => 'ann')).toBe('ann')
    expect(await once(idem, 'agent_send', 'bob', 'r1', {}, async () => 'bob')).toBe('bob')
  })

  it('shares one run between concurrent equal calls and refuses a concurrent call with other arguments', async () => {
    const idem = await memory()
    const result = Promise.withResolvers<string>()
    const run = vi.fn(() => result.promise)
    const first = once(idem, 'agent_send', 'ann', 'r1', { text: 'hi' }, run)
    const second = once(idem, 'agent_send', 'ann', 'r1', { text: 'hi' }, run)
    await expect(once(idem, 'agent_send', 'ann', 'r1', { text: 'other' }, run)).rejects.toMatchObject({ code: 'request_id_reused' })
    result.resolve('sent')
    expect(await Promise.all([first, second])).toEqual(['sent', 'sent'])
    expect(run).toHaveBeenCalledOnce()
    expect(idem.running.size).toBe(0)
  })

  it('runs again once the stored result is a day old', async () => {
    const idem = await memory()
    const run = vi.fn(async () => `sent ${String(run.mock.calls.length)}`)
    expect(await once(idem, 'agent_send', 'ann', 'r1', {}, run, () => 1_000)).toBe('sent 1')
    expect(await once(idem, 'agent_send', 'ann', 'r1', {}, run, () => 1_000 + DAY - 1)).toBe('sent 1')
    expect(await once(idem, 'agent_send', 'ann', 'r1', {}, run, () => 1_000 + DAY)).toBe('sent 2')
  })

  it('keeps no record when the run fails, so a retry runs again', async () => {
    const idem = await memory()
    await expect(once(idem, 'agent_send', 'ann', 'r1', {}, async () => { throw new Error('offline') })).rejects.toThrow('offline')
    expect(await once(idem, 'agent_send', 'ann', 'r1', {}, async () => 'sent')).toBe('sent')
  })

  it('returns the stored result from a reopened domain', async () => {
    await once(await memory(), 'agent_send', 'ann', 'r1', { text: 'hi' }, async () => 'sent')
    await context?.fiber.dispose()
    const run = vi.fn(async () => 'again')
    expect(await once(await memory(), 'agent_send', 'ann', 'r1', { text: 'hi' }, run)).toBe('sent')
    expect(run).not.toHaveBeenCalled()
  })
})

describe('prune', () => {
  it('deletes rows at least a day old and keeps newer ones', async () => {
    const idem = await memory()
    await once(idem, 'agent_send', 'ann', 'old', {}, async () => 'old', () => 0)
    await once(idem, 'agent_send', 'ann', 'new', {}, async () => 'new', () => 1)
    await prune(idem.table, () => DAY)
    expect(idem.table.get(idemKey('agent_send', 'ann/old'))).toBeUndefined()
    expect(idem.table.get(idemKey('agent_send', 'ann/new'))).toMatchObject({ result: 'new', at: 1 })
  })
})

describe('assistant and halt tables', () => {
  it('store the assistant Session id and the halt flag under main as separate records', async () => {
    const domain = await (await storage()).storageDomain.open(mcpDomain)
    await domain.table('assistant').put('main', { sessionId: 'assistant' })
    await domain.table('halt').put('main', { halted: true })
    expect(domain.table('assistant').get('main')).toEqual({ sessionId: 'assistant' })
    expect(domain.table('halt').get('main')).toEqual({ halted: true })
  })
})
