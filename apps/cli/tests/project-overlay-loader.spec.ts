/**
 * The project-box overlay in a real Loader composition: the composed rows are rendered to a cordis.yml and booted through
 * the Loader, so `!!js` expressions resolve against the entry context, and the real `Config` schema and `machineOf` judge
 * the `dsh-superagent` row. Only the Runtime and the services it needs are stubbed.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

const ENV = ['MUMBO_PANEL_ADMINS', 'MUMBO_GITHUB_APP_LOGIN', 'MUMBO_GITHUB_APP_USER_ID', 'MUMBO_EDGE_MCP_URL', 'MUMBO_EDGE_TOKEN_FILE', 'MUMBO_PROJECT_ID'] as const
interface Booted { home: string; stateDir?: string; panelAdmins?: unknown; githubApp?: unknown; edge?: unknown; rejection?: string; failure?: string }
/** Boot the project overlay's rows with `env` (unset variables are empty); returns the machine settings `dsh-superagent` resolved, the rejection of `machineOf`, or the load failure of its configuration. */
async function boot(env: Partial<Record<(typeof ENV)[number], string | undefined>> = {}): Promise<Booted> {
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
      try {
        const machine = machineOf(resolved)
        seen.githubApp = machine.githubApp
        seen.edge = machine.edge
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
  it.each([
    ['the login alone', { MUMBO_GITHUB_APP_LOGIN: 'mumbo-bot[bot]' }],
    ['the user id alone', { MUMBO_GITHUB_APP_USER_ID: '341797844' }],
  ])('fails to load dsh-superagent with %s of the GitHub App', { timeout: 60_000 }, async (_name, env) => {
    const result = await boot(env)
    expect(result.failure).toMatch(/githubApp/)
    // Validation stops the plugin before it applies, so it never runs in user mode.
    expect(result.stateDir).toBeUndefined()
  })
  const EDGE = { MUMBO_EDGE_MCP_URL: 'https://llm.app.mumbo.si/mcp', MUMBO_EDGE_TOKEN_FILE: '/root/.mumbo/edge.token', MUMBO_PROJECT_ID: '0123456789abcdef' }
  it.each([
    ['all three variables', EDGE, { url: EDGE.MUMBO_EDGE_MCP_URL, tokenFile: EDGE.MUMBO_EDGE_TOKEN_FILE, project: EDGE.MUMBO_PROJECT_ID }],
    ['no variable', {}, undefined],
  ])('resolves the edge from %s', { timeout: 60_000 }, async (_name, env, expected) => {
    const result = await boot(env)
    expect(result.edge).toEqual(expected)
    expect(result.rejection).toBeUndefined()
    expect(result.failure).toBeUndefined()
  })
  it('fails to load dsh-superagent with only some of the edge variables', { timeout: 60_000 }, async () => {
    const result = await boot({ MUMBO_EDGE_MCP_URL: EDGE.MUMBO_EDGE_MCP_URL, MUMBO_PROJECT_ID: EDGE.MUMBO_PROJECT_ID })
    expect(result.failure).toMatch(/edge/)
    expect(result.stateDir).toBeUndefined()
  })
})
