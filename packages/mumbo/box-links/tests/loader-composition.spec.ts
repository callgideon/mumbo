/**
 * The plugin in real Loader compositions: the shipped example overlays put the links in the served page bootstrap,
 * and on a person box Host with Connection and the project member authenticator, the Browser tab's route brings
 * Chrome's window to the front for the owner and answers a member 403 before any command runs.
 */
import { randomBytes } from 'node:crypto'
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Group from '@deepseek-ai/cordis-plugin-group'
import Include, { applyEntryPatches } from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import * as EdgeMember from '@mumbo/edge-member'
import { expect, it, onTestFinished, vi } from 'vitest'
import * as BoxLinks from '../src/index.ts'

/** The Peer an index render speaks for. */
const PAGE_PEER = { principal: { kind: 'owner' } } as Parameters<WebServer['renderIndex']>[1]
const PAGE = '<!doctype html><html><head></head><body></body></html>'
const ROUTE = '/api/box-links.browser-front'

/** Boot `cordis.yml` rows through the Loader, resolving each package to the test's source-plane module. */
async function boot(ctx: Context, configPath: string, modules: ReadonlyMap<string, object>): Promise<void> {
  await ctx.plugin(Loader)
  ctx.loader.builtins.group = Group
  ctx.loader.builtins.include = class FixtureInclude extends Include {
    override import(specifier: string, getOuterStack?: () => string[]): unknown {
      if (specifier.startsWith('cordis:')) return super.import(specifier, getOuterStack)
      const module = modules.get(specifier)
      if (module === undefined) throw new Error(`Unexpected Loader import: ${specifier}`)
      return module
    }
  }
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
}

it.each([
  ['person', '{"home":"https://boxes.example/home","desktop":"https://boxes.example/desktop/","browser":true}', true],
  ['project', '{"home":"https://boxes.example/home"}', false],
])('serves the %s overlay links in the page bootstrap', { timeout: 60_000 }, async (box, links, stockBrowserOff) => {
  const directory = await mkdtemp(join(tmpdir(), 'mumbo-box-links-'))
  const ctx = new Context()
  onTestFinished(async () => {
    try { await ctx.fiber.dispose() } finally { await rm(directory, { recursive: true, force: true }) }
  })
  const overlay = fileURLToPath(new URL(`../examples/${box}.overlay.yml`, import.meta.url))
  // The stock Browser row as a composition that enables it carries it.
  const rows = applyEntryPatches(
    [
      { id: 'web', name: '@deepseek-ai/dsh-host-webserver', config: { host: '127.0.0.1', port: 0 } },
      { id: 'ui-sidebar-browser', name: '@deepseek-ai/dsh-client-ui-sidebar-browser', disabled: false },
    ],
    loadOverlayPatches('box-links-test', overlay),
    (message) => { throw new Error(message) },
  )
  const configPath = join(directory, 'cordis.yml')
  await writeFile(configPath, JSON.stringify(rows))
  ctx.baseUrl = pathToFileURL(directory).href + '/'
  await boot(ctx, configPath, new Map<string, object>([
    ['@deepseek-ai/dsh-host-webserver', WebServer],
    ['@mumbo/box-links', BoxLinks],
    ['@deepseek-ai/dsh-client-ui-sidebar-browser', { apply() {} }],
  ]))
  const entries = new Map([...ctx.loader.entries()].map(entry => [entry.options.id, entry]))
  await entries.get('box-links')!.fiber!.await()
  expect(entries.get('ui-sidebar-browser')!.fiber === undefined).toBe(stockBrowserOff)
  const page = entries.get('web')!.fiber!.ctx.webServer.renderIndex(PAGE, PAGE_PEER)
  expect(page).toContain(`<script>globalThis["__MUMBO_BOX_LINKS__"] = ${links}</script>`)
})

/**
 * A person box Host whose subprocess service plays a desktop's wmctrl: with a Chrome window, without one, or with a
 * hung X server whose wmctrl exits 50 ms after its signal aborts it.
 */
async function personBox(desktop: 'chrome' | 'empty' | 'hung' = 'chrome') {
  const key = randomBytes(32)
  vi.stubEnv('MUMBO_MEMBER_KEY', key.toString('base64url'))
  // The Loader writes entry state back to its file, such as `disabled` after an unload, so it reads a copy.
  const directory = await mkdtemp(join(tmpdir(), 'mumbo-box-links-'))
  const configPath = join(directory, 'cordis.yml')
  await copyFile(fileURLToPath(new URL('./fixtures/cordis.yml', import.meta.url)), configPath)
  const ctx = new Context()
  onTestFinished(async () => {
    try { await ctx.fiber.dispose() } finally {
      vi.unstubAllEnvs()
      await rm(directory, { recursive: true, force: true })
    }
  })
  const records = new Map<unknown, unknown>()
  ctx.provide('credentials', {
    async modifyRecord(record: unknown, mutate: (current: unknown) => Promise<unknown>): Promise<unknown> {
      const next = await mutate(records.get(record))
      if (next !== undefined) records.set(record, next)
      return next ?? records.get(record)
    },
  } as never)
  ctx.provide('workspaceRegistry', { list: () => [] } as never)
  ctx.provide('sessions', { list: () => [], get: () => undefined } as never)
  const commands: string[] = []
  const signals: AbortSignal[] = []
  let exited = 0
  ctx.provide('subprocess', {
    spawn: (spec: SubprocessSpawnSpec): Partial<SubprocessHandle> => {
      commands.push(spec.argv.join(' '))
      signals.push(spec.signal!)
      const reader = (text: string) => ({ readFrom: () => ({ text, nextOffset: text.length, lossy: false }) })
      const done = desktop === 'hung'
        ? new Promise<SubprocessOutcome>((resolve) => {
          spec.signal!.addEventListener('abort', () => {
            setTimeout(() => { exited += 1; resolve({ exitCode: null, signal: 'SIGTERM' }) }, 50)
          })
        })
        // Each command takes a moment, so calls that arrive together overlap unless the route orders them.
        : new Promise<SubprocessOutcome>((resolve) => { setTimeout(() => { resolve({ exitCode: desktop === 'chrome' ? 0 : 1, signal: null }) }, 25) })
      return { done, collected: { stdout: reader(''), stderr: reader('') } }
    },
  } as never)
  await boot(ctx, configPath, new Map<string, object>([
    ['@deepseek-ai/dsh-typert-registry', TypertRegistry],
    ['@deepseek-ai/dsh-api-remote-access', RemoteAccessService],
    ['@deepseek-ai/dsh-api-gateway', TypertGatewayService],
    ['@deepseek-ai/dsh-host-webserver', WebServer],
    ['@deepseek-ai/dsh-client-connection', Connection],
    ['@mumbo/edge-member', EdgeMember],
    ['@mumbo/box-links', BoxLinks],
  ]))
  expect([...ctx.loader.entries()].filter(entry => entry.fiber === undefined).map(entry => entry.options.id)).toEqual([])
  const origin = `http://127.0.0.1:${String(ctx.webServer.port)}`
  const post = (headers: Record<string, string>) => fetch(`${origin}${ROUTE}`, { method: 'POST', headers: { origin, ...headers } })
  /** Exchange the Host's launch token for the owner's browser cookie. */
  const owner = (): Record<string, string> => {
    const target = new URL(ctx.connection.authenticatedUrl(origin))
    let setCookie: string | undefined
    ctx.connection.authorizeIndex({ method: 'GET', url: `${target.pathname}${target.search}`, headers: { host: target.host } }, {
      writeHead(_status, headers) { setCookie = headers?.['set-cookie'] },
      end() {},
    })
    return { cookie: setCookie!.split(';', 1)[0]! }
  }
  const member = (): Record<string, string> => ({ 'x-mumbo-member': EdgeMember.signMemberHeader(key, 'ann@example.com', Math.floor(Date.now() / 1000) + 300) })
  return { ctx, commands, signals, exited: () => exited, post, owner, member }
}

const ACTIVATE = 'wmctrl -x -a chrom'
const MAXIMIZE = 'wmctrl -x -r chrom -b add,maximized_vert,maximized_horz'

it('refuses a project member before any command runs, and tells only the owner\'s page about the Browser tab', { timeout: 60_000 }, async () => {
  const box = await personBox()
  const response = await box.post(box.member())
  expect(response.status).toBe(403)
  expect(box.commands).toEqual([])
  const peer = box.ctx.connection.createPeer({ principal: { kind: 'edge-member', email: 'ann@example.com' } })
  expect(box.ctx.webServer.renderIndex(PAGE, peer)).not.toContain('"browser":true')
  expect(box.ctx.webServer.renderIndex(PAGE, PAGE_PEER)).toContain('"browser":true')
})

it('brings Chrome to the front for the owner, one call after the other when two arrive together', { timeout: 60_000 }, async () => {
  const box = await personBox()
  const cookie = box.owner()
  const responses = await Promise.all([box.post(cookie), box.post(cookie)])
  expect(responses.map(response => response.status)).toEqual([204, 204])
  expect(box.commands).toEqual([ACTIVATE, MAXIMIZE, ACTIVATE, MAXIMIZE])
})

it('answers the owner 500 when no Chrome window appears within the timeout', { timeout: 60_000 }, async () => {
  const box = await personBox('empty')
  const response = await box.post(box.owner())
  expect(response.status).toBe(500)
  expect(await response.text()).toBe('Chrome did not start within 600 ms: no window of class "chrom" on :1')
  expect(new Set(box.commands)).toEqual(new Set([ACTIVATE]))
})

it('removes the route on unload, after aborting the running command and waiting for it to exit', { timeout: 60_000 }, async () => {
  const box = await personBox('hung')
  const cookie = box.owner()
  const pending = box.post(cookie)
  await expect.poll(() => box.commands).toEqual([ACTIVATE])
  const entry = [...box.ctx.loader.entries()].find(row => row.options.id === 'box-links')!
  await entry.fiber!.dispose()
  // The command exits 50 ms after its abort; unload returns only after it did.
  expect(box.signals[0]!.aborted).toBe(true)
  expect(box.exited()).toBe(1)
  const response = await pending
  expect(response.status).toBe(500)
  expect(await response.text()).toBe('This operation was aborted')
  const after = await box.post(cookie)
  expect(after.status).toBe(404)
  expect(box.commands).toEqual([ACTIVATE])
})
