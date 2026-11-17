/** The record's owner-only routes and the page flag that tells the owner's page they exist. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import PermissionPresetService from '@deepseek-ai/dsh-permission-presets'
import Approval from '@deepseek-ai/dsh-user-approval'
import { describe, expect, it, onTestFinished } from 'vitest'
import * as RunWild from '../src/index.ts'
import { RECORD_COUNTS_PATH, RECORD_GLOBAL, RECORD_PATH } from '../src/record-types.ts'

const DAY = '2026-11-11'
const AT = Date.parse(`${DAY}T09:00:00Z`)
const LINE = { kind: 'send', target: 'mail', summary: 'sent', reason: 'r', v: 1, time: AT, session: 's', root: 's', seq: 3 }

/** Run Wild over a record in `root`, with a Connection stand-in that keeps the registered routes. */
async function mounted(root: string) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  ctx.provide('shell', { sandboxMode: 'danger-full-access' } as never)
  await ctx.plugin(Approval, { policy: 'ask' })
  await ctx.plugin(PermissionPresetService, { presets: { 'run-wild': { sandbox: 'danger-full-access', approval: 'ask' } } })
  const routes = new Map<string, ConnectionFetchRoute>()
  ctx.provide('connection', { fetch: { register: (route: ConnectionFetchRoute) => { routes.set(route.path, route); return () => { routes.delete(route.path) } } } } as never)
  const fiber = await ctx.plugin(RunWild, { root, retentionDays: 90 })
  /** GET a route with a query. */
  const get = async (path: string, query = ''): Promise<{ status: number; body: string }> => {
    const response = await routes.get(path)!.fetch(new Request(`http://box.test${path}${query}`))
    return { status: response.status, body: await response.text() }
  }
  return { ctx, routes, fiber, get }
}

/** A record directory holding one day file. */
function recorded(): string {
  const root = join(mkdtempSync(join(tmpdir(), 'mumbo-run-wild-route-')), 'runwild')
  onTestFinished(() => { rmSync(join(root, '..'), { recursive: true, force: true }) })
  mkdirSync(root)
  writeFileSync(join(root, `${DAY}.jsonl`), `${JSON.stringify(LINE)}\n${JSON.stringify({ ...LINE, kind: 'post', seq: 4 })}\n`)
  return root
}

describe('the record routes', () => {
  it('answer a page and the counts, as GET routes that declare no access, so Connection refuses every non-owner', async () => {
    const { routes, get } = await mounted(recorded())
    for (const path of [RECORD_PATH, RECORD_COUNTS_PATH]) {
      expect(routes.get(path)).toMatchObject({ path, methods: ['GET'] })
      expect(routes.get(path)!.access).toBeUndefined()
    }
    const page = await get(RECORD_PATH, '?kinds=send&limit=1')
    expect([page.status, JSON.parse(page.body)]).toEqual([200, { entries: [LINE], skipped: 0, incomplete: false, retentionDays: 90 }])
    const paged = JSON.parse((await get(RECORD_PATH, `?limit=1&since=${String(AT)}`)).body) as { entries: unknown[]; next: string }
    expect([paged.entries, paged.next]).toEqual([[{ ...LINE, kind: 'post', seq: 4 }], `${DAY}:1`])
    expect(JSON.parse((await get(RECORD_PATH, `?cursor=${paged.next}`)).body)).toMatchObject({ entries: [LINE] })
    const counts = await get(RECORD_COUNTS_PATH, `?since=${String(AT)}&until=${String(AT + 1)}`)
    expect([counts.status, JSON.parse(counts.body)]).toEqual([200, { counts: { send: 1, post: 1 }, skipped: 0, incomplete: false }])
  })

  it.each([
    [RECORD_PATH, '?limit=0'], [RECORD_PATH, '?limit=201'], [RECORD_PATH, '?limit=ten'], [RECORD_PATH, '?since=yesterday'],
    [RECORD_PATH, '?cursor=2026-11-11'], [RECORD_PATH, '?kinds=send,,post'],
    [RECORD_COUNTS_PATH, ''], [RECORD_COUNTS_PATH, '?since=1'], [RECORD_COUNTS_PATH, '?since=1&until=x'], [RECORD_COUNTS_PATH, '?since=x&until=1'],
    // Whole numbers outside years 0000 through 9999 (UTC).
    [RECORD_PATH, '?since=253402300800000'], [RECORD_COUNTS_PATH, '?since=0&until=253402300800000'], [RECORD_PATH, '?since=-1'],
    [RECORD_PATH, '?since=8640000000000001'], [RECORD_COUNTS_PATH, '?since=0&until=99999999999999999999'], [RECORD_COUNTS_PATH, '?since=-8640000000000001&until=1'],
  ])('answer 400 to %s%s', async (path, query) => {
    const { get } = await mounted(recorded())
    expect((await get(path, query)).status).toBe(400)
  })

  it('accepts the last millisecond of year 9999', async () => {
    const { get } = await mounted(recorded())
    expect((await get(RECORD_COUNTS_PATH, '?since=253402300799999&until=253402300799999')).status).toBe(200)
  })

  it('answer 500 with the failure when the record cannot be read', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'mumbo-run-wild-route-'))
    onTestFinished(() => { rmSync(parent, { recursive: true, force: true }) })
    writeFileSync(join(parent, 'file'), '')
    const { get } = await mounted(join(parent, 'file'))
    for (const [path, query] of [[RECORD_PATH, ''], [RECORD_COUNTS_PATH, '?since=0&until=1']] as const) {
      const failed = await get(path, query)
      expect(failed.status).toBe(500)
      expect(failed.body).toMatch(/ENOTDIR/)
    }
  })

})

describe('the page flag', () => {
  it('is in the owner\'s page bootstrap only', async () => {
    const { ctx } = await mounted(recorded())
    const tableFor = (kind: string): IndexInjection[] => {
      const table: IndexInjection[] = []
      ctx.emit('webserver/index-inject', table, { principal: { kind } } as never)
      return table
    }
    expect(tableFor('owner')).toEqual([{ kind: 'global', name: RECORD_GLOBAL, value: { record: true } }])
    expect(tableFor('member')).toEqual([])
  })

  it('goes with the plugin, as does the service; Connection removes the routes with the registering context', async () => {
    const { ctx, fiber } = await mounted(recorded())
    await fiber.dispose()
    const table: IndexInjection[] = []
    ctx.emit('webserver/index-inject', table, { principal: { kind: 'owner' } } as never)
    expect([table, ctx.get('mumbo-run-wild-record')]).toEqual([[], undefined])
  })
})
