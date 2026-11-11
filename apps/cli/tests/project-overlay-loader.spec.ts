/**
 * The project-box overlay in a real Loader composition: the composed rows are rendered to a cordis.yml and booted through
 * the Loader, so `!!js` expressions resolve against the entry context, and the real `Config` schema and `machineOf` judge
 * the `dsh-superagent` row. Only the Runtime and the services it needs are stubbed.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Group from '@deepseek-ai/cordis-plugin-group'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { loadOverlayPatches, renderConfigDump } from '@deepseek-ai/dsh-app-boot'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Config, machineOf, type DeploymentConfig } from '../../../packages/mumbo/superagent/src/deployment.ts'

const root = resolve(import.meta.dirname, '../../..')
let context: Context | undefined
let dir: string | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  dir = undefined
  vi.unstubAllEnvs()
})

const ENV = [
  'MUMBO_PANEL_ADMINS', 'MUMBO_GITHUB_APP_LOGIN', 'MUMBO_GITHUB_APP_USER_ID', 'MUMBO_WORK_DIR', 'MUMBO_WORKER_DIR', 'MUMBO_GH_CONFIG_DIR',
] as const
/** The directories `dsh-superagent` resolved: as configured, and as `machineOf` settles them. */
interface Directories { workDirectory?: string; workerDirectory?: string; ghConfigDirectory?: string }
interface Booted {
  home: string
  stateDir?: string
  panelAdmins?: unknown
  githubApp?: unknown
  configured?: Directories
  machine?: Directories
  rejection?: string
  failure?: string
}
/**
 * Boot the project overlay's rows with `env` (unset variables are empty); returns the machine settings `dsh-superagent`
 * resolved, the rejection of `machineOf`, under a run-as subprocess provider when `runAs`, or the load failure of its
 * configuration.
 */
async function boot(env: Partial<Record<(typeof ENV)[number], string | undefined>> = {}, runAs = false): Promise<Booted> {
  dir = mkdtempSync(join(tmpdir(), 'dsh-project-loader-'))
  const home = join(dir, 'home')
  vi.stubEnv('DSH_HOME', home)
  for (const name of ENV) vi.stubEnv(name, env[name] ?? '')
  vi.stubEnv('MUMBO_MEMBER_KEY', 'unused')
  const base = join(dir, 'base.yml')
  writeFileSync(base, '[]\n')
  const dump = renderConfigDump('dsh', base, [
    { label: 'mumbo-project.overlay.yml', patches: loadOverlayPatches('dsh', join(root, 'deploy/mumbo-project.overlay.yml')) },
  ], () => {})
  const config = join(dir, 'cordis.yml')
  writeFileSync(config, dump)

  const seen: Omit<Booted, 'home'> = {}
  const superagent = {
    name: 'dsh-superagent',
    Config,
    apply(_ctx: Context, resolved: DeploymentConfig) {
      seen.stateDir = resolved.stateDir
      seen.panelAdmins = (resolved as { panelAdmins?: unknown }).panelAdmins
      const { workDirectory, workerDirectory, ghConfigDirectory } = resolved
      seen.configured = { workDirectory, workerDirectory, ghConfigDirectory }
      try {
        const machine = machineOf(resolved, runAs)
        seen.githubApp = machine.githubApp
        const { workDirectory: work, workerDirectory: worker, ghConfigDirectory: gh } = machine
        seen.machine = { workDirectory: work, workerDirectory: worker, ghConfigDirectory: gh }
      } catch (error) {
        // The plugin refuses keys its Config does not list; kept so the test reports it after the other assertions.
        seen.rejection = String(error)
      }
    },
  }
  context = new Context()
  context.provide('dshHomePath', dshHomePath)
  await context.plugin(Loader)
  const loader = context.loader
  loader.builtins.group = Group
  loader.builtins.include = class FixtureInclude extends Include {
    override import(specifier: string, getOuterStack?: () => string[]): unknown {
      if (specifier.startsWith('cordis:')) return super.import(specifier, getOuterStack)
      return specifier === '@mumbo/superagent' ? superagent : { apply() {} }
    }
  }
  await loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await loader.await()
  const entry = [...loader.entries()].find(candidate => candidate.options.id === 'dsh-superagent')
  expect(entry, 'dsh-superagent row').toBeDefined()
  expect(entry!.fiber, 'dsh-superagent started').toBeDefined()
  const failure = await entry!.fiber!.await().then(() => undefined, (error: unknown) => String(error))
  return { home, ...seen, ...failure === undefined ? {} : { failure } }
}

describe('project-box overlay in the real Loader', () => {
  it.each([
    ['unset', undefined, []],
    ['a comma list', 'a@x.io,b@x.io', ['a@x.io', 'b@x.io']],
  ])('loads dsh-superagent under DSH_HOME with panelAdmins from %s', { timeout: 60_000 }, async (_name, env, expected) => {
    const result = await boot({ MUMBO_PANEL_ADMINS: env })
    expect(result.stateDir).toBe(join(result.home, 'superagent'))
    expect(result.panelAdmins).toEqual(expected)
    // Passes once A3 adds `panelAdmins` to the plugin Config; until then `machineOf` rejects the key.
    expect(result.rejection).toBeUndefined()
  })
  it.each([
    ['both variables', { MUMBO_GITHUB_APP_LOGIN: 'mumbo-bot[bot]', MUMBO_GITHUB_APP_USER_ID: '341797844' }, { login: 'mumbo-bot[bot]', userId: 341797844 }],
    ['neither variable', {}, undefined],
  ])('resolves githubApp from %s', { timeout: 60_000 }, async (_name, env, expected) => {
    const result = await boot(env)
    expect(result.githubApp).toEqual(expected)
    expect(result.rejection).toBeUndefined()
    expect(result.failure).toBeUndefined()
  })
  it('leaves the directories unset without their variables, so the plugin keeps its defaults', { timeout: 60_000 }, async () => {
    const result = await boot()
    expect(result.configured).toEqual({ workDirectory: undefined, workerDirectory: undefined, ghConfigDirectory: undefined })
    expect(result.machine).toEqual({ workDirectory: join(result.home, 'superagent', 'work'), workerDirectory: join(result.home, 'superagent'), ghConfigDirectory: undefined })
  })
  it('reads the directories from the containment variables, which a run-as composition requires', { timeout: 60_000 }, async () => {
    // Directories this process owns stand in for the box's root-owned ones, which the run-as checks require.
    const scratch = mkdtempSync(join(tmpdir(), 'dsh-project-directories-'))
    try {
      const [work, worker, gh] = ['work', 'worker', 'gh'].map(name => join(scratch, name))
      for (const directory of [work!, worker!, gh!]) mkdirSync(directory, { mode: 0o700 })
      const contained = { MUMBO_WORK_DIR: work, MUMBO_WORKER_DIR: worker, MUMBO_GH_CONFIG_DIR: gh }
      const result = await boot(contained, true)
      expect(result.configured).toEqual({ workDirectory: work, workerDirectory: worker, ghConfigDirectory: gh })
      expect(result.machine).toEqual({ workDirectory: work, workerDirectory: worker, ghConfigDirectory: gh })
      expect(result.rejection).toBeUndefined()
      // Under run-as, the plugin refuses the directories' defaults: no worker or gh directory, and a work directory in stateDir.
      expect((await boot({}, true)).rejection).toMatch(/workerDirectory must be set under a run-as subprocess provider/u)
      expect((await boot({ ...contained, MUMBO_WORK_DIR: undefined }, true)).rejection)
        .toMatch(/workDirectory .*superagent\/work \(its default, <stateDir>\/work\) is in stateDir/u)
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })
  it.each([
    ['the login alone', { MUMBO_GITHUB_APP_LOGIN: 'mumbo-bot[bot]' }],
    ['the user id alone', { MUMBO_GITHUB_APP_USER_ID: '341797844' }],
  ])('fails to load dsh-superagent with %s of the GitHub App', { timeout: 60_000 }, async (_name, env) => {
    const result = await boot(env)
    expect(result.failure).toMatch(/githubApp/)
    // Validation stops the plugin before it applies, so it never runs in user mode.
    expect(result.stateDir).toBeUndefined()
  })
})
