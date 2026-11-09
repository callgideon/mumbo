/** The project-box overlay applied after the founder's overlays on the web profile: it loads @mumbo/superagent. */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { composeEntries, loadOverlayPatches, loadProfile } from '@deepseek-ai/dsh-app-boot'

const root = resolve(import.meta.dirname, '../../..')
const installAnchor = fileURLToPath(new URL('../package.json', import.meta.url))
const overlay = (name: string) => loadOverlayPatches('dsh', join(root, 'deploy', name))

/** Evaluate a Loader `!!js` expression node with the helpers the Loader injects. */
function evaluate(node: unknown, dshHome: string): unknown {
  const { __jsExpr } = node as { __jsExpr: string }
  const dshHomePath = (...parts: string[]) => join(dshHome, ...parts)
  return new Function('dshHomePath', 'process', `return (${__jsExpr})`)(dshHomePath, process)
}

function compose(): { rows: ReturnType<typeof composeEntries>; warnings: string[]; home: string } {
  const home = mkdtempSync(join(tmpdir(), 'dsh-project-overlay-'))
  const profile = loadProfile('dsh', 'web', installAnchor, home)
  const warnings: string[] = []
  const rows = composeEntries([
    ...profile.layers.map(layer => layer.patches),
    profile.patches,
    overlay('mumbo.overlay.yml'),
    overlay('mumbo-personal.overlay.yml'),
    overlay('mumbo-project.overlay.yml'),
  ], message => warnings.push(message))
  return { rows, warnings, home }
}

describe('project-box overlay', () => {
  it('loads the superagent rows on the web profile beside the founder overlays', () => {
    const { rows, warnings, home } = compose()
    try {
      const byId = (id: string) => rows.find(row => row.id === id)
      for (const id of ['dsh-superagent', 'dsh-superagent-github', 'dsh-superagent-worker-preset', 'dsh-superagent-router-preset']) {
        expect(byId(id), id).toBeDefined()
        expect(byId(id)?.disabled, id).toBeFalsy()
      }
      expect(byId('dsh-superagent-feishu')?.disabled).toBe(true)
      expect(byId('dsh-superagent')?.name).toBe('@mumbo/superagent')
      expect(byId('deepseek-account')?.disabled).toBe(true)
      expect(byId('mumbo-edge-member')?.name).toBe('@mumbo/edge-member')
      expect(warnings).toEqual([])

      const bundle = loadOverlayPatches('dsh', join(root, 'packages/mumbo/superagent/cordis.patch.yml'))
      const inserted = (bundle[0] as { insert: { id: string }[] }).insert
      for (const row of inserted) expect(byId(row.id)).toMatchObject({ name: (row as { name?: string }).name })
      expect(byId('dsh-superagent-worker-preset')).toEqual(inserted.find(row => row.id === 'dsh-superagent-worker-preset'))
      expect(byId('dsh-superagent-router-preset')).toEqual(inserted.find(row => row.id === 'dsh-superagent-router-preset'))
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('agrees on approval never and sets stateDir and an empty panelAdmins by default', () => {
    const { rows, home } = compose()
    try {
      const config = rows.find(row => row.id === 'dsh-superagent')?.config as { stateDir: unknown; panelAdmins: unknown }
      expect(rows.find(row => row.id === 'approval')?.config).toEqual({ policy: 'never' })
      const presets = (rows.find(row => row.id === 'permission')?.config as { presets: Record<string, { approval: string }> }).presets
      expect(Object.values(presets).map(preset => preset.approval)).toEqual(['never', 'never', 'never'])
      expect(evaluate(config.stateDir, home)).toBe(join(home, 'superagent'))
      const saved = process.env.MUMBO_PANEL_ADMINS
      try {
        delete process.env.MUMBO_PANEL_ADMINS
        expect(evaluate(config.panelAdmins, home)).toEqual([])
        process.env.MUMBO_PANEL_ADMINS = 'a@x.io,b@x.io'
        expect(evaluate(config.panelAdmins, home)).toEqual(['a@x.io', 'b@x.io'])
      } finally {
        if (saved === undefined) delete process.env.MUMBO_PANEL_ADMINS
        else process.env.MUMBO_PANEL_ADMINS = saved
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
