// node --test deploy/boxes/edge/desktop.test.mjs
// The person box's desktop (edge startScript desktop block) and its template steps (template.mjs BOX_STEPS). The loops run
// through sh in a temporary root with fake XFCE, D-Bus and Chrome programs, and only those on PATH.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { startScript, boxSite } from './edge.mjs'
import { BOX_STEPS } from './template.mjs'

const c = { llmHost: 'l', publicHost: 'boxes.x' }
const person = startScript(c, 'T', boxSite(c, 'a@x.com'), 'role', undefined, {})
const at = (text, needle) => { const i = text.indexOf(needle); assert.ok(i >= 0, `missing: ${needle}`); return i }
/** The body the start script writes to `path` with a quoted heredoc. */
const heredoc = (path) => { const head = `cat > ${path} <<'SH'\n`; const i = at(person, head) + head.length; return person.slice(i, person.indexOf('\nSH\n', i) + 1) }
/** The desktop block from Downloads to the browser loop's start, without the X server. */
const block = () => person.slice(at(person, 'install -d -o browser'), person.indexOf('\n', at(person, 'mumbo-browser >/tmp/chrome.log')) + 1).split('\n').filter(l => !l.includes('Xvfb')).join('\n')
/** How the fake Chrome answers the version check that runs before the browser loop. */
const VERSION = '[ "$1" = --version ] && { echo "Google Chrome 142.0.7444.59 "; exit; }\n'
const REAL = ['sleep', 'pgrep', 'rm', 'grep', 'head', 'sort', 'tail', 'date', 'mv', 'cat', 'chmod', 'mkdir', 'touch', 'wc']

/** A temporary root: box paths moved under it, a private debugging port, and PATH holding only fakes and REAL tools. */
function box() {
  const t = mkdtempSync(join(tmpdir(), 'desktop-'))
  const port = String(20000 + Math.floor(Math.random() * 40000))
  for (const d of ['bin', 'fake', 'home', 'log']) mkdirSync(join(t, d))
  for (const tool of REAL) symlinkSync(execFileSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim(), join(t, 'fake', tool))
  const groups = []
  const b = {
    t, port,
    local: (text) => text.replaceAll('/tmp/', `${t}/log/`).replaceAll('/usr/local/bin/', `${t}/bin/`).replaceAll('/home/browser/', `${t}/home/`).replaceAll('remote-debugging-port=9222', `remote-debugging-port=${port}`),
    fake: (name, body) => { writeFileSync(join(t, 'fake', name), `#!/bin/sh\n${body}\n`); chmodSync(join(t, 'fake', name), 0o755) },
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
  return b
}

test('person start script: XFCE as browser on :1, Chrome on the kept profile with CDP on loopback, Downloads owned by browser', () => {
  assert.match(person, /\n {2}install -d -o browser -g browser \/home\/browser\/Downloads\n/)
  assert.ok(person.includes(`pgrep -f /usr/local/bin/mumbo-desktop >/dev/null || su browser -s /bin/sh -c 'DISPLAY=:1 /usr/local/bin/mumbo-desktop >/tmp/desktop.log 2>&1 &'\n`))
  assert.ok(person.includes(`pgrep -f /usr/local/bin/mumbo-browser >/dev/null || su browser -s /bin/sh -c 'DISPLAY=:1 /usr/local/bin/mumbo-browser >/tmp/chrome.log 2>&1 &'\n`))
  assert.equal(heredoc('/usr/local/bin/google-chrome'), '#!/bin/sh\nexec "$(command -v google-chrome-stable || echo chromium)" --user-data-dir=/home/browser/profile --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 --no-first-run --no-default-browser-check --password-store=basic --start-maximized "$@"\n')
  assert.ok(at(person, 'export XAUTHORITY=/run/x11/auth') < at(person, 'su browser -s /bin/sh -c \'DISPLAY=:1 /usr/local/bin/mumbo-desktop'))
  assert.ok(at(person, 'Xvfb :1') < at(person, 'DISPLAY=:1 /usr/local/bin/mumbo-desktop') && at(person, 'DISPLAY=:1 /usr/local/bin/mumbo-browser') < at(person, 'x11vnc -display :1'))
  assert.ok(!person.includes('DISPLAY=:1 chromium') && !person.includes('DISPLAY=:1 openbox'), 'the browser and window manager start only through their loops')
})

test('the desktop session runs XFCE with xfwm4 compositing off, on its own D-Bus, and starts again after it ends', async () => {
  const b = box()
  try {
    b.fake('startxfce4', `echo "startxfce4 $DBUS_SESSION_BUS_ADDRESS" >> ${b.t}/log/session`)
    b.run(`${b.t}/bin/mumbo-desktop`)
    await sleep(3000)
    const lines = b.lines('session')
    assert.deepEqual(lines.slice(0, 4), ['xfconf-query -c xfwm4 -p /general/use_compositing -n -t bool -s false', 'startxfce4 unix:fake', 'xfconf-query -c xfwm4 -p /general/use_compositing -n -t bool -s false', 'startxfce4 unix:fake'])
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

test('a re-run starts no second desktop session, browser loop or Chrome, and makes Downloads', async () => {
  const b = box()
  try {
    b.fake('su', 'exec /bin/sh -c "$5"')
    b.fake('install', 'for a; do d=$a; done; mkdir -p "$d"')
    b.fake('startxfce4', `echo start >> ${b.t}/log/xfce; sleep 30`)
    b.fake('google-chrome-stable', `${VERSION}echo start >> ${b.t}/log/chrome; sleep 30`)
    b.run(b.local(block()))
    await sleep(1000)
    b.run(b.local(block()))
    await sleep(1000)
    assert.equal(b.count(`${b.t}/bin/mumbo-desktop`), 1)
    assert.equal(b.count(`${b.t}/bin/mumbo-browser`), 1)
    assert.deepEqual([b.lines('xfce'), b.lines('chrome')], [['start'], ['start']])
    assert.ok(statSync(join(b.t, 'home/Downloads')).isDirectory())
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
      return readdirSync(join(b.t, 'home')).sort()
    }
    assert.match(check('142.0.7444.60').join(), /^profile\.142\.0\.7444\.60\.\d+$/)
    assert.match(check('143.0.1.2').join(), /^profile\.143\.0\.1\.2\.\d+$/)
    for (const kept of ['142.0.7444.59', '142.0.7444.9', '141.0.7390.122', '', '../../x', '143.0.0.1; touch x', undefined]) assert.deepEqual(check(kept), ['profile'], String(kept))
    assert.deepEqual(check('143.0.1.2', ''), ['profile'], 'a template without Chrome keeps the profile')
    const running = spawn('/bin/sh', ['-c', 'sleep 5; true', `chrome --remote-debugging-port=${b.port}`], { stdio: 'ignore' })
    try { assert.deepEqual(check('143.0.1.2'), ['profile'], 'a running Chrome keeps its profile') } finally { running.kill('SIGKILL') }
  } finally { b.done() }
})

test('template: Google Chrome stable from Google\'s signed amd64 repository and the XFCE desktop, in place of Chromium and openbox', () => {
  const [install] = BOX_STEPS
  const repo = 'echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.asc] https://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list'
  assert.ok(at(install, 'curl -fsSL https://dl.google.com/linux/linux_signing_key.pub -o /etc/apt/keyrings/google-chrome.asc') < at(install, repo))
  const packages = install.slice(at(install, repo)).match(/apt-get install -y --no-install-recommends ([^&]+) &&/)[1].trim().split(' ')
  for (const p of ['google-chrome-stable', 'xfce4-session', 'xfwm4', 'xfce4-panel', 'xfdesktop4', 'thunar', 'xfce4-terminal', 'tango-icon-theme', 'librsvg2-common', 'dbus-x11', 'xdotool', 'xauth', 'xvfb', 'x11vnc', 'novnc', 'websockify']) assert.ok(packages.includes(p), p)
  for (const p of ['chromium', 'openbox', 'xfce4']) assert.ok(!packages.includes(p), p)
  assert.ok(BOX_STEPS.includes('id browser >/dev/null 2>&1 || useradd -m -s /bin/bash browser'))
})

test('template: Chrome\'s managed policy file, byte for byte, read-only to the browser user', () => {
  const t = mkdtempSync(join(tmpdir(), 'policy-'))
  try {
    const step = BOX_STEPS.find(s => s.includes('/etc/opt/chrome/policies/managed/mumbo.json'))
    execFileSync('sh', ['-c', step.replaceAll('/etc/opt/chrome/', `${t}/etc/opt/chrome/`)])
    const file = join(t, 'etc/opt/chrome/policies/managed/mumbo.json')
    assert.equal(readFileSync(file, 'utf8'), '{"RestoreOnStartup":1,"DefaultBrowserSettingEnabled":false,"MetricsReportingEnabled":false,"DownloadDirectory":"/home/browser/Downloads"}\n')
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
