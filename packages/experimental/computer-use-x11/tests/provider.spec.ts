/** Provider lifecycle, command construction and failure reports with the subprocess boundary mocked. */
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ComputerUseRegistry from '@deepseek-ai/dsh-computer-use'
import { ComputerUseProviderName } from '@deepseek-ai/dsh-computer-use/brand'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as X11Provider from '../src/index.ts'
import { RELEASE_ARGS, resolveInput } from '../src/index.ts'
import type { ScreenFrame } from '../src/index.ts'

interface Behavior {
  stdout?: string | Buffer
  stderr?: string
  exitCode?: number
  signal?: NodeJS.Signals
  reject?: unknown
  hang?: true
  stdoutError?: Error
}

interface Spawned {
  argv: readonly string[]
  env: SubprocessSpawnSpec['env']
  stdin: SubprocessSpawnSpec['stdio']['stdin']
}

let ctx: Context
let spawned: Spawned[]
let missing: Set<string>
let behave: (argv: readonly string[]) => Behavior

function spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
  spec.signal?.throwIfAborted()
  spawned.push({ argv: spec.argv, env: spec.env, stdin: spec.stdio.stdin })
  const behavior = behave(spec.argv)
  const stdout = new PassThrough()
  const done = Promise.withResolvers<SubprocessOutcome>()
  const finish = (outcome: SubprocessOutcome) => {
    stdout.end()
    done.resolve(outcome)
  }
  const handle: SubprocessHandle = {
    stdin: undefined, stdout, stderr: undefined, control: undefined,
    collected: { stderr: { readFrom: () => ({ text: behavior.stderr ?? '', nextOffset: 0, lossy: false }) } },
    done: done.promise,
    terminate: () => {
      finish({ exitCode: null, signal: 'SIGTERM' })
    },
    waitForExit: () => Promise.resolve(true),
  }
  spec.signal?.addEventListener('abort', () => {
    handle.terminate()
  }, { once: true })
  setImmediate(() => {
    if (behavior.reject !== undefined) {
      stdout.end()
      done.reject(behavior.reject)
      return
    }
    if (behavior.hang) return
    if (behavior.stdoutError !== undefined) stdout.destroy(behavior.stdoutError)
    if (behavior.stdout !== undefined) stdout.write(behavior.stdout)
    finish({ exitCode: behavior.exitCode ?? 0, signal: behavior.signal ?? null })
  })
  return handle
}

/** Hang every command except the release, so the release itself completes. */
const hangInput = (argv: readonly string[]): Behavior => argv[1] === RELEASE_ARGS[0] ? {} : { hang: true }

const agent = { session: { requestHeader: () => undefined }, options: { provider: 'fixture', model: 'vision' } }

async function call(args: Record<string, unknown>, options: { agent?: unknown; signal?: AbortSignal } = {}) {
  const tool = ctx.tools.get('computer')
  if (tool === undefined) throw new Error('computer tool is not registered')
  return tool.execute(args, { agent: 'agent' in options ? options.agent : agent, signal: options.signal ?? new AbortController().signal } as never)
}

function screenshotServices(inputModalities: string[] = ['text', 'image']) {
  ctx.provide('attachments', {
    saveImages: () => Promise.resolve([{ attachmentId: 'a', mediaType: 'image/png', bytes: 3, width: 1440, height: 900 }]),
    readImageRequest: () => Promise.resolve({ width: 720, height: 450 }),
  } as never)
  ctx.provide('llm', {
    resolveModelInfo: () => Promise.resolve({ inputModalities }),
    imageRequestTarget: () => ({ width: 720, height: 450, maxBytes: 1 }),
  } as never)
}

/** Deliver one 720x450 screenshot of the 1440x900 screen, then forget the commands it ran. */
async function takeFrame(): Promise<void> {
  screenshotServices()
  const previous = behave
  behave = () => ({ stdout: 'png' })
  await call({ action: 'screenshot' })
  behave = previous
  spawned = []
}

beforeEach(async () => {
  spawned = []
  missing = new Set()
  behave = argv => argv[1] === 'getdisplaygeometry' ? { stdout: '1440 900\n' } : {}
  ctx = new Context()
  ctx.provide('subprocess', {
    resolveExecutable: (command: string) => missing.has(command)
      ? Promise.reject(new Error('not on PATH'))
      : Promise.resolve(`/usr/bin/${command}`),
    spawn,
  } as never)
  await ctx.plugin(ComputerUseRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
})

afterEach(async () => {
  await ctx.fiber.dispose()
})

describe('provider lifecycle', () => {
  it('checks the display, registers the tool and releases both on unload', async () => {
    const fiber = ctx.plugin(X11Provider, { display: ':1' })
    await fiber
    expect(ctx.computerUse.providerName).toBe('x11')
    expect(ctx.tools.schemas().map(tool => tool.name)).toEqual(['computer'])
    expect(spawned).toEqual([{ argv: ['/usr/bin/xdotool', 'getdisplaygeometry'], env: { DISPLAY: ':1', XAUTHORITY: undefined }, stdin: 'ignore' }])
    await fiber.dispose()
    expect(spawned.at(-1)?.argv).toEqual(['/usr/bin/xdotool', ...RELEASE_ARGS])
    expect(ctx.tools.schemas()).toEqual([])
    expect(ctx.computerUse.providerName).toBeUndefined()
  })

  it('aborts running commands before releasing the registration', async () => {
    const fiber = ctx.plugin(X11Provider, { display: ':1' })
    await fiber
    await takeFrame()
    behave = hangInput
    const running = expect(call({ action: 'click', x: 1, y: 1 })).rejects.toThrow()
    await new Promise(resolve => setImmediate(resolve))
    await fiber.dispose()
    await running
    // The interrupted click and unload each release held input.
    expect(spawned.filter(entry => entry.argv[1] === RELEASE_ARGS[0])).toHaveLength(2)
    expect(ctx.computerUse.providerName).toBeUndefined()
  })

  it('rejects a second computer-use provider', async () => {
    const release = ctx.computerUse.register(ComputerUseProviderName('another'))
    await expect(ctx.plugin(X11Provider, { display: ':1' })).rejects.toThrow('already registered')
    await release()
  })

  it.each([
    ['xdotool', 'apt-get install xdotool) or set xdotoolPath'],
    ['xsel', 'apt-get install xsel) or set xselPath'],
    ['import', 'apt-get install imagemagick) or set importPath'],
  ])('names the installation step when %s is missing', async (command, guidance) => {
    missing.add(command)
    await expect(ctx.plugin(X11Provider, { display: ':1' })).rejects.toThrow(guidance)
    expect(ctx.computerUse.providerName).toBeUndefined()
  })

  it('fails loud when the display does not answer', async () => {
    behave = () => ({ exitCode: 1, stderr: 'Error: Can\'t open display: (null)\nFailed creating new xdo instance' })
    await expect(ctx.plugin(X11Provider, { display: ':9', xauthority: '/home/browser/.Xauthority' })).rejects.toThrow(
      'computer-use-x11 cannot use X display ":9": /usr/bin/xdotool getdisplaygeometry failed (exit 1): Error: Can\'t open display',
    )
    expect(spawned[0]?.env).toEqual({ DISPLAY: ':9', XAUTHORITY: '/home/browser/.Xauthority' })
  })
})

describe('computer tool', () => {
  beforeEach(async () => {
    await ctx.plugin(X11Provider, { display: ':1', maxScreenshotBytes: 1024, timeoutMs: 50 })
    spawned = []
  })

  it('captures the root window and maps later coordinates from the delivered image size', async () => {
    screenshotServices()
    behave = () => ({ stdout: 'png' })
    await expect(call({ action: 'screenshot' })).resolves.toMatchObject({ width: 720, height: 450, image: { attachmentId: 'a' } })
    expect(spawned[0]?.argv).toEqual(['/usr/bin/import', '-silent', '-window', 'root', 'png:-'])
    behave = () => ({})
    await expect(call({ action: 'click', x: 719, y: 0, button: 'right', modifiers: ['ctrl', 'shift', 'ctrl'] })).resolves.toEqual({ dispatched: true })
    expect(spawned[1]?.argv).toEqual(['/usr/bin/xdotool', 'mousemove', '1439', '1',
      'keydown', 'ctrl+shift', 'click', '--repeat', '1', '3', 'keyup', 'ctrl+shift'])
  })

  it('takes the request route from the Session header before Agent options', async () => {
    screenshotServices()
    behave = () => ({ stdout: 'png' })
    const routed = { session: { requestHeader: () => ({ config: { provider: 'routed', model: 'routed-vision' } }) }, options: {} }
    await expect(call({ action: 'screenshot' }, { agent: routed })).resolves.toMatchObject({ width: 720 })
  })

  it('pastes non-ASCII text through both selections and types ASCII directly', async () => {
    await call({ action: 'type', text: 'naïve' })
    expect(spawned.map(entry => [entry.argv.slice(1), entry.stdin])).toEqual([
      [['--clipboard', '--input'], { data: 'naïve' }],
      [['--primary', '--input'], { data: 'naïve' }],
      [['key', 'shift+Insert'], 'ignore'],
    ])
    expect(spawned[0]?.argv[0]).toBe('/usr/bin/xsel')
  })

  it.each([
    [{ action: 'screenshot' }, 'computer screenshots require an attachment store'],
    [{ action: 'screenshot', x: 1 }, 'screenshot does not accept x'],
    [{ action: 'click', x: 1, y: 1 }, 'Take a screenshot before using pixel coordinates'],
    [{ action: 'key', keys: 'cmd+c' }, '"cmd" has no key on this Linux desktop'],
  ])('rejects %j before running a command', async (args, message) => {
    await expect(call(args)).rejects.toThrow(message)
    expect(spawned).toEqual([])
  })

  it('requires an Agent-owned execution', async () => {
    await expect(call({ action: 'key', keys: 'Return' }, { agent: undefined })).rejects.toThrow('computer requires an Agent-owned execution')
  })

  it('requires a resolvable model route before capture', async () => {
    ctx.provide('attachments', {} as never)
    await expect(call({ action: 'screenshot' })).rejects.toThrow('computer screenshot model route could not be resolved')
    expect(spawned).toEqual([])
  })

  it('requires a model that declares image input before capture', async () => {
    screenshotServices(['text'])
    await expect(call({ action: 'screenshot' })).rejects.toThrow('computer screenshots require model "vision" to declare image input')
    expect(spawned).toEqual([])
  })

  it('reports key names that xdotool skipped and releases held input', async () => {
    behave = () => ({ stderr: '(symbol) No such key name \'XF86AudioMute\'. Ignoring it.' })
    await expect(call({ action: 'key', keys: 'ctrl+XF86AudioMute' })).rejects.toThrow('xdotool skipped an unknown key name and sent the other keys')
    expect(spawned.map(entry => entry.argv.slice(1))).toEqual([['key', 'ctrl+XF86AudioMute'], RELEASE_ARGS])
  })

  it.each([
    'exec xterm', 'sleep 60', 'windowkill', 'getactivewindow', 'Exec xterm', 'GETACTIVEWINDOW', 'ctrl+exec', 'Return exec reboot', 'windowclose',
  ])('rejects the xdotool command name in %j before running a command', async (keys) => {
    await expect(call({ action: 'key', keys })).rejects.toThrow('Unknown key')
    expect(spawned).toEqual([])
  })

  it('releases modifiers and buttons after a timed-out drag', async () => {
    await takeFrame()
    behave = hangInput
    await expect(call({ action: 'drag', x: 0, y: 0, toX: 1, toY: 1, modifiers: ['shift'] })).rejects.toThrow('timed out after 50 ms')
    expect(spawned.map(entry => entry.argv[1])).toEqual(['mousemove', 'keyup'])
    expect(spawned[1]?.argv).toEqual(['/usr/bin/xdotool', ...RELEASE_ARGS])
  })

  it('keeps the input failure when the release also fails', async () => {
    await takeFrame()
    behave = () => ({ exitCode: 1 })
    await expect(call({ action: 'click', x: 1, y: 1, modifiers: ['ctrl'] })).rejects.toThrow('/usr/bin/xdotool mousemove failed (exit 1)')
    expect(spawned.at(-1)?.argv.slice(1)).toEqual(RELEASE_ARGS)
  })

  it.each<[Behavior, string]>([
    [{ reject: new Error('spawn EACCES') }, '/usr/bin/xdotool key could not run: spawn EACCES'],
    [{ reject: 'provider closed' }, '/usr/bin/xdotool key could not run: provider closed'],
    [{ hang: true }, '/usr/bin/xdotool key timed out after 50 ms'],
    [{ exitCode: 1 }, '/usr/bin/xdotool key failed (exit 1)'],
    [{ stdoutError: new Error('EIO') }, '/usr/bin/xdotool key output could not be read: EIO'],
    [{ exitCode: 1, signal: 'SIGKILL' }, '/usr/bin/xdotool key failed (SIGKILL)'],
    [{ stdout: Buffer.alloc(64 * 1024 + 1) }, '/usr/bin/xdotool key wrote more than 65536 bytes'],
  ])('reports command failure %j', async (behavior, message) => {
    behave = () => behavior
    await expect(call({ action: 'key', keys: 'Return' })).rejects.toThrow(message)
  })

  it('bounds screenshot bytes', async () => {
    screenshotServices()
    behave = () => ({ stdout: Buffer.alloc(1025) })
    await expect(call({ action: 'screenshot' })).rejects.toThrow('/usr/bin/import -silent wrote more than 1024 bytes')
  })

  it('stops a cancelled command and releases held input', async () => {
    behave = hangInput
    const controller = new AbortController()
    const running = expect(call({ action: 'key', keys: 'ctrl+shift+t' }, { signal: controller.signal })).rejects.toThrow('cancelled by caller')
    await new Promise(resolve => setImmediate(resolve))
    controller.abort(new Error('cancelled by caller'))
    await running
    expect(spawned.map(entry => entry.argv.slice(1))).toEqual([['key', 'ctrl+shift+t'], RELEASE_ARGS])
  })
})

describe('resolveInput', () => {
  const frame: ScreenFrame = { width: 100, height: 50, screenWidth: 1000, screenHeight: 500 }
  const config = { timeoutMs: 1000, typeDelayMs: 10, dragSteps: 2 }
  const args = (request: Parameters<typeof resolveInput>[0]) => resolveInput(request, frame, config).map(step => step.args)

  it('maps each pixel to the center of its screen region', () => {
    expect(args({ action: 'move', x: 0, y: 49 })).toEqual([['mousemove', '5', '495']])
    expect(args({ action: 'click', x: 10, y: 10, count: 2 })).toEqual([['mousemove', '105', '105', 'click', '--repeat', '2', '1']])
  })

  it('drags through intermediate points with the button held', () => {
    expect(args({ action: 'drag', x: 0, y: 0, toX: 10, toY: 20, button: 'middle', modifiers: ['alt'] })).toEqual([[
      'mousemove', '5', '5', 'keydown', 'alt', 'mousedown', '2',
      'mousemove', '55', '105', 'mousemove', '105', '205', 'mouseup', '2', 'keyup', 'alt',
    ]])
  })

  it('scrolls with wheel buttons in both directions', () => {
    expect(args({ action: 'scroll', x: 1, y: 1, deltaY: -2, deltaX: 3 })).toEqual([[
      'mousemove', '15', '15', 'click', '--repeat', '2', '4', 'click', '--repeat', '3', '7',
    ]])
    expect(args({ action: 'scroll', x: 1, y: 1, deltaY: 1, deltaX: -1 })).toEqual([[
      'mousemove', '15', '15', 'click', '--repeat', '1', '5', 'click', '--repeat', '1', '6',
    ]])
  })

  it('extends the typing deadline by the per-character delay', () => {
    expect(resolveInput({ action: 'type', text: 'abc' }, undefined, config)).toEqual([
      { program: 'xdotool', args: ['type', '--delay', '10', '--file', '-'], stdin: 'abc', timeoutMs: 1030 },
    ])
  })

  it.each([
    [{ action: 'move', x: 1 }, 'move requires y'],
    [{ action: 'move', x: 100, y: 0 }, 'Coordinate (100, 0) is outside the latest 100x50 screenshot'],
    [{ action: 'move', x: -1, y: 0 }, 'is outside'],
    [{ action: 'drag', x: 1, y: 1 }, 'drag requires toX'],
    [{ action: 'scroll', x: 1, y: 1 }, 'scroll requires a nonzero deltaX or deltaY'],
    [{ action: 'scroll', x: 1, y: 1, deltaY: 11 }, 'Scroll deltas must be integers from -10 to 10'],
    [{ action: 'type', text: '' }, 'type requires non-empty text'],
    [{ action: 'type' }, 'type requires text'],
    [{ action: 'key', text: 'a' }, 'key does not accept text'],
  ])('rejects %j', (request, message) => {
    expect(() => resolveInput(request as Parameters<typeof resolveInput>[0], frame, config)).toThrow(message)
  })
})
