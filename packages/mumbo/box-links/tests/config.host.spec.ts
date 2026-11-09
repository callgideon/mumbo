/** The Host half validates the box links and embeds them in every page bootstrap. */
import { Context } from '@deepseek-ai/cordis'
import type { IndexInjection, WebServer } from '@deepseek-ai/dsh-host-webserver'
import { expect, it, onTestFinished } from 'vitest'
import * as host from '../src/index.ts'
import { BOX_LINKS_GLOBAL, Config } from '../src/config.ts'

/** The Peer an index render speaks for; this listener reads no field of it. */
const PAGE_PEER = { principal: { kind: 'owner' } } as Parameters<WebServer['renderIndex']>[1]

it('accepts absolute HTTP(S) links and an omitted desktop', () => {
  expect(host.Config).toBe(Config)
  expect(Config({ home: 'https://boxes.example/home', desktop: 'https://boxes.example/desktop/' }))
    .toEqual({ home: 'https://boxes.example/home', desktop: 'https://boxes.example/desktop/' })
  expect(Config({ home: 'http://127.0.0.1:8080/home' }).desktop).toBeUndefined()
})

it.each([
  ['no home link', { desktop: 'https://boxes.example/desktop/' }],
  ['a script URL', { home: 'javascript:alert(1)//' }],
  ['a relative URL', { home: '/home' }],
  ['a URL without a path', { home: 'https://boxes.example' }],
  ['a bad desktop link', { home: 'https://boxes.example/home', desktop: 'desktop' }],
])('rejects %s', (_case, config) => {
  expect(() => Config(config as Config)).toThrow()
})

it('embeds the links in each page bootstrap and withdraws them on disposal', async () => {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const config = Config({ home: 'https://boxes.example/home' })
  const fiber = ctx.plugin(host, config)
  await fiber.await()
  const rows: IndexInjection[] = []
  ctx.emit('webserver/index-inject', rows, PAGE_PEER)
  expect(rows).toEqual([{ kind: 'global', name: BOX_LINKS_GLOBAL, value: config }])
  await fiber.dispose()
  const after: IndexInjection[] = []
  ctx.emit('webserver/index-inject', after, PAGE_PEER)
  expect(after).toEqual([])
})
