/**
 * Rewrites a whitelist of upstream product literals to the values in brand/brand.json and copies
 * brand/assets over the matching repo paths. Run at build time so `git merge upstream/master` never
 * conflicts on these files. `--check` exits non-zero when an expected upstream literal is missing
 * (upstream moved it: update RULES). Not idempotent against already-rewritten files by design:
 * a second --apply fails loudly instead of silently skipping.
 */
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs'

const brand = JSON.parse(readFileSync('brand/brand.json', 'utf8')) as Record<string, string>

const RULES: Array<[file: string, from: string, to: string]> = [
  ['apps/desktop/scripts/electron-builder-config.mjs', "protocols: [{ name: 'DeepSeek Harness'", `protocols: [{ name: '${brand.productName}'`],
  ['apps/desktop/scripts/electron-builder-config.mjs', "productName: 'DeepSeek Harness'", `productName: '${brand.productName}'`],
  ['apps/desktop/scripts/electron-builder-config.mjs', 'artifactName: `deepseek-harness-', `artifactName: \`${brand.artifactPrefix}-`],
  ['apps/desktop/scripts/desktop-package-environment.mjs', "'com.deepseek.harness'", `'${brand.appId}'`],
  ['apps/desktop/scripts/desktop-auto-update-environment.mjs', "'https://download.deepseek.com'", `'${brand.updateOrigin}'`],
  ['apps/web/public/manifest.webmanifest', '"name": "DeepSeek Harness"', `"name": "${brand.productName}"`],
  ['apps/web/public/manifest.webmanifest', '"short_name": "DSH"', `"short_name": "${brand.shortName}"`],
  ['packages/bundle/base/cordis.patch.yml', "'https://dsh-otel-collector.deepseeksvc.com/v1/logs'", `'${brand.telemetryOtlpUrl}'`],
  ['packages/host/product-telemetry-otel/src/index.ts', 'https://dsh-otel-collector.deepseeksvc.com/v1/logs', brand.telemetryOtlpUrl],
]

const missing = RULES.filter(([file, from]) => !readFileSync(file, 'utf8').includes(from))
if (missing.length) {
  for (const [file, from] of missing) console.error(`missing in ${file}: ${from}`)
  process.exit(1)
}
if (process.argv.includes('--check')) process.exit(0)

for (const [file, from, to] of RULES) writeFileSync(file, readFileSync(file, 'utf8').replace(from, to))
if (existsSync('brand/assets')) cpSync('brand/assets', '.', { recursive: true })
