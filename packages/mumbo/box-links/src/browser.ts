/** Bring the desktop's Chrome window to the front, maximized, for the Browser tab. */
import { setTimeout as sleep } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subprocess'
import type { BrowserConfig } from './config.ts'

/** Bytes kept from each command's output; wmctrl prints at most a short diagnostic here. */
const OUTPUT_BYTES = 64 * 1024
/** Interval between attempts while no Chrome window exists yet. */
const POLL_MS = 250
/** Exit allowance of a wmctrl command aborted at the deadline; each command is one short X request. */
const GRACE_MS = 1000

/** Exit facts and trimmed output of one finished command. */
interface Ran {
  /** Exit code; null when a signal ended the command. */
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
}

function failure(label: string, { exitCode, stderr }: Ran): Error {
  return new Error(`${label} failed (${exitCode === null ? 'signal' : `exit ${String(exitCode)}`})${stderr === '' ? '' : `: ${stderr}`}`)
}

/**
 * Activate the first window the window manager lists whose WM_CLASS contains `windowClass`, then maximize it. While
 * no window matches, for example while the desktop's restart loop brings a closed Chrome back, try again every 250 ms
 * until `timeoutMs` has passed since the call began. Activation goes through EWMH, so the window manager restores a
 * minimized window and switches to its workspace; this never starts Chrome.
 * @param ctx - context carrying the subprocess service.
 * @param config - display, window class, wmctrl executable, and deadline.
 * @param signal - aborts the call.
 * @returns after the window manager was asked to activate and maximize a Chrome window.
 * @throws Error naming the failed or unfinished wmctrl command, or saying that no Chrome window appeared in time.
 */
export async function frontChrome(ctx: Context, config: BrowserConfig, signal: AbortSignal): Promise<void> {
  const env = { DISPLAY: config.display, XAUTHORITY: config.xauthority }
  const deadline = AbortSignal.timeout(config.timeoutMs)
  // A function, so the check reads the signal again after each await rather than a narrowed earlier value.
  const expired = (): boolean => deadline.aborted
  const bounded = AbortSignal.any([signal, deadline])
  const unfinished = (args: readonly string[]): Error =>
    new Error(`wmctrl ${args.join(' ')} did not finish within ${String(config.timeoutMs)} ms on ${config.display}`)

  async function wmctrl(args: readonly string[]): Promise<Ran> {
    signal.throwIfAborted()
    if (expired()) throw unfinished(args)
    const handle = ctx.subprocess.spawn({
      argv: [config.wmctrl, ...args], cwd: '/', env, graceMs: GRACE_MS, signal: bounded,
      stdio: { stdin: 'ignore', stdout: { maxBytes: OUTPUT_BYTES }, stderr: { maxBytes: OUTPUT_BYTES } },
    })
    const outcome = await handle.done.catch((error: unknown) => {
      throw new Error(`wmctrl could not run: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    })
    signal.throwIfAborted()
    // A command the deadline killed names itself: a hung X server or window manager, not a missing Chrome.
    if (outcome.signal !== null && expired()) throw unfinished(args)
    const read = (reader: typeof handle.collected.stdout): string => reader?.readFrom(0).text.trim() ?? ''
    return {
      exitCode: outcome.signal === null ? outcome.exitCode : null,
      stdout: read(handle.collected.stdout),
      stderr: read(handle.collected.stderr),
    }
  }

  for (;;) {
    const activated = await wmctrl(['-x', '-a', config.windowClass])
    if (activated.exitCode === 0) break
    // wmctrl exits 1 without a diagnostic when no window matches; every other outcome is a failure.
    if (activated.exitCode !== 1 || activated.stdout !== '' || activated.stderr !== '') throw failure('wmctrl -x -a', activated)
    try {
      await sleep(POLL_MS, undefined, { signal: bounded })
    } catch (error) {
      // The sleep only rejects on abort: the caller's, or the deadline's.
      signal.throwIfAborted()
      if (!expired()) throw error
      throw new Error(`Chrome did not start within ${String(config.timeoutMs)} ms: no window of class "${config.windowClass}" on ${config.display}`)
    }
  }
  const maximized = await wmctrl(['-x', '-r', config.windowClass, '-b', 'add,maximized_vert,maximized_horz'])
  if (maximized.exitCode !== 0) throw failure('wmctrl -x -r', maximized)
}
