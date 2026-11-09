import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
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
  // sha256 of the output recorded before B7, updated for the box-links, computer-use and browser-consent rows and the X cookie (same cfg, token T, role "role's").
  assert.equal(createHash('sha256').update(s).digest('hex'), 'cb88120c2ad4fad53464a7ed19df5ac469dc74cb8ad9d9c7d5bf7c9dd391e7eb')
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

test('create() starts a project box from projectTemplate with the owners as panel admins; a user box from template', async () => {
  const made = []; const written = []
  const e2b = {
    Sandbox: {
      list: () => ({ hasNext: true, nextItems: async function () { this.hasNext = false; return [] } }),
      create: async (tpl) => { made.push(tpl); return { sandboxId: `b${made.length}`, files: { write: async (p, t) => written.push(t) }, commands: { run: async (cmd) => ({ stdout: cmd.includes('dsh.log') ? 'launch' : '' }) }, kill: async () => {} } },
    },
  }
  const store = memoryStore()
  const cfg = { ...c, template: 'T-user', projectTemplate: 'T-project', idleMs: 1000, maxRunning: 0 }
  const { id } = await projects({ store, admitted: () => true, log: () => {} }).create('Owner@x.com', 'P')
  const b = boxes({ e2b, store, cfg, edgeKey: 'k', presignGet: async () => undefined, presignPut: async () => 'P', boxFiles, log: () => {} })
  await b.ensure(`project:${id}`)
  await b.ensure('a@x.com')
  assert.deepEqual(made, ['T-project', 'T-user'])
  assert.match(written[0], /MUMBO_PANEL_ADMINS='owner@x\.com'/)
  assert.ok(!written[1].includes('MUMBO_PANEL_ADMINS'))
})

test('templateArgs defaults', () => {
  assert.deepEqual(templateArgs(['n', 's', 'img']), { image: 'img', name: 'mumbo-box', memoryMB: 4096, cpuCount: 2 })
  assert.deepEqual(templateArgs(['n', 's', 'img', 'mumbo-project', '2048', '4']), { image: 'img', name: 'mumbo-project', memoryMB: 2048, cpuCount: 4 })
  assert.throws(() => templateArgs(['n', 's']), /ECR image/)
})
