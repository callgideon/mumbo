import { afterEach, describe, expect, it } from 'vitest'
import * as McpDoor from '../src/index.ts'
import { call, type Host, startHost, stopHosts } from './door-fixture.ts'

afterEach(stopHosts)

const HALT_CAUSE = { kind: 'hook', reason: 'runs_halt' }

/** What the next proposed model step of Session `id` is told. */
function nextStep(host: Host, id: string): Promise<unknown> {
  return host.ctx.waterfall('agent/pre-step', {
    agent: host.agents.get(id),
    messages: [],
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
  } as never, () => Promise.resolve({ kind: 'enter', messages: [] }))
}

/** A host with the plugin loaded, a running Session `a1` and an idle `a2`. */
async function door(): Promise<Host> {
  const host = await startHost()
  await host.ctx.plugin(McpDoor, host.config)
  host.addAgent('a1').status = 'running'
  host.addAgent('a2')
  return host
}

describe('runs_halt', () => {
  it('stores halted, cancels every Session keeping its inbox, kills running jobs, and rejects the next step', async () => {
    const host = await door()
    host.jobs.push(
      { id: 'j1', owner: 'a1', status: 'running' },
      { id: 'j2', status: 'running' },
      { id: 'j3', owner: 'a1', status: 'completed' },
      { id: 'j4', owner: 'a2', status: 'stopping' },
    )
    expect(await nextStep(host, 'a1')).toEqual({ kind: 'enter', messages: [] })

    const reply = await call(host.url, 'runs_halt', { request_id: 'h1' })
    expect(reply).toEqual({ isError: false, value: { halted: true, cancelled: { sessions: ['a1'], jobs: ['j2', 'j1'] }, failed: [] } })
    for (const id of ['a1', 'a2']) expect(host.agents.get(id)?.cancel.mock.calls).toEqual([[HALT_CAUSE, { keepInbox: true }]])
    expect(host.kill.mock.calls).toEqual([['j2', undefined, 'runs_halt'], ['j1', 'a1', 'runs_halt']])
    expect(await nextStep(host, 'a2')).toEqual({ kind: 'reject' })
  })

  it('reports a job whose kill throws and still kills the others', async () => {
    const host = await door()
    host.jobs.push({ id: 'j1', owner: 'a1', status: 'running' }, { id: 'j2', owner: 'a2', status: 'running' })
    host.kill.mockImplementationOnce(() => { throw new Error('producer refused') })
    const reply = await call(host.url, 'runs_halt', { request_id: 'h1' })
    expect(reply.value).toEqual({
      halted: true,
      cancelled: { sessions: ['a1'], jobs: ['j2'] },
      failed: [{ job: 'j1', message: 'Error: producer refused' }],
    })
  })

  it('refuses agent_send with code halted and sends nothing', async () => {
    const host = await door()
    await call(host.url, 'runs_halt', { request_id: 'h1' })
    expect(await call(host.url, 'agent_send', { text: 'hello', request_id: 'r1' })).toMatchObject({ isError: true, value: { code: 'halted' } })
    expect(host.calls.filter(entry => entry.startsWith('create:'))).toEqual([])
  })

  it('stays halted after the plugin reloads on the same store', async () => {
    const host = await startHost()
    const fiber = host.ctx.plugin(McpDoor, host.config)
    await fiber
    host.addAgent('a1')
    await call(host.url, 'runs_halt', { request_id: 'h1' })
    await fiber.dispose()
    expect(await nextStep(host, 'a1')).toEqual({ kind: 'enter', messages: [] })
    await host.ctx.plugin(McpDoor, host.config)
    expect(await nextStep(host, 'a1')).toEqual({ kind: 'reject' })
  })

  it('returns the first result for a retried request id without halting again', async () => {
    const host = await door()
    const first = await call(host.url, 'runs_halt', { request_id: 'h1' })
    expect(await call(host.url, 'runs_halt', { request_id: 'h1' })).toEqual(first)
    expect(host.agents.get('a1')?.cancel).toHaveBeenCalledOnce()
  })
})

describe('runs_resume', () => {
  it('opens the gate and lets agent_send through again', async () => {
    const host = await door()
    await call(host.url, 'runs_halt', { request_id: 'h1' })
    expect(await call(host.url, 'runs_resume', { request_id: 'r1' })).toEqual({ isError: false, value: { halted: false } })
    expect(await nextStep(host, 'a1')).toEqual({ kind: 'enter', messages: [] })
    expect((await call(host.url, 'agent_send', { text: 'hello', request_id: 's1' })).isError).toBe(false)
  })

  it('returns the first result for a retried request id without resuming again', async () => {
    const host = await door()
    await call(host.url, 'runs_resume', { request_id: 'r1' })
    await call(host.url, 'runs_halt', { request_id: 'h1' })
    expect(await call(host.url, 'runs_resume', { request_id: 'r1' })).toEqual({ isError: false, value: { halted: false } })
    expect(await nextStep(host, 'a1')).toEqual({ kind: 'reject' })
  })
})
