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
      // The overlay's own `dsh-superagent` row adds config; every other inserted row is the bundle's, whole.
      for (const row of inserted.filter(candidate => candidate.id !== 'dsh-superagent')) expect(byId(row.id), row.id).toEqual(row)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('registers the project Workspace after the member row, both naming the directory with one expression', () => {
    const { rows, home } = compose()
    try {
      const ids = rows.map(row => row.id)
      expect(ids.indexOf('mumbo-project-workspace')).toBe(ids.indexOf('mumbo-edge-member') + 1)
      const project = rows.find(row => row.id === 'mumbo-project-workspace')
      const member = rows.find(row => row.id === 'mumbo-edge-member')
      expect(project?.name).toBe('@mumbo/edge-member/project-workspace')
      const workspace = { __jsExpr: "process.env.HOME + '/projects'" }
      expect(project?.config).toEqual({ workspace })
      expect(member?.config).toMatchObject({ workspace })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('agrees on approval never in the policy and every permission preset', () => {
    const { rows, home } = compose()
    try {
      expect(rows.find(row => row.id === 'approval')?.config).toEqual({ policy: 'never' })
      const presets = (rows.find(row => row.id === 'permission')?.config as { presets: Record<string, { approval: string }> }).presets
      expect(Object.values(presets).map(preset => preset.approval)).toEqual(['never', 'never', 'never'])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
