/**
 * Fails when runtime sources name a DeepSeek-operated host other than api.deepseek.com (the temporary
 * model/search API). Known inert occurrences are listed in ALLOWED; a new hit after an upstream merge
 * means a new outbound contact to review. Run after scripts/mumbo-rebrand.ts.
 */
import { spawnSync } from 'node:child_process'

const HOST = /[a-z0-9.-]*(?:deepseek|deepseeksvc)\.(?:com|cn|ai)\b/gi
const ALLOWED_HOSTS = new Set(['api.deepseek.com'])
// Disabled by deploy/mumbo.overlay.yml or rewritten by scripts/mumbo-rebrand.ts, or docs-only strings.
const ALLOWED_FILES = [
  'packages/credentials/deepseek-account-platform/',
  'apps/desktop/scripts/',
  'packages/client/ui-settings-web-search/',
  'packages/llm/llm-deepseek/src/image-tokens.ts',
  'packages/test-support/',
  'scripts/mumbo-',
]

const SKIP = /(^|\/)(node_modules|lib|dist|tests?)\/|\.(md|spec\.ts|test\.ts|i18n\.yaml)$|\.zh\.|(^|\/)package\.json$/
const grep = spawnSync('grep', ['-rIliE', 'deepseek(svc)?\\.(com|cn|ai)', 'apps', 'packages', 'scripts', '--exclude-dir=node_modules', '--exclude-dir=lib', '--exclude-dir=dist'], { encoding: 'utf8', maxBuffer: 1 << 28 })
const files = grep.stdout.split('\n').filter((f) => f && !SKIP.test(f))

const { readFileSync } = await import('node:fs')
const hits = files.filter((f) => !ALLOWED_FILES.some((p) => f.startsWith(p)))
  .flatMap((f) => [...readFileSync(f, 'utf8').matchAll(HOST)].map((m) => `${f}: ${m[0]}`).filter((l) => !ALLOWED_HOSTS.has(l.split(': ')[1]!.toLowerCase())))
if (hits.length) {
  console.error(`unreviewed DeepSeek hosts:\n${[...new Set(hits)].join('\n')}`)
  process.exit(1)
}
