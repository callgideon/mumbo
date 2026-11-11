/** The person box's permission rows, composed from the Web profile and the deploy overlays as the box boots them. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { interpolate } from '@deepseek-ai/cordis-plugin-loader'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { composeEntries, loadOverlayPatches, loadProfile } from '@deepseek-ai/dsh-app-boot'
import PermissionPresetService from '@deepseek-ai/dsh-permission-presets'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'

const repo = resolve(import.meta.dirname, '../../../..')

interface Row { id?: string; name?: string; config?: unknown }

afterEach(() => { vi.unstubAllEnvs() })

/** Every row of the person box's composition, groups flattened: the Web profile, the deploy overlays, and this package's overlay. */
function personRows(): Row[] {
  const home = mkdtempSync(join(tmpdir(), 'mumbo-run-wild-profile-'))
  try {
    const profile = loadProfile('dsh', 'web', join(repo, 'apps/cli/package.json'), home)
    const rows = composeEntries([
      ...profile.layers.map(layer => layer.patches),
      profile.patches,
      loadOverlayPatches('dsh', join(repo, 'deploy/mumbo.overlay.yml')),
      loadOverlayPatches('dsh', join(repo, 'deploy/mumbo-personal.overlay.yml')),
      loadOverlayPatches('dsh', join(repo, 'packages/mumbo/run-wild/examples/person.overlay.yml')),
    ]) as Row[]
    const flat = (list: Row[]): Row[] => list.flatMap(row => [row, ...Array.isArray(row.config) ? flat(row.config as Row[]) : []])
    return flat(rows)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

/**
 * Mount the real preset service with the composed `permission` row, its `!!js` values evaluated in the current
 * environment, over the composed sandbox mode and approval policy.
 * @returns the context, and a fresh Session's Agent once `fresh` is called.
 */
async function mountPermission(rows: readonly Row[]) {
  const config = (id: string): Record<string, unknown> => {
    const row = rows.find(entry => entry.id === id)
    expect(row, id).toBeDefined()
    return interpolate({}, row!.config) as Record<string, unknown>
  }
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  const harness = await mountAgentLoopTestHarness(ctx)
  ctx.provide('shell', {
    sandboxMode: config('sandbox-policy').mode,
    resolve() { throw new Error('the composition runs no commands') },
    run() { throw new Error('the composition runs no commands') },
    start() { throw new Error('the composition runs no commands') },
  } as never)
  ctx.provide('approval', { config: { policy: config('approval').policy } } as never)
  await ctx.plugin(PermissionPresetService, config('permission'))
  return { ctx, fresh: async () => (await harness.create(SessionId('fresh'))).session }
}

describe('the person box composition', () => {
  const rows = personRows()

  it('mounts @mumbo/run-wild', () => {
    expect(rows.filter(row => row.name === '@mumbo/run-wild').map(row => row.id)).toEqual(['run-wild'])
  })

  it('lists Run Wild last when MUMBO_RUN_WILD is set, and a fresh Session still starts in Full access', async () => {
    vi.stubEnv('MUMBO_RUN_WILD', '1')
    vi.stubEnv('MUMBO_NEW_SESSION_PRESET', undefined)
    const { ctx, fresh } = await mountPermission(rows)
    expect(ctx.permissionPresets.names).toEqual(['read-only', 'workspace-write', 'danger-full-access', 'run-wild'])
    expect(ctx.permissionPresets.resolve('run-wild')).toEqual(ctx.permissionPresets.resolve('danger-full-access'))
    expect(ctx.permissionPresets.current(await fresh())).toBe('danger-full-access')
  })

  it('starts new Sessions in Run Wild when MUMBO_NEW_SESSION_PRESET names it', async () => {
    vi.stubEnv('MUMBO_RUN_WILD', '1')
    vi.stubEnv('MUMBO_NEW_SESSION_PRESET', 'run-wild')
    const { ctx, fresh } = await mountPermission(rows)
    expect(ctx.permissionPresets.current(await fresh())).toBe('run-wild')
  })

  it('lists no Run Wild entry without MUMBO_RUN_WILD, and refuses to load when the default names it', async () => {
    vi.stubEnv('MUMBO_RUN_WILD', undefined)
    vi.stubEnv('MUMBO_NEW_SESSION_PRESET', undefined)
    const { ctx } = await mountPermission(rows)
    expect(ctx.permissionPresets.names).toEqual(['read-only', 'workspace-write', 'danger-full-access'])

    vi.stubEnv('MUMBO_NEW_SESSION_PRESET', 'run-wild')
    await expect(mountPermission(rows)).rejects.toThrow('permission: unknown preset "run-wild"')
  })
})
