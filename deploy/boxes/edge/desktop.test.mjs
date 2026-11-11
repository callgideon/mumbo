// node --test deploy/boxes/edge/desktop.test.mjs
// The person box's desktop (edge startScript desktop block) and its template steps (template.mjs BOX_STEPS). The loops run
// through sh in a temporary root with fake XFCE, D-Bus and Chrome programs, and only those on PATH.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { startScript, boxSite } from './edge.mjs'
import { BOX_STEPS, KASMVNC, chromePolicyStep, kasmvncStep, maskingGuardStep } from './template.mjs'

const c = { llmHost: 'l', publicHost: 'boxes.x' }
const person = startScript(c, 'T', boxSite(c, 'a@x.com'), 'role', undefined, {})
const at = (text, needle) => { const i = text.indexOf(needle); assert.ok(i >= 0, `missing: ${needle}`); return i }
/** The body the start script writes to `path` with a quoted heredoc. */
const heredoc = (path) => { const head = `cat > ${path} <<'SH'\n`; const i = at(person, head) + head.length; return person.slice(i, person.indexOf('\nSH\n', i) + 1) }
/** What start.sh sets before the desktop block: the template gate, the live view's port (the marker's on a B24 template,
 *  edge PORTS) and the firewall helper. */
const prelude = (b24 = '') => `B24_TEMPLATE=${b24} IP6= LIVE_PORT=${b24 ? '881' : '6080'}\n${person.split('\n').find(l => l.startsWith('rule() { '))}\n`
/** The whole desktop block, run as start.sh runs it (`set -eu`, `$ip` set); it appends `reached` to log/dsh when dsh's
 *  start would run. `b24`: on a template with the B24 marker. */
const block = (b24) => `set -eu\nip=127.0.0.1\n${prelude(b24)}${person.slice(at(person, 'if id browser >/dev/null 2>&1; then'), person.indexOf('\nfi\n', at(person, '/usr/local/bin/mumbo-browser >/tmp/chrome.log')) + 4)}echo reached >> /tmp/dsh\n`
/** The test's own user stands in for browser, and one of its supplementary groups, if any, for shared. */
const USER = userInfo().username
const GROUP = execFileSync('id', ['-Gn'], { encoding: 'utf8' }).trim().split(' ')[1]
/** How the fake Chrome answers the version check that runs before the browser loop. */
const VERSION = '[ "$1" = --version ] && { echo "Google Chrome 142.0.7444.59 "; exit; }\n'
const REAL = ['sleep', 'pgrep', 'rm', 'grep', 'head', 'sort', 'tail', 'date', 'mv', 'cat', 'chmod', 'mkdir', 'touch', 'wc', 'nohup', 'install', 'rmdir', 'chgrp', 'find']

/** A temporary root: box paths moved under it, a private debugging port, process checks that see only its own fakes,
 *  and PATH holding only fakes and REAL tools. */
function box() {
  const t = mkdtempSync(join(tmpdir(), 'desktop-'))
  const port = String(20000 + Math.floor(Math.random() * 40000))
  for (const d of ['bin', 'fake', 'home', 'log', 'root', 'outside', 'shared', 'run']) mkdirSync(join(t, d))
  for (const tool of REAL) symlinkSync(execFileSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim(), join(t, 'fake', tool))
  const groups = []
  const b = {
    t, port,
    /** Box paths moved under t; `as` is the user that stands in for browser. */
    local: (text, as = USER) => text.replaceAll('/tmp/', `${t}/log/`).replaceAll('/etc/', `${t}/etc/`).replaceAll('/root/', `${t}/root/`).replaceAll('/usr/local/bin/', `${t}/bin/`).replaceAll('/home/browser/', `${t}/home/`).replaceAll('/home/shared', `${t}/shared`).replaceAll('/run/x11', `${t}/run/x11`)
      .replaceAll('remote-debugging-port=9222', `remote-debugging-port=${port}`).replaceAll('pgrep -f websockify', `pgrep -f ${t}/fake/websockify`).replace(/pgrep (?:-u xvnc )?-x (Xkasmvnc|Xvfb|x11vnc)/g, `pgrep -f ${t}/fake/$1`).replaceAll('-u browser', `-u ${as}`).replaceAll('"$(id -un)" = browser', `"$(id -un)" = ${as}`).replaceAll('chgrp -hR shared', `chgrp -hR ${GROUP ?? USER}`),
    fake: (name, body) => { rmSync(join(t, 'fake', name), { force: true }); writeFileSync(join(t, 'fake', name), `#!/bin/sh\n${body}\n`); chmodSync(join(t, 'fake', name), 0o755) },
    /** Runs sh text from a file, as the box runs start.sh, in its own process group, which done() kills with everything it
     *  started. */
    run: (text) => {
      const file = join(t, `run-${groups.length}.sh`)
      writeFileSync(file, text)
      const p = spawn('/bin/sh', [file], { detached: true, stdio: 'ignore', env: { PATH: join(t, 'fake'), HOME: t } })
      groups.push(p.pid)
      return p.pid
    },
    kill: (pid) => { try { process.kill(-pid, 'SIGKILL') } catch { /* ESRCH: the group has already exited */ } },
    lines: (name) => existsSync(join(t, 'log', name)) ? readFileSync(join(t, 'log', name), 'utf8').trim().split('\n') : [],
    count: (pattern) => spawnSync('pgrep', ['-f', pattern], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).length,
    done: () => { for (const g of groups) b.kill(g); rmSync(t, { recursive: true, force: true }) },
  }
  // The box's files as the start script writes them.
  for (const f of ['google-chrome', 'mumbo-desktop', 'mumbo-browser']) { writeFileSync(join(t, 'bin', f), b.local(heredoc(`/usr/local/bin/${f}`))); chmodSync(join(t, 'bin', f), 0o755) }
  b.fake('dbus-launch', 'sleep 30 >/dev/null 2>&1 &\necho "DBUS_SESSION_BUS_ADDRESS=unix:fake; export DBUS_SESSION_BUS_ADDRESS; DBUS_SESSION_BUS_PID=$!;"')
  b.fake('xfconf-query', `echo "xfconf-query $*" >> ${t}/log/session`)
  // `id browser` succeeds; anything else is the real id. su runs the command as the test user, setting SHELL as util-linux su -s does.
  b.fake('id', `[ "$*" = browser ] && exit 0; exec ${execFileSync('sh', ['-c', 'command -v id'], { encoding: 'utf8' }).trim()} "$@"`)
  b.fake('su', 'export SHELL="$3"; exec /bin/sh -c "$5"')
  b.fake('iptables', 'exit 0')
  // KasmVNC's server logs its arguments; the stack of a template before it logs its name.
  b.fake('Xkasmvnc', `echo "$*" >> ${t}/log/xvnc; sleep 30`)
  for (const name of ['Xvfb', 'x11vnc', 'websockify']) b.fake(name, `echo "${name} $*" >> ${t}/log/old; sleep 30`)
  return b
}

test('person start script: XFCE on :1 with bash as its shell (as xsession on the B24 template, browser before it), Chrome on its own new profile with CDP on loopback, the shared Downloads repaired', () => {
  assert.ok(person.includes(`pgrep -f /usr/local/bin/mumbo-desktop >/dev/null || su "$SESSION_USER" -s /bin/sh -c 'SHELL=/bin/bash DISPLAY=:1 /usr/local/bin/mumbo-desktop >/tmp/desktop.log 2>&1 &'\n`))
  assert.ok(person.includes('\n  SESSION_USER=browser X_OWNER=browser:xvnc\n  if [ -n "$B24_TEMPLATE" ]; then SESSION_USER=xsession X_OWNER=root:desktop; fi\n'))
  assert.ok(person.includes(`pgrep -f /usr/local/bin/mumbo-browser >/dev/null || su browser -s /bin/sh -c 'DISPLAY=:1 /usr/local/bin/mumbo-browser >/tmp/chrome.log 2>&1 &'\n`))
  assert.ok(person.includes(`\n  if getent group shared >/dev/null 2>&1 && [ ! -L /home/shared ] && [ ! -L /home/shared/Downloads ]; then install -d -o browser -g shared -m 2770 /home/shared/Downloads 2>/dev/null || echo 'shared downloads folder not repaired' >&2; fi\n`))
  assert.ok(at(person, 'install -d -o browser -g shared') < at(person, "DISPLAY=:1 /usr/local/bin/mumbo-browser"))
  assert.ok(heredoc('/usr/local/bin/mumbo-browser').startsWith('#!/bin/sh\nchmod 0700 /home/browser/\nif [ -d /home/browser/Downloads ] && [ ! -L /home/browser/Downloads ] && [ -d /home/shared/Downloads ]; then\n'))
  assert.equal(heredoc('/usr/local/bin/google-chrome'), '#!/bin/sh\nb=$(command -v google-chrome-stable) && p=/home/browser/chrome-profile || { b=chromium; p=/home/browser/profile; }\n[ "$(id -un)" != xsession ] || exec wmctrl -x -a google-chrome\n[ "$(id -un)" = browser ] || exec "$b" "$@"\nexec "$b" --user-data-dir=$p --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 --no-first-run --no-default-browser-check --password-store=basic --start-maximized "$@"\n')
  assert.ok(at(person, 'export XAUTHORITY=/run/x11/auth') < at(person, 'su "$SESSION_USER" -s /bin/sh -c \'SHELL=/bin/bash DISPLAY=:1 /usr/local/bin/mumbo-desktop'))
  // The display server, KasmVNC's or the older template's, starts before the desktop session and the browser.
  for (const server of ['Xkasmvnc :1', 'Xvfb :1', 'x11vnc -display :1']) assert.ok(at(person, server) < at(person, 'DISPLAY=:1 /usr/local/bin/mumbo-desktop'), server)
  assert.ok(person.includes('127.0.0.1:5900 >/root/websockify.log 2>&1 &\n'), 'root logs to its own directory, not to a /tmp name browser can plant')
  assert.ok(!person.includes('DISPLAY=:1 chromium') && !person.includes('DISPLAY=:1 openbox'), 'the browser and window manager start only through their loops')
  // No WebGL fallback (spec "No WebGL fallback"): Chrome never gets SwiftShader.
  assert.ok(!/swiftshader/i.test(person))
})

/** The arguments the start script gives KasmVNC on a box with the X cookie at `auth` and address 127.0.0.1, flag by flag. */
const xvncArgs = (auth, port = '6080') => [
  [':1'],
  ['-auth', auth],  // only cookie holders (browser, root) reach :1, as with Xvfb
  ['-geometry', '1600x900'], ['-depth', '24'],  // the cap is also the size before a viewer resizes; Chrome needs 24 bits
  ['-nolisten', 'tcp'],  // X itself on its local socket only
  ['-interface', '127.0.0.1'], ['-websocketPort', port],  // the box address and the live view's port, which the edge reaches
  ['-httpd', '/usr/share/kasmvnc/www'],  // its web client at /
  ['-DisableBasicAuth'], ['-sslOnly=0'], ['-SecurityTypes', 'None'],  // its own login, TLS and VNC password off: the edge is the gate
  ['-PublicIP', '127.0.0.1'],  // no STUN query at start
  ['-FrameRate', '30'], ['-RectThreads', '2'], ['-IgnoreClientSettingsKasm'],  // a viewer cannot raise the frame rate
  ['-DLP_ClipTypes', 'text/plain'], ['-DLP_ClipSendMax', '262144'], ['-DLP_ClipAcceptMax', '262144'], ['-DLP_ClipDelay', '500'],  // text only, limited
].flat().join(' ')

test('KasmVNC runs as xvnc on :1 with the X cookie and each flag, once per re-run, and no part of the older stack starts', async () => {
  // xvnc, not browser: browser runs Chrome, and whatever answers on :6080 serves pages on dsh's origin.
  assert.ok(person.includes('pgrep -u xvnc -x Xkasmvnc >/dev/null || { su xvnc -s /bin/sh -c "Xkasmvnc :1 '))
  const b = box()
  try {
    b.fake('xauth', 'printf cookie > "$3"'); b.fake('mcookie', 'echo 0123'); b.fake('chown', `echo "$*" >> ${b.t}/log/chown`)
    b.fake('Xkasmvnc', `echo "$* [$XAUTHORITY]" >> ${b.t}/log/xvnc; sleep 30`)
    b.fake('startxfce4', 'sleep 30'); b.fake('google-chrome-stable', `${VERSION}sleep 30`)
    b.run(b.local(block()))
    await sleep(1500)
    b.run(b.local(block()))
    await sleep(1500)
    assert.deepEqual(b.lines('xvnc'), [`${xvncArgs(`${b.t}/run/x11/auth`)} [${b.t}/run/x11/auth]`])
    assert.equal(readFileSync(join(b.t, 'run/x11/auth'), 'utf8'), 'cookie')
    // The cookie stays browser's; the server reads it through its group.
    assert.deepEqual([b.lines('chown').map(l => l.replaceAll(b.t, 'T')), statSync(join(b.t, 'run/x11/auth')).mode & 0o777], [['browser T/run/x11/auth', 'browser:xvnc T/run/x11/auth', 'browser:xvnc T/run/x11/auth'], 0o640])
    assert.deepEqual([b.lines('old'), b.lines('dsh')], [[], ['reached', 'reached']])
  } finally { b.done() }
})

test('B24 template: the live view on the marker\'s port, the X cookie root:desktop 0640, XFCE as xsession and Chrome as browser, and no iptables INPUT rules, which a template before it inserts best effort', async () => {
  /** The desktop block on a B24 template (or before it) with `iptables` the fake's body; what it started, as T paths. */
  const run = async (iptables, b24 = '1') => {
    const b = box()
    try {
      b.fake('xauth', 'printf cookie > "$3"'); b.fake('mcookie', 'echo 0123'); b.fake('chown', `echo "$*" >> ${b.t}/log/chown`)
      b.fake('su', `echo "$1" >> ${b.t}/log/su; export SHELL="$3"; exec /bin/sh -c "$5"`)
      b.fake('iptables', iptables(b.t))
      b.fake('startxfce4', 'sleep 30'); b.fake('google-chrome-stable', `${VERSION}sleep 30`)
      b.run(b.local(block(b24)))
      await sleep(1500)
      const auth = join(b.t, 'run/x11/auth')
      return { xvnc: b.lines('xvnc').map(l => l.replaceAll(b.t, 'T')), chown: b.lines('chown').map(l => l.replaceAll(b.t, 'T')), su: b.lines('su').sort(), iptables: b.lines('iptables'), dsh: b.lines('dsh'), mode: existsSync(auth) ? statSync(auth).mode & 0o777 : undefined }
    } finally { b.done() }
  }
  const logged = (t) => `echo "$*" >> ${t}/log/iptables; [ "$1" != -C ]`
  const r = await run(logged)
  assert.deepEqual(r.xvnc, [xvncArgs('T/run/x11/auth', '881')])
  assert.deepEqual([r.chown, r.mode], [['browser T/run/x11/auth', 'root:desktop T/run/x11/auth'], 0o640])
  assert.deepEqual(r.su, ['browser', 'xsession', 'xvnc'])
  // The nftables input chain keeps these ports box-local (edge hardening; containment.test.mjs).
  assert.deepEqual(r.iptables, [])
  assert.deepEqual(r.dsh, ['reached'])
  // Before the marker each rule is checked (-C) and, when absent, inserted (-I).
  const old = await run(logged, '')
  assert.deepEqual(old.iptables.filter(l => l.startsWith('-I')), ['-I INPUT -p tcp --dport 9222 ! -i lo -j DROP', '-I INPUT -p tcp --dport 5900:5999 ! -i lo -j DROP', '-I INPUT -p udp --dport 6080 ! -i lo -j DROP'])
  assert.deepEqual(old.iptables.filter(l => l.startsWith('-C')).map(l => l.replace('-C', '-I')), old.iptables.filter(l => l.startsWith('-I')))
  // A failed rule is passed over, as before, and the session and cookie stay browser's.
  const before = await run(() => 'exit 1', '')
  assert.deepEqual([before.su, before.chown, before.dsh], [['browser', 'browser', 'xvnc'], ['browser T/run/x11/auth', 'browser:xvnc T/run/x11/auth'], ['reached']])
})

test('the RUNBOOK\'s desktop section names the pinned KasmVNC, every flag the start script gives it with its value, and the measurements', () => {
  const runbook = readFileSync(new URL('../RUNBOOK.md', import.meta.url), 'utf8')
  const section = runbook.slice(at(runbook, '### Person box desktop and Google Chrome\n'), runbook.indexOf('\n### ', at(runbook, '### Person box desktop and Google Chrome\n')))
  const line = person.slice(at(person, 'Xkasmvnc :1 '), person.indexOf(' >/tmp/xvnc.log', at(person, 'Xkasmvnc :1 ')))
  // Each flag with its value, if it takes one: `-FrameRate 30`, `-DisableBasicAuth`.
  const flags = line.match(/-\S+(?: [^-\s]\S*)?/g)
  assert.equal(flags.length, 17)
  for (const needle of [KASMVNC.version, KASMVNC.sha256, '-auth /run/x11/auth', ...flags, 'Selkies 2.x', 'Keypress to glyph', 'Idle CPU', 'Frame rate', 'Updating KasmVNC']) assert.ok(section.includes(needle), needle)
})

test('a template before KasmVNC runs Xvfb, x11vnc and websockify with noVNC, as before', async () => {
  const b = box()
  try {
    rmSync(join(b.t, 'fake/Xkasmvnc'))
    b.fake('startxfce4', 'sleep 30'); b.fake('google-chrome-stable', `${VERSION}sleep 30`)
    b.run(b.local(block()))
    await sleep(1500)
    assert.deepEqual(b.lines('old').sort(), ['Xvfb :1 -screen 0 1440x900x24 -nolisten tcp', 'websockify --web /usr/share/novnc 127.0.0.1:6080 127.0.0.1:5900', 'x11vnc -display :1 -localhost -forever -shared -nopw -rfbport 5900 -quiet'])
    assert.deepEqual([b.lines('xvnc'), b.lines('dsh')], [[], ['reached']])
  } finally { b.done() }
})

test('the desktop session runs XFCE with xfwm4 compositing off, on its own D-Bus (none left from an earlier start), and starts again after it ends', async () => {
  const b = box()
  try {
    b.fake('startxfce4', `echo "startxfce4 [$DBUS_SESSION_BUS_ADDRESS]" >> ${b.t}/log/session`)
    // The second dbus-launch fails, printing nothing.
    b.fake('dbus-launch', `[ -e ${b.t}/bus ] && exit 1; touch ${b.t}/bus\nsleep 30 >/dev/null 2>&1 &\necho "DBUS_SESSION_BUS_ADDRESS=unix:fake; export DBUS_SESSION_BUS_ADDRESS; DBUS_SESSION_BUS_PID=$!;"`)
    b.run(`${b.t}/bin/mumbo-desktop`)
    await sleep(3000)
    const lines = b.lines('session')
    assert.deepEqual(lines.slice(0, 4), ['xfconf-query -c xfwm4 -p /general/use_compositing -n -t bool -s false', 'startxfce4 [unix:fake]', 'xfconf-query -c xfwm4 -p /general/use_compositing -n -t bool -s false', 'startxfce4 []'])
  } finally { b.done() }
})

test('the desktop session is openbox on a template without XFCE', async () => {
  const b = box()
  try {
    b.fake('openbox', `echo openbox >> ${b.t}/log/session`)
    b.run(`${b.t}/bin/mumbo-desktop`)
    await sleep(500)
    assert.deepEqual(b.lines('session'), ['openbox'])
  } finally { b.done() }
})

test('Chrome is started again within 5 s of exiting; one a launcher started is waited for, not doubled', async () => {
  const b = box()
  try {
    b.fake('google-chrome-stable', `${VERSION}echo "$(date +%s%3N) $*" >> ${b.t}/log/chrome\n[ -e ${b.t}/stay ] && sleep 30`)
    writeFileSync(join(b.t, 'stay'), '')
    const launcher = b.run(`${b.t}/bin/google-chrome`)
    await sleep(300)
    b.run(`${b.t}/bin/mumbo-browser`)
    await sleep(2500)
    assert.equal(b.lines('chrome').length, 1, 'the loop waits while the launcher\'s Chrome runs')
    rmSync(join(b.t, 'stay'))
    const closed = Date.now()
    b.kill(launcher)
    await sleep(4500)
    const starts = b.lines('chrome').slice(1).map(l => Number(l.split(' ')[0]))
    assert.ok(starts.length >= 2, `restarted: ${starts.length}`)
    for (const [i, s] of starts.entries()) assert.ok(s - (i ? starts[i - 1] : closed) < 5000, `start ${i} within 5 s`)
    assert.ok(b.lines('chrome').every(l => l.endsWith(` --user-data-dir=${b.t}/home/chrome-profile --remote-debugging-address=127.0.0.1 --remote-debugging-port=${b.port} --no-first-run --no-default-browser-check --password-store=basic --start-maximized`)))
  } finally { b.done() }
})

test('a Chrome on the profile without the debugging port is waited for: its Singleton lock stays and no second Chrome starts', async () => {
  const b = box()
  try {
    b.fake('google-chrome-stable', `${VERSION}echo start >> ${b.t}/log/chrome`)
    mkdirSync(join(b.t, 'home/chrome-profile'))
    writeFileSync(join(b.t, 'outside/keep'), 'keep')
    symlinkSync(join(b.t, 'outside/keep'), join(b.t, 'home/chrome-profile/SingletonLock'))
    b.run(`exec /bin/sh -c 'sleep 30; true' 'chrome --user-data-dir=${b.t}/home/chrome-profile'`)
    await sleep(300)
    b.run(`${b.t}/bin/mumbo-browser`)
    await sleep(2500)
    assert.deepEqual([b.lines('chrome'), readdirSync(join(b.t, 'home/chrome-profile')), readFileSync(join(b.t, 'outside/keep'), 'utf8')], [[], ['SingletonLock'], 'keep'])
  } finally { b.done() }
})

test('the google-chrome wrapper pins the profile only for browser; for any other user it is plain Chrome', () => {
  const b = box()
  try {
    b.fake('google-chrome-stable', `echo "$*" >> ${b.t}/log/chrome`)
    writeFileSync(join(b.t, 'bin/plain'), b.local(heredoc('/usr/local/bin/google-chrome'), 'browser')); chmodSync(join(b.t, 'bin/plain'), 0o755)
    execFileSync(join(b.t, 'bin/plain'), ['--headless', '--screenshot'], { env: { PATH: join(b.t, 'fake') } })
    execFileSync(join(b.t, 'bin/google-chrome'), ['https://x'], { env: { PATH: join(b.t, 'fake') } })
    assert.deepEqual(b.lines('chrome'), ['--headless --screenshot', `--user-data-dir=${b.t}/home/chrome-profile --remote-debugging-address=127.0.0.1 --remote-debugging-port=${b.port} --no-first-run --no-default-browser-check --password-store=basic --start-maximized https://x`])
  } finally { b.done() }
})

test('a re-run starts no second desktop session, browser loop or Chrome, and reaches dsh both times', async () => {
  const b = box()
  try {
    b.fake('startxfce4', `echo "start $SHELL" >> ${b.t}/log/xfce; sleep 30`)
    b.fake('google-chrome-stable', `${VERSION}echo start >> ${b.t}/log/chrome; sleep 30`)
    b.run(b.local(block()))
    await sleep(2000)
    b.run(b.local(block()))
    await sleep(1500)
    assert.equal(b.count(`${b.t}/bin/mumbo-desktop`), 1)
    assert.equal(b.count(`${b.t}/bin/mumbo-browser`), 1)
    assert.equal(b.count(`${b.t}/fake/Xkasmvnc`), 1)
    assert.deepEqual([b.lines('xfce'), b.lines('chrome'), b.lines('dsh')], [['start /bin/bash'], ['start'], ['reached', 'reached']])
  } finally { b.done() }
})

test('root\'s part of the desktop block writes nothing under /home/browser, and a planted Downloads or log symlink moves no write outside it', async () => {
  const run = async (plant, su) => {
    const b = box()
    try {
      b.fake('startxfce4', 'sleep 30')
      b.fake('google-chrome-stable', `${VERSION}sleep 30`)
      if (su) b.fake('su', su)
      writeFileSync(join(b.t, 'outside/keep'), 'keep'); chmodSync(join(b.t, 'outside'), 0o700)
      plant(b)
      const before = readdirSync(join(b.t, 'home')).sort()
      b.run(b.local(block()))
      await sleep(1500)
      assert.deepEqual([readdirSync(join(b.t, 'outside')), readFileSync(join(b.t, 'outside/keep'), 'utf8'), statSync(join(b.t, 'outside')).mode & 0o777], [['keep'], 'keep', 0o700], 'outside unchanged')
      assert.deepEqual(b.lines('dsh'), ['reached'])
      return { before, after: readdirSync(join(b.t, 'home')).sort() }
    } finally { b.done() }
  }
  // su that runs nothing: what remains is root's own part.
  const rootOnly = await run(() => {}, 'exit 0')
  assert.deepEqual(rootOnly.after, rootOnly.before)
  await run((b) => { symlinkSync(join(b.t, 'outside'), join(b.t, 'home/Downloads')); symlinkSync(join(b.t, 'outside/keep'), join(b.t, 'log/websockify.log')) })
  const file = await run((b) => writeFileSync(join(b.t, 'home/Downloads'), 'a file'))
  assert.deepEqual(file.after, ['Downloads'])
})

test('root repairs /home/shared/Downloads as browser:shared 2770, never through a symlink, and only where the group exists', async () => {
  const repairs = async (plant, group = true) => {
    const b = box()
    try {
      for (const name of ['startxfce4', 'google-chrome-stable']) b.fake(name, `${VERSION}sleep 30`)
      b.fake('su', 'exit 0')
      b.fake('getent', group ? '[ "$*" = "group shared" ]' : 'exit 2')
      b.fake('install', `echo "$*" >> ${b.t}/log/install`)
      plant(b)
      b.run(b.local(block()))
      await sleep(1500)
      assert.deepEqual(b.lines('dsh'), ['reached'])
      return b.lines('install').map(l => l.replaceAll(b.t, 'T'))
    } finally { b.done() }
  }
  assert.deepEqual(await repairs(() => {}), ['-d -o browser -g shared -m 2770 T/shared/Downloads'])
  assert.deepEqual(await repairs((b) => symlinkSync(join(b.t, 'outside'), join(b.t, 'shared/Downloads'))), [])
  assert.deepEqual(await repairs((b) => { rmSync(join(b.t, 'shared'), { recursive: true }); symlinkSync(join(b.t, 'outside'), join(b.t, 'shared')) }), [])
  assert.deepEqual(await repairs(() => {}, false), [])
})

test('the browser loop keeps its home 0700 and moves ~/Downloads into the shared folder as browser, with group shared and setgid folders, keeping both sides of a name clash and never following a link', () => {
  const pre = heredoc('/usr/local/bin/mumbo-browser').split('while :; do')[0]
  const b = box()
  try {
    b.fake('google-chrome-stable', 'exit 1')
    writeFileSync(join(b.t, 'outside/keep'), 'keep')
    const run = () => { writeFileSync(join(b.t, 'pre.sh'), b.local(pre)); execFileSync('/bin/sh', [join(b.t, 'pre.sh')], { env: { PATH: join(b.t, 'fake') } }) }
    const old = join(b.t, 'home/Downloads'), shared = join(b.t, 'shared/Downloads')
    mkdirSync(old); mkdirSync(shared); mkdirSync(join(old, 'unz')); chmodSync(join(b.t, 'home'), 0o755)
    for (const [n, v] of [['a.pdf', 'a'], ['.hidden', 'h'], ['-dash', 'd'], ['clash', 'old'], ['unz/in.txt', 'i']]) writeFileSync(join(old, n), v)
    writeFileSync(join(shared, 'clash'), 'new')
    symlinkSync(join(b.t, 'outside/keep'), join(old, 'link'))
    run()
    assert.equal(statSync(join(b.t, 'home')).mode & 0o777, 0o700)
    assert.deepEqual(readdirSync(shared).sort(), ['-dash', '.hidden', 'a.pdf', 'clash', 'link', 'unz'])
    assert.ok(statSync(join(shared, 'unz')).mode & 0o2000, 'a moved folder is setgid')
    if (GROUP) {
      const gid = Number(execFileSync('getent', ['group', GROUP], { encoding: 'utf8' }).split(':')[2])
      for (const n of ['a.pdf', '-dash', 'unz', 'unz/in.txt']) assert.equal(statSync(join(shared, n)).gid, gid, n)
      assert.equal(lstatSync(join(shared, 'link')).gid, gid)
      assert.notEqual(statSync(join(shared, 'clash')).gid, gid, 'the shared side of a clash is untouched')
    }
    assert.deepEqual([readFileSync(join(shared, 'clash'), 'utf8'), readFileSync(join(old, 'clash'), 'utf8'), readdirSync(old)], ['new', 'old', ['clash']])
    assert.ok(lstatSync(join(shared, 'link')).isSymbolicLink())
    assert.deepEqual([readdirSync(join(b.t, 'outside')), readFileSync(join(b.t, 'outside/keep'), 'utf8')], [['keep'], 'keep'])
    rmSync(join(old, 'clash')); run()
    assert.equal(existsSync(old), false, 'the emptied folder is removed')
    // A ~/Downloads that is a symlink is left alone.
    symlinkSync(join(b.t, 'outside'), old); run()
    assert.deepEqual([readdirSync(join(b.t, 'outside')), lstatSync(old).isSymbolicLink()], [['keep'], true])
  } finally { b.done() }
})

test('with Google Chrome the old Chromium profile and the copy B18 moved aside are deleted, as browser, at every start, never through a symlink (B24)', () => {
  const pre = heredoc('/usr/local/bin/mumbo-browser').split('while :; do')[0]
  const b = box()
  try {
    const home = join(b.t, 'home'), old = join(home, '.chromium-profile-old')
    const run = (chrome = true) => {
      if (chrome) b.fake('google-chrome-stable', 'exit 0'); else rmSync(join(b.t, 'fake/google-chrome-stable'), { force: true })
      writeFileSync(join(b.t, 'pre.sh'), b.local(pre)); execFileSync('/bin/sh', [join(b.t, 'pre.sh')], { env: { PATH: join(b.t, 'fake') } })
      return readdirSync(home).sort()
    }
    const profile = (dir) => { mkdirSync(join(dir, 'Default'), { recursive: true }); writeFileSync(join(dir, 'Default/Login Data'), 'old passwords'); chmodSync(dir, 0o755) }
    mkdirSync(join(home, 'chrome-profile'))
    // The Chromium fallback keeps its profile in place.
    profile(join(home, 'profile'))
    assert.deepEqual(run(false), ['chrome-profile', 'profile'])
    // Google Chrome: both go, Chrome's own profile stays; a repeat, and a restored backup's ~/profile, are deleted again.
    profile(old)
    assert.deepEqual(run(), ['chrome-profile'])
    assert.deepEqual(run(), ['chrome-profile'])
    profile(join(home, 'profile'))
    assert.deepEqual(run(), ['chrome-profile'])
    // A symlink planted at either name is removed, never what it points at.
    writeFileSync(join(b.t, 'outside/keep'), 'keep')
    symlinkSync(join(b.t, 'outside'), old); symlinkSync(join(b.t, 'outside'), join(home, 'profile'))
    assert.deepEqual(run(), ['chrome-profile'])
    assert.deepEqual([readdirSync(join(b.t, 'outside')), readFileSync(join(b.t, 'outside/keep'), 'utf8')], [['keep'], 'keep'])
    // It runs as browser: the start script starts the loop through su browser.
    assert.ok(person.includes("su browser -s /bin/sh -c 'DISPLAY=:1 /usr/local/bin/mumbo-browser"))
  } finally { b.done() }
})

test('template: Google Chrome stable from Google\'s signed amd64 repository and the XFCE desktop, in place of Chromium and openbox', () => {
  const install = BOX_STEPS.find(s => s.startsWith('apt-get update'))
  const repo = 'echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.asc] https://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list'
  assert.ok(at(install, 'curl -fsSL https://dl.google.com/linux/linux_signing_key.pub -o /etc/apt/keyrings/google-chrome.asc') < at(install, repo))
  const packages = install.slice(at(install, repo)).match(/apt-get install -y --no-install-recommends ([^&]+) &&/)[1].trim().split(' ')
  for (const p of ['google-chrome-stable', 'xfce4-session', 'xfwm4', 'xfce4-panel', 'xfdesktop4', 'thunar', 'xfce4-terminal', 'tango-icon-theme', 'librsvg2-common', 'dbus-x11', 'xdotool', 'wmctrl', 'xauth']) assert.ok(packages.includes(p), p)
  // KasmVNC (its own step) replaces the virtual display, the VNC server, the WebSocket proxy and the web client.
  for (const p of ['chromium', 'openbox', 'xfce4', 'xvfb', 'x11vnc', 'novnc', 'websockify']) assert.ok(!packages.includes(p), p)
  assert.equal(BOX_STEPS[BOX_STEPS.indexOf(install) + 1], kasmvncStep(), 'KasmVNC is installed once curl is')
  assert.ok(BOX_STEPS.includes('id browser >/dev/null 2>&1 || useradd -m -s /bin/bash browser'))
  assert.ok(BOX_STEPS.includes('id xvnc >/dev/null 2>&1 || useradd -U -M -d /nonexistent -s /usr/sbin/nologin xvnc'), 'KasmVNC\'s own user')
  assert.ok(BOX_STEPS.indexOf('id browser >/dev/null 2>&1 || useradd -m -s /bin/bash browser') < BOX_STEPS.indexOf('groupadd -f shared && usermod -aG shared browser && chmod 0700 /home/browser && install -d -m 0755 /home/shared && install -d -o browser -g shared -m 2770 /home/shared/Downloads'))
})

test('template: KasmVNC 1.5.2 or later from its release, installed only when the download has the pinned sha256, with the screen cap in both entry pages', () => {
  assert.deepEqual(KASMVNC, { version: '1.5.2', sha256: '5f4bfda43e89178782eac37ae463b1d95d16ac5e45da8b7989ec75404e764993' })
  // 1.3.2 fixed a web-server path traversal (CVE-2024-38449) and 1.5.2 a WebSocket handshake buffer overflow.
  const [major, minor, patch] = KASMVNC.version.split('.').map(Number)
  assert.ok(major > 1 || (major === 1 && (minor > 5 || (minor === 5 && patch >= 2))), KASMVNC.version)
  assert.ok(kasmvncStep().startsWith('curl -fsSL -o /tmp/kasmvncserver_debian_bookworm_1.5.2_amd64.deb https://github.com/kasmtech/KasmVNC/releases/download/v1.5.2/kasmvncserver_debian_bookworm_1.5.2_amd64.deb && echo "5f4bfda43e89178782eac37ae463b1d95d16ac5e45da8b7989ec75404e764993  /tmp/kasmvncserver_debian_bookworm_1.5.2_amd64.deb" | sha256sum -c - && apt-get update && '))
  const t = mkdtempSync(join(tmpdir(), 'kasmvnc-'))
  // The cap, and no Displays button: its additional displays size the screen to their own windows.
  const STYLE = '<style>#noVNC_container>div{max-width:1600px;max-height:900px}#noVNC_displays_button{display:none!important}</style>'
  const PAGE = '<!DOCTYPE html><html><head><title>KasmVNC</title></head><body></body></html>'
  /** Runs the step with curl downloading `download` and apt-get logging its arguments; box paths moved under t. */
  const run = (download, step = kasmvncStep({ version: '1.5.2', sha256: createHash('sha256').update('the release').digest('hex') }), pages = [PAGE, PAGE]) => {
    rmSync(t, { recursive: true, force: true })
    for (const d of ['fake', 'tmp', 'www', 'lists']) mkdirSync(join(t, d), { recursive: true })
    writeFileSync(join(t, 'download'), download)
    for (const [i, name] of ['index.html', 'vnc.html'].entries()) writeFileSync(join(t, 'www', name), pages[i])
    for (const [name, body] of [['curl', `echo "$4" >> ${t}/curl; cp ${t}/download "$3"`], ['apt-get', `echo "$*" >> ${t}/apt`]]) { writeFileSync(join(t, 'fake', name), `#!/bin/sh\n${body}\n`); chmodSync(join(t, 'fake', name), 0o755) }
    const local = step.replaceAll('/tmp/', `${t}/tmp/`).replaceAll('/usr/share/kasmvnc/www/', `${t}/www/`).replaceAll('/var/lib/apt/lists/', `${t}/lists/`)
    const r = spawnSync('sh', ['-c', local], { encoding: 'utf8', env: { PATH: `${join(t, 'fake')}:${process.env.PATH}` } })
    const read = (f) => existsSync(join(t, f)) ? readFileSync(join(t, f), 'utf8').replaceAll(t, 'T') : ''
    return { code: r.status, err: r.stderr.replaceAll(t, 'T'), curl: read('curl'), apt: read('apt'), pages: ['www/index.html', 'www/vnc.html'].map(read), deb: readdirSync(join(t, 'tmp')) }
  }
  try {
    const DEB = 'T/tmp/kasmvncserver_debian_bookworm_1.5.2_amd64.deb'
    const capped = PAGE.replace('</head>', `${STYLE}</head>`)
    assert.deepEqual(run('the release'), { code: 0, err: '', curl: 'https://github.com/kasmtech/KasmVNC/releases/download/v1.5.2/kasmvncserver_debian_bookworm_1.5.2_amd64.deb\n', apt: `update\ninstall -y --no-install-recommends ${DEB}\n`, pages: [capped, capped], deb: [] })
    // Fail-closed: a download that is not the pinned file installs nothing and fails the build.
    const bad = run('a tampered release')
    assert.deepEqual([bad.code, bad.apt, bad.pages], [1, '', [PAGE, PAGE]])
    assert.match(bad.err, /WARNING: 1 computed checksum did NOT match/)
    assert.equal(run('the release', kasmvncStep()).apt, '', 'the real pin does not match a fake file')
    // A web client whose page the cap cannot enter fails the build.
    const uncapped = run('the release', undefined, [PAGE, '<html><body></body></html>'])
    assert.deepEqual([uncapped.code, uncapped.err], [1, 'mumbo-box: no screen cap in T/www/vnc.html\n'])
  } finally { rmSync(t, { recursive: true, force: true }) }
})

test('template: Chrome\'s managed policy file, byte for byte, read-only to the browser user, without and with sensitive sync', () => {
  const t = mkdtempSync(join(tmpdir(), 'policy-'))
  try {
    const write = (step) => { rmSync(join(t, 'etc'), { recursive: true, force: true }); execFileSync('sh', ['-c', step.replaceAll('/etc/opt/chrome/', `${t}/etc/opt/chrome/`)]); return readFileSync(join(t, 'etc/opt/chrome/policies/managed/mumbo.json'), 'utf8') }
    const base = '"RestoreOnStartup":1,"DefaultBrowserSettingEnabled":false,"MetricsReportingEnabled":false,"DownloadDirectory":"/home/shared/Downloads","URLBlocklist":["chrome://password-manager","chrome://settings/passwords","chrome://settings/payments","chrome://settings/autofill","chrome://settings/addresses","chrome://sync-internals","chrome://autofill-internals","chrome://password-manager-internals"]'
    assert.equal(write(chromePolicyStep(false)), `{${base},"SyncTypesListDisabled":["passwords","payments"],"PasswordManagerEnabled":false,"AutofillCreditCardEnabled":false}\n`)
    assert.equal(statSync(join(t, 'etc/opt/chrome/policies/managed/mumbo.json')).mode & 0o777, 0o644)
    assert.equal(statSync(join(t, 'etc/opt/chrome/policies/managed')).mode & 0o777, 0o755)
    assert.equal(write(chromePolicyStep(true)), `{${base}}\n`)
    // Slice 3: full sync, passwords and cards included, now that browser snapshots mask them (B25).
    assert.ok(BOX_STEPS.includes(chromePolicyStep(true)) && !BOX_STEPS.includes(chromePolicyStep(false)))
  } finally { rmSync(t, { recursive: true, force: true }) }
})

test('template: full sync fails the build unless every installed copy of the patched playwright-core version carries the masking patch', () => {
  const t = mkdtempSync(join(tmpdir(), 'guard-'))
  const V = '1.63.0-alpha-2026-08-31'
  const PATCH = `patches/playwright-core@${V}.patch`
  const bundle = (dir) => `node_modules/.pnpm/${dir}/node_modules/playwright-core/lib/coreBundle.js`
  const MASKED = 'function maskedInjectedScriptSource() {}'
  const image = ({ consent = 'readonly deniedUrls: string[]', key = `playwright-core@${V}`, patchFile = true, copies = { [`playwright-core@${V}_patch_hash=abc`]: MASKED, 'playwright-core@1.61.1': 'unpatched' } } = {}) => {
    rmSync(t, { recursive: true, force: true })
    for (const [f, text] of [
      ['packages/mumbo/browser-consent/src/index.ts', consent],
      ['pnpm-workspace.yaml', `patchedDependencies:\n  'lexical@0.49.0': patches/lexical@0.49.0.patch\n${key ? `  ${key}: ${PATCH}\n` : ''}`],
      ...(patchFile ? [[PATCH, 'diff']] : []),
      ...Object.entries(copies).map(([dir, text]) => [bundle(dir), text]),
    ]) { mkdirSync(join(t, f, '..'), { recursive: true }); writeFileSync(join(t, f), text) }
    const r = spawnSync('sh', ['-c', maskingGuardStep(t)], { encoding: 'utf8' })
    return [r.status, r.stderr]
  }
  try {
    // Today's image: the patched version plus the test runner's unpatched 1.61.1, which is not checked.
    assert.deepEqual(image(), [0, ''])
    assert.deepEqual(image({ key: `'playwright-core@${V}'` }), [0, ''], 'a quoted key')
    assert.deepEqual(image({ consent: 'export const x = 1' }), [1, 'mumbo-box: this image has no B25 browser consent (deniedUrls)\n'])
    assert.deepEqual(image({ key: '' }), [1, 'mumbo-box: pnpm-workspace.yaml lists no playwright-core patch under patches/\n'])
    assert.deepEqual(image({ patchFile: false }), [1, 'mumbo-box: pnpm-workspace.yaml lists no playwright-core patch under patches/\n'])
    assert.deepEqual(image({ copies: { [`playwright-core@${V}_patch_hash=abc`]: 'unpatched' } }), [1, `mumbo-box: playwright-core@${V}_patch_hash=abc lacks the masking patch\n`])
    // A second, unpatched copy of the named version fails even beside a patched one; a patched other version satisfies nothing.
    assert.deepEqual(image({ copies: { [`playwright-core@${V}_patch_hash=abc`]: MASKED, [`playwright-core@${V}`]: 'unpatched' } }), [1, `mumbo-box: playwright-core@${V} lacks the masking patch\n`])
    assert.deepEqual(image({ copies: { 'playwright-core@1.61.1': MASKED } }), [1, `mumbo-box: playwright-core ${V} is not installed\n`])
    // Full sync is on, so the guard is the first step after the umask, before anything is installed.
    assert.equal(BOX_STEPS[1], maskingGuardStep())
  } finally { rmSync(t, { recursive: true, force: true }) }
})

test('template: the stock XFCE panels without the first-start dialog, and every browser launcher aimed at the box\'s one Chrome', () => {
  const t = mkdtempSync(join(tmpdir(), 'launchers-'))
  try {
    const put = (path, text) => { mkdirSync(join(t, path, '..'), { recursive: true }); writeFileSync(join(t, path), text) }
    put('etc/xdg/xfce4/panel/default.xml', 'PANELS\n')
    mkdirSync(join(t, 'etc/xdg/xfce4/xfconf/xfce-perchannel-xml'), { recursive: true })
    put('etc/xdg/xfce4/helpers.rc', 'WebBrowser=debian-sensible-browser\nMailReader=thunderbird\n')
    put('usr/share/applications/google-chrome.desktop', '[Desktop Entry]\nExec=/usr/bin/google-chrome-stable %U\n[Desktop Action new-private-window]\nExec=/usr/bin/google-chrome-stable --incognito\n')
    const step = BOX_STEPS.find(s => s.includes('xfce4-panel.xml'))
    execFileSync('sh', ['-c', step.replaceAll('/etc/', `${t}/etc/`).replaceAll('/usr/share/', `${t}/usr/share/`).replaceAll('/usr/local/share/', `${t}/usr/local/share/`)])
    assert.equal(readFileSync(join(t, 'etc/xdg/xfce4/xfconf/xfce-perchannel-xml/xfce4-panel.xml'), 'utf8'), 'PANELS\n')
    assert.equal(readFileSync(join(t, 'etc/xdg/xfce4/helpers.rc'), 'utf8'), 'WebBrowser=google-chrome\nMailReader=thunderbird\n')
    assert.equal(readFileSync(join(t, 'usr/local/share/applications/google-chrome.desktop'), 'utf8'), '[Desktop Entry]\nExec=/usr/local/bin/google-chrome %U\n[Desktop Action new-private-window]\nExec=/usr/local/bin/google-chrome --incognito\n')
  } finally { rmSync(t, { recursive: true, force: true }) }
})
