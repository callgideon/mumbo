import { afterEach, describe, expect, it } from 'vitest'
import { ensureAssistant } from '../src/assistant.ts'
import { mcpDomain } from '../src/store.ts'
import { type Host, startHost, stopHosts } from './door-fixture.ts'

afterEach(stopHosts)

/** The plugin's assistant table, opened without the plugin. */
async function assistantTable(host: Host) {
  const domain = await host.ctx.storageDomain.open(mcpDomain)
  return domain.table('assistant')
}

describe('ensureAssistant', () => {
  it('creates the Session in the assistantCwd workspace, titles it, and stores its id', async () => {
    const host = await startHost()
    const table = await assistantTable(host)
    const agent = await ensureAssistant(host.ctx, host.config, table)
    expect(agent.id).toBe('s1')
    expect(host.calls).toEqual([`workspace:${host.root}`, 'create:w1', 'rename:s1:assistant', 'resolve:s1'])
    expect(table.get('main')).toEqual({ sessionId: 's1' })
  })

  it('resolves a stored Session instead of creating one', async () => {
    const host = await startHost()
    const table = await assistantTable(host)
    host.addAgent('kept')
    await table.put('main', { sessionId: 'kept' })
    const agent = await ensureAssistant(host.ctx, host.config, table)
    expect(agent.id).toBe('kept')
    expect(host.calls).toEqual(['resolve:kept'])
    expect(table.get('main')).toEqual({ sessionId: 'kept' })
  })

  it('creates a new Session when the stored one no longer exists', async () => {
    const host = await startHost()
    const table = await assistantTable(host)
    await table.put('main', { sessionId: 'gone' })
    const agent = await ensureAssistant(host.ctx, host.config, table)
    expect(agent.id).toBe('s1')
    expect(host.calls).toEqual(['resolve:gone', `workspace:${host.root}`, 'create:w1', 'rename:s1:assistant', 'resolve:s1'])
    expect(table.get('main')).toEqual({ sessionId: 's1' })
  })

  it('fails without creating a Session when the stored one cannot be resolved for another reason', async () => {
    const host = await startHost()
    const table = await assistantTable(host)
    host.addAgent('busy')
    host.held.add('busy')
    await table.put('main', { sessionId: 'busy' })
    await expect(ensureAssistant(host.ctx, host.config, table)).rejects.toThrow('writer held')
    expect(host.calls).toEqual(['resolve:busy'])
  })

  it('keeps a created Session stored when it cannot be resolved afterwards', async () => {
    const host = await startHost()
    const table = await assistantTable(host)
    host.held.add('s1')
    await expect(ensureAssistant(host.ctx, host.config, table)).rejects.toThrow('writer held')
    expect(table.get('main')).toEqual({ sessionId: 's1' })
  })
})
