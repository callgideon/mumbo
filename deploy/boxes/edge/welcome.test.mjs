// node --test deploy/boxes/edge/welcome.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WELCOMED, welcomeInstructions, startScript, boxSite, backupCommand, restoreCommand } from './edge.mjs'

const c = { llmHost: 'l', publicHost: 'boxes.x', projectDomain: 'boxes.x' }
const sh = (script) => execFileSync('sh', ['-c', script], { encoding: 'utf8' })
const bridge = new URL('../../../packages/experimental/hooks-claude-code/', import.meta.url)

/** A temp filesystem root with the person start script's welcome block, run as start.sh would; `start()` returns $WELCOME_PATCH. */
function box() {
  const script = startScript(c, 'T', boxSite(c, 'a@x.com'), 'role')
  const from = script.indexOf('# First-run welcome')
  assert.ok(from > 0)
  const root = mkdtempSync(join(tmpdir(), 'welcome-'))
  mkdirSync(join(root, 'root/.dsh'), { recursive: true })
  mkdirSync(join(root, 'root/.mumbo'))
  const block = script.slice(from, script.indexOf('\nfi\n', script.indexOf('WELCOME_PATCH=', from)) + 4).replaceAll('/root/', `${root}/root/`)
  const at = (path) => join(root, path)
  return {
    root, at,
    start: () => sh(`set -eu\n${block}echo "$WELCOME_PATCH"`).trim(),
    prompt: () => sh(JSON.parse(readFileSync(at('root/.mumbo/welcome-hooks.json'), 'utf8')).UserPromptSubmit[0].hooks[0].command),
    done: () => rmSync(root, { recursive: true, force: true }),
  }
}

test('welcome says what the assistant can do now, including own projects, that accounts come later, and links the home page', () => {
  const w = welcomeInstructions(c)
  assert.match(w, /greet them once/)
  assert.match(w, /can do now:.*start projects of their own/)
  assert.match(w, /connecting their accounts comes later/)
  assert.doesNotMatch(w, /projects comes? later/)
  assert.match(w, /https:\/\/boxes\.x\/home\b/)
})

test('first-run welcome: the first prompt in a new person box gets it and sets the marker; later prompts and restarts do not', () => {
  const script = startScript(c, 'T', boxSite(c, 'a@x.com'), 'role')
  assert.match(script, /\$CU_PATCH \$WELCOME_PATCH/)
  const b = box()
  try {
    assert.equal(b.start(), `--patch ${b.root}/root/.mumbo/welcome.overlay.yml`)
    assert.deepEqual(JSON.parse(b.prompt()), { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: welcomeInstructions(c) } })
    assert.ok(existsSync(b.at(WELCOMED)))
    assert.equal(b.prompt(), '', 'a later prompt, in any session, gets no welcome')
    assert.equal(b.start(), '', 'a restart of a welcomed box mounts no hook')
  } finally { b.done() }
})

test('a box that dsh has booted in but nobody has talked to is still new', () => {
  const b = box()
  try {
    mkdirSync(b.at('root/.dsh/profiles/web'), { recursive: true })
    writeFileSync(b.at('root/.dsh/profiles/web/cordis.yml'), '')
    mkdirSync(b.at('root/.dsh/storages'))
    writeFileSync(b.at('root/.dsh/storages/workspace.json'), '{}')
    mkdirSync(b.at('root/.dsh/sessions'))
    assert.notEqual(b.start(), '')
  } finally { b.done() }
})

test('a box restored from a backup taken before the welcome existed is marked, not welcomed', () => {
  const b = box()
  const target = `file://${b.root}.tgz`
  try {
    const log = 'root/.dsh/sessions/--root-projects--/session-0123/session.v4.jsonl.zstd'
    mkdirSync(b.at(join(log, '..')), { recursive: true })
    writeFileSync(b.at(log), 'zstd frames')
    sh(backupCommand(target, b.root))
    rmSync(b.at('root/.dsh'), { recursive: true })
    sh(restoreCommand(target, b.root))
    assert.ok(existsSync(b.at(log)) && !existsSync(b.at(WELCOMED)))
    assert.equal(b.start(), '')
    assert.ok(existsSync(b.at(WELCOMED)))
    assert.ok(!existsSync(b.at('root/.mumbo/welcome-hooks.json')))
  } finally { b.done(); rmSync(`${b.root}.tgz`, { force: true }) }
})

test('project boxes get no welcome', () => {
  const p = startScript(c, 'T', boxSite(c, 'project:0123456789abcdef'), 'role', 'K', { proxy: 'P', gh: 'G' })
  assert.ok(!p.includes('WELCOME') && !p.includes('welcome'))
})

test('the welcome marker lives in the backed-up tree, so a restored box is not welcomed again', () => {
  assert.ok(WELCOMED.startsWith('/root/.dsh/'))
  const root = mkdtempSync(join(tmpdir(), 'welcome-bk-'))
  const target = `file://${root}.tgz`
  try {
    mkdirSync(join(root, 'root/.dsh'), { recursive: true })
    writeFileSync(join(root, WELCOMED), '')
    sh(backupCommand(target, root))
    assert.ok(execFileSync('tar', ['-tzf', `${root}.tgz`], { encoding: 'utf8' }).split('\n').includes(WELCOMED.slice(1)))
    rmSync(join(root, 'root'), { recursive: true })
    sh(restoreCommand(target, root))
    assert.ok(existsSync(join(root, WELCOMED)))
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(`${root}.tgz`, { force: true }) }
})

test('the hooks bridge accepts the generated hooks file, overlay row and hook output (its own parsers and Config schema)', async () => {
  // The bridge's source is TypeScript whose only runtime import outside itself is the hook protocol; Node strips the types.
  const protocol = new URL('../hook-protocol/src/index.ts', bridge).href
  registerHooks({ resolve: (specifier, context, next) => specifier === '@deepseek-ai/dsh-hook-protocol' ? { url: protocol, shortCircuit: true } : next(specifier, context) })
  const { parseClaudeCodeConfig } = await import(new URL('src/config.ts', bridge).href)
  const { parseHookOutput } = await import(protocol)
  const b = box()
  try {
    b.start()
    const parsed = parseClaudeCodeConfig(JSON.parse(readFileSync(b.at('root/.mumbo/welcome-hooks.json'), 'utf8')))
    assert.deepEqual(parsed.skipped, [])
    assert.deepEqual(Object.keys(parsed.config), ['UserPromptSubmit'])
    const [hook] = parsed.config.UserPromptSubmit[0].hooks
    assert.equal(hook.timeoutSec, 10)
    const out = parseHookOutput(0, sh(hook.command), '', 'UserPromptSubmit')
    assert.equal(out.additionalContext, welcomeInstructions(c))
    assert.equal(parseHookOutput(0, sh(hook.command), '', 'UserPromptSubmit').additionalContext, undefined)

    // The overlay row: the bridge's package name, and config keys that its Config schema declares, every required one present.
    const overlay = readFileSync(b.at('root/.mumbo/welcome.overlay.yml'), 'utf8')
    assert.ok(overlay.includes(`      name: '${JSON.parse(readFileSync(new URL('package.json', bridge), 'utf8')).name}'\n`), overlay)
    const row = Object.fromEntries([...overlay.matchAll(/^ {8}(\w+): (.*)$/gm)].map(([, k, v]) => [k, v]))
    assert.equal(row.configPath, b.at('root/.mumbo/welcome-hooks.json'))
    const schema = readFileSync(new URL('src/index.ts', bridge), 'utf8').match(/export const Config: z<Config> = z\.object\(\{\n([\s\S]*?)\n\}\)/)
    assert.ok(schema, 'the bridge declares its Config schema as z.object')
    const fields = Object.fromEntries([...schema[1].matchAll(/^ {2}(\w+): z\.(.*),$/gm)].map(([, k, v]) => [k, v.includes('.required()')]))
    assert.ok('configPath' in fields)
    for (const k of Object.keys(row)) assert.ok(k in fields, `the bridge Config has no ${k}`)
    for (const [k, required] of Object.entries(fields)) if (required) assert.ok(k in row, `the row lacks required ${k}`)
  } finally { b.done() }
})
