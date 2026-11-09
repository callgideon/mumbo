import { expect, it } from 'vitest'
import { z } from 'zod'
import { registerHttp } from '../src/app/http.ts'
import { PromptConflict } from '../src/app/prompts.ts'
import { SettingsConflict } from '../src/app/settings.ts'
import type { HttpHost } from '../src/app/http.ts'
import { SettingsSchema } from '../src/policy.ts'
import { SetupError } from '../src/setup.ts'

type Handler = (req: unknown, res: unknown) => Promise<void>
type Headers = Record<string, string | undefined>
type Admission = { peer: { principal: { kind: string; email?: string } } } | { rejection: 401 | 403 }
const OWNER: Admission = { peer: { principal: { kind: 'owner' } } }
const member = (email: string): Admission => ({ peer: { principal: { kind: 'edge-member', email } } })
/**
 * Mount management HTTP routes on a fake web server and return a request helper that includes default panel headers.
 * `call.connection.admit` answers DSH admission (the owner by default) and can be swapped between calls.
 */
function serve(runtime: Partial<Record<keyof HttpHost, unknown>>, host = '127.0.0.1') {
  let handler: Handler = async () => {}
  const connection = { admit: (_req: { headers: Headers }): Admission => OWNER }
  const ctx = { connection, webServer: { host, port: 3082, register: (route: { handler: Handler }) => { handler = route.handler; return () => {} } } }
  registerHttp(ctx as never, { ready: Promise.resolve(), machine: { panelAdmins: [] }, ...runtime } as unknown as HttpHost)
  const call = async (method: string, path: string, body?: unknown, headers: Headers = {}) => {
    let status = 0, text = ''
    const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
    const sent = Object.fromEntries(Object.entries({ host: '127.0.0.1:3082', 'x-orchestrator-request': '1', ...headers }).filter(([,
      value]) => value !== undefined))
    const req = { method, url: `/orchestrator/api/${path}`, headers: sent, async *[Symbol.asyncIterator]() { yield* chunks } }
    await handler(req, { writeHead: (code: number) => { status = code }, end: (data: string) => { text = data } })
    return { status, body: JSON.parse(text) as Record<string, unknown> }
  }
  return Object.assign(call, { connection })
}

it('answers each kind of failure with its own status', async () => {
  const saves: unknown[] = []
  const call = serve({
    store: { tickets: { get: () => undefined }, blockRevision: () => 0 },
    sources: { instances: () => [{ id: 'github' }] },
    settings: { save: async (...args: unknown[]) => {
      saves.push(args)
      if (args[1] === 'stale') throw new SettingsConflict('Settings changed. Reload before saving.')
      if (args[1] === 'invalid') z.object({ maxWorkers: z.number() }).parse({})
      if (args[1] === 'refused') throw new SetupError('agentCliUnset')
      if (args[1] === 'broken') throw new Error('disk full')
      return { saved: true, revision: 1, restarting: false }
    } },
  })
  expect(await call('PUT', 'settings/executor', { value: 'stale', revision: 0 })).toMatchObject({ status: 409 })
  expect(await call('PUT', 'settings/executor', { value: 'invalid', revision: 0 })).toMatchObject({ status: 400, body: { issues: [{ path: 'maxWorkers' }] } })
  expect(await call('PUT', 'settings/source:github', { value: 'refused', revision: 0 })).toMatchObject({ status: 400, body: { setup: { code: 'agentCliUnset', place: 'github' } } })
  expect(await call('PUT', 'settings/executor', { value: 'broken', revision: 0 })).toEqual({ status: 500, body: { error: 'disk full' } })
  // Block names are validated before calling settings.save: reject unknown blocks or non-existent Sources.
  expect(await call('PUT', 'settings/pause', { value: {}, revision: 0 })).toMatchObject({ status: 400 })
  expect(await call('PUT', 'settings/source:feishu', { value: {}, revision: 0 })).toEqual({ status: 404, body: { error: 'Source not found' } })
  expect(saves).toHaveLength(4)
  expect(await call('POST', 'tickets/t9/retry')).toEqual({ status: 404, body: { error: 'Ticket not found' } })
  expect(await call('GET', 'nothing/here')).toEqual({ status: 404, body: { error: 'Unknown operation' } })
  expect(await call('POST', 'executor/pause', 'not json')).toEqual({ status: 400, body: { error: 'The request body is not JSON' } })
})

it('decodes path parameters and parses each route\'s query', async () => {
  const seen: unknown[] = []
  const call = serve({
    store: { settings: () => SettingsSchema.parse({}),
      read: { decisions: (filter: unknown, offset: number, limit: number) => { seen.push({ filter, offset, limit }); return { items: [], more: false } } } },
    links: () => () => ({ url: '', label: { zh: '', en: '' } }),
    engine: { unsubscribe: (key: string) => { seen.push(key); return true } },
    sessions: { delivery: async () => 'injected' },
  })
  expect(await call('POST', `threads/${encodeURIComponent('feishu:oc_1:om/root')}/unsubscribe`)).toMatchObject({ status: 200, body: { context_delivery: 'injected' } })
  // Invalid offsets default to 0, and limits above the route maximum are clamped.
  expect(await call('GET', 'decisions?kind=accept%2Creopen&limit=500&offset=x&window=24h')).toEqual({ status: 200, body: { items: [], next_offset: null } })
  expect(seen).toEqual(['feishu:oc_1:om/root', { filter: { kinds: ['accept', 'reopen'], since: expect.any(String) }, offset: 0, limit: 200 }])
})

it('runs a management request only for an admitted owner or listed panel admin that sends the panel header', async () => {
  const unsubscribed: string[] = []
  // Any bind address serves the panel; DSH admission applies the Host and Origin checks.
  const call = serve({ machine: { panelAdmins: ['alice@example.com'] }, sessions: { delivery: async () => 'injected' },
    engine: { unsubscribe: (key: string) => { unsubscribed.push(key); return true } } }, '10.0.0.5')
  const box = { host: 'p-0123456789abcdef.boxes.mumbo.si', origin: 'https://p-0123456789abcdef.boxes.mumbo.si' }
  const admitted: Headers[] = []
  const post = (admission: Admission, headers: Headers = {}) => {
    call.connection.admit = req => { admitted.push(req.headers); return admission }
    return call('POST', 'threads/github%3A1/unsubscribe', undefined, { ...box, ...headers })
  }
  const refused = (status: number, error: string) => ({ status, body: { error } })
  const unadmitted = 'DSH authentication refused this management request'
  const notAdmin = 'Management requires the owner or a panel admin'
  expect(await post({ rejection: 401 })).toEqual(refused(401, unadmitted))
  expect(await post({ rejection: 403 })).toEqual(refused(403, unadmitted))
  expect(await post({ peer: { principal: { kind: 'share-viewer' } } })).toEqual(refused(403, notAdmin))
  expect(await post(member('bob@example.com'))).toEqual(refused(403, notAdmin))
  // Emails match exactly: no domain, suffix or case folding.
  for (const email of ['alice@example.com.evil', 'x.alice@example.com', 'Alice@example.com', '@example.com']) {
    expect(await post(member(email)), email).toEqual(refused(403, notAdmin))
  }
  expect(await post({ peer: { principal: { kind: 'share-viewer', email: 'alice@example.com' } } })).toEqual(refused(403, notAdmin))
  expect(await post(OWNER, { 'x-orchestrator-request': undefined })).toEqual(refused(403, 'Same-origin management request required'))
  expect(await post(member('alice@example.com'), { 'x-orchestrator-request': '0' }))
    .toEqual(refused(403, 'Same-origin management request required'))
  expect(unsubscribed).toEqual([])
  expect(await post(OWNER)).toMatchObject({ status: 200 })
  expect(await post(member('alice@example.com'))).toMatchObject({ status: 200 })
  expect(unsubscribed).toEqual(['github:1', 'github:1'])
  expect(admitted.at(-1)).toMatchObject({ ...box, 'x-orchestrator-request': '1' })
})

it('admits no edge member while panelAdmins is empty', async () => {
  const call = serve({ sessions: { delivery: async () => 'injected' }, engine: { unsubscribe: () => true } })
  call.connection.admit = () => member('alice@example.com')
  expect(await call('POST', 'threads/github%3A1/unsubscribe')).toEqual({ status: 403,
    body: { error: 'Management requires the owner or a panel admin' } })
})

it('answers a prompt save that lost a race with 409, and a settings body over 128 KiB with 400', async () => {
  const saves: unknown[] = []
  const call = serve({
    machine: { promptMaxChars: { get: () => 100_000 } },
    store: { atomic: (work: () => unknown) => work(), blockRevision: () => 0 },
    prompts: { save: () => { throw new PromptConflict('Prompt version changed to 3; compare the latest version before saving') } },
    sessions: { notify: () => {}, delivery: async () => 'injected' },
    settings: { save: async (...args: unknown[]) => { saves.push(args); return { saved: true, revision: 1, restarting: false } } },
  })
  expect(await call('PUT', 'prompts', { config: {}, baseRevision: 2 }))
    .toEqual({ status: 409, body: { error: 'Prompt version changed to 3; compare the latest version before saving' } })
  const value = { prepare: 'x'.repeat(128 * 1024) }
  expect(await call('PUT', 'settings/executor', { value, revision: 0 })).toEqual({ status: 400,
    body: { error: `Request exceeds ${128 * 1024} bytes` } })
  expect(saves).toEqual([])
})
