import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { backupCommand, restoreCommand } from './edge.mjs'

const sh = (c) => spawnSync('bash', ['-c', c], { encoding: 'utf8' })

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
    'profile/Default/Service Worker/Database/x', 'profile/Default/IndexedDB/https_web.whatsapp.com_0.indexeddb.leveldb/x', 'profile.143.0.1.2.1700000000/Default/Cookies']
  const dropped = ['.cache/sessions/xfce4-session-box:1', 'profile/SingletonLock', 'profile/Default/Cache/Cache_Data/x', 'profile/Default/Code Cache/js/x',
    'profile/Default/GPUCache/x', 'profile/Default/Service Worker/CacheStorage/x', 'profile/ShaderCache/x', 'profile/GrShaderCache/x', 'profile/GraphiteDawnCache/x',
    'profile/component_crx_cache/x', 'profile/extensions_crx_cache/x', 'profile/OptGuideOnDeviceModel/x', 'profile.143.0.1.2.1700000000/Default/Cache/x']
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
