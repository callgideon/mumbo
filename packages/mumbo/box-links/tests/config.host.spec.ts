/** The Host half validates the box links and Chrome control, and embeds the page links in every page bootstrap. */
import { Context } from '@deepseek-ai/cordis'
import type { IndexInjection, WebServer } from '@deepseek-ai/dsh-host-webserver'
// The `edge-member` principal kind a project member's page speaks for.
import type {} from '@mumbo/edge-member'
import { expect, it, onTestFinished } from 'vitest'
import * as host from '../src/index.ts'
import { BOX_LINKS_GLOBAL, Config, type BrowserConfig } from '../src/config.ts'

type PagePeer = Parameters<WebServer['renderIndex']>[1]
/** The Peer an index render speaks for; the listener reads only its principal kind. */
const OWNER = { principal: { kind: 'owner' } } as PagePeer
const MEMBER = { principal: { kind: 'edge-member', email: 'ann@example.com' } } as PagePeer

const HOME = 'https://boxes.example/home'
const DESKTOP = 'https://boxes.example/desktop/'
/** An empty object enables the Browser tab with every default. */
const BROWSER = {} as BrowserConfig

it('accepts absolute HTTP(S) links and an omitted desktop', () => {
  expect(host.Config).toBe(Config)
  expect(Config({ home: HOME, desktop: DESKTOP })).toEqual({ home: HOME, desktop: DESKTOP })
  expect(Config({ home: 'http://127.0.0.1:8080/home' }).desktop).toBeUndefined()
})

it('fills the Chrome control defaults of the mumbo desktop', () => {
  expect(Config({ home: HOME, desktop: DESKTOP, browser: BROWSER }).browser).toEqual({
    display: ':1', windowClass: 'chrom', wmctrl: 'wmctrl', timeoutMs: 15_000,
  })
})

it.each([
  ['no home link', { desktop: DESKTOP }],
  ['a script URL', { home: 'javascript:alert(1)//' }],
  ['a relative URL', { home: '/home' }],
  ['a URL without a path', { home: 'https://boxes.example' }],
  ['a bad desktop link', { home: HOME, desktop: 'desktop' }],
  ['a relative X authority file', { home: HOME, desktop: DESKTOP, browser: { xauthority: 'auth' } }],
  ['a display that is not an X display', { home: HOME, desktop: DESKTOP, browser: { display: 'one' } }],
  ['an empty window class', { home: HOME, desktop: DESKTOP, browser: { windowClass: '' } }],
  ['a relative wmctrl path', { home: HOME, desktop: DESKTOP, browser: { wmctrl: 'bin/wmctrl' } }],
  ['a zero timeout', { home: HOME, desktop: DESKTOP, browser: { timeoutMs: 0 } }],
])('rejects %s', (_case, config) => {
  expect(() => Config(config as Config)).toThrow()
})

it('refuses Chrome control on a box without a desktop', async () => {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const fiber = ctx.plugin(host, Config({ home: HOME, browser: BROWSER }))
  await expect(fiber.await()).rejects.toThrow(/browser requires desktop/)
})

it('embeds the links in each page bootstrap and withdraws them on disposal', async () => {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const config = Config({ home: HOME })
  const fiber = ctx.plugin(host, config)
  await fiber.await()
  const rows: IndexInjection[] = []
  ctx.emit('webserver/index-inject', rows, OWNER)
  expect(rows).toEqual([{ kind: 'global', name: BOX_LINKS_GLOBAL, value: config }])
  await fiber.dispose()
  const after: IndexInjection[] = []
  ctx.emit('webserver/index-inject', after, OWNER)
  expect(after).toEqual([])
})

it('tells only the owner\'s page about the Browser tab and keeps the Chrome control out of every page', async () => {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(host, Config({ home: HOME, desktop: DESKTOP, browser: BROWSER })).await()
  const page = (peer: PagePeer): IndexInjection[] => {
    const rows: IndexInjection[] = []
    ctx.emit('webserver/index-inject', rows, peer)
    return rows
  }
  expect(page(OWNER)).toEqual([{ kind: 'global', name: BOX_LINKS_GLOBAL, value: { home: HOME, desktop: DESKTOP, browser: true } }])
  expect(page(MEMBER)).toEqual([{ kind: 'global', name: BOX_LINKS_GLOBAL, value: { home: HOME, desktop: DESKTOP } }])
})

it('leaves the Browser tab off for a YAML browser key without a value', async () => {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  // A YAML `browser:` key without a value parses to null.
  await ctx.plugin(host, Config(JSON.parse(`{"home":"${HOME}","desktop":"${DESKTOP}","browser":null}`) as Config)).await()
  const rows: IndexInjection[] = []
  ctx.emit('webserver/index-inject', rows, OWNER)
  expect(rows).toEqual([{ kind: 'global', name: BOX_LINKS_GLOBAL, value: { home: HOME, desktop: DESKTOP } }])
})
