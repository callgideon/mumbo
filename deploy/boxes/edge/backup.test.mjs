import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync, symlinkSync, truncateSync, readlinkSync, lstatSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { backupCommand, restoreCommand } from './edge.mjs'

const sh = (c, env = process.env) => spawnSync('bash', ['-c', c], { encoding: 'utf8', env })

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bk-'))
  mkdirSync(join(root, 'root/.dsh/superagent'), { recursive: true })
  const file = join(root, 'root/.dsh/superagent/orchestrator.sqlite')
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE t(v); INSERT INTO t VALUES (42)')
  return { root, file, db, target: `file://${root}.tgz` }
}

test('backup snapshots SQLite databases without -wal files, and restore puts the row back', () => {
  const { root, file, db, target } = fixture()
  assert.ok(existsSync(`${file}-wal`), 'row is only in the WAL')
  const b = sh(backupCommand(target, root))
  assert.equal(b.status, 0, b.stderr)
  const names = execFileSync('tar', ['-tzf', `${root}.tgz`], { encoding: 'utf8' })
  assert.match(names, /root\/\.mumbo-sqlite\/\.dsh\/superagent\/orchestrator\.sqlite\.snap/)
  assert.doesNotMatch(names, /-wal|-shm|-journal|orchestrator\.sqlite$/m)
  assert.ok(!existsSync(join(root, 'root/.mumbo-sqlite')), 'cleaned up')
  db.close(); rmSync(join(root, 'root'), { recursive: true })
  const r = sh(restoreCommand(target, root))
  assert.equal(r.status, 0, r.stderr)
  assert.ok(!existsSync(join(root, 'root/.mumbo-sqlite')))
  assert.deepEqual(readdirSync(join(root, 'root/.dsh/superagent')), ['orchestrator.sqlite'])
  const back = new DatabaseSync(file)
  assert.deepEqual(back.prepare('SELECT v FROM t').all().map((x) => x.v), [42])
  back.close()
})

test('a non-SQLite .db survives a round trip, and the browser profile keeps its journals', () => {
  const { root, db, target } = fixture()
  db.close()
  mkdirSync(join(root, 'root/projects/p'), { recursive: true })
  mkdirSync(join(root, 'home/browser/profile/Default'), { recursive: true })
  writeFileSync(join(root, 'root/projects/p/x.db'), 'plain bytes')
  writeFileSync(join(root, 'home/browser/profile/Default/Cookies-journal'), 'j')
  const b = sh(backupCommand(target, root))
  assert.equal(b.status, 0, b.stderr)
  assert.match(execFileSync('tar', ['-tzf', `${root}.tgz`], { encoding: 'utf8' }), /home\/browser\/profile\/Default\/Cookies-journal/)
  rmSync(join(root, 'root/projects'), { recursive: true })
  assert.equal(sh(restoreCommand(target, root)).status, 0)
  assert.equal(readFileSync(join(root, 'root/projects/p/x.db'), 'utf8'), 'plain bytes')
})

test('backups carry the browser user\'s home, downloads and desktop settings included, without caches or locks, and restore it', () => {
  const { root, db, target } = fixture()
  db.close()
  const home = join(root, 'home/browser')
  const put = (path) => { mkdirSync(join(home, path, '..'), { recursive: true }); writeFileSync(join(home, path), path) }
  const kept = ['Downloads/report.pdf', '.config/xfce4/xfconf/xfce-perchannel-xml/xfce4-panel.xml', 'profile/Last Version', 'profile/Default/Cookies',
    'profile/Default/Service Worker/Database/x', 'profile/Default/Service Worker/ScriptCache/x', 'profile/Default/IndexedDB/https_web.whatsapp.com_0.indexeddb.leveldb/x',
    'chrome-profile/Default/Cookies', 'chrome-profile/Default/Service Worker/ScriptCache/x', 'chrome-profile/Local State']
  const dropped = ['.cache/sessions/xfce4-session-box:1', 'profile/SingletonLock', 'profile/Default/Cache/Cache_Data/x', 'profile/Default/Code Cache/js/x',
    'profile/Default/GPUCache/x', 'profile/Default/Service Worker/CacheStorage/x', 'profile/ShaderCache/x', 'profile/GrShaderCache/x', 'profile/GraphiteDawnCache/x',
    'profile/component_crx_cache/x', 'profile/extensions_crx_cache/x', 'profile/OptGuideOnDeviceModel/x', '.chromium-profile-old/Default/Login Data',
    'chrome-profile/SingletonLock', 'chrome-profile/Default/Cache/x', 'chrome-profile/Default/Code Cache/js/x', 'chrome-profile/GrShaderCache/x', 'chrome-profile/Default/DawnWebGPUCache/x',
    'profile/Default/DawnGraphiteCache/x', 'profile/Default/DawnWebGPUCache/x', 'profile/Crashpad/x', 'profile/Default/blob_storage/x', 'profile/Default/Shared Dictionary/cache/x']
  for (const p of [...kept, ...dropped]) put(p)
  const b = sh(backupCommand(target, root))
  assert.equal(b.status, 0, b.stderr)
  const names = execFileSync('tar', ['-tzf', `${root}.tgz`], { encoding: 'utf8' }).split('\n')
  for (const p of kept) assert.ok(names.includes(`home/browser/${p}`), p)
  for (const p of dropped) assert.ok(!names.some(n => n.startsWith(`home/browser/${p}`)), p)
  rmSync(home, { recursive: true })
  assert.equal(sh(restoreCommand(target, root)).status, 0)
  for (const p of kept) assert.equal(readFileSync(join(home, p), 'utf8'), p)
})

test('a backup taken when backups held only the browser profile still restores it', () => {
  const { root, db, target } = fixture()
  db.close()
  mkdirSync(join(root, 'home/browser/profile/Default'), { recursive: true })
  writeFileSync(join(root, 'home/browser/profile/Default/Cookies'), 'signed in')
  // The archive members of a backup taken before backups covered all of /home/browser.
  execFileSync('tar', ['-C', root, '-czf', `${root}.tgz`, 'root/.dsh', 'home/browser/profile'])
  rmSync(join(root, 'home/browser'), { recursive: true })
  mkdirSync(join(root, 'home/browser'))
  const r = sh(restoreCommand(target, root))
  assert.equal(r.status, 0, r.stderr)
  assert.equal(readFileSync(join(root, 'home/browser/profile/Default/Cookies'), 'utf8'), 'signed in')
})

/** A PATH whose `tar` runs the real one and then exits with `status`, as GNU tar does when a file changed while it read it. */
function tarExiting(status) {
  const dir = mkdtempSync(join(tmpdir(), 'tar-'))
  writeFileSync(join(dir, 'tar'), `#!/bin/sh\n${execFileSync('sh', ['-c', 'command -v tar'], { encoding: 'utf8' }).trim()} "$@" || exit\nexit ${status}\n`)
  chmodSync(join(dir, 'tar'), 0o755)
  return { ...process.env, PATH: `${dir}:${process.env.PATH}` }
}

test('a backup whose files changed while tar read them is still uploaded; any other tar failure stops it', () => {
  const { root, db, target } = fixture()
  db.close()
  writeFileSync(`${root}.tgz`, 'previous')
  assert.notEqual(sh(backupCommand(target, root), tarExiting(2)).status, 0)
  assert.equal(readFileSync(`${root}.tgz`, 'utf8'), 'previous')
  const b = sh(backupCommand(target, root), tarExiting(1))
  assert.equal(b.status, 0, b.stderr)
  assert.match(execFileSync('tar', ['-tzf', `${root}.tgz`], { encoding: 'utf8' }), /root\/\.mumbo-sqlite\/\.dsh\/superagent\/orchestrator\.sqlite\.snap/)
})

test('Downloads: items over 1 GiB stay out, the rest is kept newest first up to 2 GiB, and no file name excludes anything else', () => {
  const { root, db, target } = fixture()
  db.close()
  const MiB = 1024 * 1024, now = Date.now() / 1000
  mkdirSync(join(root, 'root/projects/app'), { recursive: true }); writeFileSync(join(root, 'root/projects/app/main.c'), 'int main;')
  const dl = join(root, 'home/shared/Downloads'), legacy = join(root, 'home/browser/Downloads')
  mkdirSync(join(dl, 'root/.dsh'), { recursive: true }); mkdirSync(legacy, { recursive: true })
  const put = (dir, name, size, ageHours) => { writeFileSync(join(dir, name), ''); truncateSync(join(dir, name), size); utimesSync(join(dir, name), now - ageHours * 3600, now - ageHours * 3600) }
  // Names that, as exclude patterns, would drop root/ or match other files: a newline, a glob, trailing space, a root-like path.
  put(dl, 'x\nroot', 1100 * MiB, 0)
  put(dl, 'y\n.dsh', 5, 0.5)
  put(dl, 'g*', 1100 * MiB, 0.5)
  put(dl, 'gz', 5, 0.5)
  put(dl, 'name ', 5, 0.5)
  put(dl, 'name', 5, 0.5)
  put(join(dl, 'root/.dsh'), 's', 5, 0.5)
  put(dl, 'part.crdownload', 5, 0)
  put(dl, 'new', 700 * MiB, 1)
  put(dl, 'mid', 700 * MiB, 2)
  put(dl, 'old', 700 * MiB, 3)
  put(legacy, 'legacy.txt', 5, 0.5)
  const b = sh(backupCommand(target, root))
  assert.equal(b.status, 0, b.stderr)
  assert.equal(b.stdout, 'downloads left out of the backup: 3 items, 2900 MiB\n')
  // tar -t prints a newline in a name as a backslash and an n.
  const names = execFileSync('tar', ['-tzf', `${root}.tgz`], { encoding: 'utf8' }).split('\n').map(n => n.replaceAll('\\n', '\n'))
  for (const n of ['root/.dsh/superagent/', 'root/projects/app/main.c', 'root/.mumbo-sqlite/.dsh/superagent/orchestrator.sqlite.snap', 'home/shared/', 'home/shared/Downloads/']) assert.ok(names.includes(n), n)
  const kept = ['y\n.dsh', 'gz', 'name ', 'name', 'root/.dsh/s', 'new', 'mid'].map(n => `home/shared/Downloads/${n}`)
  const left = ['x\nroot', 'g*', 'old', 'part.crdownload'].map(n => `home/shared/Downloads/${n}`)
  for (const n of [...kept, 'home/browser/Downloads/legacy.txt']) assert.ok(names.includes(n), JSON.stringify(n))
  for (const n of left) assert.ok(!names.includes(n), JSON.stringify(n))
})

test('a backup reads /home/browser without following a planted symlink out of it', () => {
  const { root, db, target } = fixture()
  db.close()
  const outside = mkdtempSync(join(tmpdir(), 'outside-'))
  try {
    writeFileSync(join(outside, 'secret'), 'secret'); writeFileSync(join(outside, 'big'), ''); truncateSync(join(outside, 'big'), 1025 * 1024 * 1024)
    mkdirSync(join(root, 'home/browser'), { recursive: true })
    symlinkSync(join(outside, 'secret'), join(root, 'home/browser/leak'))
    symlinkSync(outside, join(root, 'home/browser/Downloads'))
    const b = sh(backupCommand(target, root))
    assert.equal(b.status, 0, b.stderr)
    const listing = execFileSync('tar', ['-tvzf', `${root}.tgz`], { encoding: 'utf8' })
    assert.match(listing, /^l.* home\/browser\/leak -> /m)
    assert.match(listing, /^l.* home\/browser\/Downloads -> /m)
    assert.ok(!execFileSync('tar', ['-tzf', `${root}.tgz`], { encoding: 'utf8' }).split('\n').some(n => n.startsWith('home/browser/Downloads/') || n.startsWith('home/browser/leak/')))
  } finally { rmSync(outside, { recursive: true, force: true }) }
})

test('restore writes nothing outside /home/browser through a symlink planted in the archive or in the box', () => {
  const work = mkdtempSync(join(tmpdir(), 'restore-'))
  try {
    const outside = join(work, 'outside'), box = join(work, 'box'), src = join(work, 'src'), archive = join(work, 'a.tar')
    mkdirSync(outside); writeFileSync(join(outside, 'keep'), 'keep')
    // The archive: a symlink out of /home/browser, then a member through it; a Downloads directory with a file; a file f.
    mkdirSync(join(src, 'home/browser/Downloads'), { recursive: true })
    symlinkSync(outside, join(src, 'home/browser/esc'))
    writeFileSync(join(src, 'home/browser/Downloads/x'), 'x'); writeFileSync(join(src, 'home/browser/f'), 'new')
    execFileSync('tar', ['-C', src, '-cf', archive, 'home/browser'])
    rmSync(join(src, 'home/browser/esc')); mkdirSync(join(src, 'home/browser/esc')); writeFileSync(join(src, 'home/browser/esc/y'), 'y')
    execFileSync('tar', ['-C', src, '-rf', archive, 'home/browser/esc/y'])
    execFileSync('gzip', [archive])
    // The box: Downloads and f planted as symlinks out of /home/browser.
    mkdirSync(join(box, 'home/browser'), { recursive: true })
    symlinkSync(outside, join(box, 'home/browser/Downloads'))
    symlinkSync(join(outside, 'keep'), join(box, 'home/browser/f'))
    sh(restoreCommand(`file://${archive}.gz`, box))
    assert.deepEqual([readdirSync(outside), readFileSync(join(outside, 'keep'), 'utf8')], [['keep'], 'keep'])
    assert.ok(lstatSync(join(box, 'home/browser/Downloads')).isDirectory())
    assert.equal(readFileSync(join(box, 'home/browser/Downloads/x'), 'utf8'), 'x')
    assert.equal(readFileSync(join(box, 'home/browser/f'), 'utf8'), 'new')
    assert.equal(readlinkSync(join(box, 'home/browser/esc')), outside)
  } finally { rmSync(work, { recursive: true, force: true }) }
})

test('a ~/Downloads swapped for a symlink after the listing is archived as the symlink, never read through', () => {
  const { root, db, target } = fixture()
  db.close()
  const home = join(root, 'home/browser'), outside = mkdtempSync(join(tmpdir(), 'outside-'))
  try {
    mkdirSync(join(home, 'Downloads/item'), { recursive: true }); writeFileSync(join(home, 'Downloads/item/f'), 'mine')
    mkdirSync(join(outside, 'item')); writeFileSync(join(outside, 'item/secret'), 'ROOT ONLY')
    mkdirSync(join(root, 'home/shared/Downloads'), { recursive: true })
    // The swap lands between the listing and tar.
    const cmd = backupCommand(target, root).replace('rc=0; tar -C ', `rc=0; mv '${home}/Downloads' '${home}/D'; ln -s '${outside}' '${home}/Downloads'; tar -C `)
    const b = sh(cmd)
    assert.equal(b.status, 0, b.stderr)
    const listing = execFileSync('tar', ['-tvzf', `${root}.tgz`], { encoding: 'utf8' })
    assert.match(listing, /^l.* home\/browser\/Downloads -> /m)
    assert.doesNotMatch(listing, /home\/browser\/Downloads\/|secret/)
  } finally { rmSync(outside, { recursive: true, force: true }) }
})

test('a restore whose tar fails part way still moves the SQLite snapshots back, then reports the failure', () => {
  const { root, file, db, target } = fixture()
  assert.equal(sh(backupCommand(target, root)).status, 0)
  db.close()
  // Append members that fail extraction: a symlink out of the tree, then a file through it.
  const work = mkdtempSync(join(tmpdir(), 'fail-'))
  try {
    execFileSync('sh', ['-c', `gunzip -c '${root}.tgz' > '${work}/a.tar'`])
    mkdirSync(join(work, 'src/home/browser'), { recursive: true }); symlinkSync(work, join(work, 'src/home/browser/esc'))
    execFileSync('tar', ['-C', join(work, 'src'), '-rf', join(work, 'a.tar'), 'home/browser/esc'])
    rmSync(join(work, 'src/home/browser/esc')); mkdirSync(join(work, 'src/home/browser/esc')); writeFileSync(join(work, 'src/home/browser/esc/y'), 'y')
    execFileSync('tar', ['-C', join(work, 'src'), '-rf', join(work, 'a.tar'), 'home/browser/esc/y'])
    execFileSync('sh', ['-c', `gzip -c '${work}/a.tar' > '${root}.tgz'`])
  } finally { rmSync(work, { recursive: true, force: true }) }
  rmSync(join(root, 'root'), { recursive: true })
  const r = sh(restoreCommand(target, root))
  assert.equal(r.status, 2, r.stderr)
  assert.ok(!existsSync(join(root, 'root/.mumbo-sqlite')))
  const back = new DatabaseSync(file)
  assert.deepEqual(back.prepare('SELECT v FROM t').all().map((x) => x.v), [42])
  back.close()
})

test('a Downloads folder nested past PATH_MAX is left out and counted, and the rest is backed up', () => {
  const { root, db, target } = fixture()
  db.close()
  const dl = join(root, 'home/shared/Downloads')
  mkdirSync(join(dl, 'deep'), { recursive: true }); writeFileSync(join(dl, 'ok.txt'), 'ok')
  // Relative mkdir and chdir, which a shell's cd refuses past PATH_MAX.
  execFileSync(process.execPath, ['-e', 'const fs = require("fs"), n = "d".repeat(200); for (let i = 0; i < 22; i++) { fs.mkdirSync(n); process.chdir(n) } fs.writeFileSync("f", "x")'], { cwd: join(dl, 'deep') })
  try {
    const b = sh(backupCommand(target, root))
    assert.equal(b.status, 0, b.stderr)
    assert.equal(b.stdout, 'downloads left out of the backup: 1 items, 0 MiB\n')
    const names = execFileSync('tar', ['-tzf', `${root}.tgz`], { encoding: 'utf8' }).split('\n')
    assert.ok(names.includes('home/shared/Downloads/ok.txt') && names.includes('root/.mumbo-sqlite/.dsh/superagent/orchestrator.sqlite.snap'))
    assert.ok(!names.some(n => n.startsWith('home/shared/Downloads/deep')))
  } finally { execFileSync('rm', ['-rf', root]) }
})

test('a tar failure of status 2 lists and archives once more before the backup fails', () => {
  const { root, db, target } = fixture()
  db.close()
  const dl = join(root, 'home/shared/Downloads')
  mkdirSync(dl, { recursive: true }); writeFileSync(join(dl, 'big'), ''); truncateSync(join(dl, 'big'), 1100 * 1024 * 1024)
  const dir = mkdtempSync(join(tmpdir(), 'tar-'))
  try {
    writeFileSync(join(dir, 'tar'), `#!/bin/sh\nn=$(cat '${dir}/n' 2>/dev/null || echo 0); echo $((n + 1)) > '${dir}/n'\n[ "$n" = 0 ] && exit 2\nexec ${execFileSync('sh', ['-c', 'command -v tar'], { encoding: 'utf8' }).trim()} "$@"\n`)
    chmodSync(join(dir, 'tar'), 0o755)
    const b = sh(backupCommand(target, root), { ...process.env, PATH: `${dir}:${process.env.PATH}` })
    assert.equal(b.status, 0, b.stderr)
    assert.equal(readFileSync(join(dir, 'n'), 'utf8').trim(), '2')
    assert.equal(b.stdout, 'downloads left out of the backup: 1 items, 1100 MiB\n', 'the line is printed once')
    assert.match(execFileSync('tar', ['-tzf', `${root}.tgz`], { encoding: 'utf8' }), /orchestrator\.sqlite\.snap/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a truncated archive fails the restore, after the SQLite snapshots before the cut are moved back', () => {
  const { root, file, db, target } = fixture()
  db.close()
  mkdirSync(join(root, 'home/browser'), { recursive: true })
  writeFileSync(join(root, 'home/browser/f'), Buffer.alloc(1000000, 7).map((_, i) => (i * 2654435761) % 251))
  assert.equal(sh(backupCommand(target, root)).status, 0)
  const tar = execFileSync('gunzip', ['-c', `${root}.tgz`])
  writeFileSync(`${root}.tgz`, execFileSync('gzip', ['-c'], { input: tar.subarray(0, tar.length - 400000) }))
  rmSync(join(root, 'root'), { recursive: true }); rmSync(join(root, 'home'), { recursive: true })
  const r = sh(restoreCommand(target, root))
  assert.notEqual(r.status, 0)
  const back = new DatabaseSync(file)
  assert.deepEqual(back.prepare('SELECT v FROM t').all().map((x) => x.v), [42])
  back.close()
})

test('an old ~/Downloads is one item under the Downloads limits', () => {
  const { root, db, target } = fixture()
  db.close()
  const old = join(root, 'home/browser/Downloads')
  mkdirSync(old, { recursive: true }); mkdirSync(join(root, 'home/browser/.config'))
  writeFileSync(join(root, 'home/browser/.config/x'), 'x')
  for (const n of ['a.iso', 'b.zip']) { writeFileSync(join(old, n), ''); truncateSync(join(old, n), 600 * 1024 * 1024) }
  const b = sh(backupCommand(target, root))
  assert.equal(b.status, 0, b.stderr)
  assert.equal(b.stdout, 'downloads left out of the backup: 1 items, 1200 MiB\n')
  const names = execFileSync('tar', ['-tzf', `${root}.tgz`], { encoding: 'utf8' }).split('\n')
  assert.ok(names.includes('home/browser/.config/x') && !names.some(n => n.startsWith('home/browser/Downloads')))
})

test('a file that vanishes while a Downloads item is sized counts as empty, so the item is kept', () => {
  const root = mkdtempSync(join(tmpdir(), 'sel-'))
  try {
    mkdirSync(join(root, 'home/shared/Downloads/proj'), { recursive: true })
    for (const n of ['keep', 'vanish']) writeFileSync(join(root, 'home/shared/Downloads/proj', n), n)
    const cmd = backupCommand('U', root), from = cmd.indexOf("msg=$(node -e '") + "msg=$(node -e '".length
    // lstat of the file named vanish fails with ENOENT, as when it is deleted between readdir and lstat.
    writeFileSync(join(root, 'vanish.cjs'), 'const fs = require("fs"), real = fs.lstatSync; fs.lstatSync = function (p, ...a) { if (String(p).endsWith("/vanish")) throw Object.assign(new Error("gone"), { code: "ENOENT" }); return real.call(this, p, ...a) }')
    const out = execFileSync(process.execPath, ['-r', join(root, 'vanish.cjs'), '-e', cmd.slice(from, cmd.indexOf("'", from)), root, join(root, 'dirs'), join(root, 'units'), String(1024 ** 3), String(2 * 1024 ** 3)], { encoding: 'utf8' })
    assert.equal(out, '')
    assert.ok(readFileSync(join(root, 'units'), 'latin1').split('\0').includes('home/shared/Downloads/proj'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a corrupt database fails the backup and leaves the previous archive alone', () => {
  const { root, db, target } = fixture()
  db.close()
  writeFileSync(`${root}.tgz`, 'previous')
  writeFileSync(join(root, 'root/.dsh/superagent/bad.db'), Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(200, 7)]))
  const b = sh(backupCommand(target, root))
  assert.notEqual(b.status, 0)
  assert.equal(execFileSync('cat', [`${root}.tgz`], { encoding: 'utf8' }), 'previous')
  assert.ok(!existsSync(join(root, 'root/.mumbo-sqlite')))
})
