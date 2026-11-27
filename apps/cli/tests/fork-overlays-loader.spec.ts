/**
 * Every overlay the fork ships (deploy/*.overlay.yml, packages/mumbo/<pkg>/examples/*.overlay.yml) and the box-edge
 * fixtures, read as Include reads them, YAML 1.2 under the core schema, and mounted through the real Loader, which
 * rejects an entry whose options are malformed. Plugin modules are stand-ins: only parsing, patching and entry
 * validation are exercised.
 */

import { globSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Group from '@deepseek-ai/cordis-plugin-group'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader, { validateOptions } from '@deepseek-ai/cordis-plugin-loader'
import { composeEntries, loadOverlayPatches, loadProfile, renderConfigDump } from '@deepseek-ai/dsh-app-boot'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { describe, expect, it, onTestFinished, vi } from 'vitest'

const root = resolve(import.meta.dirname, '../../..')
const installAnchor = fileURLToPath(new URL('../package.json', import.meta.url))
const EDGE = 'apps/cli/tests/fixtures/box-edge'
const OVERLAYS = globSync(['deploy/*.overlay.yml', 'packages/mumbo/*/examples/*.overlay.yml', `${EDGE}/*.yml`], { cwd: root }).sort()

/** The overlays of each composition a mumbo profile boots, in the order its start script passes them. */
const COMPOSITIONS: Readonly<Record<string, readonly string[]>> = {
  person: [
    'deploy/mumbo.overlay.yml', 'deploy/mumbo-personal.overlay.yml', `${EDGE}/personal.overlay.yml`, 'packages/mumbo/mcp/examples/person.overlay.yml',
    'packages/mumbo/run-wild/examples/person.overlay.yml', 'packages/mumbo/state/examples/person.overlay.yml', `${EDGE}/containment-person.overlay.yml`,
  ],
  project: [
    'deploy/mumbo.overlay.yml', 'deploy/mumbo-personal.overlay.yml', `${EDGE}/project.overlay.yml`, 'deploy/mumbo-project.overlay.yml',
    `${EDGE}/containment-project.overlay.yml`,
  ],
  desktop: ['deploy/mumbo-desktop.overlay.yml'],
  assistant: ['packages/mumbo/assistant/examples/person.overlay.yml'],
  'person links': ['packages/mumbo/box-links/examples/person.overlay.yml'],
  'project links': ['packages/mumbo/box-links/examples/project.overlay.yml'],
}

type Row = ReturnType<typeof composeEntries>[number]

/** The rows of the web profile with `overlays` applied, and the warnings of patches that matched no row. */
function compose(overlays: readonly string[], home: string): { rows: Row[]; warnings: string[] } {
  const profile = loadProfile('dsh', 'web', installAnchor, home)
  const warnings: string[] = []
  const rows = composeEntries([
    ...profile.layers.map(layer => layer.patches), profile.patches, ...overlays.map(file => loadOverlayPatches('dsh', join(root, file))),
  ], message => warnings.push(message))
  return { rows, warnings }
}

/** Mount `rows` through the Loader with a stand-in for every plugin module; returns the ids it created entries for. */
async function mounted(rows: readonly Row[], home: string): Promise<Set<string>> {
  // The rows' expressions read the box's variables; values the stand-in modules never use.
  for (const name of ['DSH_HOME', 'HOME']) vi.stubEnv(name, home)
  vi.stubEnv('MUMBO_MEMBER_KEY', 'unused')
  writeFileSync(join(home, 'base.yml'), '[]\n')
  const config = join(home, 'cordis.yml')
  writeFileSync(config, renderConfigDump('dsh', join(home, 'base.yml'), [{ label: 'composition', patches: [{ insert: [...rows] }] }], () => {}))
  const context = new Context()
  onTestFinished(() => context.fiber.dispose())
  context.provide('dshHomePath', dshHomePath)
  await context.plugin(Loader)
  const loader = context.loader
  loader.builtins.group = Group
  loader.builtins.include = class FixtureInclude extends Include {
    override import(specifier: string, getOuterStack?: () => string[]): unknown {
      return specifier.startsWith('cordis:') ? super.import(specifier, getOuterStack) : { apply() {} }
    }
  }
  await loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await loader.await()
  return new Set([...loader.entries()].map(entry => entry.options.id))
}

/** Every entry of a patch list or row list at any depth: inserted rows, group children, and an agent preset's plugins. */
function entries(value: readonly Row[]): Row[] {
  return value.flatMap((row) => {
    const children = Array.isArray(row.config) ? row.config as Row[]
      : row.name === '@deepseek-ai/dsh-agent-preset' ? (row.config as { plugins?: Row[] } | undefined)?.plugins ?? [] : []
    return [row, ...entries(children)]
  })
}

/** A temporary DSH home, removed when the test ends. */
function temporaryHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-fork-overlays-'))
  onTestFinished(() => {
    vi.unstubAllEnvs()
    rmSync(home, { recursive: true, force: true })
  })
  return home
}

describe('the fork overlays', () => {
  it('covers every overlay and fixture in a composition', () => {
    expect(OVERLAYS.length).toBeGreaterThanOrEqual(14)
    expect(OVERLAYS.filter(file => !Object.values(COMPOSITIONS).flat().includes(file))).toEqual([])
  })

  it.each(OVERLAYS)('%s parses as YAML 1.2 and inserts only entries the Loader accepts', (file) => {
    const patches = loadOverlayPatches('dsh', join(root, file)) as { insert?: Row[] }[]
    const inserted = entries(patches.flatMap(patch => patch.insert ?? []))
    expect(inserted.flatMap(row => validateOptions(row, ':').map(issue => `${row.id ?? '(no id)'}: ${issue.message}`)), relative(root, file)).toEqual([])
  })

  it.each(Object.keys(COMPOSITIONS))('mounts every row of the %s composition through the Loader', { timeout: 60_000 }, async (name) => {
    const home = temporaryHome()
    const { rows, warnings } = compose(COMPOSITIONS[name]!, home)
    expect(warnings).toEqual([])
    expect(entries(rows).flatMap(row => validateOptions(row, ':').map(issue => `${row.id ?? '(no id)'}: ${issue.message}`))).toEqual([])
    const created = await mounted(rows, home)
    expect(rows.map(row => row.id!).filter(id => !created.has(id))).toEqual([])
  })

  it('finds a row whose options the Loader rejects', { timeout: 60_000 }, async () => {
    const home = temporaryHome()
    const { rows } = compose(COMPOSITIONS.desktop!, home)
    // A group without a `config` list, which Include 1.2 rejects.
    const created = await mounted([...rows, { id: 'malformed', name: 'cordis:group', group: true }], home)
    expect(created.has('malformed')).toBe(false)
    expect(created.has(rows[0]!.id)).toBe(true)
  })
})
