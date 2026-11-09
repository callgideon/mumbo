/**
 * Real Xvfb, xdotool, ImageMagick import and headed Chromium. Self-skips, naming the missing program,
 * when any of them is absent; install `xvfb xdotool imagemagick xsel` and Playwright's Chromium to run it.
 */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { accessSync, constants, existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { once } from 'node:events'
import { chromium } from 'playwright'
import type { BrowserContext, Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ImageAttachmentRef, ImageRequestTarget } from '@deepseek-ai/dsh-attachment'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { bootComposition } from './harness.ts'

function onPath(command: string): boolean {
  return (process.env.PATH ?? '').split(delimiter).some((directory) => {
    try {
      accessSync(join(directory, command), constants.X_OK)
      return true
    } catch {
      // Not executable in this PATH entry; try the next one.
      return false
    }
  })
}

const missing = [
  ...['Xvfb', 'xdotool', 'import', 'xsel'].filter(command => !onPath(command)),
  ...existsSync(chromium.executablePath()) ? [] : ['Playwright Chromium'],
]

/** Requests half-size screenshots, so every model coordinate maps to twice its value on screen. */
class HalfScaleModel extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text', 'image'] })
  }

  override imageRequestTarget(_provider: string, _model: string, image: ImageAttachmentRef): ImageRequestTarget {
    return { width: image.width / 2, height: image.height / 2, maxBytes: image.bytes * 4 }
  }

  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new Error('no model turn in this test')
  }
}

const PAGE = `<body style="margin:0;height:3000px">
<textarea id="field" style="position:fixed;left:100px;top:100px;width:400px;height:160px;font-size:20px"></textarea>
<div id="target" style="position:fixed;left:600px;top:100px;width:200px;height:200px;background:#ccc"></div>
<script>
window.events = []
for (const type of ['mousedown', 'mouseup', 'dblclick']) {
  addEventListener(type, event => events.push({ type, button: event.button, x: event.clientX, y: event.clientY, shift: event.shiftKey }))
}
</script>
</body>`

describe.skipIf(missing.length > 0)(`computer tool on a real X display${missing.length > 0 ? ` (skipped: ${missing.join(', ')} not found)` : ''}`, () => {
  let xvfb: ChildProcess | undefined
  let browser: BrowserContext | undefined
  let context: Context | undefined
  let root: string | undefined
  let page: Page
  let agent: Agent

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-x11-e2e-'))
    // -displayfd selects a free display and writes its number, so concurrent runs never collide.
    const server = xvfb = spawn('Xvfb', ['-displayfd', '1', '-screen', '0', '1024x640x24', '-nolisten', 'tcp'], { stdio: ['ignore', 'pipe', 'ignore'] })
    const [line] = await once(server.stdout, 'data') as [Buffer]
    const display = `:${line.toString().trim()}`
    browser = await chromium.launchPersistentContext(join(root, 'profile'), {
      headless: false, viewport: null, args: ['--kiosk', '--window-position=0,0'], env: { ...process.env, DISPLAY: display },
    })
    page = browser.pages()[0] ?? await browser.newPage()
    await page.setContent(PAGE)
    await page.bringToFront()
    const booted = await bootComposition(root, { display }, new HalfScaleModel())
    context = booted.context
    agent = booted.agent
  }, 60_000)

  afterAll(async () => {
    await context?.fiber.dispose()
    await browser?.close()
    xvfb?.kill()
    if (root !== undefined) await rm(root, { recursive: true, force: true })
  })

  async function computer(args: Record<string, unknown>) {
    return executeToolFixture(context as Context, {
      agent, name: 'computer', callId: ToolCallId(`x11-${String(args.action)}`), arguments: args, signal: new AbortController().signal,
    })
  }

  const events = () => page.evaluate(() => (Reflect.get(window, 'events') as unknown[]).splice(0))

  it('captures the display, then clicks, types, presses chords, scrolls and drags at mapped coordinates', async () => {
    const shot = await computer({ action: 'screenshot' })
    expect(shot.isError).toBe(false)
    expect(shot.value).toMatchObject({ width: 512, height: 320, image: { width: 1024, height: 640 } })

    // Model pixel (150, 90) is screen pixel (301, 181), inside the field.
    expect((await computer({ action: 'click', x: 150, y: 90 })).isError).toBe(false)
    expect(await events()).toEqual([
      { type: 'mousedown', button: 0, x: 301, y: 181, shift: false },
      { type: 'mouseup', button: 0, x: 301, y: 181, shift: false },
    ])
    expect((await computer({ action: 'type', text: 'héllo ✓ 1+1' })).isError).toBe(false)
    await expect.poll(() => page.inputValue('#field')).toBe('héllo ✓ 1+1')
    expect((await computer({ action: 'key', keys: 'ctrl+a BackSpace' })).isError).toBe(false)
    await expect.poll(() => page.inputValue('#field')).toBe('')
    expect((await computer({ action: 'type', text: 'Plain ASCII, typed: {1+1}\n' })).isError).toBe(false)
    await expect.poll(() => page.inputValue('#field')).toBe('Plain ASCII, typed: {1+1}\n')

    expect((await computer({ action: 'click', x: 350, y: 100, count: 2, modifiers: ['shift'] })).isError).toBe(false)
    const eventTypes = () => page.evaluate(() => (Reflect.get(window, 'events') as Array<{ type: string }>).map(event => event.type))
    await expect.poll(eventTypes).toContain('dblclick')
    expect((await events()).find(event => (event as { type: string }).type === 'dblclick')).toMatchObject({ x: 701, y: 201, shift: true })

    expect((await computer({ action: 'scroll', x: 150, y: 250, deltaY: 3 })).isError).toBe(false)
    await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(0)

    expect((await computer({ action: 'drag', x: 310, y: 60, toX: 380, toY: 130 })).isError).toBe(false)
    expect(await events()).toEqual([
      { type: 'mousedown', button: 0, x: 621, y: 121, shift: false },
      { type: 'mouseup', button: 0, x: 761, y: 261, shift: false },
    ])

    const unknown = await computer({ action: 'key', keys: 'ctrl+nosuchkey' })
    expect(unknown.isError).toBe(true)
  })
})
