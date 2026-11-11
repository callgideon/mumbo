// node --test deploy/boxes/edge/containment.test.mjs
// Agent containment (B24) in the start script: the rows it writes against the harness's fixtures, and its kernel,
// network and layout parts run by sh in a temporary root with fake id, getent, usermod, chown, setfacl, mount, nft,
// systemctl and ss, and only those and the real tools they need on PATH. The template's containment steps, its masking of
// the unused units and its nftables smoke check. The
// escape-test script's check list.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openAsBlob, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { runInNewContext } from 'node:vm'
import { startScript, boxSite, containmentRows, containmentLayout, signBox, memberKey, mumboMcpKey, roleInstructions, systemRepair, REPAIR_USERS, UNUSED_UNITS, ENVD_PORT, MUMBO_MCP_PORT, PORTS_MARKER } from './edge.mjs'
import { BOX_STEPS, PROJECT_STEPS, KASMVNC_BIND_STEP, MASK_UNITS_STEP, NFT_SMOKE_STEP, DSH_SMOKE_SECONDS, DSH_SMOKE_SETTLE_SECONDS, INACTIVE_ALLOWLIST, LISTENER_ALLOWLIST, UMASK_STEP, WRITABLE_EXCLUDES, agentInstallScript, dshSmokeStep, kasmvncStep, smokeStartScript, usersSteps } from './template.mjs'

// The files these tests make get a box's modes (0644, 0755), not this host's umask's: the checks of system files read them.
process.umask(0o022)

const c = { llmHost: 'llm.example', publicHost: 'app.example', projectDomain: 'app.example' }
const script = (cfg, person) => startScript(cfg, 'T', boxSite(cfg, person ? 'a@x.com' : 'project:0123456789abcdef'), 'role', person ? undefined : 'K', { proxy: 'P', gh: 'G' })
/** The fixtures' ids (apps/cli/tests/fixtures/box-edge/containment-*.overlay.yml): agent 1001, browsermcp 1002,
 *  desktop 1003, shared 1005, mcpserver 1006, uploads 1009 (browsermcp's one group); the workspace groups, which the fixtures
 *  do not name, 1007 and 1008. */
const IDS = { agent: [1001, 1001], browsermcp: [1002, 1002], desktop: [1003, 1003], mcpserver: [1006, 1006] }
const GROUPS = { shared: 1005, workspace: 1007, 'workspace-read': 1008, uploads: 1009 }
const SECRETS = 'secretNames: [DEEPSEEK_API_KEY, MUMBO_MEMBER_KEY, E2B_API_KEY, GH_TOKEN, GITHUB_TOKEN]'
const PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
/** The fixtures' rows without their comments, at the harness branch m1/b24-containment's dfcac61905, with agent also
 *  in workspace. No dsh-superagent row: the image's project overlay reads the directories from the variables the layout
 *  exports (the uploads and A2 contract of 2026-11-11, which the harness's fixtures take on). Both end with the web_fetch
 *  rows of that contract: the anonymous fetcher off, web_fetch through the edge's model host. agent's npm prefix and its
 *  own program directories on PATH, after a project box's command shims and gh wrapper, are the B24 fix's prefix
 *  rulings of 2026-11-11, which the harness's fixtures (m1/b24-fix-loader) take on. */
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
        NPM_CONFIG_PREFIX: /home/agent/.npm-global
${person ? `        PATH: /home/agent/.npm-global/bin:/home/agent/.local/bin:${PATH}
` : `        PATH: /var/lib/mumbo/superagent/worker-bin:/usr/local/lib/mumbo/bin:/home/agent/.npm-global/bin:/home/agent/.local/bin:${PATH}
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

const REAL = ['cat', 'grep', 'cut', 'chmod', 'find', 'cp', 'rm', 'mkdir', 'readlink', 'dirname', 'sort', 'stat', 'head', 'awk']
const which = (tool) => execFileSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim()
const ME = { uid: process.getuid(), owner: `${execFileSync('id', ['-un'], { encoding: 'utf8' }).trim()}:${execFileSync('id', ['-gn'], { encoding: 'utf8' }).trim()}` }
/** A `find` for bin directory `bin` that runs the real one with `-uid 0` as `uid` (this test's user: its files read as
 *  root's), `-uid 4000001` (agent in the dsh smoke check's fake id) as `agent`, and `-gid 0` as a group no file here
 *  has, so g+w reads as writable by a group other than root. */
const fakeFind = (bin, uid = ME.uid, agent = 4000001) => {
  rmSync(join(bin, 'find'), { force: true })
  writeFileSync(join(bin, 'find'), `#!/bin/sh\nfor a; do shift; case $p in -uid) case $a in 0) a=${uid};; 4000001) a=${agent};; esac;; -gid) [ "$a" != 0 ] || a=4000099;; esac; set -- "$@" "$a"; p=$a; done\nexec ${which('find')} "$@"\n`)
  chmodSync(join(bin, 'find'), 0o755)
}

/** A temporary root for the start script's B24 parts: box paths moved under it, fakes on PATH that log to log/<name>,
 *  and an image project overlay that reads MUMBO_WORK_DIR. Its systemctl keeps the units' states in units/ (setUnits),
 *  and its ss lists the lines of the file ss and of each running unit. */
function root({ users = true, groups = GROUPS } = {}) {
  const t = mkdtempSync(join(tmpdir(), 'containment-'))
  // What the start script's head makes before these parts: /root/projects, /root/.dsh and /root/.mumbo.
  for (const d of ['bin', 'log', 'units', 'root/projects', 'root/.dsh', 'root/.mumbo', 'proc/sys/net/ipv4', 'proc/sys/fs', 'usr/local/share/mumbo', 'var/lib', 'run', 'src/deploy']) mkdirSync(join(t, d), { recursive: true })
  writeFileSync(join(t, 'src/deploy/mumbo-project.overlay.yml'), '    workDirectory: !!js process.env.MUMBO_WORK_DIR\n')
  chmodSync(join(t, 'root'), 0o755)
  for (const tool of REAL) symlinkSync(which(tool), join(t, 'bin', tool))
  const fake = (name, body) => { rmSync(join(t, 'bin', name), { force: true }); writeFileSync(join(t, 'bin', name), `#!/bin/sh\n${body}\n`); chmodSync(join(t, 'bin', name), 0o755) }
  const log = (name) => `echo "$*" >> ${t}/log/${name}`
  const ids = Object.entries(IDS).map(([u, [uid, gid]]) => `${u}) [ "$o" = -u ] && echo ${uid} || echo ${gid};;`).join(' ')
  fake('id', users ? `o=$1; [ $# = 1 ] && o=; u=\${2:-$1}; case $u in ${ids} *) exit 1;; esac` : 'exit 1')
  // Without a key, getent lists $t/etc/passwd or $t/etc/group (the system repair's login groups).
  fake('getent', `[ $# != 1 ] || exec cat ${t}/etc/$1; case $2 in ${Object.entries(groups).map(([g, gid]) => `${g}) echo ${g}:x:${gid}:;;`).join(' ')} *) exit 2;; esac`)
  for (const name of ['usermod', 'chown', 'setfacl', 'mount']) fake(name, log(name))
  fake('systemctl', `${log('systemctl')}; d=${t}/units
case $1 in
  is-active) [ "$2" = --quiet ] && [ -e "$d/$3.active" ];;
  is-enabled) [ -e "$d/$2" ] || exit 1; cat "$d/$2"; [ "$(cat "$d/$2")" = enabled ];;
  disable) [ "$2" = --now ] && [ -e "$d/$3" ] || exit 1; rm -f "$d/$3.active"; echo disabled > "$d/$3";;
  mask) shift; now=; [ "$1" != --now ] || { now=1; shift; }; for u; do echo masked > "$d/$u" || exit 1; [ -z "$now" ] || rm -f "$d/$u.active"; done;;
  *) exit 99;;
esac`)
  fake('ss', `[ "$*" = -ltnpH ] || exit 99; [ ! -e ${t}/ss ] || cat ${t}/ss; for f in ${t}/units/*.active; do [ ! -e "$f" ] || cat "$f"; done`)
  // install: logs, then runs the real one without the owner and group, which the test's user cannot give.
  fake('install', `${log('install')}; a=; while [ $# -gt 0 ]; do case $1 in -o|-g) shift 2;; *) a="$a $1"; shift;; esac; done; exec ${which('install')} $a`)
  return {
    t,
    at: (p) => join(t, p),
    fake,
    lines: (name) => existsSync(join(t, 'log', name)) ? readFileSync(join(t, 'log', name), 'utf8').trim().split('\n').map(l => l.replaceAll(t, 'T')) : [],
    /** Runs `pre`, then `text` with box paths moved under t; returns status, stderr and the variables named. */
    run: (text, show = [], pre = '') => {
      const local = text.replaceAll('/root', `${t}/root`).replaceAll('/var/lib/mumbo', `${t}/var/lib/mumbo`).replaceAll('/usr/local/share/mumbo', `${t}/usr/local/share/mumbo`)
        .replaceAll('/run/dsh-shell', `${t}/run/dsh-shell`).replaceAll('/proc/', `${t}/proc/`).replaceAll('/src/deploy', `${t}/src/deploy`)
      const r = spawnSync('/bin/sh', ['-c', `set -eu\n${pre}${local}\n${show.map(v => `printf '%s=%s\\n' ${v} "\${${v}-}"`).join('\n')}`], { encoding: 'utf8', env: { PATH: join(t, 'bin') } })
      return { code: r.status, err: r.stderr.replaceAll(t, 'T'), out: r.stdout.replaceAll(t, 'T') }
    },
    done: () => rmSync(t, { recursive: true, force: true }),
  }
}
/** Sets root `r`'s units: `states` maps a unit to enabled, disabled or masked (no entry: the image lacks it), and
 *  `listeners` a running unit to the lines ss prints for it. */
const setUnits = (r, states, listeners = {}) => {
  for (const [u, state] of Object.entries(states)) writeFileSync(r.at(`units/${u}`), `${state}\n`)
  for (const [u, lines] of Object.entries(listeners)) writeFileSync(r.at(`units/${u}.active`), lines.map(l => `${l}\n`).join(''))
}
/** Root `r`'s units: each one's state, and the running ones. */
const unitsOf = (r) => {
  const files = readdirSync(r.at('units')).sort()
  return { states: Object.fromEntries(files.filter(f => !f.endsWith('.active')).map(f => [f, readFileSync(r.at(`units/${f}`), 'utf8').trim()])), running: files.filter(f => f.endsWith('.active')).map(f => f.slice(0, -'.active'.length)) }
}
/** A template from before the units' masking, as E2B's base and the web image leave it: ssh's socket and service,
 *  rpcbind's and nginx enabled; ssh's socket (systemd holds it), rpcbind's (on IPv4 and IPv6) and nginx listening, and
 *  rpcbind's service running. */
const OLD_UNITS = { 'ssh.socket': 'enabled', 'ssh.service': 'enabled', 'rpcbind.socket': 'enabled', 'rpcbind.service': 'enabled', 'nginx.service': 'enabled' }
const OLD_LISTENERS = {
  'ssh.socket': ['LISTEN 0 4096 *:22 *:* users:(("systemd",pid=1,fd=50))'],
  'rpcbind.socket': ['LISTEN 0 4096 0.0.0.0:111 0.0.0.0:* users:(("rpcbind",pid=300,fd=4),("systemd",pid=1,fd=51))', 'LISTEN 0 4096 [::]:111 [::]:* users:(("rpcbind",pid=300,fd=6),("systemd",pid=1,fd=53))'],
  'rpcbind.service': [],
  'nginx.service': ['LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=400,fd=6))', 'LISTEN 0 511 [::]:80 [::]:* users:(("nginx",pid=400,fd=7))'],
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
    iifname != "lo" tcp flags & (fin|syn|rst|ack) == syn tcp dport != { ${ENVD_PORT}, 880, 881, ${MUMBO_MCP_PORT} } drop
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
 *  su and sudo it can fix, with `nft` logging its arguments and no units or listeners; `fail` breaks one of them first,
 *  or sets units and listeners. What it did, and the firewall file it wrote. */
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
      ...out, mount: r.lines('mount'), nft: r.lines('nft'), systemctl: r.lines('systemctl'), units: unitsOf(r),
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
  // read is refused. From beyond loopback new TCP connections reach only envd, dsh, the live view and the door, and the
  // WebRTC port stays box-local.
  assertFirewall(h, '{ 0, 1002 }')
  // A project box has no browsermcp: only root reaches the debugging port.
  assertFirewall(hardening(script(c, false), { users: false }), '0')
  // Mutations: each port the rules name, taken out of the script, fails the check.
  for (const [from, to] of [[`dport ${ENVD_PORT} `, 'dport '], ['{ $DSH_PORT, ', '{ '], [' $LIVE_PORT, ', ' '], [`, ${MUMBO_MCP_PORT}, `, ', '], [', 5900-5999 } meta', ' } meta'], ['dport 9222 meta', 'dport meta'], [', 9222 } reject', ' } reject'], [`!= { ${ENVD_PORT}, `, '!= { '], [`${ENVD_PORT}, $DSH_PORT, `, `${ENVD_PORT}, `], [`$LIVE_PORT, ${MUMBO_MCP_PORT} } drop`, `${MUMBO_MCP_PORT} } drop`], [`, ${MUMBO_MCP_PORT} } drop`, ' } drop'], ['"lo" tcp flags & (fin|syn|rst|ack) == syn tcp dport !=', '"lo" tcp dport !='], ['udp dport $LIVE_PORT', 'udp dport 0']]) {
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

test('the B24 input chain: from beyond loopback a new TCP connection (SYN alone) reaches only envd, dsh, the live view and the door, and WebRTC UDP stays box-local', () => {
  // E2B's envd forwards every loopback listener to the box address, where its client proxy reaches it. Matching SYN alone
  // lets replies to the box's own connections in without connection tracking.
  for (const person of [true, false]) {
    const { code, err, firewall } = hardening(script(c, person), { users: person })
    assert.equal(code, 0, err)
    assert.equal(firewall.slice(firewall.indexOf('  chain input {\n'), firewall.lastIndexOf('  }\n')), `  chain input {
    type filter hook input priority 0; policy accept;
    iifname != "lo" tcp flags & (fin|syn|rst|ack) == syn tcp dport != { 49983, 880, 881, 882 } drop
    iifname != "lo" udp dport 881 drop
`)
  }
})

/** The start script's stop of the unused units and its check of their ports (edge hardening), comment lines included. */
const UNITS_PART = `  # No ssh, rpcbind or nginx, set rather than trusted (a template from before their masking, or a unit enabled again):
  # each of their units that is active is stopped and masked, and nothing may listen on TCP 22, 80 or 111.
  for u in ssh.socket ssh.service rpcbind.socket rpcbind.service nginx.service; do
    ! systemctl is-active --quiet "$u" || systemctl mask --now "$u" || { echo "mumbo-box: could not stop and mask $u" >&2; exit 1; }
  done
  L=$(ss -ltnpH) || { echo 'mumbo-box: ss could not list the TCP listeners' >&2; exit 1; }
  bad=$(printf '%s\\n' "$L" | awk '{ p = $4; sub(/.*:/, "", p) } p == "22" || p == "80" || p == "111"')
  [ -z "$bad" ] || { printf 'mumbo-box: these listen on TCP 22, 80 or 111, which no box serves:\\n%s\\n' "$bad" >&2; exit 1; }
`

test('the B24 start script stops and masks each unused unit that is active, then fails, naming the listener, when anything listens on TCP 22, 80 or 111', () => {
  assert.deepEqual(UNUSED_UNITS, ['ssh.socket', 'ssh.service', 'rpcbind.socket', 'rpcbind.service', 'nginx.service'])
  for (const person of [true, false]) {
    const s = script(c, person)
    // After the sysctls, before hidepid and the firewall: before any user's process starts.
    assert.ok(hardeningOf(s).includes(`  done\n${UNITS_PART}  # Every user but root sees only its own processes`))
  }
  const s = script(c, true)
  // Listeners on other ports, some ending or starting in 22, 80 or 111, pass.
  const others = ['LISTEN 0 511 127.0.0.1:8080 0.0.0.0:* users:(("node",pid=20,fd=3))', 'LISTEN 0 5 [::]:2222 [::]:* users:(("node",pid=21,fd=3))',
    'LISTEN 0 5 0.0.0.0:1110 0.0.0.0:* users:(("node",pid=22,fd=3))', 'LISTEN 0 511 169.254.0.21:880 0.0.0.0:* users:(("node",pid=23,fd=3))']
  const older = (r) => { setUnits(r, OLD_UNITS, OLD_LISTENERS); writeFileSync(r.at('ss'), others.map(l => `${l}\n`).join('')) }
  // A template from before the masking: each running unit stopped and masked, ssh's idle service left as it was.
  const h = hardening(s, { fail: older })
  assert.equal(h.code, 0, h.err)
  const running = ['ssh.socket', 'rpcbind.socket', 'rpcbind.service', 'nginx.service']
  assert.deepEqual(h.systemctl, UNUSED_UNITS.flatMap(u => [`is-active --quiet ${u}`, ...(running.includes(u) ? [`mask --now ${u}`] : [])]))
  assert.deepEqual(h.units, { states: { 'nginx.service': 'masked', 'rpcbind.service': 'masked', 'rpcbind.socket': 'masked', 'ssh.service': 'enabled', 'ssh.socket': 'masked' }, running: [] })
  assertFirewall(h, '{ 0, 1002 }')
  // A template with the masking: nothing runs, nothing is changed.
  const masked = Object.fromEntries(UNUSED_UNITS.map(u => [u, 'masked']))
  const now = hardening(s, { fail: (r) => setUnits(r, masked) })
  assert.deepEqual([now.code, now.systemctl, now.units], [0, UNUSED_UNITS.map(u => `is-active --quiet ${u}`), { states: masked, running: [] }], now.err)
  // Fatal, before the firewall: a unit that cannot be masked, a stop that does not take (the listeners stay), a listener
  // that is no unit's, and no ss.
  const listed = (lines) => `mumbo-box: these listen on TCP 22, 80 or 111, which no box serves:\n${lines.join('\n')}\n`
  const failures = [
    [(r) => { older(r); r.fake('systemctl', '[ "$1" = is-active ]') }, 'mumbo-box: could not stop and mask ssh.socket\n'],
    [(r) => { older(r); r.fake('systemctl', 'exit 0') }, listed([...OLD_LISTENERS['nginx.service'], ...OLD_LISTENERS['rpcbind.socket'], ...OLD_LISTENERS['ssh.socket']])],
    [(r) => writeFileSync(r.at('ss'), [...others, 'LISTEN 0 5 0.0.0.0:80 0.0.0.0:* users:(("python3",pid=30,fd=3))'].map(l => `${l}\n`).join('')), listed(['LISTEN 0 5 0.0.0.0:80 0.0.0.0:* users:(("python3",pid=30,fd=3))'])],
    [(r) => r.fake('ss', 'exit 1'), 'mumbo-box: ss could not list the TCP listeners\n'],
  ]
  for (const [fail, err] of failures) {
    const out = hardening(s, { fail })
    assert.deepEqual([out.code, out.err, out.nft, out.mount], [1, err, [], []])
  }
  // Before the marker none of it runs.
  const before = hardening(s, { fail: older, gates: 'B24_TEMPLATE= DSH_PORT=3080 LIVE_PORT=6080' })
  assert.deepEqual([before.code, before.systemctl, before.units.running], [0, [], Object.keys(OLD_LISTENERS).sort()])
})

/** A root as E2B's build leaves a box's: /usr/local, its node, /code, envd and /etc/inittab world-writable. Also a
 *  library group-writable by root alone, a module group-writable by workspace, a sticky world-writable directory, a link out of the root, world-writable paths in
 *  each tree the repair leaves alone, of those trees' top directories /home world-writable, /tmp world-writable without
 *  the sticky bit and /var/tmp sticky, a build's group-writable file in /usr/local/bin, a system user's group-writable directory, the
 *  group-writable /var/mail and /var/local of the system groups mail and staff, and directories group-writable by the
 *  system groups uploads and users. */
const E2B_MODES = { 'usr/local': 0o777, 'usr/local/bin': 0o777, 'usr/local/bin/node': 0o777, 'usr/bin/envd': 0o777, 'etc/inittab': 0o666, code: 0o777, 'usr/lib/libg.so': 0o664,
  'src/node_modules/m': 0o775, 'var/spool/sticky': 0o1777, 'home/agent/w': 0o777, 'root/w': 0o777, 'tmp/w': 0o777, 'var/tmp/w': 0o777, 'var/lib/mumbo/playwright-output/f': 0o666,
  home: 0o777, tmp: 0o777, 'var/tmp': 0o1777, 'usr/local/bin/oauth2-proxy': 0o775, 'var/lib/colord': 0o775, 'var/mail': 0o2775, 'var/local': 0o2775, 'opt/uploads': 0o775, 'opt/users': 0o775 }
/** The owners and groups of e2bRoot's paths other than root:root: agent's (1001) a build's file in /usr/local/bin with
 *  a group no name has (as the web image's oauth2-proxy), the link, /tmp and paths in the trees the repair leaves alone;
 *  browsermcp's its Playwright output; the system user colord's (112) its directory; mail (8), staff (50), uploads
 *  (999) and users (100) their directories, and workspace (1007) the module. */
const E2B_IDS = { 'usr/local/bin/oauth2-proxy': [1001, 118], 'usr/local/link': [1001, 1001], tmp: [1001, 1001], 'tmp/w': [1001, 1001], 'home/agent/w': [1001, 1001],
  'var/lib/mumbo/playwright-output': [1002, 1002], 'var/lib/mumbo/playwright-output/f': [1002, 1002], 'var/lib/colord': [112, 112],
  'var/mail': [0, 8], 'var/local': [0, 50], 'opt/uploads': [0, 999], 'opt/users': [0, 100], 'src/node_modules/m': [0, 1007] }
/** e2bRoot's users and groups, as getent lists them: the login users E2B's `user` (in sudo), agent, browsermcp (in the
 *  system group uploads) and legacy (whose primary group is the system group users), and nobody; the system users mail
 *  and colord, and the system groups mail and staff, which hold no login user. */
const E2B_PASSWD = ['root:x:0:0::/root:/bin/bash', 'mail:x:8:8::/var/mail:/usr/sbin/nologin', 'colord:x:112:112::/var/lib/colord:/usr/sbin/nologin',
  'user:x:1000:1000::/home/user:/bin/bash', 'agent:x:1001:1001::/home/agent:/bin/bash', 'browsermcp:x:1002:1002::/home/browsermcp:/usr/sbin/nologin',
  'legacy:x:1010:100::/home/legacy:/bin/sh', 'nobody:x:65534:65534::/nonexistent:/usr/sbin/nologin']
const E2B_GROUP = ['root:x:0:', 'mail:x:8:', 'sudo:x:27:user', 'staff:x:50:', 'users:x:100:', 'colord:x:112:', 'uploads:x:999:browser,browsermcp',
  'user:x:1000:', 'agent:x:1001:', 'workspace:x:1007:agent,xsession', 'nogroup:x:65534:']
/** A `find` for root `r` that reads the owners and groups in `ids` (relative path to [uid, gid]; every other path is
 *  root:root): it runs the real one with each `-uid n` and `-gid n` test (n, or +n, above 0) as the listed paths whose
 *  id matches, and with `-uid 0` and `-gid 0` as every path but the listed ones whose id is not 0. A chown logs its arguments and, when `holds`, takes its paths out of the list, as root:root. */
function idsFind(r, ids, holds = true) {
  const list = r.at('log/ids')
  writeFileSync(list, Object.entries(ids).map(([p, [u, g]]) => `${u} ${g} ${r.at(p)}\n`).join(''))
  r.fake('find', `p=; for a; do shift
  case $p in -uid|-gid)
    case $a in 0|+[0-9]*|[1-9]*) ;; *) echo "fake find: $p $a matches unlisted paths" >&2; exit 99;; esac
    n=; [ $a != 0 ] || n=!
    set -- "$@" '(' $n '(' -false; while read -r u g q; do v=$u; [ $p = -uid ] || v=$g; case $a in 0) [ $v != 0 ];; +*) [ $v -gt \${a#+} ];; *) [ $v = $a ];; esac && set -- "$@" -o -path "$q"; done < ${list}
    set -- "$@" ')' ')'; p=; continue;; esac
  case $a in -uid|-gid) p=$a;; *) set -- "$@" "$a";; esac
done
exec ${which('find')} "$@"`)
  r.fake('chown', `echo "$*" >> ${r.t}/log/chown${holds ? `; shift 2; for q; do ${which('awk')} -v q="$q" '$3 != q' ${list} > ${list}.n; ${which('mv')} ${list}.n ${list}; done` : ''}`)
}
function e2bRoot(r, holds = true) {
  for (const p of ['usr/bin', 'usr/lib', 'etc', 'src/node_modules', 'var/spool', 'var/lib', 'opt', 'home/agent', 'tmp', 'var/tmp', 'var/lib/mumbo/playwright-output']) mkdirSync(r.at(p), { recursive: true })
  for (const [p, mode] of Object.entries(E2B_MODES)) {
    if (!existsSync(r.at(p))) (/\/(node|envd|inittab|f|oauth2-proxy|libg\.so)$/.test(p) ? writeFileSync(r.at(p), '') : mkdirSync(r.at(p)))
    chmodSync(r.at(p), mode)
  }
  mkdirSync(r.at('home/outside')); chmodSync(r.at('home/outside'), 0o777); symlinkSync(r.at('home/outside'), r.at('usr/local/link'))
  writeFileSync(r.at('etc/passwd'), E2B_PASSWD.join('\n') + '\n'); writeFileSync(r.at('etc/group'), E2B_GROUP.join('\n') + '\n')
  idsFind(r, E2B_IDS, holds)
}
const modes = (r, paths) => Object.fromEntries(paths.map(p => [p, statSync(r.at(p)).mode & 0o7777]))
/** The paths the repair's check names in `err`, sorted. */
const named = (err) => err.split('\n').slice(1, -1).map(l => l.split(' ')[2]).sort()

test('the system repair: login users\' paths root\'s, g+w off login groups and group root, o+w off all but sticky directories, outside the users\' and runtime trees, then checked; system users\' and groups\' paths as they were', () => {
  let r = root()
  try {
    e2bRoot(r)
    const out = r.run('', ['login'], systemRepair(r.t))
    assert.equal(out.code, 0, out.err)
    // The login groups: 1000 and up, sudo (E2B's user), users (legacy's primary group) and uploads (browsermcp).
    assert.equal(out.out, 'login=-gid +999 -o -gid 27 -o -gid 100 -o -gid 999\n')
    // The paths a login user owns become root:root, the link itself, but in the users' and runtime trees and
    // browsermcp's Playwright output; colord's stays its own.
    const chowned = r.lines('chown').join(' ').split(' ')
    assert.deepEqual([chowned.slice(0, 2), chowned.slice(2).sort()], [['-h', '0:0'], ['T/tmp', 'T/usr/local/bin/oauth2-proxy', 'T/usr/local/link']])
    // The modes a box's start script leaves: /usr/local, node, /code, envd, inittab, /home and the non-sticky /tmp
    // without o+w and g+w (E2B's 0777 /usr/local becomes 0755: dsh's run-as provider refuses a server identity's PATH
    // directory, or an ancestor of one, that any group can write), the library and the login user's file without group root's g+w, the sticky directories as they were,
    // the module, agent's /tmp and the directories of uploads and users without g+w, colord's, /var/mail and /var/local
    // as they were, what is in the users' and runtime trees as it was, the link not followed.
    assert.deepEqual(modes(r, [...Object.keys(E2B_MODES), 'home/outside']), { 'usr/local': 0o755, 'usr/local/bin': 0o755, 'usr/local/bin/node': 0o755, 'usr/bin/envd': 0o755, 'etc/inittab': 0o644, code: 0o755, 'usr/lib/libg.so': 0o644,
      'src/node_modules/m': 0o755, 'var/spool/sticky': 0o1777, 'home/agent/w': 0o777, 'root/w': 0o777, 'tmp/w': 0o777, 'var/tmp/w': 0o777, 'var/lib/mumbo/playwright-output/f': 0o666,
      home: 0o755, tmp: 0o755, 'var/tmp': 0o1777, 'usr/local/bin/oauth2-proxy': 0o755, 'var/lib/colord': 0o775, 'var/mail': 0o2775, 'var/local': 0o2775, 'opt/uploads': 0o755, 'opt/users': 0o755, 'home/outside': 0o777 })
  } finally { r.done() }
  // The modes do not hold (chmod changes nothing): the start stops and names what every user, a login group or group
  // root (the library, and the login user's file it took) can still change, and nothing a system group's, a sticky
  // directory or in the trees left alone.
  r = root()
  try {
    e2bRoot(r)
    r.fake('chmod', 'exit 0')
    const out = r.run('echo reached', [], systemRepair(r.t))
    assert.equal(out.code, 1)
    assert.ok(out.err.startsWith('mumbo-box: a login user can still change these system files after their repair:\n'), out.err)
    assert.deepEqual(named(out.err), ['T/code', 'T/etc/inittab', 'T/home', 'T/opt/uploads', 'T/opt/users', 'T/src/node_modules/m', 'T/tmp', 'T/usr/bin/envd', 'T/usr/lib/libg.so', 'T/usr/local', 'T/usr/local/bin', 'T/usr/local/bin/node', 'T/usr/local/bin/oauth2-proxy'])
    assert.match(out.err, new RegExp(`^-rwxrwxrwx ${ME.owner} T/usr/bin/envd$`, 'm'))
    assert.ok(!out.out.includes('reached'))
  } finally { r.done() }
  // The owners do not hold (chown changes nothing): the check names the login user's paths alone.
  r = root()
  try {
    e2bRoot(r, false)
    const out = r.run('', [], systemRepair(r.t))
    assert.equal(out.code, 1)
    assert.deepEqual(named(out.err), ['T/tmp', 'T/usr/local/bin/oauth2-proxy', 'T/usr/local/link'])
  } finally { r.done() }
  // Without the users and groups the repair changes nothing and the start stops.
  r = root()
  try {
    e2bRoot(r)
    r.fake('getent', 'exit 2')
    const out = r.run('', [], systemRepair(r.t))
    assert.deepEqual([out.code, out.err, r.lines('chown'), modes(r, ['usr/local'])], [1, 'mumbo-box: could not read the users and groups for the system repair\n', [], { 'usr/local': 0o777 }])
  } finally { r.done() }
})

test('the system repair stops the start, before it changes anything, when E2B\'s user, or on a B24 template (agent) a user the template makes, is below uid 1000; a template before B24 with its system user xvnc starts', () => {
  const below = (name) => `mumbo-box: user ${name} has uid 999, below 1000, so the system repair would not cover it; rebuild the template (RUNBOOK "Rebuild the box template")\n`
  /** Runs the repair on e2bRoot with `name` at uid 999 in place of its E2B_PASSWD line, and agent's dropped when `agent` is false. */
  const run = (name, agent = true) => {
    const r = root()
    try {
      e2bRoot(r)
      const passwd = E2B_PASSWD.filter(l => ![name, ...(agent ? [] : ['agent'])].includes(l.split(':')[0]))
      writeFileSync(r.at('etc/passwd'), [...passwd, `${name}:x:999:999::/nonexistent:/usr/sbin/nologin`].join('\n') + '\n')
      const out = r.run('echo reached', [], systemRepair(r.t))
      return [out.code, out.err, out.out, r.lines('chown').length > 0, modes(r, ['usr/local'])['usr/local']]
    } finally { r.done() }
  }
  for (const name of REPAIR_USERS) assert.deepEqual(run(name), [1, below(name), '', false, 0o777], name)
  assert.deepEqual(run('user', false), [1, below('user'), '', false, 0o777])
  assert.deepEqual(run('xvnc', false), [0, '', 'reached\n', true, 0o755])
  // The RUNBOOK's Rollout quotes the line an old B24 person box (xvnc) and project box (ghproxy) stops with.
  const rollout = readFileSync(new URL('../RUNBOOK.md', import.meta.url), 'utf8').split('\n').find(l => l.startsWith('- **Rollout.**'))
  for (const name of ['xvnc', 'ghproxy']) {
    const quoted = `mumbo-box: user ${name} has uid …, below 1000`
    assert.ok(rollout.includes(`\`${quoted}\``) && below(name).startsWith(quoted.replace('…', '999')), name)
  }
})

test('the start script repairs the system files first, before it reads the ports marker: a world-writable marker still sets the firewall on the template\'s ports', () => {
  const s = script(c, true)
  const read = `if [ -e ${PORTS_MARKER} ]; then B24_TEMPLATE=1; read -r DSH_PORT LIVE_PORT < ${PORTS_MARKER}; fi\n`
  assert.ok(s.startsWith(`#!/bin/sh\n# Start dsh web for this box's user. Re-runnable: the router calls it again when dsh is found dead.\nset -eu\npkill -f 'apps/cli/src/bin.ts' 2>/dev/null || true\n${systemRepair()}ip=`))
  assert.ok(s.indexOf(read) > s.indexOf(systemRepair()) && s.indexOf(read) < s.indexOf(hardeningOf(s)))
  for (const holds of [true, false]) {
    const r = root()
    try {
      e2bRoot(r)
      writeFileSync(r.at('usr/local/share/mumbo/ports'), '880 881\n'); chmodSync(r.at('usr/local/share/mumbo/ports'), 0o666)
      for (const k of ['net/ipv4/ip_unprivileged_port_start', 'fs/protected_hardlinks', 'fs/protected_symlinks']) writeFileSync(r.at(`proc/sys/${k}`), '0\n')
      writeFileSync(r.at('proc/mounts'), 'proc /proc proc rw,hidepid=2 0 0\n')
      r.fake('nft', `echo "$*" >> ${r.t}/log/nft`)
      if (!holds) r.fake('chmod', `case "$1" in o-w|g-w) exit 0;; esac; exec ${which('chmod')} "$@"`)
      const out = r.run(`B24_TEMPLATE= DSH_PORT=3080 LIVE_PORT=6080\n${read}${hardeningOf(s)}`, ['DSH_PORT'], systemRepair(r.t))
      const firewall = r.at('root/.mumbo/firewall.nft')
      if (holds) {
        assert.equal(out.code, 0, out.err)
        assert.deepEqual([out.out, statSync(r.at('usr/local/share/mumbo/ports')).mode & 0o777, readFileSync(firewall, 'utf8')], ['DSH_PORT=880\n', 0o644, FIREWALL('{ 0, 1002 }')])
      } else {
        // Stopped before the marker is read: no firewall, no dsh.
        assert.equal(out.code, 1)
        assert.match(out.err, new RegExp(`^-rw-rw-rw- ${ME.owner} T/usr/local/share/mumbo/ports$`, 'm'))
        assert.deepEqual([out.out, existsSync(firewall), r.lines('nft')], ['', false, []])
      }
    } finally { r.done() }
  }
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
  // The beyond-loopback ids, which beyond() names to skip them all.
  for (const t of /\nbeyond\(\) \{ for t in ([a-z ]+); do /.exec(text)[1].split(' ')) ids.add(`beyond-loopback-${t}`)
  // Ids built in loops, as the script spells them.
  for (const loop of ['agent-bind-$1', 'agent-bind-$p', 'agent-connect-$1', 'envd-$u', 'xkasmvnc-$u', 'sudo-$u', 'su-$u', 'beyond-loopback-$1', 'beyond-loopback-$t']) assert.ok(text.includes(`"${loop}"`), loop)
  const required = [
    // agent: root's files, the browser's profile, other users' processes
    'start-sh-mode', 'agent-read-start-sh', 'agent-read-dsh-home', 'agent-read-dsh-log', 'agent-read-root-entries', 'agent-read-browser-home', 'agent-read-login-data', 'agent-read-cookies',
    'agent-proc-environ', 'agent-proc-cmdline', 'agent-proc-browser', 'mcpserver-proc-environ',
    // agent: what root runs or reads for it, and install paths
    'agent-write-src', 'agent-write-plugin-paths', 'agent-write-mcp-home', 'agent-write-gh-wrapper', 'agent-write-superagent', 'agent-write-attachments', 'agent-write-spill', 'agent-write-agents-home',
    // the display, computer use, uploads
    'agent-x-cookie', 'agent-x-display', 'xsession-login-data', 'computer-use-terminal', 'upload-outside-downloads',
    // consent's staged upload copies, and uploads through the real consent (the uploads contract of 2026-11-11)
    'agent-list-uploads', 'agent-read-uploads', 'upload-swap', 'upload-swap-ask', 'upload-staged-copy', 'agent-list-staged', 'agent-read-staged', 'upload-nested',
    'upload-nested-refused', 'upload-fifo', 'upload-fifo-refused', 'upload-over-cap', 'upload-over-cap-refused', 'upload-staging-restart',
    // the workspace and the person's MCP servers
    'mcpserver-workspace', 'mcpserver-node-modules', 'browsermcp-connect-cdp',
    // tunnels through the project box's GitHub proxy
    'proxy-tunnel',
    // restore, root setup, the model's file tools, a ticket's git hook
    'restore-symlink', 'browser-symlink-setup', 'file-tools-login-data', 'file-tools-dsh-environ', 'file-tools-dsh-log', 'file-tools-swap-read', 'file-tools-swap-write', 'git-hook-ticket',
    // web_fetch of the debugging port and of dsh (the web_fetch contract of 2026-11-11)
    'web-fetch-cdp', 'web-fetch-dsh',
    // from beyond loopback, where E2B's client proxy reaches envd's forwards (the B24 fix): envd answers, and dsh, the
    // live view and the door connect, so a rule that drops too much fails too
    'beyond-loopback-envd', 'beyond-loopback-dsh', 'beyond-loopback-live', 'beyond-loopback-door',
    // what root runs and dsh imports, which E2B's build leaves world-writable (the B24 fix's system repair)
    'agent-write-usr-local-bin', 'agent-write-envd', 'agent-write-load-path',
  ]
  assert.deepEqual(required.filter(id => !ids.has(id)), [])
  // Binds: dsh, the live view and the door refused (EACCES); 3000 and 5173 allowed. Connects: CDP, VNC, dsh, the live view
  // and the door on loopback and the box address; envd for root and every unprivileged user, E2B's own included.
  assert.ok(text.includes('for b in "dsh $DSH_PORT $ip" "live $LIVE_PORT $ip" "door $DOOR_PORT 127.0.0.1"; do') && text.includes('for p in 3000 5173; do'))
  assert.ok(text.includes('for h in 127.0.0.1 "$ip"; do') && text.includes('for t in "cdp 9222" "vnc 5900" "vnc 5901" "dsh $DSH_PORT" "live $LIVE_PORT" "door $DOOR_PORT"; do'))
  assert.ok(text.includes('USERS="agent mcpserver"; [ -z "$person" ] || USERS="$USERS browsermcp desktop xsession browser"\nuser user && USERS="$USERS user"'))
  assert.ok(text.includes(`DOOR_PORT=${MUMBO_MCP_PORT} ENVD_PORT=${ENVD_PORT}`) && text.includes('for u in root $USERS; do denied "envd-$u"'))
  // From beyond loopback, through a network namespace: dsh, the live view and the door connect (status 0), each SKIP when
  // nothing listens on its port; root's 9229 and a high port, agent's 8000, the debugging port and VNC dropped (status 2,
  // a timeout); each SKIP when the box cannot make the namespace.
  assert.ok(text.includes('for t in "dsh $DSH_PORT" "live $LIVE_PORT" "door $DOOR_PORT"; do\n      set -- $t\n      if ! listening $2; then say SKIP "beyond-loopback-$1"') && text.includes('if [ $rc = 0 ]; then say PASS "beyond-loopback-$1" "a connection from beyond loopback to $ip:$2 connects"; else say FAIL "beyond-loopback-$1"'))
  assert.ok(text.includes('node -e "$LISTEN" 9229 ') && text.includes('node -e "$LISTEN" 47999 ') && text.includes(`su -s /bin/sh agent -c "exec node -e '$LISTEN' 8000"`))
  assert.ok(text.includes('for t in "inspector 9229" "high 47999" "dev 8000" "cdp 9222" "vnc 5900"; do') && text.includes('if [ $rc = 2 ]; then say PASS "beyond-loopback-$1"'))
  assert.ok(text.includes('beyond() { for t in envd dsh live door inspector high dev cdp vnc; do say SKIP "beyond-loopback-$t" "$1"; done; }'))
  // The veth pair is on 198.18.0.0/30, not 192.0.2.0/24, where self-hosted E2B puts its in-guest orchestrator address;
  // the namespace goes when the script exits or is interrupted during the checks.
  assert.ok(text.includes('ip addr add 198.18.0.1/30 dev ${v}a') && text.includes('ip -n $ns addr add 198.18.0.2/30 dev ${v}b') && text.includes('route add default via 198.18.0.1') && !text.includes('192.0.2.1/30'))
  assert.ok(text.includes("trap 'ip netns del $ns 2>/dev/null' EXIT; trap 'exit 1' HUP INT TERM\nif ! command -v ip ") && text.includes('\nfi\nip netns del $ns 2>/dev/null; trap - EXIT HUP INT TERM\n'))
})

/** escape-test.sh's uploads through consent (--with-uploads), with Downloads, the staging directory and the page's port
 *  moved, its 3 s read delay cut to 0.3 s, and root:uploads, the copies' owner and group, as the test's user's. The test
 *  plays consent, which stages a copy of each upload it allows (0440 in a 0750 directory unless `openCopies`), and
 *  Chrome, which runs the served page's script on a file-backed File of that copy; agent is the test's user, which su
 *  keeps out of the staging directory unless `openCopies`. `staleCopies` leaves an earlier run's open copies of
 *  mumbo-escape-swap.txt, the same size as this run's, and of mumbo-escape-nested.txt in the staging directory. Returns
 *  each upload check's status and the FAIL lines. */
async function escapeUploads({ deleteAfterCall = false, blockOnFifo = false, openCopies = false, staleCopies = false }) {
  const text = readFileSync(new URL('./escape-test.sh', import.meta.url), 'utf8')
  const t = mkdtempSync(join(tmpdir(), 'escape-uploads-'))
  const D = join(t, 'Downloads'), S = join(t, 'uploads')
  let sh, reader
  try {
    for (const d of [D, S, join(t, 'bin')]) mkdirSync(d)
    writeFileSync(join(t, 'consent.ts'), 'uploadStaging')
    writeFileSync(join(t, 'bin/su'), `#!/bin/sh\n${openCopies ? '' : `case "$5" in *${S}*) exit 1;; esac\n`}exec /bin/sh -c "$5"\n`)
    chmodSync(join(t, 'bin/su'), 0o755)
    const port = await new Promise(r => { const v = createServer().listen(0, '127.0.0.1', () => { const { port } = v.address(); v.close(() => r(port)) }) })
    const helpers = text.split('\n').filter(l => /^(say|as|refused|manual)\(\) /.test(l)).join('\n')
    const owner = `${execFileSync('id', ['-un'], { encoding: 'utf8' }).trim()}:${execFileSync('id', ['-gn'], { encoding: 'utf8' }).trim()}`
    const block = text.slice(text.indexOf('D=/home/shared/Downloads\n'), text.indexOf('# Restore:')).replaceAll('/home/shared/Downloads', D)
      .replaceAll('/src/packages/mumbo/browser-consent/src/index.ts', join(t, 'consent.ts')).replaceAll('8790', String(port)).replace('}, 3000)', '}, 300)').replaceAll('root:uploads', owner)
    sh = spawn('/bin/sh', ['-c', `set -u\nfails=0 person=1 uploads=1 S=${S}\n${helpers}\n${block}`], { env: { ...process.env, PATH: `${join(t, 'bin')}:${process.env.PATH}` } })
    if (staleCopies) {
      mkdirSync(join(S, 'n0'))
      writeFileSync(join(S, 'n0/mumbo-escape-swap.txt'), `original ${'9'.repeat(String(sh.pid).length)}\n`)
      writeFileSync(join(S, 'n0/mumbo-escape-nested.txt'), 'nested')
      for (const f of ['mumbo-escape-swap.txt', 'mumbo-escape-nested.txt']) utimesSync(join(S, 'n0', f), 0, 0)
    }
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
      if (!openCopies) { chmodSync(join(S, n, name), 0o440); chmodSync(join(S, n), 0o750) }
      await until(swapped)
      input.files = [new File([await openAsBlob(join(S, n, name))], name)]
      input.onchange()
      if (deleteAfterCall) rmSync(join(S, n), { recursive: true })
    }
    await upload('mumbo-escape-swap.txt', 'n1', () => readFileSync(join(D, 'mumbo-escape-swap.txt'), 'utf8') === 'swapped')
    if (blockOnFifo) reader = spawn('cat', [join(D, 'mumbo-escape-fifo')], { stdio: 'ignore' })
    await upload('mumbo-escape-done.txt', 'n2')
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

const UPLOAD_CHECKS = { 'upload-swap': 'PASS', 'upload-swap-ask': 'MANUAL', 'upload-staged-copy': 'PASS', 'agent-list-staged': 'PASS', 'agent-read-staged': 'PASS',
  'upload-nested': 'PASS', 'upload-nested-refused': 'MANUAL', 'upload-fifo': 'PASS', 'upload-fifo-refused': 'MANUAL', 'upload-over-cap': 'PASS', 'upload-over-cap-refused': 'MANUAL' }

test('escape-test.sh --with-uploads passes a consent that keeps its copies, closed to agent, until it unmounts', async () => {
  assert.deepEqual(await escapeUploads({}), { status: UPLOAD_CHECKS, fails: [] })
})

test('escape-test.sh --with-uploads counts only the copies consent makes during the run, not an earlier run\'s kept copies', async () => {
  assert.deepEqual(await escapeUploads({ staleCopies: true }), { status: UPLOAD_CHECKS, fails: [] })
})

test('escape-test.sh --with-uploads fails a consent that deletes its copy before the page reads it, or that is blocked opening the FIFO', async () => {
  assert.deepEqual(await escapeUploads({ deleteAfterCall: true, blockOnFifo: true }), {
    status: { ...UPLOAD_CHECKS, 'upload-swap': 'FAIL', 'upload-staged-copy': 'FAIL', 'agent-list-staged': 'SKIP', 'agent-read-staged': 'SKIP', 'upload-fifo': 'FAIL' },
    fails: [
      'upload-swap the page could not read the file 3 s after the call: consent removed its staged copy before the page read it',
      'upload-staged-copy consent kept no copy of mumbo-escape-swap.txt: copies stay until consent unmounts',
      'upload-fifo a FIFO in Downloads: consent is blocked opening it',
    ],
  })
})

test('escape-test.sh --with-uploads fails a consent whose kept copy agent can list and read', async () => {
  const { status } = await escapeUploads({ openCopies: true })
  assert.deepEqual(status, { ...UPLOAD_CHECKS, 'upload-staged-copy': 'FAIL', 'agent-list-staged': 'FAIL', 'agent-read-staged': 'FAIL' })
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
  // The project box's GitHub proxy becomes its own user, with no home or login (edge startScript).
  assert.ok(PROJECT_STEPS.includes('id ghproxy >/dev/null 2>&1 || useradd -U -M -d /nonexistent -s /usr/sbin/nologin ghproxy'))
  // No template user is a system user (`useradd -r`): each gets a uid of 1000 or more, a login user's, whose paths the
  // system repair takes and whose groups lose g+w there (edge systemRepair), and every one is a user whose uid the start
  // checks before that repair (REPAIR_USERS).
  const useradds = [...BOX_STEPS, ...PROJECT_STEPS].flatMap(s => s.match(/\buseradd [^&|;]*/g) ?? [])
  assert.deepEqual([...new Set(useradds.map(u => u.split(' ').at(-1)))].sort(), REPAIR_USERS.filter(u => u !== 'user').sort())
  assert.deepEqual(useradds.filter(u => /\s(-r|--system)\s/.test(u)), [])
  // nftables, setfacl, setcap and python3-venv (agent's venvs) are installed, not assumed from the base image;
  // iptables, which nothing on a template with the marker runs, is not.
  const pkgs = (steps) => steps.find(s => s.includes('apt-get install')).match(/--no-install-recommends ([^&]+?) &&/g).join(' ')
  for (const p of ['nftables', 'acl', 'libcap2-bin', 'iproute2', 'python3-venv']) assert.match(pkgs(BOX_STEPS), new RegExp(`\\b${p}\\b`), p)
  for (const p of ['nftables', 'acl', 'iproute2', 'python3-venv']) assert.match(pkgs(PROJECT_STEPS), new RegExp(`\\b${p}\\b`), p)
  assert.ok(![...BOX_STEPS, ...PROJECT_STEPS].some(s => /\biptables\b/.test(s)))
  // First the umask for every step: e2b's runCmd runs them in one shell.
  assert.deepEqual([UMASK_STEP, BOX_STEPS[0], PROJECT_STEPS[0]], ['umask 022', UMASK_STEP, UMASK_STEP])
  // The users, the unused units masked, then the nftables smoke check, which runs as agent, and the dsh smoke check, last.
  assert.deepEqual([BOX_STEPS.slice(-usersSteps(true).length - 3), PROJECT_STEPS.slice(-usersSteps(false).length - 3)], [[...usersSteps(true), MASK_UNITS_STEP, NFT_SMOKE_STEP, dshSmokeStep(true)], [...usersSteps(false), MASK_UNITS_STEP, NFT_SMOKE_STEP, dshSmokeStep(false)]])
})

test('template: the unused units are stopped, disabled and masked, also those the image lacks, and the build fails unless each reads masked', () => {
  assert.equal(MASK_UNITS_STEP, '(for u in ssh.socket ssh.service rpcbind.socket rpcbind.service nginx.service; do systemctl disable --now "$u" 2>/dev/null || :; done; '
    + 'systemctl mask ssh.socket ssh.service rpcbind.socket rpcbind.service nginx.service || exit 1; '
    + 'for u in ssh.socket ssh.service rpcbind.socket rpcbind.service nginx.service; do [ "$(systemctl is-enabled "$u" 2>/dev/null)" = masked ] || { echo "mumbo-box: $u is not masked" >&2; exit 1; }; done)')
  /** Runs `before && MASK_UNITS_STEP`, as e2b's runCmd joins the steps, on OLD_UNITS less `lacks`, after `setup`. */
  const run = ({ before = 'true', lacks = [], setup = () => {} } = {}) => {
    const r = root()
    try {
      setUnits(r, Object.fromEntries(Object.entries(OLD_UNITS).filter(([u]) => !lacks.includes(u))), Object.fromEntries(Object.entries(OLD_LISTENERS).filter(([u]) => !lacks.includes(u))))
      setup(r)
      const out = spawnSync('/bin/sh', ['-c', `${before} && ${MASK_UNITS_STEP}`], { encoding: 'utf8', env: { PATH: r.at('bin') } })
      return { code: out.status, err: out.stderr, systemctl: r.lines('systemctl'), units: unitsOf(r) }
    } finally { r.done() }
  }
  const masked = { states: Object.fromEntries(UNUSED_UNITS.map(u => [u, 'masked']).sort()), running: [] }
  const calls = [...UNUSED_UNITS.map(u => `disable --now ${u}`), `mask ${UNUSED_UNITS.join(' ')}`, ...UNUSED_UNITS.map(u => `is-enabled ${u}`)]
  // E2B's base and the web image: every unit stopped and masked.
  assert.deepEqual(run(), { code: 0, err: '', systemctl: calls, units: masked })
  // An image without nginx or rpcbind: their disable fails, and the mask covers them too.
  assert.deepEqual(run({ lacks: ['rpcbind.socket', 'rpcbind.service', 'nginx.service'] }), { code: 0, err: '', systemctl: calls, units: masked })
  // A mask that fails, or one that does not take, fails the build.
  const cannot = run({ setup: (r) => r.fake('systemctl', `echo "$*" >> ${r.t}/log/systemctl; [ "$1" != mask ]`) })
  assert.deepEqual([cannot.code, cannot.systemctl.at(-1)], [1, `mask ${UNUSED_UNITS.join(' ')}`])
  const ignored = run({ setup: (r) => r.fake('systemctl', `case $1 in disable|mask) exit 0;; is-enabled) [ "$2" = ssh.socket ] && echo masked || echo enabled;; esac`) })
  assert.deepEqual([ignored.code, ignored.err], [1, 'mumbo-box: ssh.service is not masked\n'])
  // After a failed step it does not run, and the failure is the build's.
  assert.deepEqual(run({ before: 'false' }).systemctl, [])
  // The dsh smoke check's listener check stays strict: no entry for their ports.
  for (const port of ['22', '80', '111']) assert.ok(!LISTENER_ALLOWLIST.some(l => l.port === port), port)
  // The RUNBOOK names each unit, and checks their ports on a real box.
  const runbook = readFileSync(new URL('../RUNBOOK.md', import.meta.url), 'utf8').split('\n')
  const template = runbook.find(l => l.startsWith('- **Template (marker).**')), real = runbook.find(l => l.startsWith('- **Checked only on a real box.**'))
  for (const text of [...UNUSED_UNITS.map(u => `\`${u}\``), '`MASK_UNITS_STEP`', '`systemctl mask --now`']) assert.ok(template.includes(text), text)
  assert.ok(real.includes('`ss -ltn` showing nothing on 22, 80 or 111'))
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

/** The dummy edge config smokeStartScript makes its script with (template.mjs SMOKE_CFG). */
const SMOKE_CFG = { llmHost: 'llm.invalid', publicHost: 'box.invalid', projectDomain: 'box.invalid', agentLogin: 'smoke[bot]', agentId: 1 }
const base64 = (text) => Buffer.from(text).toString('base64')

test('template: the dsh smoke check runs a box\'s start script with dummy values, less the parts that would stay in the template, and waits 60 s for dsh', () => {
  assert.equal(DSH_SMOKE_SECONDS, 60)
  for (const person of [true, false]) {
    const s = smokeStartScript(person), step = dshSmokeStep(person)
    for (const text of [s, step]) execFileSync('sh', ['-n'], { input: text })
    assert.ok(step.includes(`; echo ${base64(s)} | base64 -d > $T/start.sh; `))
    // What E2B's finalize phase does after the template's steps (its configure.sh:94-100), before start.sh runs.
    const finalize = `; chmod -R 777 /usr/local && mkdir -p /code && chmod -R 777 /code || { echo "mumbo-box: the dsh smoke check could not make /usr/local and /code 0777 as E2B's finalize phase does" >&2; exit 1; }; `
    assert.ok(step.includes(finalize) && step.indexOf(finalize) < step.indexOf('; why=; ps -e -o pid= > $T/pids; setsid -w '))
    assert.ok(step.includes('elif [ $n -ge 60 ]; then why=\'dsh printed no start line within 60 s\'; else sleep 1;'))
    // The script the edge would write for that box, line for line, less the kernel and network part, a person box's
    // desktop and a project box's GitHub proxy.
    const principal = person ? 'smoke@box.invalid' : 'project:0000000000000000'
    const full = startScript(SMOKE_CFG, signBox('smoke', principal, 'smoke'), boxSite(SMOKE_CFG, principal), roleInstructions(SMOKE_CFG, principal),
      person ? undefined : memberKey('smoke', 'smoke').toString('base64url'), { proxy: '', gh: '' }, person ? undefined : ['smoke@box.invalid'],
      person ? { key: mumboMcpKey('smoke', 'smoke'), principal: 'smoke' } : undefined, principal).split('\n')
    let i = 0
    for (const line of s.split('\n')) { while (i < full.length && full[i] !== line) i++; assert.ok(i++ < full.length, line) }
    for (const gone of ['table inet mumbo', 'hidepid', 'chmod u-s', ...(person ? ['Xkasmvnc', '/usr/local/bin/mumbo-desktop', '/usr/local/bin/google-chrome'] : ['update-ca-certificates', 'github-local-proxy', 'ca.key'])]) assert.ok(!s.includes(gone), gone)
    // The kernel part's sysctls stay, set and checked as every start sets them: the run-as provider refuses to load
    // without fs.protected_hardlinks=1.
    assert.ok(s.includes('if [ -n "$B24_TEMPLATE" ]; then\n  # Only root binds') && s.includes('  for kv in net/ipv4/ip_unprivileged_port_start=1024 fs/protected_hardlinks=1 fs/protected_symlinks=1; do\n'))
    // So do the unused units' stop and the check of their ports, which change nothing after MASK_UNITS_STEP.
    assert.ok(s.includes(UNITS_PART))
    // The system repair, the layout and rows a box gets, and dsh with a box's profile and patches.
    assert.ok(s.includes(systemRepair()) && s.includes(containmentLayout(SMOKE_CFG, person)))
    const box = startScript(c, 'T', boxSite(c, person ? 'a@x.com' : 'project:0123456789abcdef'), 'role', person ? undefined : 'K', { proxy: 'P', gh: 'G' }, ['o@x.com'], person ? { key: 'K', principal: 'a' } : undefined, 'a@x.com')
    const patches = (text) => text.split('\n').filter(l => /^nohup node|^ {2}--patch /.test(l))
    assert.deepEqual(patches(s), patches(box))
    assert.equal(patches(s).length, 2)
  }
  // start.sh's first command is `pkill -f 'apps/cli/src/bin.ts'`: no template step's text may match it.
  for (const steps of [BOX_STEPS, PROJECT_STEPS]) assert.ok(!/apps\/cli\/src\/bin.ts/.test(steps.join(' && ')))
})

test('template: the dsh smoke check\'s listeners: of users other than agent, only those on the output chain\'s reset set or the allowlist', () => {
  // The output chain's reset set, read from the firewall a box loads: envd for everyone, the rest for all but root (and
  // browsermcp on 9222).
  const s = script(c, true)
  const envd = /dport (\d+) reject with tcp reset/.exec(s)[1], reset = /dport \{ ([^}]+) \} reject with tcp reset/.exec(s)[1].split(', ')
  assert.deepEqual([envd, reset], [ENVD_PORT, ['$DSH_PORT', '$LIVE_PORT', MUMBO_MCP_PORT, '5900-5999', '9222']])
  for (const person of [true, false]) assert.ok(dshSmokeStep(person).includes(` -v open="${[envd, ...reset, ...LISTENER_ALLOWLIST.map(l => l.port)].join(' ')}" `))
  // Each entry a port with its reason.
  assert.deepEqual(LISTENER_ALLOWLIST.map(l => l.port), ['8899'])
  for (const l of LISTENER_ALLOWLIST) assert.ok(/^\d+$/.test(l.port) && l.reason.length > 40, l.port)
})

/** Listeners every check below passes: root's on the reset set (dsh, the door, envd, envd's forward of the door, VNC),
 *  another user's on 9222 and on the allowlist's 8899, and agent's own (uid 4000001). */
const SS_OK = [
  'LISTEN 0 511 169.254.0.21:880 0.0.0.0:* users:(("node",pid=10,fd=20)) ino:1 sk:1 <->',
  'LISTEN 0 511 127.0.0.1:882 0.0.0.0:* users:(("node",pid=10,fd=21)) ino:2 sk:2 <->',
  'LISTEN 0 4096 *:49983 *:* users:(("envd",pid=1,fd=3)) ino:3 sk:3 <->',
  'LISTEN 0 5 169.254.0.21:882 0.0.0.0:* users:(("socat",pid=9,fd=5)) ino:4 sk:4 <->',
  'LISTEN 0 5 127.0.0.1:5999 0.0.0.0:* users:(("x",pid=11,fd=3)) ino:5 sk:5 <->',
  'LISTEN 0 5 [::1]:9222 [::]:* users:(("chrome",pid=12,fd=3)) uid:4000009 ino:6 sk:6 <->',
  'LISTEN 0 5 127.0.0.1:8899 0.0.0.0:* users:(("node",pid=13,fd=3)) uid:4000010 ino:7 sk:7 <->',
  'LISTEN 0 5 0.0.0.0:3000 0.0.0.0:* users:(("node",pid=14,fd=3)) uid:4000001 ino:8 sk:8 <->',
]
/** A fake start.sh in a temporary root `$T`: for the system repair, unless `repair` is false, it sets /usr/local's modes
 *  back to those in $T/usr-local.modes and takes g+w and o+w off /code; then it lays out and writes as a box's does, in /root (also changing its modes
 *  and writing into the image's .cargo), /home, /src, /var/lib/mumbo, /usr/local/share/mumbo, /run and /tmp, starts a
 *  fake dsh (a node process whose command line names dsh's entry point, pid in $T/dsh.pid) unless `dsh` is false,
 *  prints dsh's start line unless `line` is false, then dsh's warning that the entries `inactive` names did not activate
 *  unless it is empty, runs `extra` and exits with `exit`. A process `extra` starts writes its pid to another $T/*.pid
 *  file. */
/** dsh's warning that entries `ids` did not activate (app-boot activationDiagnostic), each with a stack line. */
const warning = (ids) => [`dsh: warning: ${ids.length} ${ids.length === 1 ? 'entry' : 'entries'} did not activate`, ...ids.flatMap(id => [`${id} (@deepseek-ai/dsh-${id}): Error: ${id} could not load`, '    at apply (file:///src/x.ts:1:1)'])]
const fakeStart = ({ line = true, dsh = true, exit = 0, extra = '', inactive = [], repair = true } = {}) => `set -eu
: > $T/ran
${repair ? 'while read -r m p; do chmod $m $p; done < $T/usr-local.modes; chmod -R go-w $T/code' : ''}
echo 'start.sh: laying out'
mkdir -p $T/root/.dsh/sessions $T/root/.dsh/logs $T/root/.mumbo $T/root/projects $T/var/lib/mumbo/spill $T/run/dsh-shell $T/home/agent/.mumbo-welcome $T/usr/local/share/mumbo/agents $T/tmp/tsx-0 $T/src/.dsh
: > $T/root/.dsh/sessions/s.jsonl; : > $T/root/.cargo/cache
chmod 0711 $T/root; chmod 0700 $T/root/.cargo
echo 'startup audit: subprocess did not activate' > $T/root/.dsh/logs/startup-1.log
echo 'dsh: loading' > $T/root/dsh.log
${dsh ? `"${process.execPath}" -e 'setTimeout(() => {}, 30000)' apps/cli/src/bin.ts </dev/null >/dev/null 2>&1 & echo $! > $T/dsh.pid` : ''}
${line ? 'echo \'dsh web: https://box.invalid/?token=abc\' >> $T/root/dsh.log' : ''}
${inactive.length ? `printf '%s\\n' ${[warning(inactive)].flat().map(l => `'${l}'`).join(' ')} >> $T/root/dsh.log` : ''}
${extra}
exit ${exit}
`

/** Runs `before && dshSmokeStep(true)` with the box paths moved into a temporary root whose /root (0700) holds .cargo
 *  (0755) and .profile, /usr/local's modes after `setup` in usr-local.modes there, the start script replaced by `start`, real tools, and fake id (containment users 4000001 to
 *  4000005), ss (printing `ss`, or failing on null), sleep (20 ms), ps, which lists only the processes whose
 *  environment holds the run's MUMBO_SMOKE_TEST, so the step sees and kills no process of this host's, and su, which
 *  runs `su` when the step runs agentInstallScript(true) as agent with the moved /bin/sh, and fails otherwise. Returns the status, output with
 *  the root as T, whether a process of a $T/*.pid file is still running, whether start.sh ran, and whether the moved
 *  paths read as before. */
function smoke({ start = fakeStart(), ss = SS_OK, before = 'true', setup = () => {}, su = 'exit 0' } = {}) {
  const t = mkdtempSync(join(tmpdir(), 'dsh-smoke-'))
  try {
    for (const d of ['bin', 'root/.cargo', 'home/agent', 'src/node_modules/pkg', 'usr/local/share/mumbo', 'usr/local/bin', 'usr/local/lib/node_modules/npm', 'usr/bin', 'etc', 'var/lib', 'var/tmp', 'run', 'tmp', 'dev/shm']) mkdirSync(join(t, d), { recursive: true })
    for (const f of ['usr/local/bin/node', 'usr/bin/envd', 'etc/inittab']) writeFileSync(join(t, f), '')
    chmodSync(join(t, 'usr/local/bin/node'), 0o755); chmodSync(join(t, 'usr/bin/envd'), 0o755)
    writeFileSync(join(t, 'root/.profile'), '')
    chmodSync(join(t, 'root'), 0o700); chmodSync(join(t, 'root/.cargo'), 0o755)
    writeFileSync(join(t, 'usr/local/share/mumbo/ports'), '880 881\n')
    for (const tool of ['sh', 'sort', 'comm', 'cmp', 'mktemp', 'base64', 'setsid', 'cat', 'grep', 'pgrep', 'awk', 'xargs', 'rm', 'chmod', 'tail', 'tr', 'head', 'mkdir', 'readlink']) symlinkSync(which(tool), join(t, 'bin', tool))
    fakeFind(join(t, 'bin'))
    symlinkSync('/bin/kill', join(t, 'bin/kill'))
    const fake = (name, body) => { writeFileSync(join(t, 'bin', name), `#!/bin/sh\n${body}\n`); chmodSync(join(t, 'bin', name), 0o755) }
    fake('id', 'case "$2" in agent) echo 4000001;; mcpserver) echo 4000002;; browsermcp) echo 4000003;; desktop) echo 4000004;; xsession) echo 4000005;; *) exit 1;; esac')
    writeFileSync(join(t, 'ss.txt'), ss === null ? '' : ss.join('\n') + '\n')
    fake('ss', ss === null ? 'exit 1' : `[ "$1" = -ltnpeH ] && cat ${t}/ss.txt`)
    fake('sleep', `exec ${which('sleep')} 0.02`)
    fake('npm', `[ "$*" = 'root -g --logs-max=0' ] && echo ${t}/usr/local/lib/node_modules`)
    writeFileSync(join(t, 'agent.sh'), agentInstallScript(true))
    fake('su', `[ "$1 $2 $3 $4" = '-s ${t}/bin/sh agent -c' ] && printf '%s\\n' "$5" | cmp -s - ${t}/agent.sh || exit 99\n${su}`)
    fake('ps', `[ "$1" = -e ] || exit 2; shift; exec ${which('ps')} -p "$(${which('grep')} -lsF 'MUMBO_SMOKE_TEST=${t}' /proc/[0-9]*/environ | ${which('cut')} -d/ -f3 | ${which('paste')} -sd, -)" "$@"`)
    setup(t)
    writeFileSync(join(t, 'usr-local.modes'), ['usr/local', ...readdirSync(join(t, 'usr/local'), { recursive: true }).map(p => join('usr/local', p))]
      .map(p => `${(lstatSync(join(t, p)).mode & 0o7777).toString(8)} ${join(t, p)}\n`).join(''))
    const listing = () => ['root', 'home', 'src', 'usr', 'var', 'run', 'tmp', 'dev'].flatMap(d => [d, ...readdirSync(join(t, d), { recursive: true }).map(p => join(d, p))])
      .map(p => `${p} ${(lstatSync(join(t, p)).mode & 0o7777).toString(8)}`).sort().join('\n')
    const was = listing()
    const step = dshSmokeStep(true).replace(base64(smokeStartScript(true)), base64(start.replaceAll('$T', t)))
      .replace(/(?<=^|[\s'"=(<>])\/(root|home|src|run|tmp|usr|s?bin|var|etc|opt|proc|sys|code|dev(?!\/null))(?=[/\s'";)]|$)/g, `${t}/$1`).replaceAll('find / ', `find ${t} `)
    const out = spawnSync('/bin/sh', ['-c', `${before} && ${step}`], { encoding: 'utf8', env: { PATH: join(t, 'bin'), MUMBO_SMOKE_TEST: t }, timeout: 60000 })
    // A zombie waiting for its new parent to reap it is stopped.
    const running = readdirSync(t).filter(f => f.endsWith('.pid')).map(f => Number(readFileSync(join(t, f), 'utf8'))).filter(pid => {
      try { return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1][0] !== 'Z' } catch { return false /* ENOENT: gone */ }
    })
    for (const pid of running) process.kill(pid, 'SIGKILL')
    return { code: out.status, out: out.stdout, err: out.stderr.replaceAll(t, 'T'), running: running.length > 0, ran: existsSync(join(t, 'ran')), same: listing() === was }
  } finally { rmSync(t, { recursive: true, force: true }) }
}

test('template: the dsh smoke check passes when dsh prints its start line and no other user\'s listener is open to agent, and leaves nothing behind', (t) => {
  if (spawnSync('sh', ['-c', 'command -v setsid']).status !== 0) return t.skip('setsid is not installed on this host')
  const ok = { code: 0, out: 'mumbo-box: dsh smoke check: start dsh as a box does, with dummy values\nmumbo-box: dsh smoke check passed\n', err: '', running: false, ran: true, same: true }
  assert.deepEqual(smoke(), ok)
  // dsh-subprocess-local starts each child in a session of its own, and without containment as root: the step stops it too.
  const detached = `setsid "${process.execPath}" -e 'setTimeout(() => {}, 30000)' </dev/null >/dev/null 2>&1 & echo $! > $T/detached.pid`
  assert.deepEqual(smoke({ start: fakeStart({ extra: detached }) }), ok)
  // Before start.sh the step makes /usr/local and /code 0777, as E2B's finalize phase: without the repair the check names them.
  const unrepaired = smoke({ start: fakeStart({ repair: false }) })
  assert.equal(unrepaired.code, 1)
  for (const [mode, p] of [['drwxrwxrwx', 'code'], ['drwxrwxrwx', 'usr/local/bin'], ['-rwxrwxrwx', 'usr/local/bin/node'], ['-rwxrwxrwx', 'usr/local/share/mumbo/ports']]) assert.match(unrepaired.err, new RegExp(`(: |\\n)${mode} ${ME.owner} T/${p}$`, 'm'), p)
})

test('template: the dsh smoke check fails on a slow, dead or failed dsh, an open listener or no ss, prints why with the logs, and still leaves nothing behind', (t) => {
  if (spawnSync('sh', ['-c', 'command -v setsid']).status !== 0) return t.skip('setsid is not installed on this host')
  const failed = 'mumbo-box: the dsh smoke check failed'
  const logs = '--- start.sh\nstart.sh: laying out\n--- T/root/dsh.log\ndsh: loading\n--- T/root/.dsh/logs/startup-1.log\nstartup audit: subprocess did not activate\n'
  const bad = ['LISTEN 0 5 127.0.0.1:9229 0.0.0.0:* users:(("node",pid=15,fd=3)) ino:9 sk:9 <->', 'LISTEN 0 5 [::]:6000 [::]:* users:(("python3",pid=16,fd=3)) uid:4000002 ino:10 sk:10 <->']
  for (const [opts, why, tail] of [
    [{ start: fakeStart({ line: false }) }, 'dsh printed no start line within 60 s', logs],
    [{ start: fakeStart({ line: false, dsh: false }) }, 'dsh exited before its start line', logs],
    [{ start: fakeStart({ line: false, exit: 3 }) }, 'start.sh failed (status 3)', logs],
    [{ ss: [...SS_OK.slice(0, 4), bad[0], ...SS_OK.slice(4), bad[1]] }, `agent may connect to these listeners of other users, outside the output chain's reset set and LISTENER_ALLOWLIST (template.mjs): ${bad.join('\n')}`, logs.replace('dsh: loading\n', 'dsh: loading\ndsh web: https://box.invalid/?token=abc\n')],
    [{ ss: null }, 'ss could not list the TCP listeners', logs.replace('dsh: loading\n', 'dsh: loading\ndsh web: https://box.invalid/?token=abc\n')],
  ]) {
    const out = smoke(opts)
    assert.deepEqual(out, { code: 1, out: 'mumbo-box: dsh smoke check: start dsh as a box does, with dummy values\n', err: `${failed}: ${why}\n${tail}`, running: false, ran: true, same: true }, why)
  }
  // A path the template had, which start.sh removed, fails the build.
  const gone = smoke({ start: fakeStart({ extra: 'rm $T/root/.profile' }) })
  assert.deepEqual([gone.code, gone.err, gone.running], [1, "chmod: cannot access 'T/root/.profile': No such file or directory\nmumbo-box: the dsh smoke check could not undo: T/root/.profile\nmumbo-box: the dsh smoke check could not restore the modes in T/root\n", false])
  // A template with a box's own paths is refused before anything runs; after a failed step the check does not run.
  const kept = smoke({ setup: (root) => mkdirSync(join(root, 'root/.dsh')) })
  assert.deepEqual([kept.code, kept.err, kept.ran, kept.same], [1, 'mumbo-box: the dsh smoke check needs a template without T/root/.dsh, which a box\'s start script makes\n', false, true])
  const after = smoke({ before: 'false' })
  assert.deepEqual([after.code, after.out, after.ran], [1, '', false])
})

const SMOKE_START = 'mumbo-box: dsh smoke check: start dsh as a box does, with dummy values\n'
const SMOKE_OK = { code: 0, out: `${SMOKE_START}mumbo-box: dsh smoke check passed\n`, err: '', running: false, ran: true, same: true }
/** The output of a dsh smoke check that fails with `why` after dsh's start line, which `log` follows in dsh's log. */
const smokeFailed = (why, log = '') => ({ code: 1, out: SMOKE_START, running: false, ran: true, same: true,
  err: `mumbo-box: the dsh smoke check failed: ${why}\n--- start.sh\nstart.sh: laying out\n--- T/root/dsh.log\ndsh: loading\ndsh web: https://box.invalid/?token=abc\n${log}--- T/root/.dsh/logs/startup-1.log\nstartup audit: subprocess did not activate\n` })

test('template: the dsh smoke check fails on an entry outside INACTIVE_ALLOWLIST in dsh\'s warning that entries did not activate, and prints the warning', (t) => {
  if (spawnSync('sh', ['-c', 'command -v setsid']).status !== 0) return t.skip('setsid is not installed on this host')
  // dsh warns after the Loader settles, about when it prints its start line; computer use's X provider fails without the
  // desktop, which the check does not start.
  assert.equal(DSH_SMOKE_SETTLE_SECONDS, 3)
  assert.deepEqual(INACTIVE_ALLOWLIST.map(e => e.id), ['computer-use-x11'])
  for (const e of INACTIVE_ALLOWLIST) assert.ok(e.reason.length > 40, e.id)
  for (const person of [true, false]) assert.ok(dshSmokeStep(person).includes(`; [ -n "$why" ] || { sleep 3; bad=$(awk -v ok=" computer-use-x11 " `))
  assert.deepEqual(smoke({ start: fakeStart({ inactive: ['computer-use-x11'] }) }), SMOKE_OK)
  // subprocess, whose failure left B24's assistant waiting: dsh still starts, and the check fails.
  const w = `${warning(['computer-use-x11', 'subprocess']).join('\n')}\n`
  assert.deepEqual(smoke({ start: fakeStart({ inactive: ['computer-use-x11', 'subprocess'] }) }), {
    ...smokeFailed('these dsh entries did not activate, outside INACTIVE_ALLOWLIST (template.mjs): subprocess', w),
    err: `${smokeFailed('these dsh entries did not activate, outside INACTIVE_ALLOWLIST (template.mjs): subprocess', w).err}--- dsh's entries that did not activate\n${w}`,
  })
})

test('template: the dsh smoke check fails on a world-writable file or a directory without the sticky bit, and on what another user can change on a PATH or in dsh\'s code tree', (t) => {
  if (spawnSync('sh', ['-c', 'command -v setsid']).status !== 0) return t.skip('setsid is not installed on this host')
  // Skipped: the kernel's and runtime trees and /tmp, each with its reason.
  assert.deepEqual(WRITABLE_EXCLUDES.map(e => e.path), ['/proc', '/sys', '/dev', '/run', '/tmp'])
  for (const e of WRITABLE_EXCLUDES) assert.ok(e.reason.length > 20, e.path)
  // The run-as users' PATHs, from the rows.
  assert.ok(dshSmokeStep(true).includes(` tr : ' ') /usr/local/sbin /usr/local/bin /usr/sbin /usr/bin /sbin /bin; do `))
  assert.ok(dshSmokeStep(false).includes(` tr : ' ') /var/lib/mumbo/superagent/worker-bin /usr/local/lib/mumbo/bin /usr/local/sbin /usr/local/bin /usr/sbin /usr/bin /sbin /bin; do `))
  // A sticky world-writable directory, as /var/tmp, passes.
  assert.deepEqual(smoke({ setup: (root) => { mkdirSync(join(root, 'var/spool')); chmodSync(join(root, 'var/spool'), 0o1777) } }), SMOKE_OK)
  const world = 'these are world-writable, outside WRITABLE_EXCLUDES (template.mjs), and no sticky directory: '
  const changeable = 'a user other than root can change these (in agent\'s own PATH directories, a user other than root or agent), which root or a run-as user runs or dsh imports (on root\'s or a run-as user\'s PATH, or in dsh\'s code tree): '
  const at = (mode, path) => `${mode} ${ME.owner} T/${path}`
  // E2B's build: /usr/local/bin and its node, envd and /etc/inittab world-writable, and the ports marker, which the
  // start script's repair fixes before it reads it; then a world-writable directory elsewhere, and group-writable (by a
  // group other than root) a PATH directory, a module in /src and one in npm's global root.
  for (const [path, mode, why] of [
    ['usr/local/bin', 0o777, world + at('drwxrwxrwx', 'usr/local/bin')],
    ['usr/local/bin/node', 0o777, world + at('-rwxrwxrwx', 'usr/local/bin/node')],
    ['usr/bin/envd', 0o777, world + at('-rwxrwxrwx', 'usr/bin/envd')],
    ['etc/inittab', 0o666, world + at('-rw-rw-rw-', 'etc/inittab')],
    ['usr/local/share/mumbo/ports', 0o666, world + at('-rw-rw-rw-', 'usr/local/share/mumbo/ports')],
    ['var/lib', 0o777, world + at('drwxrwxrwx', 'var/lib')],
    ['usr/local/bin', 0o775, changeable + at('drwxrwxr-x', 'usr/local/bin')],
    ['src/node_modules/pkg', 0o775, changeable + at('drwxrwxr-x', 'src/node_modules/pkg')],
    ['usr/local/lib/node_modules/npm', 0o775, changeable + at('drwxrwxr-x', 'usr/local/lib/node_modules/npm')],
  ]) assert.deepEqual(smoke({ setup: (root) => chmodSync(join(root, path), mode) }), smokeFailed(why), `${path} ${mode.toString(8)}`)
})

test('template: agent may own the directories in its home on its own PATH, but none on root\'s or another user\'s PATH, and the dsh smoke check fails when agent cannot install into its own prefixes', (t) => {
  if (spawnSync('sh', ['-c', 'command -v setsid']).status !== 0) return t.skip('setsid is not installed on this host')
  // agent's prefixes, from the rows: in its home and on its PATH alone.
  for (const person of [true, false]) assert.ok(dshSmokeStep(person).includes(' && O=$(for d in /home/agent/.npm-global/bin /home/agent/.local/bin; do [ ! -d "$d" ] || readlink -f "$d"; done | sort -u) && '))
  // Every file reads as agent's, none as root's: the root-only PATH directories (mcpserver's /usr/local/bin among them)
  // and dsh's code tree fail, and agent's npm prefix passes unless another user can write it.
  for (const mode of [0o755, 0o775]) {
    const out = smoke({ setup: (root) => {
      mkdirSync(join(root, 'home/agent/.npm-global/bin'), { recursive: true }); chmodSync(join(root, 'home/agent/.npm-global/bin'), mode)
      fakeFind(join(root, 'bin'), 4000098, ME.uid)
    } })
    assert.equal(out.code, 1, mode.toString(8))
    for (const p of ['usr/local/bin', 'src/node_modules/pkg']) assert.match(out.err, new RegExp(`(^| )drwxr-xr-x ${ME.owner} T/${p}$`, 'm'), p)
    assert.equal(/ T\/home\/agent\/\.npm-global\/bin$/m.test(out.err), mode === 0o775, mode.toString(8))
  }
  // agent's npm or pip fails: so does the build, with their output.
  assert.deepEqual(smoke({ su: 'echo "npm error code EACCES"; exit 1' }), smokeFailed('agent could not install packages into its own prefixes (npm -g, pip in a venv): npm error code EACCES'))
})

test('agentInstallScript: with agent\'s environment from the rows, npm -g installs into agent\'s prefix and runs from its PATH, and a venv\'s pip installs and imports a local wheel, offline', (t) => {
  if (spawnSync('sh', ['-c', 'command -v npm && python3 -c "import ensurepip, venv"']).status !== 0) return t.skip('npm, or python3 with venv and ensurepip, is not installed on this host')
  for (const person of [true, false]) {
    const r = mkdtempSync(join(tmpdir(), 'agent-install-'))
    try {
      mkdirSync(join(r, 'home/agent/tmp'), { recursive: true })
      const out = spawnSync('/bin/sh', ['-c', agentInstallScript(person).replaceAll('/home/agent', `${r}/home/agent`)], { encoding: 'utf8', env: {}, timeout: 120000 })
      assert.equal(out.status, 0, out.stdout + out.stderr)
      assert.equal(readlinkSync(join(r, 'home/agent/.npm-global/bin/mumbo-smoke')), '../lib/node_modules/mumbo-smoke/cli.js')
    } finally { rmSync(r, { recursive: true, force: true }) }
  }
})

test('the RUNBOOK gates a new template on a throwaway person box and project box whose dsh.log names no entry that did not activate, computer-use-x11 included', () => {
  const runbook = readFileSync(new URL('../RUNBOOK.md', import.meta.url), 'utf8')
  const section = (h) => { const i = runbook.indexOf(`\n### ${h}\n`); return runbook.slice(i, runbook.indexOf('\n#', i + 1)) }
  const bullet = (h, b) => section(h).split('\n').find(l => l.startsWith(`- **${b}.**`))
  const gate = "grep -n ' did not activate$' /root/dsh.log"
  const rebuild = section('Rebuild the box template')
  for (const text of [gate, "awk '/^dsh: .* did not activate$/ { p = 1 } p' /root/dsh.log", 'throwaway person box', 'throwaway project box', '`computer-use-x11`', 'INACTIVE_ALLOWLIST']) assert.ok(rebuild.includes(text), text)
  for (const b of ['Rollout', 'Checked only on a real box']) assert.ok(bullet('Agent containment (B24)', b).includes(gate) && bullet('Agent containment (B24)', b).includes('`computer-use-x11` included'), b)
  // The build's own check accepts computer use alone, which the throwaway person box covers.
  assert.deepEqual(INACTIVE_ALLOWLIST.map(e => e.id), ['computer-use-x11'])
})
