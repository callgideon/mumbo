/**
 * The desktop overlay that mumbo-desktop.yml appends to the web-app bundle: no row it leaves on names a deepseek.com
 * host other than the model API, counting the origins the deepseek-account row leaves at their defaults, and the
 * desktop, which runs dsh as the person, keeps the Office tools that a root dsh turns off.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { composeEntries, loadOverlayPatches, loadProfile } from '@deepseek-ai/dsh-app-boot'
import DeepSeekAccount from '@deepseek-ai/dsh-deepseek-account'

const root = resolve(import.meta.dirname, '../../..')
const installAnchor = fileURLToPath(new URL('../package.json', import.meta.url))
const DEEPSEEK_HOST = /[a-z0-9.-]*deepseek\.com\b/gi

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
/** Every string in a config value, `!!js` sources included. */
const strings = (value: unknown): string[] =>
  typeof value === 'string' ? [value] : isRecord(value) ? Object.values(value).flatMap(strings) : []
/** The row's literal fields through the plugin's Config, so its defaults count; `!!js` fields keep their defaults. */
const resolveAccount = (config: unknown) => DeepSeekAccount.Config(Object.fromEntries(Object.entries(isRecord(config) ? config : {})
  .filter(([, value]) => !(isRecord(value) && '__jsExpr' in value))))

/** The desktop composition's rows: the web profile with the desktop overlay last. */
function compose(): ReturnType<typeof composeEntries> {
  const home = mkdtempSync(join(tmpdir(), 'dsh-desktop-overlay-'))
  try {
    const profile = loadProfile('dsh', 'web', installAnchor, home)
    const warnings: string[] = []
    const rows = composeEntries([
      ...profile.layers.map(layer => layer.patches),
      profile.patches,
      loadOverlayPatches('dsh', join(root, 'deploy/mumbo-desktop.overlay.yml')),
    ], message => warnings.push(message))
    expect(warnings).toEqual([])
    return rows
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

/**
 * Evaluate a `disabled` value as the Loader does, against a profile context and a stand-in `process` whose `getuid`
 * returns `uid`.
 */
function disabledFor(value: unknown, uid: number): boolean {
  if (!(isRecord(value) && '__jsExpr' in value)) return Boolean(value)
  // The expressions are the repository's own composition files.
  // oxlint-disable-next-line typescript/no-implied-eval
  const evaluate = new Function('ctx', 'process', `return (${String(value.__jsExpr)})`) as (ctx: unknown, process: unknown) => unknown
  return Boolean(evaluate({ get: (name: string) => (name === 'profileContext' ? {} : undefined) }, { platform: 'linux', env: {}, getuid: () => uid }))
}

it('leaves no enabled row on a deepseek.com host other than api.deepseek.com', () => {
  const rows = compose()
  expect(rows.find(row => row.id === 'deepseek-account')?.disabled).toBeFalsy()
  const hosts = rows.filter(row => row.disabled !== true).flatMap((row) => {
    const config: unknown = row.name === '@deepseek-ai/dsh-deepseek-account' ? resolveAccount(row.config) : row.config
    return strings(config).flatMap(text => [...text.matchAll(DEEPSEEK_HOST)].map(match => `${row.id}: ${match[0]}`))
  })
  expect(hosts.filter(host => !host.endsWith(': api.deepseek.com'))).toEqual([])
})

it('keeps the Office tools in both presets for a non-root dsh and turns them off under root', () => {
  const rows = compose()
  for (const id of ['preset-standard', 'preset-ptc']) {
    const plugins = (rows.find(row => row.id === id)?.config as { plugins: { id?: string; name?: string; disabled?: unknown }[] }).plugins
    const office = plugins.find(row => row.name === '@deepseek-ai/dsh-tool-office')
    expect(office, id).toBeDefined()
    expect(disabledFor(office?.disabled, 1000), id).toBe(false)
    expect(disabledFor(office?.disabled, 0), id).toBe(true)
  }
})
