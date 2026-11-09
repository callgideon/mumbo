/**
 * The member plugin in a real Loader composition: Web carrier, Connection, Gateway, and remote access. A
 * request carrying the edge-signed header reaches Remote methods as the `edge-member` principal on the Sessions
 * the Workspace list holds; a tampered, expired, or missing header is not a member, and a member reaches no
 * settings method.
 */

import { randomBytes } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Group from '@deepseek-ai/cordis-plugin-group'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { Remote, TypertRemoteService, principalOf, type Principal } from '@deepseek-ai/dsh-typert-protocol'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as EdgeMember from '../src/index.ts'
import { signMemberHeader } from '../src/header.ts'

const CONFIG = fileURLToPath(new URL('./fixtures/cordis.yml', import.meta.url))
const KEY = randomBytes(32)

/** Stands in for the Session Controller's `session/prompt`: records the caller the Gateway admitted. */
class PromptProbe extends TypertRemoteService {
  readonly callers: (Principal | undefined)[] = []
  constructor(ctx: Context) {
    super(ctx, 'promptProbe', { namespace: 'session' })
  }

  @Remote('prompt')
  prompt(request: { readonly sessionId: string; readonly text: string }): string {
    void request
    this.callers.push(principalOf(this.ctx.invocation))
    return 'queued'
  }
}

/** Stands in for a settings write. */
class SettingsProbe extends TypertRemoteService {
  constructor(ctx: Context) {
    super(ctx, 'settingsProbe', { namespace: 'settings' })
  }

  @Remote('update')
  update(ns: string, value: string): string {
    return `${ns}=${value}`
  }
}

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  vi.unstubAllEnvs()
})

async function boot(): Promise<{ readonly origin: string; readonly probe: PromptProbe }> {
  vi.stubEnv('MUMBO_MEMBER_KEY', KEY.toString('base64url'))
  context = new Context()
  const records = new Map<unknown, unknown>()
  context.provide('credentials', {
    async modifyRecord(key: unknown, mutate: (current: unknown) => Promise<unknown>): Promise<unknown> {
      const next = await mutate(records.get(key))
      if (next !== undefined) records.set(key, next)
      return next ?? records.get(key)
    },
  } as never)
  // One Workspace holding one Session; the policy grants over exactly this list.
  context.provide('workspaceRegistry', { list: () => [{ id: 'w1', sessionIds: ['s1'] }] } as never)
  await context.plugin(Loader)
  const modules = new Map<string, object>([
    ['@deepseek-ai/dsh-typert-registry', TypertRegistry],
    ['@deepseek-ai/dsh-api-remote-access', RemoteAccessService],
    ['@deepseek-ai/dsh-api-gateway', TypertGatewayService],
    ['@deepseek-ai/dsh-host-webserver', WebServer],
    ['@deepseek-ai/dsh-client-connection', Connection],
    ['@mumbo/edge-member', EdgeMember],
  ])
  const loader = context.loader
  loader.builtins.group = Group
  loader.builtins.include = class FixtureInclude extends Include {
    override import(specifier: string, getOuterStack?: () => string[]): unknown {
      if (specifier.startsWith('cordis:')) return super.import(specifier, getOuterStack)
      const module = modules.get(specifier)
      if (module === undefined) throw new Error(`unexpected Loader import: ${specifier}`)
      return module
    }
  }
  await loader.create({ name: 'cordis:include', config: { path: pathToFileURL(CONFIG).href } })
  await loader.await()
  const entries = [...loader.entries()]
  expect(entries.filter(entry => entry.fiber === undefined && !entry.disabled).map(entry => entry.options.id)).toEqual([])
  context.typert.resources.register('session', { field: 'sessionId' })
  context.typert.resources.register('workspace', { field: 'workspaceId' })
  await context.plugin(PromptProbe)
  await context.plugin(SettingsProbe)
  const probe = context.get('promptProbe') as PromptProbe
  return { origin: `http://127.0.0.1:${String(context.webServer.port)}`, probe }
}

async function call(origin: string, method: string, args: Record<string, unknown>, header?: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${origin}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...header === undefined ? {} : { 'x-mumbo-member': header } },
    body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method, payload: { args } }),
  })
  return { status: response.status, body: response.ok ? await response.json() : await response.text() }
}

const now = (): number => Math.floor(Date.now() / 1000)

describe('real Loader composition', () => {
  it('admits a signed member and records the member as the caller of a prompt', { timeout: 60_000 }, async () => {
    const { origin, probe } = await boot()
    const header = signMemberHeader(KEY, 'ann@example.com', now() + 300)
    const answer = await call(origin, 'session/prompt', { request: { sessionId: 's1', text: 'hi' } }, header)
    expect(answer).toEqual({ status: 200, body: { type: 'server-response', rpcId: 'r1', result: { ok: true, value: 'queued' } } })
    expect(probe.callers).toEqual([{ kind: 'edge-member', email: 'ann@example.com' }])
  })

  it('refuses a member a Session no Workspace lists, and every settings method', { timeout: 60_000 }, async () => {
    const { origin, probe } = await boot()
    const header = signMemberHeader(KEY, 'ann@example.com', now() + 300)
    const elsewhere = await call(origin, 'session/prompt', { request: { sessionId: 's2', text: 'hi' } }, header)
    expect(elsewhere.body).toMatchObject({ result: { ok: false, error: { code: 'remote-access/denied' } } })
    const settings = await call(origin, 'settings/update', { ns: 'llm', value: 'x' }, header)
    expect(settings.body).toMatchObject({ result: { ok: false, error: { code: 'remote-access/denied' } } })
    expect(probe.callers).toEqual([])
  })

  it('does not admit a tampered, expired, too-distant, foreign-key, or missing header', { timeout: 60_000 }, async () => {
    const { origin, probe } = await boot()
    const valid = signMemberHeader(KEY, 'ann@example.com', now() + 300)
    const [email, expiry, mac] = valid.split('.') as [string, string, string]
    for (const header of [
      `${Buffer.from('bo@example.com').toString('base64url')}.${expiry}.${mac}`,
      signMemberHeader(KEY, 'ann@example.com', now() - 1),
      signMemberHeader(KEY, 'ann@example.com', now() + 3600),
      signMemberHeader(randomBytes(32), 'ann@example.com', now() + 300),
      `${email}.${expiry}`,
      undefined,
    ]) {
      const answer = await call(origin, 'session/prompt', { request: { sessionId: 's1', text: 'hi' } }, header)
      expect(answer, String(header)).toEqual({ status: 401, body: 'unauthorized' })
    }
    expect(probe.callers).toEqual([])
  })
})
