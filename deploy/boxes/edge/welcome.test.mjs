// node --test deploy/boxes/edge/welcome.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WELCOMED, welcomeInstructions, startScript, boxSite, backupCommand, restoreCommand } from './edge.mjs'

const c = { llmHost: 'l', publicHost: 'boxes.x', projectDomain: 'boxes.x' }
const sh = (script) => execFileSync('sh', ['-c', script], { encoding: 'utf8' })

test('welcome says what the assistant can do now, that accounts and projects come later, and links the home page', () => {
  const w = welcomeInstructions(c)
  assert.match(w, /greet them once/)
  assert.match(w, /can do now/)
  assert.match(w, /accounts and projects comes later/)
  assert.match(w, /https:\/\/boxes\.x\/home\b/)
})

test('first-run welcome: the first prompt in a new person box gets it and sets the marker; later prompts and restarts do not', () => {
  const script = startScript(c, 'T', boxSite(c, 'a@x.com'), 'role')
  assert.match(script, /\$CU_PATCH \$WELCOME_PATCH/)
  const from = script.indexOf('WELCOME_PATCH=\n')
  assert.ok(from > 0)
  const root = mkdtempSync(join(tmpdir(), 'welcome-'))
  try {
    mkdirSync(join(root, 'root/.dsh'), { recursive: true })
    mkdirSync(join(root, 'root/.mumbo'))
    const block = script.slice(from, script.indexOf('\nfi\n', from) + 4).replaceAll('/root/', `${root}/root/`)
    const start = () => sh(`${block}echo "$WELCOME_PATCH"`).trim()

    assert.equal(start(), `--patch ${root}/root/.mumbo/welcome.overlay.yml`)
    const overlay = readFileSync(join(root, 'root/.mumbo/welcome.overlay.yml'), 'utf8')
    assert.ok(overlay.includes(`name: '@deepseek-ai/dsh-hooks-claude-code'\n      config:\n        configPath: ${root}/root/.mumbo/welcome-hooks.json\n`), overlay)
    const hooks = JSON.parse(readFileSync(join(root, 'root/.mumbo/welcome-hooks.json'), 'utf8'))
    const [{ command }] = hooks.UserPromptSubmit[0].hooks
    const prompt = () => sh(command)

    const first = JSON.parse(prompt())
    assert.deepEqual(first, { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: welcomeInstructions(c) } })
    assert.ok(existsSync(join(root, WELCOMED)))
    assert.equal(prompt(), '', 'a later prompt, in any session, gets no welcome')
    assert.equal(start(), '', 'a restart of a welcomed box mounts no hook')
  } finally { rmSync(root, { recursive: true, force: true }) }
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
