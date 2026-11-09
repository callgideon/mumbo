/** The shipped example overlays load through the real Loader and put the links in the served page bootstrap. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include, { applyEntryPatches } from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { expect, it, onTestFinished } from 'vitest'
import * as BoxLinks from '../src/index.ts'

/** The Peer an index render speaks for; the links do not depend on it. */
const PAGE_PEER = { principal: { kind: 'owner' } } as Parameters<WebServer['renderIndex']>[1]
const PAGE = '<!doctype html><html><head></head><body></body></html>'

it.each([
  ['person', '{"home":"https://boxes.example/home","desktop":"https://boxes.example/desktop/"}'],
  ['project', '{"home":"https://boxes.example/home"}'],
])('serves the %s overlay links in the page bootstrap', { timeout: 60_000 }, async (box, links) => {
  const directory = await mkdtemp(join(tmpdir(), 'mumbo-box-links-'))
  const ctx = new Context()
  onTestFinished(async () => {
    try { await ctx.fiber.dispose() } finally { await rm(directory, { recursive: true, force: true }) }
  })
  const overlay = fileURLToPath(new URL(`../examples/${box}.overlay.yml`, import.meta.url))
  const rows = applyEntryPatches(
    [{ id: 'web', name: '@deepseek-ai/dsh-host-webserver', config: { host: '127.0.0.1', port: 0 } }],
    loadOverlayPatches('box-links-test', overlay),
    (message) => { throw new Error(message) },
  )
  const configPath = join(directory, 'cordis.yml')
  await writeFile(configPath, JSON.stringify(rows))
  ctx.baseUrl = pathToFileURL(directory).href + '/'
  await ctx.plugin(Loader)
  // Loader imports resolve to the test's source-plane modules.
  const modules = new Map<string, object>([
    ['@deepseek-ai/dsh-host-webserver', WebServer],
    ['@mumbo/box-links', BoxLinks],
  ])
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
  const entries = new Map([...ctx.loader.entries()].map(entry => [entry.options.id, entry]))
  await entries.get('box-links')!.fiber!.await()
  const page = entries.get('web')!.fiber!.ctx.webServer.renderIndex(PAGE, PAGE_PEER)
  expect(page).toContain(`<script>globalThis["__MUMBO_BOX_LINKS__"] = ${links}</script>`)
})
