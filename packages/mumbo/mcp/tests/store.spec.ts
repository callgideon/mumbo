import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToolError } from '../src/errors.ts'
import { idemKey, mcpDomain, once, prune } from '../src/store.ts'

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

describe('once', () => {
  it('runs once for equal calls and returns the first result', async () => {
    const domain = await (await storage()).storageDomain.open(mcpDomain)
    const table = domain.table('idem')
    const run = vi.fn(async () => 'sent')
    expect(await once(table, 'agent_send', 'r1', { text: 'hi', wait: 1 }, run)).toBe('sent')
    expect(await once(table, 'agent_send', 'r1', { wait: 1, text: 'hi' }, run)).toBe('sent')
    expect(run).toHaveBeenCalledOnce()
  })

  it('refuses the same request id with other arguments', async () => {
    const domain = await (await storage()).storageDomain.open(mcpDomain)
    const table = domain.table('idem')
    await once(table, 'agent_send', 'r1', { text: 'hi' }, async () => 'sent')
    const reused = once(table, 'agent_send', 'r1', { text: 'other' }, async () => 'again')
    await expect(reused).rejects.toBeInstanceOf(ToolError)
    await expect(reused).rejects.toMatchObject({ code: 'request_id_reused' })
  })

  it('runs again once the stored result is a day old', async () => {
    const domain = await (await storage()).storageDomain.open(mcpDomain)
    const table = domain.table('idem')
    const run = vi.fn(async () => `sent ${String(run.mock.calls.length)}`)
    expect(await once(table, 'agent_send', 'r1', {}, run, () => 1_000)).toBe('sent 1')
    expect(await once(table, 'agent_send', 'r1', {}, run, () => 1_000 + DAY - 1)).toBe('sent 1')
    expect(await once(table, 'agent_send', 'r1', {}, run, () => 1_000 + DAY)).toBe('sent 2')
  })

  it('keeps no record when the run fails, so a retry runs again', async () => {
    const domain = await (await storage()).storageDomain.open(mcpDomain)
    const table = domain.table('idem')
    await expect(once(table, 'agent_send', 'r1', {}, async () => { throw new Error('offline') })).rejects.toThrow('offline')
    expect(await once(table, 'agent_send', 'r1', {}, async () => 'sent')).toBe('sent')
  })

  it('returns the stored result from a reopened domain', async () => {
    const first = await (await storage()).storageDomain.open(mcpDomain)
    await once(first.table('idem'), 'agent_send', 'r1', { text: 'hi' }, async () => 'sent')
    await context?.fiber.dispose()
    const reopened = await (await storage()).storageDomain.open(mcpDomain)
    const run = vi.fn(async () => 'again')
    expect(await once(reopened.table('idem'), 'agent_send', 'r1', { text: 'hi' }, run)).toBe('sent')
    expect(run).not.toHaveBeenCalled()
  })
})

describe('prune', () => {
  it('deletes rows at least a day old and keeps newer ones', async () => {
    const domain = await (await storage()).storageDomain.open(mcpDomain)
    const table = domain.table('idem')
    await once(table, 'agent_send', 'old', {}, async () => 'old', () => 0)
    await once(table, 'agent_send', 'new', {}, async () => 'new', () => 1)
    await prune(table, () => DAY)
    expect(table.get(idemKey('agent_send', 'old'))).toBeUndefined()
    expect(table.get(idemKey('agent_send', 'new'))).toMatchObject({ result: 'new', at: 1 })
  })
})

describe('state table', () => {
  it('stores the assistant Session id and halt flag under main', async () => {
    const domain = await (await storage()).storageDomain.open(mcpDomain)
    await domain.table('state').put('main', { assistantSessionId: 'assistant', halted: true })
    expect(domain.table('state').get('main')).toEqual({ assistantSessionId: 'assistant', halted: true })
  })
})
