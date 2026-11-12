// node --test: the offboarding script defaults to a dry run, touches only the named person, and verifies the result.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { userPrefix } from './edge.mjs'
import { memoryStore } from './store.mjs'
import { assertEdgeStore, offboard, offboardArgs, s3Adapter } from './offboard.mjs'

test('arguments: dry run by default; --delete must repeat the email', () => {
  assert.deepEqual(offboardArgs(['A@Mumbo.si']), { email: 'a@mumbo.si', apply: false, allowEmptyStore: false })
  assert.deepEqual(offboardArgs(['a@mumbo.si', '--delete', 'A@mumbo.si']), { email: 'a@mumbo.si', apply: true, allowEmptyStore: false })
  assert.equal(offboardArgs(['a@mumbo.si', '--allow-empty-store']).allowEmptyStore, true)
  for (const bad of [[], ['nobody'], ['a@mumbo.si', '--delete'], ['a@mumbo.si', '--delete', 'b@mumbo.si'], ['a@mumbo.si', '--force', 'a@mumbo.si'], ['a@mumbo.si', '--delete', 'a@mumbo.si', 'x']])
    assert.throws(() => offboardArgs(bad), /usage|confirmation/, bad.join(' '))
})

/** An E2B fake that, like a loose backend, returns every sandbox for any query, so the script's own exact filter is under test. */
function fakes({ stuck = false } = {}) {
  const calls = []
  let sandboxes = [
    { sandboxId: 'box-a', metadata: { user: 'a@mumbo.si' } }, { sandboxId: 'box-aa', metadata: { user: 'aa@mumbo.si' } },
    { sandboxId: 'kid-a', metadata: { owner: 'a@mumbo.si' } }, { sandboxId: 'kid-aa', metadata: { owner: 'aa@mumbo.si' } },
    { sandboxId: 'proj-1', metadata: { user: 'project:0123456789abcdef' } },
  ]
  const e2b = { Sandbox: {
    list: () => { let more = true; return { get hasNext() { return more }, nextItems: async () => { more = false; return sandboxes } } },
    kill: async (id) => { calls.push(['kill', id]); if (!stuck) sandboxes = sandboxes.filter(s => s.sandboxId !== id) },
  } }
  const prefix = (p) => `${p}latest.tar.gz`
  let versions = [{ Key: prefix(`${userPrefix('a@mumbo.si')}/`), VersionId: 'v1' }, { Key: prefix(`${userPrefix('a@mumbo.si')}/`), VersionId: 'v2' }]
  const s3 = {
    listObjectVersions: async () => { calls.push(['list-s3']); return versions },
    deleteVersions: async (b, o) => { calls.push(['delete-s3', o.length]); versions = [] },
  }
  return { e2b, s3, calls }
}
const storeWithProject = async () => {
  const store = memoryStore()
  await store.putDoc('project:0123456789abcdef', { id: '0123456789abcdef', name: 'n', owner: 'a@mumbo.si', members: [] })
  await store.addToSet('projects:a@mumbo.si', '0123456789abcdef')
  return store
}

test('dry run lists ids with owners and the owned project, and deletes nothing', async () => {
  const { e2b, s3, calls } = fakes(); const out = []
  const r = await offboard({ email: 'a@mumbo.si', apply: false, e2b, s3, bucket: 'b', store: await storeWithProject(), say: (l) => out.push(l) })
  assert.deepEqual(r.sandboxes.map(s => s.id), ['box-a', 'kid-a']); assert.equal(r.versions.length, 2); assert.deepEqual(r.projects, ['0123456789abcdef'])
  assert.equal(calls.some(c => c[0] === 'kill' || c[0] === 'delete-s3'), false)
  const text = out.join('\n')
  assert.match(text, /box box-a owner a@mumbo.si/); assert.match(text, /child kid-a owner a@mumbo.si/); assert.match(text, /project 0123456789abcdef.*proj-1.*NOT deleted/)
  assert.doesNotMatch(text, /aa@mumbo.si/)
})

test('apply kills only the named person\'s box and child, drops the edges\' cached box, deletes versions, verifies, and leaves projects', async () => {
  const { e2b, s3, calls } = fakes()
  const store = await storeWithProject()
  store.invalidate = async (kind, id) => { calls.push(['invalidate', kind, id]) }
  await offboard({ email: 'a@mumbo.si', apply: true, e2b, s3, bucket: 'b', store, say: () => {} })
  assert.deepEqual(calls.filter(c => ['kill', 'invalidate'].includes(c[0])), [['kill', 'box-a'], ['invalidate', 'box', 'box-a'], ['kill', 'kid-a']])
  assert.ok(calls.findIndex(c => c[0] === 'kill') < calls.findIndex(c => c[0] === 'delete-s3'), 'kill first')
})

test('apply fails loudly when a sandbox survives', async () => {
  const { e2b, s3 } = fakes({ stuck: true })
  await assert.rejects(offboard({ email: 'a@mumbo.si', apply: true, e2b, s3, bucket: 'b', store: memoryStore(), say: () => {} }), /incomplete.*box-a/)
})

test('S3 adapter: pages, delete markers, batches of 1000, and per-object errors', async () => {
  const sent = []
  const Cmd = (name) => class { constructor(input) { this.name = name; this.input = input } }
  const cmds = { ListObjectVersionsCommand: Cmd('list'), DeleteObjectsCommand: Cmd('delete') }
  let errors
  const client = { send: async (c) => {
    sent.push(c)
    if (c.name === 'delete') return { Errors: errors }
    const t = new Date('2026-11-01T00:00:00Z')
    return c.input.KeyMarker === undefined
      ? { Versions: [{ Key: 'k1', VersionId: 'a', LastModified: t, Size: 10, IsLatest: false, ETag: 'e', StorageClass: 'STANDARD' }], IsTruncated: true, NextKeyMarker: 'k1', NextVersionIdMarker: 'a' }
      : { DeleteMarkers: [{ Key: 'k1', VersionId: 'm', LastModified: t, IsLatest: true }], IsTruncated: false }
  } }
  const s3 = s3Adapter(client, cmds)
  const t = new Date('2026-11-01T00:00:00Z')
  const listed = await s3.listObjectVersions('b', 'p/')
  assert.deepEqual(listed, [{ Key: 'k1', VersionId: 'a', LastModified: t, Size: 10, IsLatest: false }, { Key: 'k1', VersionId: 'm', LastModified: t, Size: undefined, IsLatest: true, DeleteMarker: true }])
  assert.equal(sent[1].input.KeyMarker, 'k1'); assert.equal(sent[1].input.VersionIdMarker, 'a')
  sent.length = 0
  await s3.deleteVersions('b', Array.from({ length: 2500 }, (_, i) => ({ Key: 'k', VersionId: String(i) })))
  assert.deepEqual(sent.map(c => c.input.Delete.Objects.length), [1000, 1000, 500])
  // A listing passed straight back deletes by Key and VersionId only: no Size condition reaches S3.
  sent.length = 0
  await s3.deleteVersions('b', listed)
  assert.deepEqual(sent[0].input.Delete.Objects, [{ Key: 'k1', VersionId: 'a' }, { Key: 'k1', VersionId: 'm' }])
  errors = [{ Message: 'AccessDenied' }]
  await assert.rejects(s3.deleteVersions('b', [{ Key: 'k', VersionId: '1' }]), /refused 1.*AccessDenied/)
})

test('a store without the edge box index is refused', async () => {
  await assert.rejects(assertEdgeStore({ sCard: async () => 0 }), /holds no `boxes` set/)
  await assertEdgeStore({ sCard: async () => 3 })
  await assertEdgeStore({ sCard: async () => 0 }, true)
})
