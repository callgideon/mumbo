/**
 * Every `@mumbo/*` plugin a Mumbo box overlay names by its bare package name resolves from the CLI's install anchor, the
 * way the Loader resolves overlay patches in the box image. A package that only the workspace knows (hoisted under
 * node_modules/.pnpm) would fail to import there, and an optional entry would then only warn. The check runs in a plain
 * Node child process with no inherited NODE_PATH, because the test runner's resolution finds workspace packages the image
 * cannot.
 */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../../..')
const mumboPackages = readdirSync(join(root, 'packages/mumbo'), { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => `@mumbo/${entry.name}`)

/** Package names that plain Node cannot resolve from apps/cli/package.json. */
function unresolved(names: readonly string[]): string[] {
  const script = `const r = require('node:module').createRequire(process.argv[1]); const missing = []
for (const name of process.argv.slice(2)) { try { r.resolve(name + '/package.json') } catch { missing.push(name) } }
process.stdout.write(JSON.stringify(missing))`
  const run = spawnSync(process.execPath, ['-e', script, join(root, 'apps/cli/package.json'), ...names], {
    encoding: 'utf8',
    // The box starts dsh with plain node, so no NODE_PATH from a package manager or test runner widens the search.
    env: { PATH: process.env.PATH ?? '' },
  })
  if (run.status !== 0) throw new Error(`resolution check failed: ${run.stderr}`)
  return JSON.parse(run.stdout) as string[]
}

describe('Mumbo plugins resolve from the CLI install anchor', () => {
  it('finds every package under packages/mumbo, @mumbo/mcp included', () => {
    expect(mumboPackages).toContain('@mumbo/mcp')
  })

  it('resolves each of them from apps/cli in plain Node', () => {
    expect(unresolved(mumboPackages)).toEqual([])
  })
})
