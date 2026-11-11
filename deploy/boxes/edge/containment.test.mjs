// node --test deploy/boxes/edge/containment.test.mjs
// Agent containment (B24) in the start script: the rows it writes against the harness's fixtures, and its kernel,
// network and layout parts run by sh in a temporary root with fake id, getent, usermod, chown, setfacl, mount and nft,
// and only those and the real tools they need on PATH. The template's containment steps and nftables smoke check. The
// escape-test script's check list.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openAsBlob, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { runInNewContext } from 'node:vm'
import { startScript, boxSite, containmentRows, containmentLayout, ENVD_PORT, MUMBO_MCP_PORT } from './edge.mjs'
import { BOX_STEPS, PROJECT_STEPS, KASMVNC_BIND_STEP, NFT_SMOKE_STEP, kasmvncStep, usersSteps } from './template.mjs'

const c = { llmHost: 'llm.example', publicHost: 'app.example', projectDomain: 'app.example' }
const script = (cfg, person) => startScript(cfg, 'T', boxSite(cfg, person ? 'a@x.com' : 'project:0123456789abcdef'), 'role', person ? undefined : 'K', { proxy: 'P', gh: 'G' })
/** The fixtures' ids (apps/cli/tests/fixtures/box-edge/containment-*.overlay.yml): agent 1001, browsermcp 1002,
 *  desktop 1003, shared 1005, mcpserver 1006, uploads 1009 (browsermcp's one group); the workspace groups, which the fixtures
 *  do not name, 1007 and 1008. */
const IDS = { agent: [1001, 1001], browsermcp: [1002, 1002], desktop: [1003, 1003], mcpserver: [1006, 1006] }
const GROUPS = { shared: 1005, workspace: 1007, 'workspace-read': 1008, uploads: 1009 }
const SECRETS = 'secretNames: [DEEPSEEK_API_KEY, MUMBO_MEMBER_KEY, E2B_API_KEY, GH_TOKEN, GITHUB_TOKEN]'
const PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
/** The fixtures' rows without their comments, at the harness branch's 500045c765, with agent also in workspace,
 *  browsermcp also in uploads, and no dsh-superagent row: the image's project overlay reads the directories from the
 *  variables the layout exports (the uploads and A2 contract of 2026-11-11, which the harness's fixtures take on). Both
 *  end with the web_fetch rows of that contract: the anonymous fetcher off, web_fetch through the edge's model host. */
const FIXTURE = (person, mcpGroups = '') => `- id: subprocess
  config:
    shellActivityDirectory: /run/dsh-shell
    spillDirectory: /var/lib/mumbo/subprocess-spill
    runAs:
      uid: 1001
      gid: 1001
      groups: [${person ? '1005, ' : ''}1007]
      inherit: [LANG, LC_ALL, TZ]
      set:
        HOME: /home/agent
        TMPDIR: /home/agent/tmp
        USER: agent
        LOGNAME: agent
        SHELL: /bin/bash
${person ? `        PATH: ${PATH}
` : `        PATH: /var/lib/mumbo/superagent/worker-bin:/usr/local/lib/mumbo/bin:${PATH}
        GIT_CONFIG_GLOBAL: /var/lib/mumbo/superagent/worker-gitconfig
        GIT_CONFIG_NOSYSTEM: '1'
        GIT_ASKPASS: ''
        GIT_TERMINAL_PROMPT: '0'
        NODE_EXTRA_CA_CERTS: /usr/local/share/ca-certificates/mumbo-box.crt
        NODE_USE_ENV_PROXY: '1'
        HTTPS_PROXY: http://127.0.0.1:8899
        NO_PROXY: 127.0.0.1,localhost,llm.example
`}      ${SECRETS}
    identities:
${person ? `      browsermcp:
        uid: 1002
        gid: 1002
        groups: [1009]
        inherit: [LANG, LC_ALL, TZ]
        set:
          HOME: /home/browsermcp
          TMPDIR: /home/browsermcp/tmp
          USER: browsermcp
          LOGNAME: browsermcp
          PATH: ${PATH}
        ${SECRETS}
      desktop:
        uid: 1003
        gid: 1003
        groups: []
        inherit: [LANG, LC_ALL, TZ]
        set:
          HOME: /home/desktop
          TMPDIR: /home/desktop/tmp
          USER: desktop
          LOGNAME: desktop
          PATH: ${PATH}
        ${SECRETS}
` : ''}      mcpserver:
        uid: 1006
        gid: 1006
        groups: [${mcpGroups}]
        inherit: [LANG]
        set:
          HOME: /home/mcpserver
          USER: mcpserver
          PATH: /usr/local/bin:/usr/bin:/bin
        ${SECRETS}
    serverIdentity: mcpserver
- id: fs-sandbox
  config:
    modelRoots: [/root/projects, /home/agent, ${person ? '/home/shared/Downloads' : '/root/work'}]
    readOnlyRoots:
      - /var/lib/mumbo/attachments/attachments/v1
      - /root/.dsh/skills
      - /usr/local/share/mumbo/agents/skills
      - /var/lib/mumbo/spill
      - /var/lib/mumbo/subprocess-spill
- id: attachment-local
  config:
    dshHome: /var/lib/mumbo/attachments
    groupReadable: true
- id: spill-local
  config:
    root: /var/lib/mumbo/spill
    groupReadable: true
- id: mcp-manager
  inject: [credentials, subprocess]
- id: plugin-manager
  config:
    modelTools: false
- id: preset-cordis
  disabled: true
- id: workspace-changes
  config:
    summaries: false
- id: web-fetch-http
  disabled: true
- id: web
  config:
    searchProvider: deepseek-search-api
    fetchProvider: deepseek-fetch-api
- id: web-deepseek-api
  config:
    fetchBaseURL: https://llm.example/v1/tools
`

const REAL = ['cat', 'grep', 'cut', 'chmod', 'find', 'cp', 'rm', 'mkdir', 'readlink', 'dirname', 'sort', 'stat']
const which = (tool) => execFileSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim()

/** A temporary root for the start script's B24 parts: box paths moved under it, fakes on PATH that log to log/<name>,
 *  and an image project overlay that reads MUMBO_WORK_DIR. */
function root({ users = true, groups = GROUPS } = {}) {
  const t = mkdtempSync(join(tmpdir(), 'containment-'))
  // What the start script's head makes before these parts: /root/projects, /root/.dsh and /root/.mumbo.
  for (const d of ['bin', 'log', 'root/projects', 'root/.dsh', 'root/.mumbo', 'proc/sys/net/ipv4', 'proc/sys/fs', 'usr/local/share/mumbo', 'var/lib', 'run', 'src/deploy']) mkdirSync(join(t, d), { recursive: true })
  writeFileSync(join(t, 'src/deploy/mumbo-project.overlay.yml'), '    workDirectory: !!js process.env.MUMBO_WORK_DIR\n')
  chmodSync(join(t, 'root'), 0o755)
  for (const tool of REAL) symlinkSync(which(tool), join(t, 'bin', tool))
  const fake = (name, body) => { rmSync(join(t, 'bin', name), { force: true }); writeFileSync(join(t, 'bin', name), `#!/bin/sh\n${body}\n`); chmodSync(join(t, 'bin', name), 0o755) }
  const log = (name) => `echo "$*" >> ${t}/log/${name}`
  const ids = Object.entries(IDS).map(([u, [uid, gid]]) => `${u}) [ "$o" = -u ] && echo ${uid} || echo ${gid};;`).join(' ')
  fake('id', users ? `o=$1; [ $# = 1 ] && o=; u=\${2:-$1}; case $u in ${ids} *) exit 1;; esac` : 'exit 1')
  fake('getent', `case $2 in ${Object.entries(groups).map(([g, gid]) => `${g}) echo ${g}:x:${gid}:;;`).join(' ')} *) exit 2;; esac`)
  for (const name of ['usermod', 'chown', 'setfacl', 'mount']) fake(name, log(name))
  // install: logs, then runs the real one without the owner and group, which the test's user cannot give.
  fake('install', `${log('install')}; a=; while [ $# -gt 0 ]; do case $1 in -o|-g) shift 2;; *) a="$a $1"; shift;; esac; done; exec ${which('install')} $a`)
  return {
    t,
    at: (p) => join(t, p),
    fake,
    lines: (name) => existsSync(join(t, 'log', name)) ? readFileSync(join(t, 'log', name), 'utf8').trim().split('\n').map(l => l.replaceAll(t, 'T')) : [],
    /** Runs `text` with box paths moved under t; returns status, stderr and the variables named. */
    run: (text, show = []) => {
      const local = text.replaceAll('/root', `${t}/root`).replaceAll('/var/lib/mumbo', `${t}/var/lib/mumbo`).replaceAll('/usr/local/share/mumbo', `${t}/usr/local/share/mumbo`)
        .replaceAll('/run/dsh-shell', `${t}/run/dsh-shell`).replaceAll('/proc/', `${t}/proc/`).replaceAll('/src/deploy', `${t}/src/deploy`)
      const r = spawnSync('/bin/sh', ['-c', `set -eu\n${local}\n${show.map(v => `printf '%s=%s\\n' ${v} "\${${v}-}"`).join('\n')}`], { encoding: 'utf8', env: { PATH: join(t, 'bin') } })
      return { code: r.status, err: r.stderr.replaceAll(t, 'T'), out: r.stdout.replaceAll(t, 'T') }
    },
    done: () => rmSync(t, { recursive: true, force: true }),
  }
}
/** The start script's B24 layout part, after the gates. */
const layoutOf = (s) => s.slice(s.indexOf('CONTAINMENT_PATCH=\n'), s.indexOf('AGENTS_HOME=/root/.mumbo/agents'))
/** The start script's B24 kernel and network part. */
const hardeningOf = (s) => s.slice(s.indexOf('if [ -n "$B24_TEMPLATE" ]; then\n  # Only root binds'), s.indexOf('CONTAINMENT_PATCH=\n'))
/** The nftables ruleset the B24 start script loads with DSH_PORT 880 and LIVE_PORT 881; `cdp` is who besides root may
 *  connect to the debugging port: `{ 0, <browsermcp's uid> }`, or `0` on a box without browsermcp. */
const FIREWALL = (cdp) => `table inet mumbo
delete table inet mumbo
table inet mumbo {
  chain output {
    type filter hook output priority 0; policy accept;
    tcp flags & (fin|syn|rst|ack) == syn tcp dport ${ENVD_PORT} reject with tcp reset
    tcp flags & (fin|syn|rst|ack) == syn tcp dport 9222 meta skuid ${cdp} accept
    tcp flags & (fin|syn|rst|ack) == syn tcp dport { 880, 881, ${MUMBO_MCP_PORT}, 5900-5999 } meta skuid 0 accept
    tcp flags & (fin|syn|rst|ack) == syn tcp dport { 880, 881, ${MUMBO_MCP_PORT}, 5900-5999, 9222 } reject with tcp reset
  }
  chain input {
    type filter hook input priority 0; policy accept;
    iifname != "lo" tcp dport { 9222, 5900-5999 } drop
    iifname != "lo" udp dport 881 drop
  }
}
`

test('containment rows: the harness fixtures with the box\'s ids and agent in the workspace group, for each mcpServerWorkspace', () => {
  for (const person of [true, false]) {
    for (const [mode, groups] of [['none', ''], ['read', '1008'], ['readwrite', '1007']]) {
      const r = root()
      try {
        const s = script({ ...c, mcpServerWorkspace: mode }, person)
        const out = r.run(`B24_IMAGE=1 B24_TEMPLATE=1\n${layoutOf(s)}`, ['CONTAINMENT_PATCH'])
        assert.equal(out.code, 0, out.err)
        assert.equal(out.out, 'CONTAINMENT_PATCH=--patch T/root/.mumbo/containment.overlay.yml\n')
        assert.equal(readFileSync(r.at('root/.mumbo/containment.overlay.yml'), 'utf8').replaceAll(r.t, ''), FIXTURE(person, groups), `${person ? 'person' : 'project'} ${mode}`)
        // The same groups in /etc/group, for su (the escape test): none, workspace-read or workspace.
        assert.deepEqual(r.lines('usermod'), [`-G ${{ none: '', read: 'workspace-read', readwrite: 'workspace' }[mode]} mcpserver`])
      } finally { r.done() }
    }
  }
  // An unquoted heredoc carries the rows: no $ but the id variables, no backquote, no backslash.
  for (const person of [true, false]) {
    const rows = containmentRows(c, person)
    assert.deepEqual([...new Set(rows.match(/\$\w*/g))].sort(), ['$AGENT_GID', '$AGENT_UID', '$MCP_GID', '$MCP_GROUPS', '$MCP_UID', '$WS_GID', ...(person ? ['$BMCP_GID', '$BMCP_UID', '$DESKTOP_GID', '$DESKTOP_UID', '$SHARED_GID', '$UPLOADS_GID'] : [])].sort())
    assert.ok(!/[`\\]/.test(rows))
    // No value of the subprocess row names a path in /root/.mumbo, which stays 0700.
    assert.ok(!rows.slice(0, rows.indexOf('- id: fs-sandbox')).includes('/root/.mumbo'))
    // dsh-superagent's row is the image's project overlay's alone: a patch's config would replace it.
    assert.ok(!rows.includes('dsh-superagent'))
  }
  assert.throws(() => containmentLayout({ ...c, mcpServerWorkspace: 'all' }, true), /mcpServerWorkspace "all"/)
})

test('a contained project box exports dsh-superagent\'s directories for the image\'s overlay, and stops on an overlay that does not read them', () => {
  const vars = ['MUMBO_WORK_DIR', 'MUMBO_WORKER_DIR', 'MUMBO_GH_CONFIG_DIR']
  let r = root()
  try {
    const out = r.run(`B24_IMAGE=1 B24_TEMPLATE=1\n${layoutOf(script(c, false))}`, vars)
    assert.equal(out.code, 0, out.err)
    assert.equal(out.out, 'MUMBO_WORK_DIR=T/root/work\nMUMBO_WORKER_DIR=T/var/lib/mumbo/superagent\nMUMBO_GH_CONFIG_DIR=T/root/.config/gh\n')
    // Exported, so dsh, started later by the same script, has them.
    assert.ok(layoutOf(script(c, false)).includes('  export MUMBO_WORK_DIR=/root/work MUMBO_WORKER_DIR=/var/lib/mumbo/superagent MUMBO_GH_CONFIG_DIR=/root/.config/gh\n'))
  } finally { r.done() }
  // An overlay from before the variables, or none: nothing is laid out and dsh does not start.
  for (const overlay of ['    workDirectory: /root/work\n', undefined]) {
    r = root()
    try {
      if (overlay === undefined) rmSync(r.at('src/deploy/mumbo-project.overlay.yml'))
      else writeFileSync(r.at('src/deploy/mumbo-project.overlay.yml'), overlay)
      const out = r.run(`B24_IMAGE=1 B24_TEMPLATE=1\n${layoutOf(script(c, false))}`)
      assert.deepEqual([out.code, out.err], [1, 'mumbo-box: this image runs agent containment (B24), but its T/src/deploy/mumbo-project.overlay.yml does not read MUMBO_WORK_DIR: build the image from a harness whose dsh-superagent row does (RUNBOOK "Agent containment (B24)")\n'])
      assert.deepEqual([r.lines('install'), existsSync(r.at('root/.mumbo/containment.overlay.yml'))], [[], false])
    } finally { r.done() }
  }
  // Person boxes run no superagent and export none.
  r = root()
  try {
    rmSync(r.at('src/deploy/mumbo-project.overlay.yml'))
    const out = r.run(`B24_IMAGE=1 B24_TEMPLATE=1\n${layoutOf(script(c, true))}`, vars)
    assert.deepEqual([out.code, out.out], [0, 'MUMBO_WORK_DIR=\nMUMBO_WORKER_DIR=\nMUMBO_GH_CONFIG_DIR=\n'], out.err)
  } finally { r.done() }
})

test('containment rows are patched last, only on an image with the harness, and dsh starts with its own TMPDIR and agents root', () => {
  for (const person of [true, false]) {
    const s = script(c, person)
    assert.ok(s.includes('B24_IMAGE=\nif grep -qs serverIdentity /src/packages/subprocess/subprocess-local/src/index.ts; then B24_IMAGE=1; fi\n'))
    assert.match(s, / \$CONTAINMENT_PATCH \\\n  --no-open --host "\$ip" --port \$DSH_PORT /)
    assert.ok(s.indexOf('[ -z "$B24_IMAGE" ] || export TMPDIR=/root/.dsh/tmp\ncd /src\n') > s.indexOf('# Desktop:') || !person)
    assert.ok(s.indexOf('[ -z "$B24_IMAGE" ] || export TMPDIR=/root/.dsh/tmp') > s.lastIndexOf('su '), 'no user process inherits root\'s TMPDIR')
    assert.match(s, / DSH_AGENTS_HOME="\$AGENTS_HOME" /)
  }
})

test('the B24 layout: root\'s files kept from agent, every directory the rows name, the workspace agent\'s with its group, and both migrations once', () => {
  const r = root()
  try {
    const s = script(c, true)
    // A restored box: root's projects and uploads from before containment, root's dot directories, a link in /root.
    for (const d of ['root/projects/app/sub', 'root/.dsh/attachments/v1/ab', 'root/.cargo', 'root/.dsh/sessions']) mkdirSync(r.at(d), { recursive: true })
    writeFileSync(r.at('root/projects/app/a.txt'), 'a'); chmodSync(r.at('root/projects/app/a.txt'), 0o644)
    writeFileSync(r.at('root/.dsh/attachments/v1/ab/obj'), 'img')
    writeFileSync(r.at('root/dsh.log'), 'token=x'); chmodSync(r.at('root/dsh.log'), 0o644)
    chmodSync(r.at('root/.cargo'), 0o755)
    mkdirSync(r.at('outside')); chmodSync(r.at('outside'), 0o755); symlinkSync(r.at('outside'), r.at('root/link'))
    // A staged upload copy left over from before the start.
    const staged = () => { mkdirSync(r.at('var/lib/mumbo/uploads/n0nce'), { recursive: true }); writeFileSync(r.at('var/lib/mumbo/uploads/n0nce/report.pdf'), 'pdf') }
    staged()
    const run = () => r.run(`B24_IMAGE=1 B24_TEMPLATE=1\n${layoutOf(s)}`)
    let out = run()
    assert.equal(out.code, 0, out.err)
    // Browser consent's staging directory: root's, entered by the group uploads alone, and emptied.
    assert.ok(r.lines('install').includes('-d -o root -g uploads -m 2750 T/var/lib/mumbo/uploads'))
    assert.deepEqual([statSync(r.at('var/lib/mumbo/uploads')).mode & 0o7777, readdirSync(r.at('var/lib/mumbo/uploads'))], [0o2750, []])
    const mode = (p) => statSync(r.at(p)).mode & 0o7777
    assert.deepEqual(['root', 'root/.cargo', 'root/.dsh', 'root/.mumbo', 'root/dsh.log', 'root/.dsh/tmp', 'root/.dsh/skills', 'run/dsh-shell', 'var/lib/mumbo', 'usr/local/share/mumbo/agents/skills'].map(p => [p, mode(p).toString(8)]),
      [['root', '711'], ['root/.cargo', '700'], ['root/.dsh', '700'], ['root/.mumbo', '700'], ['root/dsh.log', '600'], ['root/.dsh/tmp', '700'], ['root/.dsh/skills', '700'], ['run/dsh-shell', '711'], ['var/lib/mumbo', '755'], ['usr/local/share/mumbo/agents/skills', '755']])
    assert.equal(mode('outside'), 0o755, 'a link in /root is not followed')
    for (const d of ['attachments', 'attachments/attachments', 'attachments/attachments/v1', 'spill', 'subprocess-spill']) assert.equal(mode(`var/lib/mumbo/${d}`), 0o2750, d)
    assert.ok(r.lines('install').includes('-d -o root -g agent -m 2750 T/var/lib/mumbo/attachments/attachments/v1'))
    assert.ok(r.lines('install').includes('-d -o agent -g workspace -m 2770 T/root/projects'))
    assert.equal(mode('root/projects'), 0o2770)
    assert.deepEqual(r.lines('setfacl'), ['--set u::rwx,g::rwx,m::rwx,o::--- T/root/projects'])
    // Uploads moved into the store, readable by the group only; dsh's old store is gone.
    assert.equal(readFileSync(r.at('var/lib/mumbo/attachments/attachments/v1/ab/obj'), 'utf8'), 'img')
    assert.deepEqual([mode('var/lib/mumbo/attachments/attachments/v1/ab'), mode('var/lib/mumbo/attachments/attachments/v1/ab/obj')], [0o2750, 0o440])
    assert.equal(existsSync(r.at('root/.dsh/attachments')), false)
    // The workspace: agent's, group-writable, its directories passing the group on.
    assert.deepEqual(r.lines('chown'), ['-R agent:workspace T/root/projects', '-R root:agent T/var/lib/mumbo/attachments/attachments'])
    assert.deepEqual([mode('root/projects/app'), mode('root/projects/app/sub'), mode('root/projects/app/a.txt')], [0o2775, 0o2775, 0o664])
    assert.ok(existsSync(r.at('root/.mumbo/workspace-owned')))
    // Again: no second chown of the workspace, no second move; an interrupted move (both stores) completes; the staging
    // directory is emptied at every start.
    staged()
    out = run()
    assert.equal(out.code, 0, out.err)
    assert.deepEqual(readdirSync(r.at('var/lib/mumbo/uploads')), [])
    assert.deepEqual(r.lines('chown'), ['-R agent:workspace T/root/projects', '-R root:agent T/var/lib/mumbo/attachments/attachments'])
    for (const d of ['ab', 'cd']) mkdirSync(r.at(`root/.dsh/attachments/v1/${d}`), { recursive: true })
    writeFileSync(r.at('root/.dsh/attachments/v1/ab/obj'), 'img'); writeFileSync(r.at('root/.dsh/attachments/v1/cd/two'), 'two')
    out = run()
    assert.equal(out.code, 0, out.err)
    assert.deepEqual(readdirSync(r.at('var/lib/mumbo/attachments/attachments/v1')).sort(), ['ab', 'cd'])
    assert.deepEqual([readFileSync(r.at('var/lib/mumbo/attachments/attachments/v1/ab/obj'), 'utf8'), readFileSync(r.at('var/lib/mumbo/attachments/attachments/v1/cd/two'), 'utf8'), existsSync(r.at('root/.dsh/attachments'))], ['img', 'two', false])
  } finally { r.done() }
  // The project box: /root/work beside the workspace, the superagent's worker directory and gh configuration, the proxy's log.
  const p = root()
  try {
    const out = p.run(`B24_IMAGE=1 B24_TEMPLATE=1\n${layoutOf(script({ ...c, mcpServerWorkspace: 'read' }, false))}`)
    assert.equal(out.code, 0, out.err)
    assert.deepEqual(p.lines('setfacl'), ['--set u::rwx,g::rwx,g:workspace-read:r-x,m::rwx,o::--- T/root/projects', '--set u::rwx,g::rwx,g:workspace-read:r-x,m::rwx,o::--- T/root/work'])
    assert.equal(statSync(p.at('var/lib/mumbo/superagent')).mode & 0o7777, 0o2750)
    assert.deepEqual([statSync(p.at('root/.config/gh')).mode & 0o777, statSync(p.at('root/github-proxy.log')).mode & 0o777], [0o700, 0o600])
    assert.equal(existsSync(p.at('var/lib/mumbo/uploads')), false, 'no browser, no upload staging')
  } finally { p.done() }
})

test('the B24 layout fails loud on a template without containment\'s users or marker, and does nothing on an image without the harness', () => {
  const s = script(c, true)
  for (const [gates, users] of [['B24_IMAGE=1 B24_TEMPLATE=', true], ['B24_IMAGE=1 B24_TEMPLATE=1', false]]) {
    const r = root({ users })
    try {
      const out = r.run(`${gates}\n${layoutOf(s)}`)
      assert.deepEqual([out.code, out.err], [1, 'mumbo-box: this image runs agent containment (B24), which needs a template built with it (RUNBOOK "Agent containment (B24)")\n'])
      assert.deepEqual([r.lines('install'), existsSync(r.at('root/.mumbo/containment.overlay.yml'))], [[], false])
    } finally { r.done() }
  }
  // A template built before a group the layout needs, here uploads, names it.
  const { uploads, ...older } = GROUPS
  let r = root({ groups: older })
  try {
    const out = r.run(`B24_IMAGE=1 B24_TEMPLATE=1\n${layoutOf(s)}`)
    assert.deepEqual([out.code, out.err], [1, 'mumbo-box: the template has no group uploads (RUNBOOK "Agent containment (B24)")\n'])
    assert.deepEqual([r.lines('install'), existsSync(r.at('root/.mumbo/containment.overlay.yml'))], [[], false])
  } finally { r.done() }
  r = root()
  try {
    const out = r.run(`B24_IMAGE= B24_TEMPLATE=1\n${layoutOf(s)}`, ['CONTAINMENT_PATCH'])
    assert.deepEqual([out.code, out.out, r.lines('install'), statSync(r.at('root')).mode & 0o777], [0, 'CONTAINMENT_PATCH=\n', [], 0o755])
  } finally { r.done() }
})

/** Runs the B24 kernel and network part of start script `s` in a fresh root whose sysctls, /proc mount and set-user-ID
 *  su and sudo it can fix, with `nft` logging its arguments; `fail` breaks one of them first. What it did, and the
 *  firewall file it wrote. */
function hardening(s, { fail = () => {}, users = true, gates = 'B24_TEMPLATE=1 DSH_PORT=880 LIVE_PORT=881' } = {}) {
  const r = root({ users })
  try {
    for (const k of ['net/ipv4/ip_unprivileged_port_start', 'fs/protected_hardlinks', 'fs/protected_symlinks']) writeFileSync(r.at(`proc/sys/${k}`), '0\n')
    writeFileSync(r.at('proc/mounts'), 'proc /proc proc rw,nosuid,nodev,noexec,relatime,hidepid=invisible 0 0\n')
    for (const b of ['su', 'sudo']) { writeFileSync(r.at(`bin/${b}`), ''); chmodSync(r.at(`bin/${b}`), 0o4755) }
    r.fake('nft', `echo "$*" >> ${r.t}/log/nft`)
    fail(r)
    const out = r.run(`${gates}\n${hardeningOf(s)}`)
    const file = r.at('root/.mumbo/firewall.nft')
    return {
      ...out, mount: r.lines('mount'), nft: r.lines('nft'),
      sysctls: ['net/ipv4/ip_unprivileged_port_start', 'fs/protected_hardlinks', 'fs/protected_symlinks'].map(k => readFileSync(r.at(`proc/sys/${k}`), 'utf8')),
      setuid: ['su', 'sudo'].map(b => statSync(r.at(`bin/${b}`)).mode & 0o7777),
      firewall: existsSync(file) ? readFileSync(file, 'utf8') : undefined, firewallMode: existsSync(file) ? statSync(file).mode & 0o777 : undefined,
    }
  } finally { r.done() }
}
/** Fails unless run `h` loaded exactly FIREWALL(cdp) from a root-only file and checked that it is loaded. */
const assertFirewall = (h, cdp) => {
  assert.equal(h.code, 0, h.err)
  assert.equal(h.firewall, FIREWALL(cdp))
  assert.deepEqual([h.firewallMode, h.nft], [0o600, ['-f T/root/.mumbo/firewall.nft', 'list table inet mumbo']])
}

test('the B24 template\'s kernel and network part: port floor, link protections and hidepid set and checked, no set-user-ID su or sudo, the nftables firewall, each fatal', () => {
  const s = script(c, true)
  const h = hardening(s)
  assert.deepEqual([h.sysctls, h.mount, h.setuid], [['1024\n', '1\n', '1\n'], ['-o remount,hidepid=2 /proc'], [0o755, 0o755]])
  // One inet table (IPv4 and IPv6), replaced whole: every process, root's dsh included, is refused E2B's envd, which runs
  // commands as root; every user but root dsh, the live view, the door and VNC; every user but root and browsermcp
  // (1002) the debugging port. The allowed users are accepted first and the rest reset, so a socket whose user nft cannot
  // read is refused. The debugging, VNC and WebRTC ports stay box-local.
  assertFirewall(h, '{ 0, 1002 }')
  // A project box has no browsermcp: only root reaches the debugging port.
  assertFirewall(hardening(script(c, false), { users: false }), '0')
  // Mutations: each port the rules name, taken out of the script, fails the check.
  for (const [from, to] of [[`dport ${ENVD_PORT} `, 'dport '], ['{ $DSH_PORT, ', '{ '], [' $LIVE_PORT, ', ' '], [`, ${MUMBO_MCP_PORT}, `, ', '], [', 5900-5999 } meta', ' } meta'], ['dport 9222 meta', 'dport meta'], [', 9222 } reject', ' } reject'], ['{ 9222, 5900-5999 } drop', '{ 9222 } drop'], ['udp dport $LIVE_PORT', 'udp dport 0']]) {
    const mutant = s.replace(from, to)
    assert.notEqual(mutant, s, from)
    assert.throws(() => assertFirewall(hardening(mutant), '{ 0, 1002 }'), assert.AssertionError, from)
  }
  // Fatal: a sysctl that does not take, /proc without hidepid, a su that keeps its bit, a table nft does not load or
  // does not list, and no nft at all.
  const failures = [
    [(r) => { rmSync(r.at('proc/sys/fs/protected_symlinks')); symlinkSync('/dev/null', r.at('proc/sys/fs/protected_symlinks')) }, `mumbo-box: T/proc/sys/fs/protected_symlinks is not 1\n`],
    [(r) => writeFileSync(r.at('proc/mounts'), 'proc /proc proc rw 0 0\n'), 'mumbo-box: /proc is not mounted with hidepid=2\n'],
    [(r) => r.fake('chmod', 'exit 0'), `mumbo-box: T/bin/su is still set-user-ID\n`],
    [(r) => r.fake('nft', '[ "$1" != -f ]'), 'mumbo-box: nft could not load the firewall table inet mumbo from T/root/.mumbo/firewall.nft\n'],
    [(r) => r.fake('nft', '[ "$1" != list ]'), 'mumbo-box: the firewall table inet mumbo is not loaded\n'],
    [(r) => rmSync(r.at('bin/nft')), /^.*nft.*not found\nmumbo-box: nft could not load the firewall table inet mumbo from T\/root\/\.mumbo\/firewall\.nft\n$/],
  ]
  for (const [fail, err] of failures) {
    const out = hardening(s, { fail })
    assert.equal(out.code, 1, out.err)
    if (typeof err === 'string') assert.equal(out.err, err); else assert.match(out.err, err)
  }
  // Before the marker none of it runs.
  const before = hardening(s, { gates: 'B24_TEMPLATE= DSH_PORT=3080 LIVE_PORT=6080' })
  assert.deepEqual([before.code, before.mount, before.nft, before.firewall, before.setuid], [0, [], [], undefined, [0o4755, 0o4755]])
})

test('the start scripts parse under sh, name no iptables owner match, and their firewall parses under nft -c when this host can run it', (t) => {
  for (const s of [script(c, true), script(c, false)]) {
    execFileSync('sh', ['-n'], { input: s })
    execFileSync('sh', ['-n'], { input: hardeningOf(s) })
    assert.ok(!s.includes('-m owner') && !s.includes('uid-owner'))
  }
  const dir = mkdtempSync(join(tmpdir(), 'firewall-'))
  try {
    writeFileSync(join(dir, 'firewall.nft'), FIREWALL('{ 0, 1002 }'))
    const check = spawnSync('nft', ['-c', '-f', join(dir, 'firewall.nft')], { encoding: 'utf8' })
    if (check.error?.code === 'ENOENT') return t.skip('nft is not installed on this host')
    if (/Operation not permitted/.test(check.stderr)) return t.skip('nft -c needs CAP_NET_ADMIN, which this test\'s user lacks')
    assert.equal(check.status, 0, check.stderr)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('escape-test.sh parses under sh and runs every escape test the B24 brief names', () => {
  const file = new URL('./escape-test.sh', import.meta.url)
  execFileSync('sh', ['-n', file.pathname])
  const text = readFileSync(file, 'utf8')
  const ids = new Set([...text.matchAll(/\b(?:refused|allowed|unwritable|denied|manual|refusal|say (?:PASS|FAIL|SKIP))\s+"?([a-z0-9-]+)/g)].map(m => m[1]))
  // Ids built in loops, as the script spells them.
  for (const loop of ['agent-bind-$1', 'agent-bind-$p', 'agent-connect-$1', 'envd-$u', 'xkasmvnc-$u', 'sudo-$u', 'su-$u']) assert.ok(text.includes(`"${loop}"`), loop)
  const required = [
    // agent: root's files, the browser's profile, other users' processes
    'start-sh-mode', 'agent-read-start-sh', 'agent-read-dsh-home', 'agent-read-dsh-log', 'agent-read-root-entries', 'agent-read-browser-home', 'agent-read-login-data', 'agent-read-cookies',
    'agent-proc-environ', 'agent-proc-cmdline', 'agent-proc-browser', 'mcpserver-proc-environ',
    // agent: what root runs or reads for it, and install paths
    'agent-write-src', 'agent-write-plugin-paths', 'agent-write-mcp-home', 'agent-write-gh-wrapper', 'agent-write-superagent', 'agent-write-attachments', 'agent-write-spill', 'agent-write-agents-home',
    // the display, computer use, uploads
    'agent-x-cookie', 'agent-x-display', 'xsession-login-data', 'computer-use-terminal', 'upload-outside-downloads',
    // consent's staged upload copies, and uploads through the real consent (the uploads contract of 2026-11-11)
    'agent-list-uploads', 'agent-read-uploads', 'upload-swap', 'upload-swap-ask', 'upload-nested', 'upload-nested-refused', 'upload-fifo', 'upload-fifo-refused',
    'upload-over-cap', 'upload-over-cap-refused', 'upload-staging-empty',
    // the workspace and the person's MCP servers
    'mcpserver-workspace', 'mcpserver-node-modules', 'browsermcp-connect-cdp',
    // tunnels through the project box's GitHub proxy
    'proxy-tunnel',
    // restore, root setup, the model's file tools, a ticket's git hook
    'restore-symlink', 'browser-symlink-setup', 'file-tools-login-data', 'file-tools-dsh-environ', 'file-tools-dsh-log', 'file-tools-swap-read', 'file-tools-swap-write', 'git-hook-ticket',
    // web_fetch of the debugging port and of dsh (the web_fetch contract of 2026-11-11)
    'web-fetch-cdp', 'web-fetch-dsh',
  ]
  assert.deepEqual(required.filter(id => !ids.has(id)), [])
  // Binds: dsh, the live view and the door refused (EACCES); 3000 and 5173 allowed. Connects: CDP, VNC, dsh, the live view
  // and the door on loopback and the box address; envd for root and every unprivileged user, E2B's own included.
  assert.ok(text.includes('for b in "dsh $DSH_PORT $ip" "live $LIVE_PORT $ip" "door $DOOR_PORT 127.0.0.1"; do') && text.includes('for p in 3000 5173; do'))
  assert.ok(text.includes('for h in 127.0.0.1 "$ip"; do') && text.includes('for t in "cdp 9222" "vnc 5900" "vnc 5901" "dsh $DSH_PORT" "live $LIVE_PORT" "door $DOOR_PORT"; do'))
  assert.ok(text.includes('USERS="agent mcpserver"; [ -z "$person" ] || USERS="$USERS browsermcp desktop xsession browser"\nuser user && USERS="$USERS user"'))
  assert.ok(text.includes(`DOOR_PORT=${MUMBO_MCP_PORT} ENVD_PORT=${ENVD_PORT}`) && text.includes('for u in root $USERS; do denied "envd-$u"'))
})

/** escape-test.sh's uploads through consent (--with-uploads), with Downloads, the staging directory and the page's port
 *  moved and its 3 s read delay cut to 0.3 s. The test plays consent, which stages a copy of each upload it allows, and
 *  Chrome, which runs the served page's script on a file-backed File of that copy; agent is the test's user. Returns each
 *  upload check's status and the FAIL lines. */
async function escapeUploads({ deleteAfterCall, blockOnFifo }) {
  const text = readFileSync(new URL('./escape-test.sh', import.meta.url), 'utf8')
  const t = mkdtempSync(join(tmpdir(), 'escape-uploads-'))
  const D = join(t, 'Downloads'), S = join(t, 'uploads')
  let sh, reader
  try {
    for (const d of [D, S, join(t, 'bin')]) mkdirSync(d)
    writeFileSync(join(t, 'consent.ts'), 'uploadStaging')
    writeFileSync(join(t, 'bin/su'), '#!/bin/sh\nexec /bin/sh -c "$5"\n')
    chmodSync(join(t, 'bin/su'), 0o755)
    const port = await new Promise(r => { const v = createServer().listen(0, '127.0.0.1', () => { const { port } = v.address(); v.close(() => r(port)) }) })
    const helpers = text.split('\n').filter(l => /^(say|as|manual)\(\) /.test(l)).join('\n')
    const block = text.slice(text.indexOf('D=/home/shared/Downloads\n'), text.indexOf('# Restore:')).replaceAll('/home/shared/Downloads', D)
      .replaceAll('/src/packages/mumbo/browser-consent/src/index.ts', join(t, 'consent.ts')).replaceAll('8790', String(port)).replace('}, 3000)', '}, 300)')
    sh = spawn('/bin/sh', ['-c', `set -u\nfails=0 person=1 uploads=1 S=${S}\n${helpers}\n${block}`], { env: { ...process.env, PATH: `${join(t, 'bin')}:${process.env.PATH}` } })
    let out = ''
    sh.stdout.on('data', (c) => { out += c })
    const exited = new Promise(r => sh.on('close', r))
    const until = async (f) => { while (!f()) await sleep(50) }
    await until(() => existsSync(join(D, 'mumbo-escape-done.txt')))
    const input = {}
    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text()
    runInNewContext(html.match(/<script>([^]*)<\/script>/)[1], { document: { querySelector: (q) => q === 'input' ? input : { textContent: '' } }, crypto, setTimeout, fetch: (u, o) => fetch(`http://127.0.0.1:${port}${u}`, o) })
    const upload = async (name, n, swapped = () => true) => {
      mkdirSync(join(S, n))
      copyFileSync(join(D, name), join(S, n, name))
      await until(swapped)
      input.files = [new File([await openAsBlob(join(S, n, name))], name)]
      input.onchange()
      if (deleteAfterCall) rmSync(join(S, n), { recursive: true })
    }
    await upload('mumbo-escape-swap.txt', 'n1', () => readFileSync(join(D, 'mumbo-escape-swap.txt'), 'utf8') === 'swapped')
    if (blockOnFifo) reader = spawn('cat', [join(D, 'mumbo-escape-fifo')], { stdio: 'ignore' })
    await upload('mumbo-escape-done.txt', 'n2')
    // The turn ends once the script has its verdicts on the calls.
    await until(() => out.includes(' upload-swap '))
    rmSync(join(S, 'n1'), { recursive: true, force: true })
    rmSync(join(S, 'n2'), { recursive: true, force: true })
    await exited
    if (reader) await new Promise(r => reader.exitCode === null ? reader.on('close', r) : r())
    const lines = out.trim().split('\n').map(l => l.split(' '))
    return { status: Object.fromEntries(lines.map(([s, id]) => [id, s])), fails: lines.filter(([s]) => s === 'FAIL').map(l => l.slice(1).join(' ')) }
  } finally {
    sh?.kill()
    reader?.kill()
    rmSync(t, { recursive: true, force: true })
  }
}

const UPLOAD_CHECKS = { 'upload-swap': 'PASS', 'upload-swap-ask': 'MANUAL', 'upload-nested': 'PASS', 'upload-nested-refused': 'MANUAL', 'upload-fifo': 'PASS',
  'upload-fifo-refused': 'MANUAL', 'upload-over-cap': 'PASS', 'upload-over-cap-refused': 'MANUAL', 'upload-staging-empty': 'PASS' }

test('escape-test.sh --with-uploads passes a consent that keeps its copies until the turn ends, after the page has read them', async () => {
  assert.deepEqual(await escapeUploads({ deleteAfterCall: false, blockOnFifo: false }), { status: UPLOAD_CHECKS, fails: [] })
})

test('escape-test.sh --with-uploads fails a consent that deletes its copy before the page reads it, or that is blocked opening the FIFO', async () => {
  assert.deepEqual(await escapeUploads({ deleteAfterCall: true, blockOnFifo: true }), {
    status: { ...UPLOAD_CHECKS, 'upload-swap': 'FAIL', 'upload-fifo': 'FAIL' },
    fails: [
      'upload-swap the page could not read the file 3 s after the call: consent removed its staged copy before the page read it',
      'upload-fifo a FIFO in Downloads: consent is blocked opening it',
    ],
  })
})

test('template: containment\'s users and groups, homes 0700 with the run-as TMPDIRs, the ACL check, no empty password, the ports marker', () => {
  for (const person of [true, false]) {
    const r = root()
    try {
      for (const name of ['useradd', 'groupadd', 'usermod', 'passwd']) r.fake(name, `echo "${name} $*" >> ${r.t}/log/steps`)
      r.fake('id', 'exit 1')
      r.fake('setfacl', `echo "setfacl $*" >> ${r.t}/log/steps`)
      r.fake('getfacl', 'echo group:workspace-read:r-x')
      r.fake('install', `echo "install $*" >> ${r.t}/log/steps`)
      r.fake('chmod', `case "$2" in /home/*) echo "chmod $*" >> ${r.t}/log/steps;; *) exec ${which('chmod')} "$@";; esac`)
      for (const tool of ['awk', 'xargs', 'mktemp', 'printf']) if (!existsSync(r.at(`bin/${tool}`))) symlinkSync(which(tool), r.at(`bin/${tool}`))
      writeFileSync(r.at('shadow'), 'root:*:1::::::\nuser::1::::::\nagent:!:1::::::\n')
      const steps = usersSteps(person).join('\n').replaceAll('/etc/shadow', r.at('shadow')).replaceAll('/var/tmp/', `${r.t}/`).replaceAll('/usr/local/share/mumbo', r.at('usr/local/share/mumbo'))
      const out = spawnSync('/bin/sh', ['-c', `set -eu\n${steps}`], { encoding: 'utf8', env: { PATH: r.at('bin') } })
      assert.equal(out.status, 0, out.stderr)
      const users = person ? ['agent', 'mcpserver', 'browsermcp', 'desktop', 'xsession'] : ['agent', 'mcpserver']
      assert.deepEqual(r.lines('steps'), [
        ...users.map(u => `useradd -m -s ${['agent', 'xsession'].includes(u) ? '/bin/bash' : '/usr/sbin/nologin'} ${u}`),
        'groupadd -f workspace', 'groupadd -f workspace-read', 'usermod -aG workspace agent',
        ...(person ? ['usermod -aG shared agent', 'usermod -aG shared xsession', 'usermod -aG workspace xsession', 'usermod -aG desktop browser', 'usermod -aG desktop xvnc', 'usermod -aG desktop xsession',
          // Browser consent's staged upload copies: browser and browsermcp, not agent, xsession, desktop or mcpserver.
          'groupadd -f -r uploads', 'usermod -aG uploads browser', 'usermod -aG uploads browsermcp'] : []),
        ...users.map(u => `chmod 0700 /home/${u}`),
        ...['agent', ...(person ? ['browsermcp', 'desktop'] : [])].map(u => `install -d -o ${u} -g ${u} -m 0700 /home/${u}/tmp`),
        r.lines('steps').find(l => l.startsWith('setfacl')),
        // Only the account with an empty password is locked.
        'passwd -l user',
        'install -d -m 0755 T/usr/local/share/mumbo',
      ])
      assert.match(r.lines('steps').find(l => l.startsWith('setfacl')), /^setfacl --set u::rwx,g::rwx,g:workspace-read:r-x,m::rwx,o::--- T\/acl\.\w{6}$/)
      assert.equal(readFileSync(r.at('usr/local/share/mumbo/ports'), 'utf8'), '880 881\n')
    } finally { r.done() }
  }
  // KasmVNC, which runs as xvnc, may bind the live view's port below 1024, and only root and xvnc may run it: after it
  // and xvnc exist, its group and mode, then the capability, which chgrp would drop, each checked.
  const xvnc = BOX_STEPS.findIndex(s => s.endsWith(' xvnc') && s.includes('useradd'))
  assert.ok(BOX_STEPS.indexOf(kasmvncStep()) < xvnc && BOX_STEPS[xvnc + 1] === KASMVNC_BIND_STEP)
  const r = root()
  try {
    writeFileSync(r.at('Xkasmvnc'), ''); chmodSync(r.at('Xkasmvnc'), 0o755)
    r.fake('Xkasmvnc', ''); r.fake('readlink', `echo ${r.at('Xkasmvnc')}`)
    for (const name of ['chgrp', 'chmod', 'setcap']) r.fake(name, `echo "${name} $*" >> ${r.t}/log/bind`)
    r.fake('getcap', 'echo "$1 cap_net_bind_service=ep"')
    for (const [mode, code] of [['750:root:xvnc', 0], ['755:root:xvnc', 1]]) {
      r.fake('stat', `echo ${mode}`)
      const out = spawnSync('/bin/sh', ['-c', `set -eu\n${KASMVNC_BIND_STEP}`], { encoding: 'utf8', env: { PATH: r.at('bin') } })
      assert.equal(out.status, code, mode)
    }
    assert.deepEqual(r.lines('bind').slice(0, 3), ['chgrp xvnc T/Xkasmvnc', 'chmod 0750 T/Xkasmvnc', 'setcap cap_net_bind_service=+ep T/Xkasmvnc'])
  } finally { r.done() }
  // The project box's GitHub proxy becomes its own system user (edge startScript).
  assert.ok(PROJECT_STEPS.includes('id ghproxy >/dev/null 2>&1 || useradd -r -U -M -d /nonexistent -s /usr/sbin/nologin ghproxy'))
  // nftables, setfacl and setcap are installed, not assumed from the base image; iptables, which nothing on a template
  // with the marker runs, is not.
  const pkgs = (steps) => steps.find(s => s.includes('apt-get install')).match(/--no-install-recommends ([^&]+?) &&/g).join(' ')
  for (const p of ['nftables', 'acl', 'libcap2-bin']) assert.match(pkgs(BOX_STEPS), new RegExp(`\\b${p}\\b`), p)
  for (const p of ['nftables', 'acl']) assert.match(pkgs(PROJECT_STEPS), new RegExp(`\\b${p}\\b`), p)
  assert.ok(![...BOX_STEPS, ...PROJECT_STEPS].some(s => /\biptables\b/.test(s)))
  // The users, then the nftables smoke check, which runs as agent, last.
  assert.deepEqual([BOX_STEPS.slice(-usersSteps(true).length - 1), PROJECT_STEPS.slice(-usersSteps(false).length - 1)], [[...usersSteps(true), NFT_SMOKE_STEP], [...usersSteps(false), NFT_SMOKE_STEP]])
})

test('template: the nftables smoke check passes only when root connects and agent is refused, always removes its table and listener, and runs only after the steps before it succeed', () => {
  /** Runs `before && NFT_SMOKE_STEP`, as e2b's runCmd joins the steps, with fake nft, su and node: a connection exits
   *  with `root` or, under su (as agent), `agent`, and the listener writes its pid and sleeps. `listener`: still alive. */
  const run = ({ root: rootRc = 0, agent = 3, nft = '', before = 'true' } = {}) => {
    const r = root()
    try {
      r.fake('nft', `echo "nft $*" >> ${r.t}/log/steps; ${nft}`)
      r.fake('su', `echo "su $*" >> ${r.t}/log/steps; AS=agent /bin/sh -c "$5"`)
      r.fake('node', `case "$2" in *createServer*) echo "listen $2" >> ${r.t}/log/steps; echo $$ > ${r.t}/listener; exec ${which('sleep')} 30;; esac; [ -n "\${AS:-}" ] && exit ${agent}; exit ${rootRc}`)
      r.fake('sleep', '')
      const out = spawnSync('/bin/sh', ['-c', `${before} && ${NFT_SMOKE_STEP}`], { encoding: 'utf8', env: { PATH: r.at('bin') }, timeout: 20000 })
      const pid = existsSync(r.at('listener')) ? Number(readFileSync(r.at('listener'), 'utf8')) : undefined
      let listener = pid !== undefined
      try { if (listener) process.kill(pid, 'SIGKILL') } catch { listener = false /* ESRCH: the step stopped it */ }
      return { code: out.status, err: out.stderr, steps: r.lines('steps'), listener }
    } finally { r.done() }
  }
  const ok = run()
  assert.equal(ok.code, 0, ok.err)
  assert.deepEqual(ok.steps, [
    'nft table inet mumbo_probe { chain output { type filter hook output priority 0; policy accept; tcp dport 47999 meta skuid 0 accept; tcp dport 47999 reject with tcp reset; }; }',
    'listen require("net").createServer(s=>s.end()).listen(47999,"127.0.0.1")',
    'su -s /bin/sh agent -c "$N" -e "$C"',
    'nft delete table inet mumbo_probe',
  ])
  assert.equal(ok.listener, false)
  const failed = 'mumbo-box: the nftables smoke check failed'
  // Agent connects, or fails some other way than a refusal; root cannot connect.
  for (const [opts, err] of [[{ agent: 0 }, `${failed}: root's connection ended with 0 and agent's with 0, not 0 and 3 (refused)\n`], [{ agent: 1 }, `${failed}: root's connection ended with 0 and agent's with 1, not 0 and 3 (refused)\n`], [{ root: 3 }, `${failed}: root's connection ended with 3 and agent's with 3, not 0 and 3 (refused)\n`], [{ root: 2 }, `${failed}: root's connection ended with 2 and agent's with 3, not 0 and 3 (refused)\n`]]) {
    const out = run(opts)
    assert.deepEqual([out.code, out.err, out.steps.at(-1), out.listener], [1, err, 'nft delete table inet mumbo_probe', false])
  }
  // nft cannot load the table, or cannot delete it.
  const load = run({ nft: '[ "$1" = delete ]' }), del = run({ nft: '[ "$1" != delete ]' })
  assert.deepEqual([load.code, load.err, load.listener], [1, 'mumbo-box: nft cannot load the probe table inet mumbo_probe\n', false])
  assert.deepEqual([del.code, del.err, del.listener], [1, 'mumbo-box: nft could not delete the probe table inet mumbo_probe\n', false])
  // After a failed step it does not run, and the failure is the build's.
  const after = run({ before: 'false' })
  assert.deepEqual([after.code, after.steps], [1, []])
})
