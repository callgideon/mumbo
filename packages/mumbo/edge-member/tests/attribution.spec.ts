/** Member attribution through a real Agent step: the durable notice and the model request it produces. */
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, onTestFinished } from 'vitest'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import type {} from '../src/index.ts'
import { ATTRIBUTION_SOURCE, attributeMemberMessages, attributionText, memberOf } from '../src/attribution.ts'

function text(value: string, principal?: { readonly kind: 'edge-member'; readonly email: string }) {
  return createUserMessage({
    content: [{ type: 'text', text: value }],
    source: { kind: 'user', rpcId: `rpc-${value}` as SessionRequestId, ...principal === undefined ? {} : { principal } },
  })
}

describe('member attribution', () => {
  it('logs a notice naming the member before each member message and sends it to the model', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin({ name: 'attribution-fixture', apply: attributeMemberMessages })
    const adapter = new MockAdapter([textResponse('ok'), textResponse('ok')])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('member-attribution'), { provider: 'mock', model: 'mock' })

    agent.followup(text('owner asks'))
    agent.followup(text('member asks', { kind: 'edge-member', email: 'ann@example.com' }))
    await agent.whenIdle()

    const logged = agent.session.snapshotEvents()
      .filter(event => event.type === 'user/message')
      .map(event => event.type === 'user/message' ? [event.data.source.kind, event.data.content] : [])
    expect(logged).toEqual([
      ['user', [{ type: 'text', text: 'owner asks' }]],
      [ATTRIBUTION_SOURCE, [{ type: 'text', text: attributionText('ann@example.com') }]],
      ['user', [{ type: 'text', text: 'member asks' }]],
    ])
    const requestTexts = adapter.requests.at(-1)?.messages
      .flatMap(message => message.content)
      .flatMap(block => block.type === 'text' ? [block.text] : [])
    expect(requestTexts).toEqual(expect.arrayContaining([
      'owner asks',
      'The next message is from project member ann@example.com.',
      'member asks',
    ]))
    const order = ['owner asks', 'The next message is from project member ann@example.com.', 'member asks']
      .map(value => requestTexts?.indexOf(value))
    expect(order).toEqual([...order].sort((left, right) => (left ?? 0) - (right ?? 0)))
  })

  it('adds a notice only before the member message of a step that also holds an owner message', async () => {
    let listener: ((payload: unknown, next: () => Promise<PreStepDecision>) => Promise<PreStepDecision>) | undefined
    attributeMemberMessages({ on: (_event: string, callback: typeof listener) => { listener = callback } } as never)
    const member = text('member asks', { kind: 'edge-member', email: 'ann@example.com' })
    const owner = text('owner adds')
    const decision = await listener!({}, async () => ({ kind: 'enter', messages: [member, owner] }))
    expect(decision.kind === 'enter' ? decision.messages.map(message => message.source.kind) : decision)
      .toEqual([ATTRIBUTION_SOURCE, 'user', 'user'])
    expect(decision.kind === 'enter' ? decision.messages.slice(1) : decision).toEqual([member, owner])
  })

  it('names no member for a message whose source is not a person\'s', () => {
    const notice = createUserMessage({
      content: [{ type: 'text', text: attributionText('ann@example.com') }],
      source: { kind: ATTRIBUTION_SOURCE, form: 'notice', summary: attributionText('ann@example.com') },
    })
    expect(memberOf(notice)).toBeUndefined()
  })

  it('leaves a step without member messages unchanged', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin({ name: 'attribution-fixture', apply: attributeMemberMessages })
    ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('ok')]))
    const agent = await ctx.agentLoop.create(SessionId('owner-only'), { provider: 'mock', model: 'mock' })
    agent.followup(text('owner asks'))
    await agent.whenIdle()
    expect(agent.session.snapshotEvents().filter(event => event.type === 'user/message')).toHaveLength(1)
  })
})
