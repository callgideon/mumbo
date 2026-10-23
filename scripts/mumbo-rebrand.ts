/**
 * Build-time rebrand, so `git merge upstream/master` never conflicts on product text:
 * 1. RULES rewrite specific upstream literals (ids, origins, logo fallbacks) to brand/brand.json values.
 * 2. Every shipped text file under TEXT_ROOTS has the product names "DeepSeek Harness" and "DeepSeek"
 *    replaced by brand.productName. Only the capitalised word is touched: lowercase wire values
 *    (api.deepseek.com, model ids, @deepseek-ai/* packages, DEEPSEEK_API_KEY) and identifiers such as
 *    DeepSeekModelsEditor keep working.
 * 3. brand/assets is copied over the matching repo paths.
 * `--check` exits non-zero when an expected RULES literal is missing (upstream moved it: update RULES).
 * Not idempotent by design: a second run fails loudly instead of silently skipping.
 */
import { cpSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const brand = JSON.parse(readFileSync('brand/brand.json', 'utf8')) as {
  productName: string
  shortName: string
  artifactPrefix: string
  appId: string
  updateOrigin: string
  telemetryOtlpUrl: string
}

const RULES: Array<[file: string, from: string, to: string]> = [
  ['apps/desktop/scripts/electron-builder-config.mjs', 'artifactName: `deepseek-harness-', `artifactName: \`${brand.artifactPrefix}-`],
  // Packaged app.name (crash reports, macOS app menu, userData folder) comes from the manifest productName.
  ['apps/desktop/scripts/electron-builder-config.mjs', 'dshDesktopAppId: appId,', `productName: '${brand.productName}', dshDesktopAppId: appId,`],
  ['apps/desktop/scripts/desktop-package-environment.mjs', "'com.deepseek.harness'", `'${brand.appId}'`],
  ['apps/desktop/scripts/desktop-auto-update-environment.mjs', "'https://download.deepseek.com'", `'${brand.updateOrigin}'`],
  ['apps/web/public/manifest.webmanifest', '"short_name": "DSH"', `"short_name": "${brand.shortName}"`],
  ['packages/bundle/base/cordis.patch.yml', "'https://dsh-otel-collector.deepseeksvc.com/v1/logs'", `'${brand.telemetryOtlpUrl}'`],
  ['packages/host/product-telemetry-otel/src/index.ts', 'https://dsh-otel-collector.deepseeksvc.com/v1/logs', brand.telemetryOtlpUrl],
  // New-chat hero: no animated whale.
  ['packages/client/ui-conversation/src/client/skeleton/EmptyHero.tsx', 'fallback: <HeroFish hovering={hovering} />', 'fallback: false && <HeroFish hovering={hovering} />'],
  // Desktop: the overlay disables the DeepSeek account plugin, so its RPC 404s; read that as signed out.
  ['apps/desktop/src/welcome-backend.ts', "loggedIn: (await account.state()).status === 'credential-stored',", "loggedIn: await account.state().then(s => s.status === 'credential-stored', () => false),"],
]

const TEXT_ROOTS = ['packages', 'apps', 'scripts/client-build-environment.ts']
const SKIP = /(^|\/)(node_modules|lib|dist|tests?|__tests__|fixtures|snapshots|test-support|\.desktop-build)(\/|$)|\.(test|spec)\.|README|CHANGELOG|\.i18n\.yaml$/
const NAMES: Array<[RegExp, string]> = [
  [/DeepSeek[ -][Hh]arness/g, brand.productName],
  [/(?<![\w@/.-])DeepSeek(?!\w)/g, brand.productName],
]

const missing = RULES.filter(([file, from]) => !readFileSync(file, 'utf8').includes(from))
if (missing.length) {
  for (const [file, from] of missing) console.error(`missing in ${file}: ${from}`)
  process.exit(1)
}
if (process.argv.includes('--check')) process.exit(0)

for (const [file, from, to] of RULES) writeFileSync(file, readFileSync(file, 'utf8').replace(from, to))

function* textFiles(path: string): Generator<string> {
  if (SKIP.test(path)) return
  const stat = statSync(path, { throwIfNoEntry: false })
  if (stat?.isFile()) {
    if (stat.size < 4_000_000) yield path
    return
  }
  // withFileTypes reports symlinks (pnpm workspace links) as non-directories, so they are not followed.
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isDirectory() || entry.isFile()) yield* textFiles(join(path, entry.name))
  }
}

let changed = 0
for (const root of TEXT_ROOTS) {
  for (const file of textFiles(root)) {
    const before = readFileSync(file)
    if (before.includes(0)) continue
    const text = before.toString('utf8')
    const after = NAMES.reduce((s, [pattern, to]) => s.replace(pattern, to), text)
    if (after !== text) {
      writeFileSync(file, after)
      changed++
    }
  }
}
console.log(`mumbo-rebrand: product name rewritten in ${changed} files`)

if (existsSync('brand/assets')) cpSync('brand/assets', '.', { recursive: true })
