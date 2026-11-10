// node --test deploy/boxes/edge/desktop.test.mjs
// The person box's desktop (edge startScript desktop block) and its template steps (template.mjs BOX_STEPS). The loops run
// through sh in a temporary root with fake XFCE, D-Bus and Chrome programs, and only those on PATH.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { startScript, boxSite } from './edge.mjs'
import { BOX_STEPS } from './template.mjs'

const c = { llmHost: 'l', publicHost: 'boxes.x' }
const person = startScript(c, 'T', boxSite(c, 'a@x.com'), 'role', undefined, {})
const at = (text, needle) => { const i = text.indexOf(needle); assert.ok(i >= 0, `missing: ${needle}`); return i }
/** The body the start script writes to `path` with a quoted heredoc. */
const heredoc = (path) => { const head = `cat > ${path} <<'SH'\n`; const i = at(person, head) + head.length; return person.slice(i, person.indexOf('\nSH\n', i) + 1) }
/** The whole desktop block, run as start.sh runs it (`set -eu`, `$ip` set); it appends `reached` to log/dsh when dsh's start would run. */
const block = () => `set -eu\nip=127.0.0.1\n${person.slice(at(person, 'if id browser >/dev/null 2>&1; then'), person.indexOf('\nfi\n', at(person, 'websockify --web')) + 4)}echo reached >> /tmp/dsh\n`
/** The test's own user stands in for browser. */
const USER = userInfo().username
/** How the fake Chrome answers the version check that runs before the browser loop. */
const VERSION = '[ "$1" = --version ] && { echo "Google Chrome 142.0.7444.59 "; exit; }\n'
const REAL = ['sleep', 'pgrep', 'rm', 'grep', 'head', 'sort', 'tail', 'date', 'mv', 'cat', 'chmod', 'mkdir', 'touch', 'wc', 'nohup', 'install', 'rmdir']

/** A temporary root: box paths moved under it, a private debugging port, and PATH holding only fakes and REAL tools. */
function box() {
  const t = mkdtempSync(join(tmpdir(), 'desktop-'))
  const port = String(20000 + Math.floor(Math.random() * 40000))
  for (const d of ['bin', 'fake', 'home', 'log', 'root', 'outside', 'shared']) mkdirSync(join(t, d))
  for (const tool of REAL) symlinkSync(execFileSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim(), join(t, 'fake', tool))
  const groups = []
  const b = {
    t, port,
    /** Box paths moved under t; `as` is the user that stands in for browser. */
    local: (text, as = USER) => text.replaceAll('/tmp/', `${t}/log/`).replaceAll('/etc/', `${t}/etc/`).replaceAll('/root/', `${t}/root/`).replaceAll('/usr/local/bin/', `${t}/bin/`).replaceAll('/home/browser/', `${t}/home/`).replaceAll('/home/shared', `${t}/shared`)
      .replaceAll('remote-debugging-port=9222', `remote-debugging-port=${port}`).replaceAll('pgrep -f websockify', `pgrep -f ${t}/fake/websockify`).replaceAll('-u browser', `-u ${as}`).replaceAll('"$(id -un)" = browser', `"$(id -un)" = ${as}`),
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
  for (const name of ['Xvfb', 'x11vnc', 'websockify']) b.fake(name, 'sleep 30')
  return b
}

test('person start script: XFCE as browser on :1 with bash as its shell, Chrome on the kept profile with CDP on loopback, the shared Downloads repaired', () => {
  assert.ok(person.includes(`pgrep -f /usr/local/bin/mumbo-desktop >/dev/null || su browser -s /bin/sh -c 'SHELL=/bin/bash DISPLAY=:1 /usr/local/bin/mumbo-desktop >/tmp/desktop.log 2>&1 &'\n`))
  assert.ok(person.includes(`pgrep -f /usr/local/bin/mumbo-browser >/dev/null || su browser -s /bin/sh -c 'DISPLAY=:1 /usr/local/bin/mumbo-browser >/tmp/chrome.log 2>&1 &'\n`))
  assert.ok(person.includes(`\n  if getent group shared >/dev/null 2>&1 && [ ! -L /home/shared ] && [ ! -L /home/shared/Downloads ]; then install -d -o browser -g shared -m 2770 /home/shared/Downloads 2>/dev/null || echo 'shared downloads folder not repaired' >&2; fi\n`))
  assert.ok(at(person, 'install -d -o browser -g shared') < at(person, "DISPLAY=:1 /usr/local/bin/mumbo-browser"))
  assert.ok(heredoc('/usr/local/bin/mumbo-browser').startsWith('#!/bin/sh\nif [ -d /home/browser/Downloads ] && [ ! -L /home/browser/Downloads ] && [ -d /home/shared/Downloads ]; then\n'))
  assert.equal(heredoc('/usr/local/bin/google-chrome'), '#!/bin/sh\n[ "$(id -un)" = browser ] || exec "$(command -v google-chrome-stable || echo chromium)" "$@"\nexec "$(command -v google-chrome-stable || echo chromium)" --user-data-dir=/home/browser/profile --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 --no-first-run --no-default-browser-check --password-store=basic --start-maximized "$@"\n')
  assert.ok(at(person, 'export XAUTHORITY=/run/x11/auth') < at(person, 'su browser -s /bin/sh -c \'SHELL=/bin/bash DISPLAY=:1 /usr/local/bin/mumbo-desktop'))
  assert.ok(at(person, 'Xvfb :1') < at(person, 'DISPLAY=:1 /usr/local/bin/mumbo-desktop') && at(person, 'DISPLAY=:1 /usr/local/bin/mumbo-browser') < at(person, 'x11vnc -display :1'))
  assert.ok(person.includes('127.0.0.1:5900 >/root/websockify.log 2>&1 &\n'), 'root logs to its own directory, not to a /tmp name browser can plant')
  assert.ok(!person.includes('DISPLAY=:1 chromium') && !person.includes('DISPLAY=:1 openbox'), 'the browser and window manager start only through their loops')
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
    assert.ok(b.lines('chrome').every(l => l.endsWith(` --user-data-dir=${b.t}/home/profile --remote-debugging-address=127.0.0.1 --remote-debugging-port=${b.port} --no-first-run --no-default-browser-check --password-store=basic --start-maximized`)))
  } finally { b.done() }
})

test('a Chrome on the profile without the debugging port is waited for: its Singleton lock stays and no second Chrome starts', async () => {
  const b = box()
  try {
    b.fake('google-chrome-stable', `${VERSION}echo start >> ${b.t}/log/chrome`)
    mkdirSync(join(b.t, 'home/profile'))
    writeFileSync(join(b.t, 'outside/keep'), 'keep')
    symlinkSync(join(b.t, 'outside/keep'), join(b.t, 'home/profile/SingletonLock'))
    b.run(`exec /bin/sh -c 'sleep 30; true' 'chrome --user-data-dir=${b.t}/home/profile'`)
    await sleep(300)
    b.run(`${b.t}/bin/mumbo-browser`)
    await sleep(2500)
    assert.deepEqual([b.lines('chrome'), readdirSync(join(b.t, 'home/profile')), readFileSync(join(b.t, 'outside/keep'), 'utf8')], [[], ['SingletonLock'], 'keep'])
  } finally { b.done() }
})

test('the google-chrome wrapper pins the profile only for browser; for any other user it is plain Chrome', () => {
  const b = box()
  try {
    b.fake('google-chrome-stable', `echo "$*" >> ${b.t}/log/chrome`)
    writeFileSync(join(b.t, 'bin/plain'), b.local(heredoc('/usr/local/bin/google-chrome'), 'browser')); chmodSync(join(b.t, 'bin/plain'), 0o755)
    execFileSync(join(b.t, 'bin/plain'), ['--headless', '--screenshot'], { env: { PATH: join(b.t, 'fake') } })
    execFileSync(join(b.t, 'bin/google-chrome'), ['https://x'], { env: { PATH: join(b.t, 'fake') } })
    assert.deepEqual(b.lines('chrome'), ['--headless --screenshot', `--user-data-dir=${b.t}/home/profile --remote-debugging-address=127.0.0.1 --remote-debugging-port=${b.port} --no-first-run --no-default-browser-check --password-store=basic --start-maximized https://x`])
  } finally { b.done() }
})

test('a re-run starts no second desktop session, browser loop or Chrome, and reaches dsh both times', async () => {
  const b = box()
  try {
    b.fake('startxfce4', `echo "start $SHELL" >> ${b.t}/log/xfce; sleep 30`)
    b.fake('google-chrome-stable', `${VERSION}echo start >> ${b.t}/log/chrome; sleep 30`)
    b.run(b.local(block()))
    await sleep(1000)
    b.run(b.local(block()))
    await sleep(1000)
    assert.equal(b.count(`${b.t}/bin/mumbo-desktop`), 1)
    assert.equal(b.count(`${b.t}/bin/mumbo-browser`), 1)
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
      await sleep(1000)
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
      await sleep(700)
      assert.deepEqual(b.lines('dsh'), ['reached'])
      return b.lines('install').map(l => l.replaceAll(b.t, 'T'))
    } finally { b.done() }
  }
  assert.deepEqual(await repairs(() => {}), ['-d -o browser -g shared -m 2770 T/shared/Downloads'])
  assert.deepEqual(await repairs((b) => symlinkSync(join(b.t, 'outside'), join(b.t, 'shared/Downloads'))), [])
  assert.deepEqual(await repairs((b) => { rmSync(join(b.t, 'shared'), { recursive: true }); symlinkSync(join(b.t, 'outside'), join(b.t, 'shared')) }), [])
  assert.deepEqual(await repairs(() => {}, false), [])
})

test('the browser loop moves ~/Downloads into the shared folder as browser, keeping both sides of a name clash and never following a link', () => {
  const pre = heredoc('/usr/local/bin/mumbo-browser').split('while :; do')[0]
  const b = box()
  try {
    b.fake('google-chrome-stable', 'exit 1')
    writeFileSync(join(b.t, 'outside/keep'), 'keep')
    const run = () => { writeFileSync(join(b.t, 'pre.sh'), b.local(pre)); execFileSync('/bin/sh', [join(b.t, 'pre.sh')], { env: { PATH: join(b.t, 'fake') } }) }
    const old = join(b.t, 'home/Downloads'), shared = join(b.t, 'shared/Downloads')
    mkdirSync(old); mkdirSync(shared)
    for (const [n, v] of [['a.pdf', 'a'], ['.hidden', 'h'], ['-dash', 'd'], ['clash', 'old']]) writeFileSync(join(old, n), v)
    writeFileSync(join(shared, 'clash'), 'new')
    symlinkSync(join(b.t, 'outside/keep'), join(old, 'link'))
    run()
    assert.deepEqual(readdirSync(shared).sort(), ['-dash', '.hidden', 'a.pdf', 'clash', 'link'])
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

test('a profile last used by a newer browser is moved aside before Chrome starts; an older, equal or unreadable one is kept', () => {
  const pre = heredoc('/usr/local/bin/mumbo-browser').split('while :; do')[0]
  const b = box()
  try {
    const check = (last, version = 'Google Chrome 142.0.7444.59 ') => {
      rmSync(join(b.t, 'home'), { recursive: true }); mkdirSync(join(b.t, 'home/profile'), { recursive: true })
      if (last !== undefined) writeFileSync(join(b.t, 'home/profile/Last Version'), last)
      if (version) b.fake('google-chrome-stable', `echo '${version}'`); else rmSync(join(b.t, 'fake/google-chrome-stable'), { force: true })
      // From a file, as the box runs it: an sh -c command line would match the check's own pgrep.
      writeFileSync(join(b.t, 'pre.sh'), b.local(pre))
      execFileSync('/bin/sh', [join(b.t, 'pre.sh')], { env: { PATH: join(b.t, 'fake') } })
      return readdirSync(join(b.t, 'home')).filter(n => n !== 'Downloads').sort()
    }
    assert.match(check('142.0.7444.60').join(), /^profile\.142\.0\.7444\.60\.\d+$/)
    assert.match(check('143.0.1.2').join(), /^profile\.143\.0\.1\.2\.\d+$/)
    for (const kept of ['142.0.7444.59', '142.0.7444.9', '141.0.7390.122', '', '../../x', '143.0.0.1; touch x', undefined]) assert.deepEqual(check(kept), ['profile'], String(kept))
    assert.deepEqual(check('143.0.1.2', ''), ['profile'], 'a template without Chrome keeps the profile')
    const running = spawn('/bin/sh', ['-c', 'sleep 5; true', `chrome --user-data-dir=${b.t}/home/profile`], { stdio: 'ignore' })
    try { assert.deepEqual(check('143.0.1.2'), ['profile'], 'a running Chrome, even without the debugging port, keeps its profile') } finally { running.kill('SIGKILL') }
    // A symlink planted at the move-aside name does not take the profile out of /home/browser.
    b.fake('date', 'echo 1700000000')
    rmSync(join(b.t, 'home'), { recursive: true }); mkdirSync(join(b.t, 'home/profile'), { recursive: true }); writeFileSync(join(b.t, 'home/profile/Last Version'), '143.0.1.2')
    symlinkSync(join(b.t, 'outside'), join(b.t, 'home/profile.143.0.1.2.1700000000'))
    b.fake('google-chrome-stable', "echo 'Google Chrome 142.0.7444.59'")
    writeFileSync(join(b.t, 'pre.sh'), b.local(pre))
    spawnSync('/bin/sh', [join(b.t, 'pre.sh')], { env: { PATH: join(b.t, 'fake') } })
    assert.deepEqual([readdirSync(join(b.t, 'outside')), existsSync(join(b.t, 'home/profile/Last Version'))], [[], true])
  } finally { b.done() }
})

test('template: Google Chrome stable from Google\'s signed amd64 repository and the XFCE desktop, in place of Chromium and openbox', () => {
  const [install] = BOX_STEPS
  const repo = 'echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.asc] https://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list'
  assert.ok(at(install, 'curl -fsSL https://dl.google.com/linux/linux_signing_key.pub -o /etc/apt/keyrings/google-chrome.asc') < at(install, repo))
  const packages = install.slice(at(install, repo)).match(/apt-get install -y --no-install-recommends ([^&]+) &&/)[1].trim().split(' ')
  for (const p of ['google-chrome-stable', 'xfce4-session', 'xfwm4', 'xfce4-panel', 'xfdesktop4', 'thunar', 'xfce4-terminal', 'tango-icon-theme', 'librsvg2-common', 'dbus-x11', 'xdotool', 'wmctrl', 'xauth', 'xvfb', 'x11vnc', 'novnc', 'websockify']) assert.ok(packages.includes(p), p)
  for (const p of ['chromium', 'openbox', 'xfce4']) assert.ok(!packages.includes(p), p)
  assert.ok(BOX_STEPS.includes('id browser >/dev/null 2>&1 || useradd -m -s /bin/bash browser'))
  assert.ok(BOX_STEPS.indexOf('id browser >/dev/null 2>&1 || useradd -m -s /bin/bash browser') < BOX_STEPS.indexOf('groupadd -f shared && usermod -aG shared browser && chmod 0700 /home/browser && install -d -m 0755 /home/shared && install -d -o browser -g shared -m 2770 /home/shared/Downloads'))
})

test('template: Chrome\'s managed policy file, byte for byte, read-only to the browser user', () => {
  const t = mkdtempSync(join(tmpdir(), 'policy-'))
  try {
    const step = BOX_STEPS.find(s => s.includes('/etc/opt/chrome/policies/managed/mumbo.json'))
    execFileSync('sh', ['-c', step.replaceAll('/etc/opt/chrome/', `${t}/etc/opt/chrome/`)])
    const file = join(t, 'etc/opt/chrome/policies/managed/mumbo.json')
    assert.equal(readFileSync(file, 'utf8'), '{"RestoreOnStartup":1,"DefaultBrowserSettingEnabled":false,"MetricsReportingEnabled":false,"DownloadDirectory":"/home/shared/Downloads"}\n')
    assert.equal(statSync(file).mode & 0o777, 0o644)
    assert.equal(statSync(join(t, 'etc/opt/chrome/policies/managed')).mode & 0o777, 0o755)
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
