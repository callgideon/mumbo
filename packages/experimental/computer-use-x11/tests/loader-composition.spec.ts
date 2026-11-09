/** Real Loader, AgentLoop, attachment store and local subprocesses with fake xdotool and import executables. */
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef, ImageRequestTarget } from '@deepseek-ai/dsh-attachment'
import { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { bootComposition, whitePng } from './harness.ts'

const CALLS = [
  { id: 'x11-screenshot', arguments: { action: 'screenshot' } },
  { id: 'x11-click', arguments: { action: 'click', x: 10, y: 5 } },
  { id: 'x11-paste', arguments: { action: 'type', text: 'héllo ✓\n' } },
  { id: 'x11-type', arguments: { action: 'type', text: 'ok\n' } },
]

/** Requests half-size images, so model coordinates are doubled on the 64x40 screen. */
class VisualModel extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text', 'image'] })
  }

  override imageRequestTarget(_provider: string, _model: string, image: ImageAttachmentRef): ImageRequestTarget {
    return { width: image.width / 2, height: image.height / 2, maxBytes: image.bytes * 4 }
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const call = CALLS[this.requests.length - 1]
    if (call !== undefined) {
      const block = { type: 'tool-call' as const, id: ToolCallId(call.id), name: 'computer', arguments: JSON.stringify(call.arguments) }
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Typed into the clicked field.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

let context: Context | undefined
let root: string | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  context = undefined
  root = undefined
})

it('loads from cordis.yml, maps screenshot pixels to the screen and logs the screenshot for the next request', { timeout: 60_000 }, async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-x11-composition-'))
  const log = join(root, 'xdotool.log')
  const typed = join(root, 'typed.txt')
  const selections = join(root, 'selections.txt')
  await writeFile(join(root, 'screen.png'), whitePng(64, 40))
  await writeFile(join(root, 'xdotool'), `#!/bin/sh
printf '%s|%s|%s\\n' "$DISPLAY" "\${XAUTHORITY-unset}" "$*" >> '${log}'
case "$1" in
  getdisplaygeometry) echo '64 40' ;;
  type) cat >> '${typed}' ;;
esac
`)
  await writeFile(join(root, 'import'), `#!/bin/sh\ncat '${join(root, 'screen.png')}'\n`)
  await writeFile(join(root, 'xsel'), `#!/bin/sh\nprintf '%s:' "$1" >> '${selections}'\ncat >> '${selections}'\n`)
  for (const program of ['xdotool', 'import', 'xsel']) await chmod(join(root, program), 0o755)

  const model = new VisualModel()
  const booted = await bootComposition(root, {
    display: ':7', xauthority: '/run/x11-fixture/auth', xdotoolPath: join(root, 'xdotool'), importPath: join(root, 'import'), xselPath: join(root, 'xsel'),
  }, model)
  context = booted.context
  const { agent } = booted
  expect(context.computerUse.providerName).toBe('x11')
  const idle: PromiseWithResolvers<void> = Promise.withResolvers()
  const stop = context.on('agent/status', ({ agent: subject, status }) => {
    if (subject === agent && status === 'idle') idle.resolve()
  })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Type into the field.' }], source: { kind: 'user' } }))
  await idle.promise
  stop()

  expect(model.requests).toHaveLength(5)
  expect(JSON.stringify(model.requests[0]?.tools)).toContain('Operate the Linux desktop on X display :7.')
  const results = agent.session.deriveMessages().filter(message => message.role === 'tool')
  expect(results.map(result => result.role === 'tool' && result.isError)).toEqual([false, false, false, false])
  const screenshot = results[0]
  if (screenshot?.role !== 'tool') throw new Error('Screenshot result was not logged')
  expect(screenshot.content[0]).toEqual({ type: 'text', text: 'Screenshot of X display :7, 32x20 px; coordinates use these pixels.' })
  const image = screenshot.content[1]
  if (image?.type !== 'image') throw new Error('Screenshot image was not admitted')
  expect(image.attachment).toMatchObject({ mediaType: 'image/png', width: 64, height: 40 })
  expect(JSON.stringify(model.requests[1]?.messages)).toContain(JSON.stringify(image.attachment))

  expect((await readFile(log, 'utf8')).trim().split('\n')).toEqual([
    ':7|/run/x11-fixture/auth|getdisplaygeometry',
    // (10 + 0.5) * 64 / 32 and (5 + 0.5) * 40 / 20, rounded down.
    ':7|/run/x11-fixture/auth|mousemove 21 11 click --repeat 1 1',
    ':7|/run/x11-fixture/auth|key shift+Insert',
    ':7|/run/x11-fixture/auth|type --delay 12 --file -',
  ])
  expect(await readFile(selections, 'utf8')).toBe('--clipboard:héllo ✓\n--primary:héllo ✓\n')
  expect(await readFile(typed, 'utf8')).toBe('ok\n')
})
