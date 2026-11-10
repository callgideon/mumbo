// node --test: the versioned-restore script defaults to a dry run, accepts only a backup version of exactly the principal's
// key, and writes the record the edge reads at the next box creation.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { boxes, restoreCommand, restoreKey, userPrefix } from './edge.mjs'
import { memoryStore } from './store.mjs'
import { restoreArgs, restoreVersion } from './restore-version.mjs'

const P = 'project:0123456789abcdef'

test('arguments: dry run by default; --set needs a version id; --set and --clear repeat the principal', () => {
  assert.deepEqual(restoreArgs(['A@Mumbo.si']), { principal: 'a@mumbo.si', versionId: undefined, action: undefined, allowEmptyStore: false })
  assert.deepEqual(restoreArgs(['a@mumbo.si', 'v1']), { principal: 'a@mumbo.si', versionId: 'v1', action: undefined, allowEmptyStore: false })
  assert.deepEqual(restoreArgs(['a@mumbo.si', 'v1', '--set', 'A@mumbo.si']), { principal: 'a@mumbo.si', versionId: 'v1', action: 'set', allowEmptyStore: false })
  assert.deepEqual(restoreArgs([P, '--clear', P, '--allow-empty-store']), { principal: P, versionId: undefined, action: 'clear', allowEmptyStore: true })
  for (const [bad, why] of [[[], /usage/], [['nobody'], /usage/], [['project:short'], /usage/], [['a@mumbo.si', 'v1', '--set'], /confirmation/],
    [['a@mumbo.si', 'v1', '--set', 'b@mumbo.si'], /confirmation/], [['a@mumbo.si', '--set', 'a@mumbo.si'], /needs the version id/],
    [['a@mumbo.si', '--clear', 'b@mumbo.si'], /confirmation/], [['a@mumbo.si', 'v1', '--clear', 'a@mumbo.si'], /usage/],
    [['a@mumbo.si', 'v1', '--force', 'a@mumbo.si'], /usage/], [['a@mumbo.si', 'v1', '--set', 'a@mumbo.si', 'x'], /usage/]])
    assert.throws(() => restoreArgs(bad), why, bad.join(' '))
})

const KEY = `${userPrefix('a@mumbo.si')}/latest.tar.gz`
/** S3 and E2B fakes that, like a loose backend, list everything for any query, so the script's own exact filters are under test. */
function fakes() {
  const at = (d) => new Date(`2026-11-0${d}T10:00:00Z`)
  const s3 = { listObjectVersions: async () => [
    { Key: KEY, VersionId: 'v-old', LastModified: at(1), Size: 900, IsLatest: false },
    { Key: KEY, VersionId: 'v-new', LastModified: at(3), Size: 1000, IsLatest: true },
    { Key: KEY, VersionId: 'v-marker', LastModified: at(2), IsLatest: false, DeleteMarker: true },
    { Key: `${KEY}.partial`, VersionId: 'v-longer-key', LastModified: at(2), Size: 5, IsLatest: true },
    { Key: `${userPrefix('b@mumbo.si')}/latest.tar.gz`, VersionId: 'v-other', LastModified: at(2), Size: 7, IsLatest: true },
  ] }
  const sandboxes = [{ sandboxId: 'box-a', state: 'paused', metadata: { user: 'a@mumbo.si' } }, { sandboxId: 'box-b', state: 'running', metadata: { user: 'b@mumbo.si' } }]
  const e2b = { Sandbox: { list: () => { let more = true; return { get hasNext() { return more }, nextItems: async () => { more = false; return sandboxes } } } } }
  return { s3, e2b }
}
const run = async (opts) => {
  const out = []; const store = opts.store ?? memoryStore()
  const r = await restoreVersion({ principal: 'a@mumbo.si', ...fakes(), bucket: 'bk', store, say: (l) => out.push(l), now: () => 42, ...opts })
  return { r, out: out.join('\n'), store }
}

test('dry run lists the key\'s versions newest first with the delete marker, the pending record and the box, and writes nothing', async () => {
  const store = memoryStore()
  await store.putDoc(restoreKey('a@mumbo.si'), { versionId: 'v-old', at: Date.parse('2026-11-04T00:00:00Z') })
  const { r, out } = await run({ store })
  assert.deepEqual(r.versions.map(v => v.VersionId), ['v-new', 'v-marker', 'v-old'])
  assert.equal(out, [
    `a@mumbo.si: 3 version(s) of s3://bk/${KEY}, newest first`,
    '  2026-11-03T10:00:00.000Z  1000 bytes  v-new  latest',
    '  2026-11-02T10:00:00.000Z  delete marker  v-marker',
    '  2026-11-01T10:00:00.000Z  900 bytes  v-old',
    'pending restore: v-old, set 2026-11-04T00:00:00.000Z',
    'dry run: nothing changed',
    'box: box-a paused; a record takes effect only when the box is next created, so kill it after --set',
  ].join('\n'))
  assert.deepEqual(await store.getDoc(restoreKey('a@mumbo.si')), { versionId: 'v-old', at: Date.parse('2026-11-04T00:00:00Z') })
  const checked = await run({ versionId: 'v-old' })
  assert.match(checked.out, /dry run: v-old is a backup version; rerun with --set a@mumbo.si to restore it/)
  assert.match(checked.out, /pending restore: none/)
  assert.equal(await checked.store.getDoc(restoreKey('a@mumbo.si')), undefined)
})

test('--set refuses an unknown id, a delete marker, and a version of another key, and writes nothing', async () => {
  for (const [versionId, why] of [['v-nope', /not a version of/], ['v-marker', /delete marker/], ['v-longer-key', /not a version of/], ['v-other', /not a version of/]]) {
    const store = memoryStore()
    await assert.rejects(run({ versionId, action: 'set', store }), why, versionId)
    assert.equal(await store.getDoc(restoreKey('a@mumbo.si')), undefined, versionId)
  }
})

test('--set writes exactly the record the edge reads at the next creation, which restores that version; --clear removes it', async () => {
  const { out, store } = await run({ versionId: 'v-old', action: 'set' })
  assert.match(out, /set: the next creation of this box restores v-old/)
  assert.deepEqual(await store.getDoc(restoreKey('a@mumbo.si')), { versionId: 'v-old', at: 42 })
  // Without E2B, or when E2B fails, the box is not checked and the record is still written; a box is listed after the write.
  assert.match((await run({ versionId: 'v-new', action: 'set', store, e2b: undefined })).out, /set: the next creation of this box restores v-new \(replaced v-old\)\nbox: not checked \(E2B_API_KEY unset\); kill any running or paused box of a@mumbo.si after --set$/)
  const down = { Sandbox: { list: () => ({ hasNext: true, nextItems: async () => { throw new Error('connect ECONNREFUSED') } }) } }
  assert.match((await run({ versionId: 'v-old', action: 'set', store, e2b: down })).out, /set: the next creation of this box restores v-old \(replaced v-new\)\nbox: not checked \(connect ECONNREFUSED\); kill any running or paused box of a@mumbo.si after --set$/)
  assert.deepEqual(await store.getDoc(restoreKey('a@mumbo.si')), { versionId: 'v-old', at: 42 })
  const presigned = []; const ran = []
  const box = (id) => ({ sandboxId: id, files: { write: async () => {} }, kill: async () => {}, commands: { run: async (c) => { ran.push(c); return { stdout: c.includes('dsh.log') ? 'launch123' : '' } } } })
  const e2b = { Sandbox: { list: () => ({ hasNext: true, nextItems: async function () { this.hasNext = false; return [] } }), create: async () => box('b1'), setTimeout: async () => {} } }
  const cfg = { publicHost: 'boxes.example', projectDomain: 'boxes.example', llmHost: 'llm.example', template: 'mumbo-box', idleMs: 60_000, maxRunningUnits: 0 }
  const edge = boxes({ e2b, store, cfg, edgeKey: 'k', presignGet: async (key, v) => { presigned.push([key, v]); return `GET-${v}` }, presignPut: async () => 'PUT', log: () => {} })
  await edge.ensure('a@mumbo.si')
  assert.deepEqual(presigned, [[KEY, 'v-old']])
  assert.ok(ran.includes(restoreCommand('GET-v-old')))

  assert.match((await run({ action: 'clear', store })).out, /cleared the pending restore of v-old/)
  assert.equal(await store.getDoc(restoreKey('a@mumbo.si')), undefined)
  assert.match((await run({ action: 'clear', store })).out, /cleared: nothing was pending/)
})
