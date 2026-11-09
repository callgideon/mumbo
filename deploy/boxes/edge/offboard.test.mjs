// node --test: the offboarding script defaults to a dry run and deletes only with the repeated email.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { userPrefix } from './edge.mjs'
import { offboard, offboardArgs } from './offboard.mjs'

test('arguments: dry run by default; --delete must repeat the email', () => {
  assert.deepEqual(offboardArgs(['A@Mumbo.si']), { email: 'a@mumbo.si', apply: false })
  assert.deepEqual(offboardArgs(['a@mumbo.si', '--delete', 'A@mumbo.si']), { email: 'a@mumbo.si', apply: true })
  for (const bad of [[], ['nobody'], ['a@mumbo.si', '--delete'], ['a@mumbo.si', '--delete', 'b@mumbo.si'], ['a@mumbo.si', '--force', 'a@mumbo.si'], ['a@mumbo.si', '--delete', 'a@mumbo.si', 'x']])
    assert.throws(() => offboardArgs(bad), /usage|confirmation/, bad.join(' '))
})

function fakes() {
  const calls = []
  const e2b = { Sandbox: {
    list: (o) => { calls.push(['list', o.query.metadata.user]); let done = false; return { get hasNext() { return !done }, nextItems: async () => { done = true; return [{ sandboxId: 'sb1' }] } } },
    kill: async (id) => { calls.push(['kill', id]) },
  } }
  const s3 = {
    listObjectVersions: async (b, p) => { calls.push(['list-s3', p]); return [{ Key: `${p}latest.tar.gz`, VersionId: 'v1' }] },
    deleteVersions: async (b, o) => { calls.push(['delete-s3', o.length]) },
  }
  return { e2b, s3, calls }
}

test('dry run lists and deletes nothing', async () => {
  const { e2b, s3, calls } = fakes()
  const r = await offboard({ email: 'a@mumbo.si', apply: false, e2b, s3, bucket: 'b', say: () => {} })
  assert.equal(r.boxes.length, 1); assert.equal(r.versions.length, 1)
  assert.deepEqual(calls.map(c => c[0]), ['list', 'list-s3'])
  assert.equal(calls[1][1], `${userPrefix('a@mumbo.si')}/`)
})

test('apply kills the box and deletes the backup versions', async () => {
  const { e2b, s3, calls } = fakes()
  await offboard({ email: 'a@mumbo.si', apply: true, e2b, s3, bucket: 'b', say: () => {} })
  assert.deepEqual(calls.slice(2), [['kill', 'sb1'], ['delete-s3', 1]])
})
