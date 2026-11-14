/**
 * Fails when runtime sources name a DeepSeek-operated host other than api.deepseek.com (the temporary
 * model/search API). Known inert occurrences are listed in ALLOWED; a new hit after an upstream merge
 * means a new outbound contact to review. Run after scripts/mumbo-rebrand.ts.
 */
import { spawnSync } from 'node:child_process'

const HOST = /[a-z0-9.-]*(?:deepseek|deepseeksvc)\.(?:com|cn|ai)\b/gi
const ALLOWED_HOSTS = new Set(['api.deepseek.com'])
// Reviewed defaults: deploy/mumbo.overlay.yml disables the row, and deploy/mumbo-desktop.overlay.yml points each origin
// at the mumbo gateway (apps/cli/tests/desktop-overlay.spec.ts). A new host in this file fails again.
const ALLOWED_IN_FILE: Record<string, string[]> = {
  'packages/credentials/deepseek-account/src/index.ts': ['platform.deepseek.com', 'harness.deepseek.com'],
}
// Disabled by deploy/mumbo.overlay.yml or rewritten by scripts/mumbo-rebrand.ts, or docs-only strings.
const ALLOWED_FILES = [
  'apps/desktop/scripts/',
  // Upstream's release-upload templates (placeholder buckets and keys); no Mumbo build reads them.
  'apps/desktop/config/publishing/',
  'packages/client/ui-settings-web-search/',
  'packages/llm/llm-deepseek/src/image-tokens.ts',
  'packages/test-support/',
  'scripts/mumbo-',
]

const SKIP = /(^|\/)(node_modules|lib|dist|tests?)\/|\.(md|spec\.ts|test\.ts)$|(^|\/)package\.json$/
const grep = spawnSync('grep', ['-rIliE', 'deepseek(svc)?\\.(com|cn|ai)', 'apps', 'packages', 'scripts', '--exclude-dir=node_modules', '--exclude-dir=lib', '--exclude-dir=dist'], { encoding: 'utf8', maxBuffer: 1 << 28 })
const files = grep.stdout.split('\n').filter(f => f && !SKIP.test(f))

const { readFileSync } = await import('node:fs')
const hits = files.filter(f => !ALLOWED_FILES.some(p => f.startsWith(p)))
  .flatMap(f => [...readFileSync(f, 'utf8').matchAll(HOST)].map(m => m[0].toLowerCase())
    .filter(host => !ALLOWED_HOSTS.has(host) && !ALLOWED_IN_FILE[f]?.includes(host)).map(host => `${f}: ${host}`))
if (hits.length) {
  console.error(`unreviewed DeepSeek hosts:\n${[...new Set(hits)].join('\n')}`)
  process.exit(1)
}
