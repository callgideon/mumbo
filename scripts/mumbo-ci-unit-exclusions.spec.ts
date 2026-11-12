/**
 * mumbo-ci's unit job leaves out the tests that scripts/mumbo-ci-unit-exclusions.ts lists. These cases fail when a
 * mumbo profile starts loading an excluded package, or a mumbo pipeline starts running a script an excluded spec tests.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, globSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, normalize } from 'node:path'
import yaml from 'js-yaml'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ON_DEMAND_BUNDLES, OPTIONAL_BUNDLES } from '../packages/util/official-bundles/src/bundles.ts'
import { MUMBO_CI_UNIT_EXCLUSIONS, type UnitExclusion } from './mumbo-ci-unit-exclusions.ts'
import { gatesForMode, type Mode } from './run-gates.ts'

const root = join(import.meta.dirname, '..')

/** The `--patch` overlays of each mumbo profile over `--profile web`, as the box start scripts and mumbo-desktop.yml apply them. */
const PROFILES: Record<string, string[]> = {
  person: [
    'deploy/mumbo.overlay.yml', 'deploy/mumbo-personal.overlay.yml', 'packages/mumbo/mcp/examples/person.overlay.yml',
    'packages/mumbo/run-wild/examples/person.overlay.yml', 'packages/mumbo/state/examples/person.overlay.yml',
  ],
  project: ['deploy/mumbo.overlay.yml', 'deploy/mumbo-personal.overlay.yml', 'deploy/mumbo-project.overlay.yml'],
  desktop: ['deploy/mumbo-desktop.overlay.yml'],
}

/** Plugins the box start scripts mount through overlays they write at start (startScript in edge.mjs on boxes/production). */
const BOX_START_SCRIPT_PLUGINS = [
  '@deepseek-ai/dsh-mcp-client', '@deepseek-ai/dsh-browser-use', '@mumbo/browser-consent', '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp',
  '@mumbo/box-links', '@mumbo/assistant', '@deepseek-ai/dsh-computer-use', '@deepseek-ai/dsh-computer-use-x11', '@deepseek-ai/dsh-hooks-claude-code',
]

/** Host and client applications the profiles run: the dsh installation, the Web client, and the desktop app and host. */
const APPLICATIONS = ['@deepseek-ai/dsh', '@deepseek-ai/dsh-web-frontend', '@deepseek-ai/dsh-desktop', '@deepseek-ai/dsh-desktop-host']

interface Manifest { name: string; scripts?: Record<string, string>; [section: string]: Record<string, string> | string | undefined }
interface Workspace { dir: string; manifest: Manifest }

const IMPORT = /(?:from\s+|import\s+|import\(\s*|require\(\s*)['"]([^'".][^'"]*)['"]/g
const TYPE_ONLY_IMPORT = /\b(?:import|export)\s+type\s+(?:\*(?:\s+as\s+\w+)?|\{[^}]*\}|\w+)\s+from\s+['"][^'"]+['"]/g
const RELATIVE_IMPORT = /(?:from\s+|import\(\s*|require\(\s*|new URL\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g
// A named spec is a suite-list entry, not a step; the specs a gate runs are never excluded.
const SCRIPT_DIR = String.raw`(?:scripts|website|apps/[\w-]+/scripts|native/system/scripts)`
const SCRIPT_PATH = new RegExp(String.raw`(?:^|[\s'"=])(?:\./)?(${SCRIPT_DIR}/[\w./-]+(?<!\.spec)\.(?:[mc]?[jt]s|sh))`, 'g')
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const packageOf = (specifier: string): string => specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/')
const read = (path: string): string => readFileSync(join(root, path), 'utf8')

const workspaces = new Map<string, Workspace>()
for (const path of globSync(['packages/*/*/package.json', 'apps/*/package.json', 'vendor/*/package.json'], { cwd: root })) {
  const manifest = JSON.parse(read(path)) as Manifest
  workspaces.set(manifest.name, { dir: dirname(path), manifest })
}
const nameOfDir = new Map([...workspaces].map(([name, { dir }]) => [dir, name]))

/** Runtime dependency sections plus workspace packages src/ imports at runtime, since client halves bundle devDependencies. */
function edges(name: string): string[] {
  const { dir, manifest } = workspaces.get(name)!
  const imported = globSync('src/**/*.{ts,tsx,mts,js,mjs}', { cwd: join(root, dir) })
    .flatMap(file => [...readFileSync(join(root, dir, file), 'utf8').replace(TYPE_ONLY_IMPORT, '').matchAll(IMPORT)].map(match => packageOf(match[1]!)))
  // The installation manifest lists every profile's bundles; only its own imports run under `--profile web`.
  const sections = name === '@deepseek-ai/dsh' ? [] : ['dependencies', 'optionalDependencies', 'peerDependencies']
  const declared = sections.flatMap((section) => {
    const dependencies = manifest[section]
    return isRecord(dependencies) ? Object.keys(dependencies) : []
  })
  return [...new Set([...declared, ...imported])].filter(dependency => workspaces.has(dependency))
}

/**
 * The packages a composed profile's rows name, off Windows: `on` rows are mounted (any `!!js` condition but the
 * Windows-only one counts as on), `off` rows are `disabled: true` or inside such a group, which the plugin manager can
 * switch on. Windows-only rows are in neither.
 */
function mountedPackages(dump: string): { on: string[]; off: string[] } {
  const js = new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: (source: string) => ({ js: source }) })
  const rows = { on: [...dump.matchAll(/^# == (@[^\s,]+)/gm)].map(match => match[1]!), off: [] as string[] }
  const walk = (value: unknown, off: boolean): void => {
    if (Array.isArray(value)) {
      for (const child of value) walk(child, off)
      return
    }
    if (!isRecord(value)) return
    const disabled = value.disabled
    if (isRecord(disabled) && disabled.js === "process.platform !== 'win32'") return
    const rowOff = off || disabled === true
    if (typeof value.name === 'string') rows[rowOff ? 'off' : 'on'].push(packageOf(value.name))
    for (const child of Object.values(value)) walk(child, rowOff)
  }
  walk(yaml.load(dump, { schema: yaml.DEFAULT_SCHEMA.extend([js]) }), false)
  return rows
}

const home = mkdtempSync(join(tmpdir(), 'mumbo-ci-exclusions-'))
/** Loaded package -> 'root' or the package that pulled it in. */
const loaded = new Map<string, string>()
const roots = new Set<string>()
/** Packages that `disabled: true` rows name; the plugin manager can switch those rows on. */
const switchable = new Set<string>()

beforeAll(() => {
  for (const [profile, patches] of Object.entries(PROFILES)) {
    const args = ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', 'web', '--dump-config', ...patches.flatMap(patch => ['--patch', patch])]
    const env = { ...process.env, DSH_HOME: join(home, profile), DSH_TELEMETRY_DISABLED: '1' }
    // dsh reports a patch it cannot apply on stderr, exits 0 and dumps the profile without it.
    const dump = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', env })
    if (dump.status !== 0 || dump.stderr !== '') throw new Error(`dsh --dump-config for the ${profile} profile failed: ${dump.stderr}`)
    const { on, off } = mountedPackages(dump.stdout)
    for (const name of on) roots.add(name)
    for (const name of off) switchable.add(name)
  }
  // The plugin manager offers the optional bundles to switch on and installs the on-demand ones.
  for (const name of [...BOX_START_SCRIPT_PLUGINS, ...APPLICATIONS, ...OPTIONAL_BUNDLES, ...ON_DEMAND_BUNDLES]) roots.add(name)
  const visit = (name: string, via: string): void => {
    if (!workspaces.has(name) || loaded.has(name)) return
    loaded.set(name, via)
    for (const dependency of edges(name)) visit(dependency, name)
  }
  for (const name of roots) visit(name, 'root')
  // These load their packages but are not enabled rows: web-app turns tool-pwsh off this way on every platform.
  for (const name of switchable) visit(name, 'root')
}, 120_000)

afterAll(() => { rmSync(home, { recursive: true, force: true }) })

const chain = (name: string): string => {
  const links = [name]
  for (let via = loaded.get(name); via !== undefined && via !== 'root'; via = loaded.get(via)) links.push(via)
  return links.join(' <- ')
}
const packagesOf = (exclusion: UnitExclusion): string[] => globSync(exclusion.path, { cwd: root }).flatMap(dir => nameOfDir.get(dir) ?? [])
const resolveRelative = (file: string, specifier: string): string => {
  const target = join(dirname(file), specifier)
  return existsSync(join(root, target)) ? target : `${target}.ts`
}
/** The files a spec imports relatively or names by script path; an excluded spec may name none a mumbo pipeline runs. */
const subjectsOf = (spec: string): string[] => {
  const text = read(spec)
  return [...new Set([...text.matchAll(RELATIVE_IMPORT)].map(match => resolveRelative(spec, match[1]!))
    .concat([...text.matchAll(SCRIPT_PATH)].map(match => normalize(match[1]!))))]
}
const packageExclusions = (category: UnitExclusion['category']): UnitExclusion[] =>
  MUMBO_CI_UNIT_EXCLUSIONS.filter(exclusion => exclusion.category === category && !exclusion.path.endsWith('.ts'))

describe('mumbo-ci unit exclusions', () => {
  it('names only paths that select tests outside packages/mumbo and deploy', () => {
    for (const { path } of MUMBO_CI_UNIT_EXCLUSIONS) {
      const tests = globSync(path.endsWith('.ts') ? path : `${path}/tests/**/*.spec.{ts,tsx}`, { cwd: root })
      expect(tests, path).not.toHaveLength(0)
      expect(tests.filter(test => /^(packages\/mumbo|deploy)\//.test(test)), path).toEqual([])
    }
  })

  it('excludes no package a mumbo profile loads', () => {
    expect(loaded.has('@mumbo/superagent')).toBe(true)
    const violations = packageExclusions('not-mounted').flatMap(packagesOf).filter(name => loaded.has(name)).map(chain)
    expect(violations).toEqual([])
  })

  it('leaves Windows-only packages to Windows rows and their listed dependents', () => {
    const windowsOnly = new Map(packageExclusions('windows-only').flatMap(exclusion => packagesOf(exclusion).map(name => [name, exclusion] as const)))
    expect([...windowsOnly.keys()].filter(name => roots.has(name)), 'mounted by a row enabled off Windows').toEqual([])
    const dependents = (name: string): string[] =>
      [...loaded.keys()].filter(other => !windowsOnly.has(other) && edges(other).includes(name)).sort()
    const actual = Object.fromEntries([...windowsOnly.keys()].map(name => [name, dependents(name)]))
    const listed = Object.fromEntries([...windowsOnly].map(([name, exclusion]) => [name, [...exclusion.loadedDependents ?? []].sort()]))
    expect(actual).toEqual(listed)
  })

  it('excludes no spec of a script a mumbo pipeline runs', () => {
    const scripts = (JSON.parse(read('package.json')) as Manifest).scripts ?? {}
    /** Reached file -> the command or file that reached it. */
    const reached = new Map<string, string>()
    const queue: string[] = []
    const expanded = new Set<string>()
    const reach = (path: string, via: string): void => {
      const file = normalize(path)
      if (reached.has(file) || !existsSync(join(root, file))) return
      reached.set(file, via)
      queue.push(file)
    }
    const command = (text: string, via: string, base = '.', table: Record<string, string> = scripts): void => {
      for (const match of text.matchAll(SCRIPT_PATH)) reach(join(base, match[1]!), via)
      for (const [, name] of text.matchAll(/(?:pnpm|npm) (?:run )?([\w:.-]+)/g)) {
        const script = table[name!]
        if (script === undefined || expanded.has(`${base}:${name!}`)) continue
        expanded.add(`${base}:${name!}`)
        command(script, `${via} > ${name!}`, base, table)
      }
      for (const [, filter, name] of text.matchAll(/--filter (@[\w/-]+) run ([\w:.-]+)/g)) {
        const target = workspaces.get(filter!)
        const script = target?.manifest.scripts?.[name!]
        if (target?.manifest.scripts === undefined || script === undefined) continue
        command(script, `${via} > ${filter!} ${name!}`, target.dir, target.manifest.scripts)
      }
      for (const [, mode] of text.matchAll(/scripts\/run-gates\.ts ([\w-]+)/g)) {
        if (expanded.has(`gates:${mode!}`)) continue
        expanded.add(`gates:${mode!}`)
        for (const gate of gatesForMode(mode as Mode)) command(gate.displayCommand, `${via} > ${gate.id}`)
      }
    }
    const sources = ['.github/workflows/mumbo-ci.yml', '.github/workflows/mumbo-desktop.yml', 'deploy/Dockerfile', 'lefthook.yml']
    for (const file of sources) command(read(file), file)
    for (const file of ['vitest.config.ts', 'scripts/install-lefthook.mjs']) reach(file, 'mumbo-ci unit or pnpm install')
    for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
      // The exclusion list names the subjects it excludes; it runs none of them.
      if (!/\.(ts|mts|mjs|cjs|js)$/.test(file) || file === 'scripts/mumbo-ci-unit-exclusions.ts') continue
      const text = read(file)
      for (const match of text.matchAll(RELATIVE_IMPORT)) reach(resolveRelative(file, match[1]!), file)
      command(text, file)
    }
    const violations = MUMBO_CI_UNIT_EXCLUSIONS.filter(exclusion => exclusion.category === 'gate-not-run')
      .flatMap(exclusion => globSync(exclusion.path, { cwd: root }))
      .flatMap(spec => subjectsOf(spec).filter(subject => reached.has(subject)).map(subject => `${spec}: ${subject} <- ${reached.get(subject)!}`))
    expect(violations).toEqual([])
    expect(reached.has('scripts/run-gates.ts')).toBe(true)
  })

  // mumbo-ci.yml's unit step copies these steps with mumbo's config; an upstream change to them fails here.
  it('copies the ci-unit aggregate mumbo-ci.yml runs as its unit step', () => {
    expect(gatesForMode('ci-unit').map(gate => [gate.displayCommand, gate.env ?? {}]))
      .toEqual([['pnpm run build:native-system', {}], ['pnpm exec vitest run', {}]])
  })
})
