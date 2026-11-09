/**
 * Linux X11 computer-use provider: one `computer` tool that captures the configured display with
 * ImageMagick `import` and sends pointer and keyboard input with `xdotool`.
 * @module @deepseek-ai/dsh-computer-use-x11
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { ComputerUseProviderName } from '@deepseek-ai/dsh-computer-use/brand'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { MODIFIERS, translateKeys } from './keys.ts'
import type { Modifier } from './keys.ts'
import type {} from '@deepseek-ai/dsh-computer-use'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-subprocess'

/** Loader plugin identity. */
export const name = 'computer-use-x11'
/** Services required for registration, tool exposure and command execution. */
export const inject = ['computerUse', 'tools', 'subprocess']

/** X display selection, command locations and per-command bounds. */
export interface Config {
  /** X display name passed as `DISPLAY` to every command, such as `:1`. */
  display: string
  /** Absolute X authority file passed as `XAUTHORITY`; omission removes an inherited `XAUTHORITY`. */
  xauthority?: string
  /** `xdotool` executable: an absolute path or a name looked up on the subprocess provider's `PATH`. */
  xdotoolPath: string
  /** ImageMagick `import` executable: an absolute path or a name looked up on the subprocess provider's `PATH`. */
  importPath: string
  /** `xsel` executable that holds pasted text: an absolute path or a name looked up on the subprocess provider's `PATH`. */
  xselPath: string
  /** Deadline in milliseconds for each command; typing adds `typeDelayMs` per character. */
  timeoutMs: number
  /** Milliseconds a cancelled or timed-out command may take to exit after termination starts. */
  graceMs: number
  /** Maximum PNG bytes accepted from one screenshot command. */
  maxScreenshotBytes: number
  /** Delay in milliseconds between typed characters. */
  typeDelayMs: number
  /** Pointer movements dispatched between the start and end of a drag. */
  dragSteps: number
}

/** Validated configuration; `display` has no default because it names deployment-owned hardware. */
export const Config = Schema.object({
  display: Schema.string().pattern(/^[\w.-]*:\d+(\.\d+)?$/).required(),
  xauthority: Schema.string().pattern(/^\//),
  xdotoolPath: Schema.string().min(1).default('xdotool'),
  importPath: Schema.string().min(1).default('import'),
  xselPath: Schema.string().min(1).default('xsel'),
  timeoutMs: Schema.number().step(1).min(1).max(2 ** 31 - 1).default(10_000),
  graceMs: Schema.number().step(1).min(1).max(2 ** 31 - 1).default(1000),
  maxScreenshotBytes: Schema.number().step(1).min(1024).max(2 ** 31 - 1).default(32 * 1024 * 1024),
  typeDelayMs: Schema.number().step(1).min(0).max(1000).default(12),
  dragSteps: Schema.number().step(1).min(1).max(240).default(10),
}) satisfies Schema<Record<string, unknown>, Config>

/** Bytes retained from diagnostic output; xdotool prints only short status lines. */
const DIAGNOSTIC_BYTES = 64 * 1024

/** Actions accepted by the `computer` tool. */
export const ACTIONS = ['screenshot', 'click', 'move', 'drag', 'scroll', 'type', 'key'] as const

/** One `computer` tool action. */
export type Action = typeof ACTIONS[number]

/** An action that sends input through xdotool. */
export type InputAction = Exclude<Action, 'screenshot'>

const MEDIA_TYPES: readonly ImageMediaType[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

const BUTTONS = { left: '1', middle: '2', right: '3' } as const

/** Parameters each action accepts besides `action`. */
const FIELDS: Readonly<Record<Action, readonly string[]>> = {
  screenshot: [],
  click: ['x', 'y', 'button', 'count', 'modifiers'],
  move: ['x', 'y'],
  drag: ['x', 'y', 'toX', 'toY', 'button', 'modifiers'],
  scroll: ['x', 'y', 'deltaX', 'deltaY'],
  type: ['text'],
  key: ['keys'],
}

/** Model arguments after schema validation. */
export interface ComputerRequest {
  action: Action
  x?: number
  y?: number
  toX?: number
  toY?: number
  button?: keyof typeof BUTTONS
  count?: number
  modifiers?: Modifier[]
  deltaX?: number
  deltaY?: number
  text?: string
  keys?: string
}

/** Latest screenshot delivered to one Agent and the screen it was captured from. */
export interface ScreenFrame {
  /** Width in pixels of the image the model received. */
  width: number
  /** Height in pixels of the image the model received. */
  height: number
  /** Screen width in pixels at capture. */
  screenWidth: number
  /** Screen height in pixels at capture. */
  screenHeight: number
}

/** One resolved command of an input action. */
export interface InputStep {
  /** Program that runs this step. */
  program: 'xdotool' | 'xsel'
  /** Arguments after the executable. */
  args: string[]
  /** Text written to the program's standard input. */
  stdin?: string
  /** Deadline in milliseconds for this command. */
  timeoutMs: number
}

/** Characters xdotool types through the US keymap without remapping keycodes. */
const TYPEABLE = /^[\x20-\x7e\n\t]*$/

function rejectExtraFields(request: Readonly<ComputerRequest>): void {
  const extra = Object.keys(request).filter(key => key !== 'action' && !FIELDS[request.action].includes(key))
  if (extra.length > 0) throw new Error(`${request.action} does not accept ${extra.join(', ')}`)
}

function required<T>(value: T | undefined, field: string, action: Action): T {
  if (value === undefined) throw new Error(`${action} requires ${field}`)
  return value
}

function toScreen(frame: ScreenFrame | undefined, x: number, y: number): [string, string] {
  if (frame === undefined) throw new Error('Take a screenshot before using pixel coordinates')
  if (x < 0 || y < 0 || x >= frame.width || y >= frame.height) {
    throw new Error(`Coordinate (${x}, ${y}) is outside the latest ${frame.width}x${frame.height} screenshot`)
  }
  const map = (value: number, image: number, screen: number) => Math.min(screen - 1, Math.floor((value + 0.5) * screen / image))
  return [String(map(x, frame.width, frame.screenWidth)), String(map(y, frame.height, frame.screenHeight))]
}

function withModifiers(modifiers: readonly Modifier[] | undefined, args: string[]): string[] {
  if (modifiers === undefined || modifiers.length === 0) return args
  const chord = [...new Set(modifiers)].join('+')
  return ['keydown', chord, ...args, 'keyup', chord]
}

function wheel(delta: number, positive: string, negative: string): string[] {
  if (!Number.isInteger(delta) || delta < -10 || delta > 10) throw new Error('Scroll deltas must be integers from -10 to 10')
  return delta === 0 ? [] : ['click', '--repeat', String(Math.abs(delta)), delta > 0 ? positive : negative]
}

/**
 * Resolve one validated input request into ordered commands, mapping screenshot pixels to screen pixels.
 * Text with characters outside printable ASCII, newline and tab is placed in the CLIPBOARD and PRIMARY
 * selections and pasted with shift+Insert, because Chromium-based applications drop or substitute
 * characters that xdotool types by remapping a spare keycode.
 * @param request - schema-validated model arguments for any action except `screenshot`.
 * @param frame - the calling Agent's latest screenshot, required by pointer actions.
 * @param config - typing delay, drag steps and command deadline.
 * @returns the commands to run in order.
 * @throws Error naming the missing, extra or out-of-range parameter.
 */
export function resolveInput(
  request: Readonly<ComputerRequest & { action: InputAction }>,
  frame: ScreenFrame | undefined,
  config: Pick<Config, 'timeoutMs' | 'typeDelayMs' | 'dragSteps'>,
): InputStep[] {
  const { action } = request
  rejectExtraFields(request)
  const at = () => toScreen(frame, required(request.x, 'x', action), required(request.y, 'y', action))
  const button = BUTTONS[request.button ?? 'left']
  const command = (args: string[]): InputStep[] => [{ program: 'xdotool', args, timeoutMs: config.timeoutMs }]
  switch (action) {
    case 'click':
      return command(['mousemove', ...at(), ...withModifiers(request.modifiers,
        ['click', '--repeat', String(request.count ?? 1), button])])
    case 'move':
      return command(['mousemove', ...at()])
    case 'drag': {
      const [fromX, fromY] = at().map(Number) as [number, number]
      const [toX, toY] = toScreen(frame, required(request.toX, 'toX', action), required(request.toY, 'toY', action)).map(Number) as [number, number]
      const steps = Array.from({ length: config.dragSteps }, (_, index) => {
        const ratio = (index + 1) / config.dragSteps
        return ['mousemove', String(Math.round(fromX + (toX - fromX) * ratio)), String(Math.round(fromY + (toY - fromY) * ratio))]
      }).flat()
      return command(['mousemove', String(fromX), String(fromY),
        ...withModifiers(request.modifiers, ['mousedown', button, ...steps, 'mouseup', button])])
    }
    case 'scroll': {
      const vertical = wheel(request.deltaY ?? 0, '5', '4')
      const horizontal = wheel(request.deltaX ?? 0, '7', '6')
      if (vertical.length === 0 && horizontal.length === 0) throw new Error('scroll requires a nonzero deltaX or deltaY')
      return command(['mousemove', ...at(), ...vertical, ...horizontal])
    }
    case 'type': {
      const text = required(request.text, 'text', action)
      if (text === '') throw new Error('type requires non-empty text')
      if (!TYPEABLE.test(text)) {
        return [
          { program: 'xsel', args: ['--clipboard', '--input'], stdin: text, timeoutMs: config.timeoutMs },
          { program: 'xsel', args: ['--primary', '--input'], stdin: text, timeoutMs: config.timeoutMs },
          ...command(['key', 'shift+Insert']),
        ]
      }
      return [{ program: 'xdotool', args: ['type', '--delay', String(config.typeDelayMs), '--file', '-'], stdin: text,
        timeoutMs: config.timeoutMs + text.length * config.typeDelayMs }]
    }
    case 'key':
      return command(['key', ...translateKeys(required(request.keys, 'keys', action))])
    /* v8 ignore next 2 -- closed-union backstop after schema validation. */
    default:
      return assertNever(action)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Model-visible `computer` tool description for one display. */
function describe(display: string): string {
  return `Operate the Linux desktop on X display ${display}. Take a screenshot before using coordinates and after each action to verify it: actions report dispatch, not success. x, y, toX and toY are pixels in the latest screenshot. Actions: screenshot; click (x, y, optional button, count, modifiers); move (x, y; hovers); drag (from x, y to toX, toY, optional button, modifiers); scroll (x, y, deltaX and deltaY in wheel clicks, positive scrolls right and down); type (literal text including newlines; text containing non-ASCII characters is pasted with shift+Insert, replacing the clipboard and primary selection); key (keys: chords such as ctrl+l, ctrl+shift+t, alt+F4 or Return, separated by spaces for a sequence; use ctrl, not cmd). Keyboard input goes to the focused window; click a window to focus it. Start GUI programs from the shell with DISPLAY=${display} so they appear on this desktop.`
}

/**
 * Verify the commands and display, then register the provider and its `computer` tool.
 * Unload stops admitting calls, aborts running commands and awaits them before releasing the registration.
 * @param ctx - context with computer-use registration, tools and subprocess services.
 * @param config - validated display, executables and bounds.
 * @returns after the display answered and the tool is registered.
 * @throws Error with installation or display guidance when a command or the display is unavailable.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const env = { DISPLAY: config.display, XAUTHORITY: config.xauthority }

  async function resolve(command: string, label: string, install: string, field: string): Promise<string> {
    try {
      return await ctx.subprocess.resolveExecutable(command)
    } catch (error) {
      throw new Error(`computer-use-x11 could not find ${label} "${command}" (${errorMessage(error)}); install it (Debian/Ubuntu: apt-get install ${install}) or set ${field}`, { cause: error })
    }
  }

  async function run(executable: string, args: readonly string[], options: {
    signal: AbortSignal
    timeoutMs: number
    maxStdoutBytes: number
    stdin?: string
  }): Promise<{ stdout: Buffer; stderr: string }> {
    const label = `${executable} ${args[0]}`
    const deadline = AbortSignal.timeout(options.timeoutMs)
    const handle = ctx.subprocess.spawn({
      argv: [executable, ...args], cwd: '/', env, graceMs: config.graceMs,
      signal: AbortSignal.any([options.signal, deadline]),
      stdio: {
        stdin: options.stdin === undefined ? 'ignore' : { data: options.stdin },
        stdout: 'pipe',
        stderr: { maxBytes: DIAGNOSTIC_BYTES },
      },
    })
    const chunks: Buffer[] = []
    let size = 0
    const stdout = handle.stdout as NonNullable<typeof handle.stdout>
    // Resolves true when the output exceeded its bound and the command was terminated.
    const overflowed = (async () => {
      for await (const chunk of stdout as AsyncIterable<Buffer>) {
        size += chunk.length
        if (size > options.maxStdoutBytes) {
          handle.terminate()
          return true
        }
        chunks.push(chunk)
      }
      return false
    })()
    const [outcome, reading] = await Promise.allSettled([handle.done, overflowed])
    if (outcome.status === 'rejected') throw new Error(`${label} could not run: ${errorMessage(outcome.reason)}`, { cause: outcome.reason })
    options.signal.throwIfAborted()
    if (deadline.aborted) throw new Error(`${label} timed out after ${options.timeoutMs} ms`)
    if (reading.status === 'rejected') throw new Error(`${label} output could not be read: ${errorMessage(reading.reason)}`, { cause: reading.reason })
    if (reading.value) throw new Error(`${label} wrote more than ${options.maxStdoutBytes} bytes`)
    // Collect mode guarantees the stderr reader.
    const stderr = (handle.collected.stderr as NonNullable<typeof handle.collected.stderr>).readFrom(0).text.trim()
    const { exitCode, signal } = outcome.value
    if (exitCode !== 0) throw new Error(`${label} failed (${signal ?? `exit ${exitCode}`})${stderr === '' ? '' : `: ${stderr}`}`)
    return { stdout: Buffer.concat(chunks), stderr }
  }

  const lifetime = new AbortController()
  const programs = {
    xdotool: await resolve(config.xdotoolPath, 'xdotool', 'xdotool', 'xdotoolPath'),
    xsel: await resolve(config.xselPath, 'xsel', 'xsel', 'xselPath'),
    import: await resolve(config.importPath, 'ImageMagick import', 'imagemagick', 'importPath'),
  }
  try {
    await run(programs.xdotool, ['getdisplaygeometry'], { signal: lifetime.signal, timeoutMs: config.timeoutMs, maxStdoutBytes: DIAGNOSTIC_BYTES })
  } catch (error) {
    throw new Error(`computer-use-x11 cannot use X display "${config.display}": ${errorMessage(error)}. Start the X server for that display, or correct display or xauthority`, { cause: error })
  }

  const frames = new WeakMap<Agent, ScreenFrame>()
  const pending = new Set<Promise<unknown>>()

  async function screenshot(agent: Agent, signal: AbortSignal) {
    const attachments = ctx.get('attachments')
    if (attachments === undefined) throw new Error('computer screenshots require an attachment store')
    const routed = agent.session.requestHeader()?.config
    const provider = routed?.provider ?? agent.options.provider
    const model = routed?.model ?? agent.options.model
    const llm = ctx.get('llm')
    if (provider === undefined || model === undefined || llm === undefined) throw new Error('computer screenshot model route could not be resolved')
    const info = await llm.resolveModelInfo(provider, model, signal)
    if (!info.inputModalities?.includes('image')) throw new Error(`computer screenshots require model "${model}" to declare image input`)
    const { stdout } = await run(programs.import, ['-silent', '-window', 'root', 'png:-'], { signal, timeoutMs: config.timeoutMs, maxStdoutBytes: config.maxScreenshotBytes })
    const [image] = await attachments.saveImages([{ data: stdout, mediaType: 'image/png' }]) as [ImageAttachmentRef]
    signal.throwIfAborted()
    const request = await attachments.readImageRequest(image, llm.imageRequestTarget(provider, model, image), signal)
    const screen = image.originalDimensions ?? image
    frames.set(agent, { width: request.width, height: request.height, screenWidth: screen.width, screenHeight: screen.height })
    return { width: request.width, height: request.height, image }
  }

  const tool: ToolDefinition = defineTool({
    name: 'computer',
    description: describe(config.display),
    parameters: {
      action: { type: 'string', enum: ACTIONS, required: true },
      x: { type: 'integer', description: 'Pixel column in the latest screenshot; the drag start.' },
      y: { type: 'integer', description: 'Pixel row in the latest screenshot; the drag start.' },
      toX: { type: 'integer', description: 'Drag end column.' },
      toY: { type: 'integer', description: 'Drag end row.' },
      button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button; default left.' },
      count: { type: 'integer', enum: [1, 2, 3], description: 'Clicks; default 1.' },
      modifiers: { type: 'array', items: { type: 'string', enum: MODIFIERS }, description: 'Keys held during a click or drag.' },
      deltaX: { type: 'integer', description: 'Horizontal wheel clicks from -10 to 10.' },
      deltaY: { type: 'integer', description: 'Vertical wheel clicks from -10 to 10.' },
      text: { type: 'string', description: 'Text to type.' },
      keys: { type: 'string', description: 'Key chords to press.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          dispatched: { type: 'boolean', description: 'The input reached the X server; its effect is unverified.' },
          width: { type: 'integer', description: 'Screenshot width in pixels; coordinates use this space.' },
          height: { type: 'integer', description: 'Screenshot height in pixels.' },
          image: {
            type: 'object', additionalProperties: false, description: 'Durable attachment reference of the screenshot.',
            properties: {
              attachmentId: { type: 'string', required: true }, mediaType: { type: 'string', enum: MEDIA_TYPES, required: true },
              bytes: { type: 'integer', required: true }, width: { type: 'integer', required: true }, height: { type: 'integer', required: true },
              name: { type: 'string' },
              originalDimensions: { type: 'object', additionalProperties: false,
                properties: { width: { type: 'integer', required: true }, height: { type: 'integer', required: true } } },
            },
          },
        },
      },
      render: (_args, value) => {
        if (value.image === undefined) return [{ type: 'text', text: JSON.stringify(value) }]
        return [
          { type: 'text', text: `Screenshot of X display ${config.display}, ${value.width}x${value.height} px; coordinates use these pixels.` },
          { type: 'image', attachment: { ...value.image, attachmentId: AttachmentId(value.image.attachmentId) } },
        ]
      },
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('computer requires an Agent-owned execution')
      const signal = AbortSignal.any([exec.signal, lifetime.signal])
      const operation = (async () => {
        const { action } = args
        if (action === 'screenshot') {
          rejectExtraFields(args)
          return screenshot(agent, signal)
        }
        for (const step of resolveInput({ ...args, action }, frames.get(agent), config)) {
          const { stderr } = await run(programs[step.program], step.args, {
            signal, timeoutMs: step.timeoutMs, maxStdoutBytes: DIAGNOSTIC_BYTES,
            ...step.stdin === undefined ? {} : { stdin: step.stdin },
          })
          // xdotool reports unknown key names on stderr and still exits 0.
          if (stderr.includes('No such key name')) throw new Error(`xdotool skipped an unknown key name and sent the other keys: ${stderr}`)
        }
        return { dispatched: true }
      })()
      pending.add(operation)
      try {
        return await operation
      } finally {
        pending.delete(operation)
      }
    },
  })

  ctx.effect(function* () {
    yield ctx.computerUse.register(ComputerUseProviderName('x11'))
    yield async () => {
      lifetime.abort()
      await Promise.allSettled(pending)
    }
    yield ctx.tools.register(tool)
  }, 'computer-use-x11.runtime')
}
