import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { initializeRoleModel } from '../src/app/role-models.ts'
const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())); vi.restoreAllMocks() })
async function fixture() {
  const ctx = new Context(); contexts.push(ctx); await ctx.plugin(SystemPrompt)
  const resolve = vi.fn(async value => value)
  const flush = vi.fn(async () => {})
  ctx.reflect.provide('llm', { resolveCallConfig: resolve })
  ctx.reflect.provide('sessionPersistence', { flush })
  const session = Session.create(SessionId('role-model'))
  const agent = { ctx, session } as Agent
  return { ctx, agent, resolve, flush }
}
const selections = (agent: Agent) => agent.session.snapshotEvents().flatMap(event => event.type === 'model/selection' ? [event.data] : [])
it('keeps prompt variables and initial routing on the role model without saving the host default', async () => {
  const { ctx, agent, flush } = await fixture()
  await initializeRoleModel(ctx, agent, { provider: 'worker-provider', model: 'worker-model' })
  expect((await ctx.systemPrompt.assemble()).variables).toMatchObject({ provider: 'worker-provider', model: 'worker-model' })
  expect(selections(agent)).toEqual([{ provider: 'worker-provider', model: 'worker-model' }])
  expect(flush).toHaveBeenCalledOnce()
  await ctx.systemPrompt.assemble()
  expect(selections(agent)).toHaveLength(1)
})
it('stops overriding prompt variables once a later explicit selection is recorded', async () => {
  const { ctx, agent } = await fixture()
  await initializeRoleModel(ctx, agent, { provider: 'worker', model: 'one' })
  expect((await ctx.systemPrompt.assemble()).variables).toMatchObject({ provider: 'worker', model: 'one' })
  const manual = { provider: 'manual', model: 'two', reasoningEffort: ReasoningEffortId('low') }
  const event = agent.session.append('model/selection', manual); ctx.emit('session/event', agent.session, event)
  expect((await ctx.systemPrompt.assemble()).variables).not.toMatchObject({ provider: 'worker', model: 'one' })
})
it.each(['header', 'selection'])('preserves a resumed Session with existing %s', async kind => {
  const { ctx, agent, resolve } = await fixture()
  const existing = { provider: 'existing', model: 'keep' }
  if (kind === 'header') agent.session.append('request/header', { header: { config: existing }, reason: 'initial' })
  else agent.session.append('model/selection', existing)
  await initializeRoleModel(ctx, agent, { provider: 'worker', model: 'new' })
  expect(resolve).not.toHaveBeenCalled()
})
it('inherits the host when unset and fails unavailable routes before recording a selection', async () => {
  const { ctx, agent, resolve } = await fixture()
  await initializeRoleModel(ctx, agent, null)
  expect(selections(agent)).toEqual([])
  resolve.mockRejectedValueOnce(new Error('unknown provider'))
  await expect(initializeRoleModel(ctx, agent, { provider: 'unknown', model: 'x' })).rejects.toThrow('unknown provider')
  expect(agent.session.snapshotEvents().some(event => event.type === 'model/selection')).toBe(false)
})
