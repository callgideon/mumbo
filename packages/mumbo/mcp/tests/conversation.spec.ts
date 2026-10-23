import { afterEach, describe, expect, it, vi } from 'vitest'
import * as McpDoor from '../src/index.ts'
import { call, type FakeAgent, type Host, message, startHost, stopHosts, unfence } from './door-fixture.ts'

afterEach(stopHosts)

/** A host with the plugin loaded and one existing assistant Session `s1`; `unload` disposes the plugin. */
async function door(allowlist?: string[]): Promise<{ host: Host; agent: FakeAgent; unload: () => Promise<void> }> {
  const host = await startHost(allowlist === undefined ? {} : { allowlist })
  const fiber = host.ctx.plugin(McpDoor, host.config)
  await fiber
  // The first call creates `s1`; tests then shape its log.
  await call(host.url, 'agent_read', { after_seq: 0 })
  const agent = host.agents.get('s1')
  if (agent === undefined) throw new Error('assistant Session was not created')
  return { host, agent, unload: async () => { await fiber.dispose() } }
}

/** Make `resolveAgent` wait until the returned release is called. */
function hold(host: Host): () => void {
  const release = Promise.withResolvers<undefined>()
  host.hold.promise = release.promise
  return () => {
    host.hold.promise = Promise.resolve()
    release.resolve(undefined)
  }
}

describe('agent_send', () => {
  it('sends the text once as a user message from the principal and returns the seq the reply follows', async () => {
    const { host, agent } = await door()
    const reply = await call(host.url, 'agent_send', { text: 'hello', request_id: 'r1' })
    expect(agent.followup).toHaveBeenCalledOnce()
    const sent = agent.followup.mock.calls[0]?.[0]
    expect(sent).toMatchObject({ role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'mcp', principal: 'ann' } })
    expect(reply).toEqual({ isError: false, value: { message_id: (sent as { id: string }).id, after_seq: agent.log.length - 1 } })
  })

  it('returns the first result for a retried request id without sending again', async () => {
    const { host, agent } = await door()
    const first = await call(host.url, 'agent_send', { text: 'hello', request_id: 'r1' })
    message(agent, 'user', { kind: 'mcp', principal: 'ann' }, [{ type: 'text', text: 'hello' }])
    expect(await call(host.url, 'agent_send', { text: 'hello', request_id: 'r1' })).toEqual(first)
    expect(agent.followup).toHaveBeenCalledOnce()
  })

  it('keeps the request ids of different principals apart', async () => {
    const { host, agent } = await door(['ann', 'bob'])
    await call(host.url, 'agent_send', { text: 'hello', request_id: 'r1' })
    await call(host.url, 'agent_send', { text: 'hello', request_id: 'r1' }, 'bob')
    expect(agent.followup.mock.calls.map(([sent]) => sent)).toMatchObject([
      { source: { kind: 'mcp', principal: 'ann' } },
      { source: { kind: 'mcp', principal: 'bob' } },
    ])
  })

  it.each([
    ['empty text', { text: '', request_id: 'r1' }],
    ['text over 32768 characters', { text: 'x'.repeat(32_769), request_id: 'r1' }],
    ['a request id with a space', { text: 'hi', request_id: 'r 1' }],
    ['a request id over 64 characters', { text: 'hi', request_id: 'r'.repeat(65) }],
  ])('answers %s with code invalid and sends nothing', async (_label, args) => {
    const { host, agent } = await door()
    const reply = await call(host.url, 'agent_send', args)
    expect(reply).toMatchObject({ isError: true, value: { code: 'invalid' } })
    expect(agent.followup).not.toHaveBeenCalled()
  })

  it('reports a failure to reach the assistant Session as a tool error and sends nothing', async () => {
    const { host, agent } = await door()
    host.held.add('s1')
    expect(await call(host.url, 'agent_send', { text: 'hello', request_id: 'r1' })).toEqual({ isError: true, value: 'writer held' })
    expect(agent.followup).not.toHaveBeenCalled()
  })

  it('creates one assistant Session for concurrent first calls', async () => {
    const host = await startHost()
    await host.ctx.plugin(McpDoor, host.config)
    await Promise.all([
      call(host.url, 'agent_send', { text: 'one', request_id: 'r1' }),
      call(host.url, 'agent_send', { text: 'two', request_id: 'r2' }),
    ])
    expect(host.calls.filter(entry => entry.startsWith('create:'))).toEqual(['create:w1'])
    expect(host.agents.get('s1')?.followup).toHaveBeenCalledTimes(2)
  })

  it('finishes a send admitted before an unload, and its retry after reload sends nothing', async () => {
    const { host, agent, unload } = await door()
    const before = host.calls.length
    const release = hold(host)
    const sending = call(host.url, 'agent_send', { text: 'hello', request_id: 'r1' })
    // `resolve:s1`: the send is held before it stores its result.
    await vi.waitFor(() => { expect(host.calls.length).toBe(before + 1) })
    let unloaded = false
    const unloading = unload().then(() => { unloaded = true })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(unloaded).toBe(false)
    release()
    const first = await sending
    await unloading
    expect(first).toMatchObject({ isError: false })
    await host.ctx.plugin(McpDoor, host.config)
    expect(await call(host.url, 'agent_send', { text: 'hello', request_id: 'r1' })).toEqual(first)
    expect(agent.followup).toHaveBeenCalledOnce()
  })

  it('talks to the same assistant Session after the plugin reloads', async () => {
    const host = await startHost()
    const fiber = host.ctx.plugin(McpDoor, host.config)
    await fiber
    await call(host.url, 'agent_send', { text: 'one', request_id: 'r1' })
    await fiber.dispose()
    await host.ctx.plugin(McpDoor, host.config)
    await call(host.url, 'agent_send', { text: 'two', request_id: 'r2' })
    expect(host.calls.filter(entry => entry.startsWith('create:'))).toEqual(['create:w1'])
    expect(host.agents.get('s1')?.followup).toHaveBeenCalledTimes(2)
  })
})

describe('agent_read', () => {
  it('returns the user and assistant messages after after_seq, oldest first, labelled and fenced', async () => {
    const { host, agent } = await door()
    const after = agent.log.length - 1
    message(agent, 'user', { kind: 'mcp', principal: 'ann' }, [{ type: 'text', text: 'status?' }])
    agent.log.push({ type: 'turn/start', seq: agent.log.length, time: 0, data: {}, surfaceOp: 'append' })
    message(agent, 'user', { kind: 'user' }, [{ type: 'text', text: 'from the browser' }, { type: 'image' }])
    message(agent, 'assistant', { kind: 'model' }, [{ type: 'reasoning', text: 'hidden' }, { type: 'tool-call', id: 'c1' }])
    message(agent, 'assistant', { kind: 'model' }, [{ type: 'text', text: 'all green' }, { type: 'text', text: 'done' }])
    agent.log.push({
      type: 'user/message',
      seq: agent.log.length,
      time: 0,
      data: { id: 'summary', role: 'user', content: [{ type: 'text', text: 'compacted' }], source: { kind: 'compact-checkpoint' } },
      surfaceOp: { op: 'replace', startSeq: 1, endSeq: 3 },
    })

    const reply = await call(host.url, 'agent_read', { after_seq: after })
    expect(reply).toMatchObject({ isError: false })
    const value = reply.value as { messages: { seq: number; role: string; source: string; text: string }[]; next_seq: number }
    expect(value.messages.map(({ text, ...rest }) => ({ ...rest, text: unfence(text) }))).toEqual([
      { seq: after + 1, role: 'user', source: 'mcp:ann', text: 'status?' },
      { seq: after + 3, role: 'user', source: 'user', text: 'from the browser' },
      { seq: after + 5, role: 'assistant', source: 'model', text: 'all green\ndone' },
    ])
    expect(value.next_seq).toBe(agent.log.length - 1)
  })

  it('waits for the next message of the assistant Session with text when none follows after_seq yet', async () => {
    const { host, agent } = await door()
    const after = agent.log.length - 1
    const before = host.calls.length
    const reading = call(host.url, 'agent_read', { after_seq: after, wait_s: 40 })
    // `resolve:s1` and the first `page:` call: the read found nothing and waits.
    await vi.waitFor(() => { expect(host.calls.length).toBe(before + 2) })
    const toolCall = message(agent, 'assistant', { kind: 'model' }, [{ type: 'tool-call', id: 'c1' }])
    host.ctx.emit('session/event', { id: 'other' } as never, toolCall as never)
    host.ctx.emit('session/event', agent.session as never, { ...toolCall, type: 'turn/end' } as never)
    await new Promise(resolve => setImmediate(resolve))
    expect(host.calls.length).toBe(before + 2)
    // A message without text wakes a read that still finds nothing, and the wait goes on.
    host.ctx.emit('session/event', agent.session as never, toolCall as never)
    await vi.waitFor(() => { expect(host.calls.length).toBe(before + 3) })
    const reply = message(agent, 'assistant', { kind: 'model' }, [{ type: 'text', text: 'here' }])
    host.ctx.emit('session/event', agent.session as never, reply as never)
    const value = (await reading).value as { messages: { text: string }[]; next_seq: number }
    expect(value.messages.map(({ text }) => unfence(text))).toEqual(['here'])
    expect(value.next_seq).toBe(reply.seq)
  })

  it('returns no messages once wait_s passes without one', async () => {
    const { host, agent } = await door()
    const started = Date.now()
    const reply = await call(host.url, 'agent_read', { after_seq: agent.log.length - 1, wait_s: 1 })
    expect(Date.now() - started).toBeGreaterThanOrEqual(900)
    expect(reply).toEqual({ isError: false, value: { messages: [], next_seq: agent.log.length - 1, more: false } })
  })

  it('ends its wait when the plugin unloads', async () => {
    const { host, agent, unload } = await door()
    const before = host.calls.length
    const reading = call(host.url, 'agent_read', { after_seq: agent.log.length - 1, wait_s: 40 })
    await vi.waitFor(() => { expect(host.calls.length).toBe(before + 2) })
    await unload()
    expect(await reading).toEqual({ isError: false, value: { messages: [], next_seq: agent.log.length - 1, more: false } })
  })

  it('does not wait once the plugin is unloading', async () => {
    const { host, agent, unload } = await door()
    const before = host.calls.length
    const release = hold(host)
    const reading = call(host.url, 'agent_read', { after_seq: agent.log.length - 1, wait_s: 40 })
    await vi.waitFor(() => { expect(host.calls.length).toBe(before + 1) })
    const unloading = unload()
    await new Promise(resolve => setTimeout(resolve, 20))
    release()
    expect(await reading).toEqual({ isError: false, value: { messages: [], next_seq: agent.log.length - 1, more: false } })
    await unloading
  })

  it('ends a reply before it passes 64 KiB of text, says more follows, and continues from next_seq', async () => {
    const { host, agent } = await door()
    const after = agent.log.length - 1
    for (const text of ['a'.repeat(40_000), 'b'.repeat(40_000), 'c']) {
      message(agent, 'assistant', { kind: 'model' }, [{ type: 'text', text }])
    }
    type Reply = { messages: { seq: number }[]; next_seq: number; more: boolean }
    const first = (await call(host.url, 'agent_read', { after_seq: after })).value as Reply
    expect(first.messages.map(({ seq }) => seq)).toEqual([after + 1])
    expect(first).toMatchObject({ next_seq: after + 1, more: true })
    const second = (await call(host.url, 'agent_read', { after_seq: first.next_seq })).value as Reply
    expect(second.messages.map(({ seq }) => seq)).toEqual([after + 2, after + 3])
    expect(second).toMatchObject({ next_seq: after + 3, more: false })
  })

  it.each([
    ['wait_s 41', { after_seq: 0, wait_s: 41 }],
    ['wait_s -1', { after_seq: 0, wait_s: -1 }],
    ['after_seq -1', { after_seq: -1 }],
    ['a fractional after_seq', { after_seq: 1.5 }],
  ])('answers %s with code invalid', async (_label, args) => {
    const { host } = await door()
    expect(await call(host.url, 'agent_read', args)).toMatchObject({ isError: true, value: { code: 'invalid' } })
  })
})
