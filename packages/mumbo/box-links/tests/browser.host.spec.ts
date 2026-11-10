/** The commands that bring the desktop's Chrome to the front, run through a fake subprocess service. */
import { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { expect, it } from 'vitest'
import { frontChrome } from '../src/browser.ts'
import { Config, type BrowserConfig } from '../src/config.ts'

const FLAGS = ['--user-data-dir=/home/browser/profile', '--remote-debugging-port=9222', '--start-maximized']
const BROWSER = Config({
  home: 'https://boxes.example/home', desktop: 'https://boxes.example/desktop/',
  browser: { chromeArgs: FLAGS, xauthority: '/run/x11/auth' } as BrowserConfig,
}).browser!

/** What one fake command does: exit facts and output, or a spawn failure, or no exit until aborted. */
type Outcome = { readonly exitCode?: number; readonly stdout?: string; readonly stderr?: string } | 'spawn-error' | 'hang'

/** A subprocess service whose commands answer from `answer`, recording every spawn. */
function bench(answer: (argv: readonly string[]) => Outcome, resolvable = true) {
  const spawns: SubprocessSpawnSpec[] = []
  const resolved: string[] = []
  const ctx = new Context()
  ctx.provide('subprocess', {
    resolveExecutable: async (command: string) => {
      resolved.push(command)
      if (!resolvable) throw new Error(`${command}: not found`)
      return `/usr/bin/${command}`
    },
    spawn: (spec: SubprocessSpawnSpec): Partial<SubprocessHandle> => {
      spawns.push(spec)
      const outcome = answer(spec.argv)
      const reader = (text: string) => ({ readFrom: () => ({ text, nextOffset: text.length, lossy: false }) })
      if (outcome === 'spawn-error') return { done: Promise.reject(new Error('spawn ENOENT')), collected: {} }
      if (outcome === 'hang') {
        return {
          done: new Promise((resolve) => { spec.signal!.addEventListener('abort', () => { resolve({ exitCode: null, signal: 'SIGTERM' }) }) }),
          collected: { stdout: reader(''), stderr: reader('') },
        }
      }
      return {
        done: Promise.resolve({ exitCode: outcome.exitCode ?? 0, signal: null }),
        collected: { stdout: reader(outcome.stdout ?? ''), stderr: reader(outcome.stderr ?? '') },
      }
    },
  } as never)
  return { ctx, spawns, resolved, argv: () => spawns.map(spec => spec.argv.join(' ')) }
}

const SEARCH = 'xdotool search --onlyvisible --class google-chrome|chromium'
const WAIT = 'xdotool search --sync --onlyvisible --class google-chrome|chromium'
const START = `runuser -u browser -- setsid -f sh -c exec "$0" "$@" >/dev/null 2>&1 google-chrome-stable ${FLAGS.join(' ')}`

it('activates the topmost visible Chrome window on the configured display', async () => {
  const h = bench(argv => argv[1] === 'search' ? { stdout: '4194305\n6291457\n' } : {})
  await frontChrome(h.ctx, BROWSER, new AbortController().signal)
  expect(h.argv()).toEqual([SEARCH, 'xdotool windowactivate 6291457'])
  for (const spec of h.spawns) {
    expect(spec.env).toEqual({ DISPLAY: ':1', XAUTHORITY: '/run/x11/auth' })
    expect(spec.cwd).toBe('/')
  }
  expect(h.resolved).toEqual([])
})

it('starts Chrome as the desktop user with the desktop\'s flags when no Chrome window shows, then activates its window', async () => {
  let running = false
  const h = bench((argv) => {
    if (argv[0] === 'runuser') { running = true; return {} }
    if (argv[1] === 'search') return running ? { stdout: '8388609' } : { exitCode: 1 }
    return {}
  })
  await frontChrome(h.ctx, BROWSER, new AbortController().signal)
  expect(h.argv()).toEqual([SEARCH, START, WAIT, 'xdotool windowactivate 8388609'])
  expect(h.resolved).toEqual(['google-chrome-stable'])
  // The fixed script discards Chrome's own output, so Chrome holds none of the pipes the call waits on.
  expect(h.spawns[1]!.argv.slice(4, 10)).toEqual(['setsid', '-f', 'sh', '-c', 'exec "$0" "$@" >/dev/null 2>&1', 'google-chrome-stable'])
})

it.each([
  ['an unreachable display', () => bench(() => ({ exitCode: 1, stderr: 'Error: Can\'t open display: :1' })),
    /xdotool search failed \(exit 1\): Error: Can't open display: :1/, [SEARCH]],
  ['a missing xdotool', () => bench(() => 'spawn-error'), /xdotool search could not run: spawn ENOENT/, [SEARCH]],
  ['a missing Chrome executable', () => bench(() => ({ exitCode: 1 }), false),
    /Chrome executable "google-chrome-stable" was not found/, [SEARCH]],
  ['a refused start', () => bench(argv => argv[0] === 'runuser' ? { exitCode: 1, stderr: 'runuser: user browser does not exist' } : { exitCode: 1 }),
    /starting google-chrome-stable as browser failed \(exit 1\): runuser: user browser does not exist/, [SEARCH, START]],
  ['a refused activation', () => bench(argv => argv[1] === 'search' ? { stdout: '7' } : { exitCode: 1, stderr: 'XGetWindowProperty failed' }),
    /xdotool windowactivate failed \(exit 1\): XGetWindowProperty failed/, [SEARCH, 'xdotool windowactivate 7']],
])('reports %s with the failed command', async (_case, make, message, argv) => {
  const h = make()
  await expect(frontChrome(h.ctx, BROWSER, new AbortController().signal)).rejects.toThrow(message)
  expect(h.argv()).toEqual(argv)
})

it('gives up on a started Chrome whose window never shows once the command deadline passes', async () => {
  let running = false
  const h = bench((argv) => {
    if (argv[0] === 'runuser') { running = true; return {} }
    if (argv.includes('--sync')) return 'hang'
    return running ? { stdout: '1' } : { exitCode: 1 }
  })
  await expect(frontChrome(h.ctx, { ...BROWSER, timeoutMs: 20 }, new AbortController().signal))
    .rejects.toThrow(/xdotool search timed out after 20 ms/)
  expect(h.argv()).toEqual([SEARCH, START, WAIT])
})
