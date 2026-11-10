/** The wmctrl commands that bring the desktop's Chrome window to the front, run against a fake desktop. */
import { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { expect, it } from 'vitest'
import { frontChrome } from '../src/browser.ts'
import { Config, type BrowserConfig } from '../src/config.ts'

const BROWSER = Config({
  home: 'https://boxes.example/home', desktop: 'https://boxes.example/desktop/', browser: { xauthority: '/run/x11/auth' } as BrowserConfig,
}).browser!

/** WM_CLASS values as `wmctrl -lx` prints them on the box desktop. */
const CHROME = 'google-chrome (/home/browser/profile).Google-chrome'
const CHROMIUM = 'chromium (/home/browser/profile).Chromium'
const TERMINAL = 'xfce4-terminal.Xfce4-terminal'
const FILES = 'thunar.Thunar'

interface FakeWindow {
  readonly wmClass: string
  minimized: boolean
  maximized: boolean
  active: boolean
}

/** A fake answer that is not a window manager's: a spawn failure, a command that runs until killed, or one fixed outcome. */
type Override = 'spawn-error' | 'hang' | { readonly exitCode: number; readonly stderr: string; readonly afterMs?: number }

/**
 * A desktop whose wmctrl matches `-x` targets as the real one does: the first listed window whose WM_CLASS contains
 * the target, ignoring case. `appearAfter` windows show only after that many `-a` attempts found nothing.
 */
function desktop(classes: readonly string[], options: {
  appearAfter?: number
  minimized?: boolean
  override?: (argv: readonly string[]) => Override | undefined
} = {}) {
  const windows: FakeWindow[] = []
  const spawns: SubprocessSpawnSpec[] = []
  let misses = 0
  const show = () => {
    if (windows.length === 0 && misses >= (options.appearAfter ?? 0)) {
      for (const wmClass of classes) windows.push({ wmClass, minimized: options.minimized ?? false, maximized: false, active: false })
    }
  }
  const ctx = new Context()
  ctx.provide('subprocess', {
    spawn: (spec: SubprocessSpawnSpec): Partial<SubprocessHandle> => {
      spawns.push(spec)
      const reader = (text: string) => ({ readFrom: () => ({ text, nextOffset: text.length, lossy: false }) })
      const answer = (exitCode: number, stderr = '') => ({
        done: Promise.resolve({ exitCode, signal: null }), collected: { stdout: reader(''), stderr: reader(stderr) },
      })
      const override = options.override?.(spec.argv)
      if (override === 'spawn-error') return { done: Promise.reject(new Error('spawn wmctrl ENOENT')), collected: {} }
      if (override === 'hang') {
        // A wmctrl blocked on a stopped X server exits only when its signal kills it.
        const done = new Promise<SubprocessOutcome>((resolve) => {
          spec.signal!.addEventListener('abort', () => { resolve({ exitCode: null, signal: 'SIGTERM' }) })
        })
        return { done, collected: { stdout: reader(''), stderr: reader('') } }
      }
      if (override?.afterMs !== undefined) {
        // A command that ignores its signal and exits normally once `afterMs` has passed.
        const done = new Promise<SubprocessOutcome>((resolve) => {
          setTimeout(() => { resolve({ exitCode: override.exitCode, signal: null }) }, override.afterMs)
        })
        return { done, collected: { stdout: reader(''), stderr: reader(override.stderr) } }
      }
      if (override !== undefined) return answer(override.exitCode, override.stderr)
      show()
      const [, , action, target] = spec.argv
      const found = windows.find(window => window.wmClass.toLowerCase().includes(target!.toLowerCase()))
      if (found === undefined) {
        if (action === '-a') misses += 1
        return answer(1)
      }
      if (action === '-a') {
        for (const window of windows) window.active = window === found
        found.minimized = false
      } else {
        found.maximized = spec.argv.at(-1) === 'add,maximized_vert,maximized_horz'
      }
      return answer(0)
    },
  } as never)
  return { ctx, spawns, windows, argv: () => spawns.map(spec => spec.argv.join(' ')) }
}

const ACTIVATE = 'wmctrl -x -a chrom'
const MAXIMIZE = 'wmctrl -x -r chrom -b add,maximized_vert,maximized_horz'

it('activates and maximizes the Chrome window on the configured display', async () => {
  const h = desktop([TERMINAL, CHROME])
  await frontChrome(h.ctx, BROWSER, new AbortController().signal)
  expect(h.argv()).toEqual([ACTIVATE, MAXIMIZE])
  expect(h.windows.map(({ wmClass, active, maximized }) => [wmClass, active, maximized]))
    .toEqual([[TERMINAL, false, false], [CHROME, true, true]])
  for (const spec of h.spawns) {
    expect(spec.env).toEqual({ DISPLAY: ':1', XAUTHORITY: '/run/x11/auth' })
    expect(spec.cwd).toBe('/')
  }
})

it('restores a minimized Chrome window instead of starting another', async () => {
  const h = desktop([CHROME], { minimized: true })
  await frontChrome(h.ctx, BROWSER, new AbortController().signal)
  expect(h.argv()).toEqual([ACTIVATE, MAXIMIZE])
  expect(h.windows).toEqual([{ wmClass: CHROME, minimized: false, maximized: true, active: true }])
})

it('waits while the desktop\'s restart loop brings a closed Chrome back', async () => {
  const h = desktop([CHROME], { appearAfter: 2 })
  await frontChrome(h.ctx, BROWSER, new AbortController().signal)
  expect(h.argv()).toEqual([ACTIVATE, ACTIVATE, ACTIVATE, MAXIMIZE])
  expect(h.windows[0]).toMatchObject({ active: true, maximized: true })
})

it.each([
  ['Google Chrome', [TERMINAL, CHROME], CHROME],
  ['Debian Chromium', [FILES, CHROMIUM], CHROMIUM],
])('matches %s with the default window class, and nothing else on the desktop', async (_case, classes, chrome) => {
  const h = desktop(classes)
  await frontChrome(h.ctx, BROWSER, new AbortController().signal)
  expect(h.windows.filter(window => window.active).map(window => window.wmClass)).toEqual([chrome])
})

it('says that Chrome did not start when no window matches before the deadline', async () => {
  const h = desktop([TERMINAL, FILES])
  await expect(frontChrome(h.ctx, { ...BROWSER, timeoutMs: 600 }, new AbortController().signal))
    .rejects.toThrow('Chrome did not start within 600 ms: no window of class "chrom" on :1')
  expect(new Set(h.argv())).toEqual(new Set([ACTIVATE]))
  expect(h.argv().length).toBeGreaterThan(1)
})

it.each([
  ['an unreachable display', (argv: readonly string[]) => argv[2] === '-a' ? { exitCode: 1, stderr: 'Cannot open display.' } : undefined,
    'wmctrl -x -a failed (exit 1): Cannot open display.', [ACTIVATE]],
  ['a missing window manager', (argv: readonly string[]) => argv[2] === '-a'
    ? { exitCode: 1, stderr: 'Cannot get client list properties. (_NET_CLIENT_LIST or _WIN_CLIENT_LIST)' } : undefined,
  'wmctrl -x -a failed (exit 1): Cannot get client list properties. (_NET_CLIENT_LIST or _WIN_CLIENT_LIST)', [ACTIVATE]],
  ['a missing wmctrl', () => 'spawn-error' as const, 'wmctrl could not run: spawn wmctrl ENOENT', [ACTIVATE]],
  ['a refused maximize', (argv: readonly string[]) => argv[2] === '-r' ? { exitCode: 1, stderr: '' } : undefined,
    'wmctrl -x -r failed (exit 1)', [ACTIVATE, MAXIMIZE]],
])('reports %s at once with the failed command', async (_case, override, message, argv) => {
  const h = desktop([CHROME], { override })
  await expect(frontChrome(h.ctx, BROWSER, new AbortController().signal)).rejects.toThrow(message)
  expect(h.argv()).toEqual(argv)
})

it.each([
  ['an activation', (argv: readonly string[]) => argv[2] === '-a' ? 'hang' as const : undefined,
    `${ACTIVATE} did not finish within 300 ms on :1`, [ACTIVATE]],
  ['a maximize after the window was activated', (argv: readonly string[]) => argv[2] === '-r' ? 'hang' as const : undefined,
    `${MAXIMIZE} did not finish within 300 ms on :1`, [ACTIVATE, MAXIMIZE]],
])('names %s that the deadline stopped, rather than a missing Chrome', async (_case, override, message, argv) => {
  const h = desktop([CHROME], { override })
  await expect(frontChrome(h.ctx, { ...BROWSER, timeoutMs: 300 }, new AbortController().signal)).rejects.toThrow(message)
  expect(h.argv()).toEqual(argv)
  expect(h.spawns.at(-1)!.signal!.aborted).toBe(true)
})

it('names the maximize when the deadline passed before it could start', async () => {
  const h = desktop([CHROME], { override: argv => argv[2] === '-a' ? { exitCode: 0, stderr: '', afterMs: 400 } : undefined })
  await expect(frontChrome(h.ctx, { ...BROWSER, timeoutMs: 300 }, new AbortController().signal))
    .rejects.toThrow(`${MAXIMIZE} did not finish within 300 ms on :1`)
  expect(h.argv()).toEqual([ACTIVATE])
})

it.each([
  ['a running command', (argv: readonly string[]) => argv[2] === '-a' ? 'hang' as const : undefined],
  ['the wait between attempts', undefined],
])('stops at %s once the caller aborts, and runs nothing more', async (_case, override) => {
  const h = desktop([TERMINAL], override === undefined ? {} : { override })
  const caller = new AbortController()
  const call = frontChrome(h.ctx, BROWSER, caller.signal)
  await expect.poll(() => h.spawns.length).toBe(1)
  await new Promise((resolve) => { setTimeout(resolve, 20) })
  caller.abort()
  await expect(call).rejects.toThrow('This operation was aborted')
  expect(h.spawns[0]!.signal!.aborted).toBe(true)
  expect(h.argv()).toEqual([ACTIVATE])
})
