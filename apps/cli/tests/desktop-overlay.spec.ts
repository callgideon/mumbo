/**
 * The desktop overlay that mumbo-desktop.yml appends to the web-app bundle: no row it leaves on names a deepseek.com
 * host other than the model API, counting the origins the deepseek-account row leaves at their defaults.
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

it('leaves no enabled row on a deepseek.com host other than api.deepseek.com', () => {
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
    expect(rows.find(row => row.id === 'deepseek-account')?.disabled).toBeFalsy()
    const hosts = rows.filter(row => row.disabled !== true).flatMap((row) => {
      const config = row.name === '@deepseek-ai/dsh-deepseek-account' ? resolveAccount(row.config) : row.config
      return strings(config).flatMap(text => [...text.matchAll(DEEPSEEK_HOST)].map(match => `${row.id}: ${match[0]}`))
    })
    expect(hosts.filter(host => !host.endsWith(': api.deepseek.com'))).toEqual([])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
