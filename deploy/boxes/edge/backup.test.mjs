import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, readdirSync } from 'node:fs'
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

test('a corrupt database fails the backup and leaves the previous archive alone', () => {
  const { root, db, target } = fixture()
  db.close()
  writeFileSync(`${root}.tgz`, 'previous')
  writeFileSync(join(root, 'root/.dsh/superagent/bad.db'), 'not a sqlite database'.repeat(50))
  const b = sh(backupCommand(target, root))
  assert.notEqual(b.status, 0)
  assert.equal(execFileSync('cat', [`${root}.tgz`], { encoding: 'utf8' }), 'previous')
  assert.ok(!existsSync(join(root, 'root/.mumbo-sqlite')))
})
