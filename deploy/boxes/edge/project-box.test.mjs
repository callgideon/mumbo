import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startScript, boxSite, boxes } from './edge.mjs'
import { memoryStore } from './store.mjs'
import { projects } from './projects.mjs'
import { templateArgs } from './template.mjs'

const c = { llmHost: 'l', publicHost: 'boxes.x' }
const boxFiles = { proxy: 'PROXY-JS\n', gh: '#!/bin/sh\nGH\n' }
const b64 = (s) => Buffer.from(s).toString('base64')
const at = (text, needle) => { const i = text.indexOf(needle); assert.ok(i >= 0, `missing: ${needle}`); return i }

test('a user box start script is byte-for-byte what it was before project boxes grew a proxy', () => {
  const s = startScript(c, 'T', boxSite(c, 'a@x.com'), "role's", undefined, boxFiles, ['o@x.com'])
  // sha256 of the output recorded before B7, updated for the box-links, computer-use and browser-consent rows, the X cookie and the first-run welcome (same cfg, token T, role "role's").
  assert.equal(createHash('sha256').update(s).digest('hex'), '307068336f6f6c73a112ce4e3930485ccf012edf58082ffd8053de98765d58c1')
})

test('box links: the overlay loads only when the image ships @mumbo/box-links; project boxes get no desktop link', () => {
  const u = startScript(c, 'T', boxSite(c, 'a@x.com'), 'role', undefined, boxFiles)
  assert.match(u, /if \[ -d \/src\/packages\/mumbo\/box-links \]; then/)
  assert.match(u, /home: https:\/\/boxes\.x\/home\n        desktop: https:\/\/boxes\.x\/desktop\//)
  assert.match(u, /sandboxes\.overlay\.yml \$LINKS_PATCH /)
  const p = startScript({ ...c, projectDomain: 'boxes.x' }, 'T', boxSite({ ...c, projectDomain: 'boxes.x' }, 'project:0123456789abcdef'), 'role', 'K', boxFiles)
  assert.match(p, /home: https:\/\/boxes\.x\/home\n/)
  assert.ok(!p.includes('desktop: https://'))
})

test('browser consent replaces the plain Playwright provider row only when the image ships @mumbo/browser-consent', () => {
  const u = startScript(c, 'T', boxSite(c, 'a@x.com'), 'role', undefined, boxFiles)
  assert.ok(at(u, 'if [ -d /src/packages/mumbo/browser-consent ]; then') < at(u, "name: '@mumbo/browser-consent'"))
  assert.ok(at(u, "name: '@mumbo/browser-consent'") < at(u, 'else') && at(u, 'else') < at(u, "dsh-experimental-browser-use-playwright-mcp"))
  const p = startScript({ ...c, projectDomain: 'boxes.x' }, 'T', boxSite({ ...c, projectDomain: 'boxes.x' }, 'project:0123456789abcdef'), 'role', 'K', boxFiles)
  assert.ok(!p.includes('browser-consent') && !p.includes('playwright-mcp'))
})

test('computer use: person boxes load it only with the package and xdotool, and :1 needs the X cookie; project boxes never', () => {
  const u = startScript(c, 'T', boxSite(c, 'a@x.com'), 'role', undefined, boxFiles)
  assert.match(u, /if \[ -d \/src\/packages\/experimental\/computer-use-x11 \] && command -v xdotool/)
  assert.match(u, /\$LINKS_PATCH \$CU_PATCH/)
  assert.match(u, /Xvfb :1 \$XVFB_AUTH /)
  assert.ok(at(u, 'export XAUTHORITY=/run/x11/auth') < at(u, "Xvfb :1"))
  const p = startScript({ ...c, projectDomain: 'boxes.x' }, 'T', boxSite({ ...c, projectDomain: 'boxes.x' }, 'project:0123456789abcdef'), 'role', 'K', boxFiles)
  assert.ok(!p.includes('CU_PATCH') && !p.includes('computer-use'))
})

test('a project box start script has the proxy setup in order, before the member-auth block', () => {
  const s = startScript(c, 'TOK', boxSite(c, 'project:0123456789abcdef'), 'role', 'KEYTEXT', boxFiles, ['O@x.com', 'p@x.com'])
  const order = [
    'flock 9',
    'openssl req -x509',
    '/usr/local/share/ca-certificates/mumbo-box.crt',
    'update-ca-certificates',
    `echo ${b64(boxFiles.proxy)} | base64 -d > /root/.mumbo/bin/github-local-proxy.mjs`,
    `echo ${b64(boxFiles.gh)} | base64 -d > /root/.mumbo/bin/gh`,
    'chmod 0755 /root/.mumbo/bin/github-local-proxy.mjs /root/.mumbo/bin/gh',
    "pgrep -f github-local-proxy.mjs >/dev/null || PORT=8899 CA_DIR=/root/.mumbo/ca EDGE_GITHUB_URL=https://l/github BOX_TOKEN=TOK nohup node /root/.mumbo/bin/github-local-proxy.mjs",
    'curl -s -o /dev/null -m 1 http://127.0.0.1:8899/',
    'if [ -f /src/deploy/mumbo-project.overlay.yml ]',
    'export MUMBO_MEMBER_KEY=KEYTEXT',
    'PATH=/root/.mumbo/bin:$PATH NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.mumbo/ca/ca.crt HTTPS_PROXY=http://127.0.0.1:8899 NO_PROXY=127.0.0.1,localhost,l ',
    '$PROJECT_PATCH',
  ].map(n => at(s, n))
  assert.deepEqual(order, [...order].sort((a, b) => a - b))
  assert.match(s, /\(\nflock 9\n/)
  assert.match(s, /\) 9>\/root\/\.mumbo\/ca\.lock\n/)
  assert.match(s, /a=\$\(openssl x509 -noout -pubkey -in \/root\/\.mumbo\/ca\/ca\.crt [^\n]*\|\| true\)\nb=\$\(openssl pkey -pubout -in \/root\/\.mumbo\/ca\/ca\.key [^\n]*\|\| true\)\nif \[ -z "\$a" \] \|\| \[ "\$a" != "\$b" \]; then\n  pkill -f github-local-proxy\.mjs \|\| true\n  rm -rf \/root\/\.mumbo\/ca\/leaf\n  openssl req/)
  assert.match(s, /mv \/root\/\.mumbo\/ca\/ca\.key\.tmp .*\n.*mv \/root\/\.mumbo\/ca\/ca\.crt\.tmp/)
  assert.match(s, /9>&- &\n/)
  assert.match(s, /MUMBO_PANEL_ADMINS='o@x\.com,p@x\.com' /)
  assert.ok(!/HTTP_PROXY/.test(s.replace('HTTPS_PROXY', '')), 'no plain HTTP_PROXY')
  assert.match(s, /touch \/root\/\.mumbo\/member-auth/)
})

const APP_GATE = 'if grep -qs MUMBO_GITHUB_APP_LOGIN /src/deploy/mumbo-project.overlay.yml; then export '
/** The App env line of a start script, run by sh with its overlay path pointed at `overlay`; prints both variables. */
function runAppEnv(script, overlay, cwd) {
  const line = script.split('\n').find(l => l.startsWith(APP_GATE))
  assert.ok(line, 'App env line present')
  const sh = `${line.replace('/src/deploy/mumbo-project.overlay.yml', overlay)}\nprintf '[%s][%s]' "\${MUMBO_GITHUB_APP_LOGIN-unset}" "\${MUMBO_GITHUB_APP_USER_ID-unset}"`
  return execFileSync('sh', ['-c', sh], { cwd, encoding: 'utf8', env: { PATH: process.env.PATH } })
}

test('GitHub App env: a project box exports the agent login and id after the proxy, before dsh; a person box gets neither', () => {
  const app = { ...c, agentLogin: 'mumbo-bot[bot]', agentId: 341797844 }
  const p = startScript(app, 'TOK', boxSite(app, 'project:0123456789abcdef'), 'role', 'K', boxFiles, ['o@x.com'])
  assert.ok(p.includes(`${APP_GATE}MUMBO_GITHUB_APP_LOGIN='mumbo-bot[bot]' MUMBO_GITHUB_APP_USER_ID=341797844; fi\n`))
  // Outside the proxy's subshell, so the export reaches the dsh process.
  assert.ok(at(p, ') 9>/root/.mumbo/ca.lock') < at(p, APP_GATE) && at(p, APP_GATE) < at(p, 'nohup node --import tsx/esm apps/cli/src/bin.ts'))
  const u = startScript(app, 'T', boxSite(app, 'a@x.com'), 'role', undefined, boxFiles)
  assert.ok(!u.includes('MUMBO_GITHUB_APP'))
  // Without GITHUB_AGENT_LOGIN and GITHUB_AGENT_ID (edge config sets both or neither) a project box gets neither.
  const none = startScript(c, 'TOK', boxSite(c, 'project:0123456789abcdef'), 'role', 'K', boxFiles)
  assert.ok(!none.includes('MUMBO_GITHUB_APP'))
})

test('GitHub App env: sh exports both only when the overlay reads them, with the [bot] login quoted literally', () => {
  const dir = mkdtempSync(join(tmpdir(), 'app-env-'))
  try {
    // Files an unquoted export argument MUMBO_GITHUB_APP_LOGIN=mumbo-bot[bot] would glob to.
    for (const name of ['mumbo-botb', 'mumbo-boto']) writeFileSync(join(dir, `MUMBO_GITHUB_APP_LOGIN=${name}`), '')
    const reads = join(dir, 'reads.yml'), older = join(dir, 'older.yml')
    writeFileSync(reads, "githubApp: !!js \"process.env.MUMBO_GITHUB_APP_LOGIN || ...\"\n")
    writeFileSync(older, 'stateDir: x\n')
    const app = { ...c, agentLogin: 'mumbo-bot[bot]', agentId: 341797844 }
    const p = startScript(app, 'TOK', boxSite(app, 'project:0123456789abcdef'), 'role', 'K', boxFiles)
    assert.equal(runAppEnv(p, reads, dir), '[mumbo-bot[bot]][341797844]')
    assert.equal(runAppEnv(p, older, dir), '[unset][unset]')
    assert.equal(runAppEnv(p, join(dir, 'missing.yml'), dir), '[unset][unset]')
    // A login with a quote stays one literal word, not shell syntax.
    const odd = { ...app, agentLogin: "it's[bot]; touch pwned" }
    assert.equal(runAppEnv(startScript(odd, 'TOK', boxSite(odd, 'project:0123456789abcdef'), 'role', 'K', boxFiles), reads, dir), "[it's[bot]; touch pwned][341797844]")
    assert.ok(!existsSync(join(dir, 'pwned')))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('create() starts a project box from projectTemplate with the owners as panel admins; a user box from template', async () => {
  const made = []; const written = []
  const e2b = {
    Sandbox: {
      list: () => ({ hasNext: true, nextItems: async function () { this.hasNext = false; return [] } }),
      create: async (tpl) => { made.push(tpl); return { sandboxId: `b${made.length}`, files: { write: async (p, t) => written.push(t) }, commands: { run: async (cmd) => ({ stdout: cmd.includes('dsh.log') ? 'launch' : '' }) }, kill: async () => {} } },
    },
  }
  const store = memoryStore()
  const cfg = { ...c, template: 'T-user', projectTemplate: 'T-project', idleMs: 1000, maxRunningUnits: 0 }
  const { id } = await projects({ store, admitted: () => true, log: () => {} }).create('Owner@x.com', 'P')
  const b = boxes({ e2b, store, cfg, edgeKey: 'k', presignGet: async () => undefined, presignPut: async () => 'P', boxFiles, log: () => {} })
  await b.ensure(`project:${id}`)
  await b.ensure('a@x.com')
  assert.deepEqual(made, ['T-project', 'T-user'])
  assert.match(written[0], /MUMBO_PANEL_ADMINS='owner@x\.com'/)
  assert.ok(!written[1].includes('MUMBO_PANEL_ADMINS'))
})

test('templateArgs defaults', () => {
  assert.deepEqual(templateArgs(['n', 's', 'img'], {}), { image: 'img', name: 'mumbo-box', memoryMB: 4096, cpuCount: 2, minAvailMB: 9216 })
  assert.deepEqual(templateArgs(['n', 's', 'img', 'mumbo-project', '2048', '4'], { MIN_AVAIL_MB: '10240' }), { image: 'img', name: 'mumbo-project', memoryMB: 2048, cpuCount: 4, minAvailMB: 10240 })
  assert.throws(() => templateArgs(['n', 's'], {}), /ECR image/)
  for (const bad of ['', 'x', '9.5', '-1']) assert.throws(() => templateArgs(['n', 's', 'img'], { MIN_AVAIL_MB: bad }), /MIN_AVAIL_MB/, bad)
})
