/** Bring the desktop's Chrome to the front for the Browser tab, starting Chrome when no Chrome window shows. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subprocess'
import type { BrowserConfig } from './config.ts'

/** Bytes kept from each command's output; xdotool prints window ids and short diagnostics. */
const OUTPUT_BYTES = 64 * 1024

/** Shell script that runs Chrome, given as `$0`, with its flags and its output discarded. */
const CHROME_START = 'exec "$0" "$@" >/dev/null 2>&1'

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
 * Activate the topmost visible Chrome window on the configured display. When none shows, start Chrome as the
 * desktop user with the desktop's own flags, detached from this process, wait for its first window, and activate it.
 * xdotool runs as this process's user with `DISPLAY` and `XAUTHORITY` from the configuration.
 * @param ctx - context carrying the subprocess service.
 * @param config - display, user, executables, flags, and bounds.
 * @param signal - aborts the running command.
 * @returns after the window manager was asked to activate a Chrome window.
 * @throws Error naming the failed command and its diagnostic.
 */
export async function frontChrome(ctx: Context, config: BrowserConfig, signal: AbortSignal): Promise<void> {
  const env = { DISPLAY: config.display, XAUTHORITY: config.xauthority }

  async function run(argv: readonly string[]): Promise<Ran> {
    const deadline = AbortSignal.timeout(config.timeoutMs)
    const handle = ctx.subprocess.spawn({
      argv, cwd: '/', env, graceMs: config.graceMs, signal: AbortSignal.any([signal, deadline]),
      stdio: { stdin: 'ignore', stdout: { maxBytes: OUTPUT_BYTES }, stderr: { maxBytes: OUTPUT_BYTES } },
    })
    const label = argv.slice(0, 2).join(' ')
    const outcome = await handle.done.catch((error: unknown) => {
      throw new Error(`${label} could not run: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    })
    signal.throwIfAborted()
    if (deadline.aborted) throw new Error(`${label} timed out after ${String(config.timeoutMs)} ms`)
    const read = (reader: typeof handle.collected.stdout): string => reader?.readFrom(0).text.trim() ?? ''
    return {
      exitCode: outcome.signal === null ? outcome.exitCode : null,
      stdout: read(handle.collected.stdout),
      stderr: read(handle.collected.stderr),
    }
  }

  /** Visible Chrome windows, bottom to top; with `sync`, xdotool waits until one shows. */
  async function windows(sync: boolean): Promise<string[]> {
    const ran = await run([config.xdotool, 'search', ...sync ? ['--sync'] : [], '--onlyvisible', '--class', config.windowClass])
    // xdotool search exits 1 without a diagnostic when nothing matches.
    if (ran.exitCode === 1 && ran.stdout === '' && ran.stderr === '') return []
    if (ran.exitCode !== 0) throw failure('xdotool search', ran)
    return ran.stdout.split('\n').filter(line => /^\d+$/.test(line))
  }

  let found = await windows(false)
  if (found.length === 0) {
    // setsid -f returns once Chrome is forked, so the call does not wait for Chrome to exit and an exec failure shows
    // only as no window appearing; resolving the executable first names a missing program instead. Chrome's own output
    // goes to /dev/null rather than to pipes this call would wait on; the script is fixed and takes Chrome as arguments.
    await ctx.subprocess.resolveExecutable(config.chrome, undefined, signal).catch((error: unknown) => {
      throw new Error(`Chrome executable "${config.chrome}" was not found`, { cause: error })
    })
    const start = await run(['runuser', '-u', config.user, '--', 'setsid', '-f', 'sh', '-c', CHROME_START, config.chrome, ...config.chromeArgs])
    if (start.exitCode !== 0) throw failure(`starting ${config.chrome} as ${config.user}`, start)
    found = await windows(true)
  }
  // Search lists the window tree in stacking order, so the last window is the topmost.
  const top = found.at(-1)
  if (top === undefined) throw new Error(`no ${config.chrome} window appeared on ${config.display}`)
  const activated = await run([config.xdotool, 'windowactivate', top])
  if (activated.exitCode !== 0) throw failure('xdotool windowactivate', activated)
}
