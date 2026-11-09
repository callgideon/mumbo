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
  // sha256 of the output recorded from the script before B7 (same cfg, token T, role "role's").
  assert.equal(createHash('sha256').update(s).digest('hex'), 'e45f9296d5ce13071ffd5914aec541968d2013eada0a9b68404f2bed104c363d')
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
  assert.match(s, /openssl x509 -noout -pubkey -in \/root\/\.mumbo\/ca\/ca\.crt\)" = "\$\(openssl pkey -pubout -in \/root\/\.mumbo\/ca\/ca\.key\)/)
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
