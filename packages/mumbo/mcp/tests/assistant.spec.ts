import { afterEach, describe, expect, it } from 'vitest'
import { ensureAssistant } from '../src/assistant.ts'
import { mcpDomain } from '../src/store.ts'
import { type Host, startHost, stopHosts } from './door-fixture.ts'

afterEach(stopHosts)

/** A host plus the plugin's state table, opened without the plugin. */
async function stateOf(host: Host) {
  const domain = await host.ctx.storageDomain.open(mcpDomain)
  return domain.table('state')
}

describe('ensureAssistant', () => {
  it('creates the Session in the assistantCwd workspace, titles it, and stores its id', async () => {
    const host = await startHost()
    const state = await stateOf(host)
    const agent = await ensureAssistant(host.ctx, host.config, state)
    expect(agent.id).toBe('s1')
    expect(host.calls).toEqual([`workspace:${host.root}`, 'create:w1', 'rename:s1:assistant', 'resolve:s1'])
    expect(state.get('main')).toEqual({ assistantSessionId: 's1', halted: false })
  })

  it('resolves a stored Session instead of creating one, keeping the halt flag', async () => {
    const host = await startHost()
    const state = await stateOf(host)
    host.addAgent('kept')
    await state.put('main', { assistantSessionId: 'kept', halted: true })
    const agent = await ensureAssistant(host.ctx, host.config, state)
    expect(agent.id).toBe('kept')
    expect(host.calls).toEqual(['resolve:kept'])
    expect(state.get('main')).toEqual({ assistantSessionId: 'kept', halted: true })
  })

  it('creates a new Session when the stored one no longer exists', async () => {
    const host = await startHost()
    const state = await stateOf(host)
    await state.put('main', { assistantSessionId: 'gone', halted: true })
    const agent = await ensureAssistant(host.ctx, host.config, state)
    expect(agent.id).toBe('s1')
    expect(host.calls).toEqual(['resolve:gone', `workspace:${host.root}`, 'create:w1', 'rename:s1:assistant', 'resolve:s1'])
    expect(state.get('main')).toEqual({ assistantSessionId: 's1', halted: true })
  })

  it('fails without creating a Session when the stored one cannot be resolved for another reason', async () => {
    const host = await startHost()
    const state = await stateOf(host)
    host.addAgent('busy')
    host.held.add('busy')
    await state.put('main', { assistantSessionId: 'busy', halted: false })
    await expect(ensureAssistant(host.ctx, host.config, state)).rejects.toThrow('writer held')
    expect(host.calls).toEqual(['resolve:busy'])
  })

  it('keeps a created Session stored when it cannot be resolved afterwards', async () => {
    const host = await startHost()
    const state = await stateOf(host)
    host.held.add('s1')
    await expect(ensureAssistant(host.ctx, host.config, state)).rejects.toThrow('writer held')
    expect(state.get('main')).toEqual({ assistantSessionId: 's1', halted: false })
  })
})
