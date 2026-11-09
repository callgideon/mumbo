// node --test: project repositories and ownership lookups used by the M1 edge services.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { memoryStore } from './store.mjs'
import { projects, getRepos, addRepo, projectsWithRepos, ownersOf, projectsOwnedBy } from './projects.mjs'

test('repos: empty by default, appended once, and the project joins projects:with-repos', async () => {
  const store = memoryStore()
  const p = projects({ store, admitted: () => true, log: () => {} })
  const { id } = await p.create('a@x.com', 'P')
  const { id: other } = await p.create('a@x.com', 'Q')
  assert.deepEqual(await getRepos(store, id), [])
  assert.deepEqual(await getRepos(store, 'not-an-id'), [])
  assert.deepEqual(await projectsWithRepos(store), [])
  await addRepo(store, id, 'callgideon/mumbo')
  await addRepo(store, id, 'callgideon/mumbo')
  await addRepo(store, id, 'CallGideon/Mumbo')
  await addRepo(store, id, 'callgideon/site')
  assert.deepEqual(await getRepos(store, id), ['callgideon/mumbo', 'callgideon/site'])
  assert.deepEqual(await projectsWithRepos(store), [id])
  assert.deepEqual(await getRepos(store, other), [])
  // The member doc layout is kept: membership still works and other fields survive.
  const doc = await p.get(id)
  assert.equal(doc.name, 'P'); assert.deepEqual(doc.members, ['a@x.com'])
  assert.equal(await p.isMember('a@x.com', id), true)
})

test('addRepo refuses an unknown project and a name that is not owner/name', async () => {
  const store = memoryStore()
  const { id } = await projects({ store, admitted: () => true, log: () => {} }).create('a@x.com', 'P')
  await assert.rejects(addRepo(store, '0123456789abcdef', 'o/r'), (e) => e.status === 404)
  for (const bad of ['mumbo', 'o/r/x', 'o r/x', 'o/', '', 'o/r?x', undefined]) await assert.rejects(addRepo(store, id, bad), (e) => e.status === 400, bad)
  assert.deepEqual(await projectsWithRepos(store), [])
})

test('ownersOf and projectsOwnedBy follow the owner field, not membership', async () => {
  const store = memoryStore()
  const p = projects({ store, admitted: () => true, log: () => {} })
  const { id: mine } = await p.create('a@x.com', 'Mine')
  const { id: theirs } = await p.create('b@x.com', 'Theirs')
  await p.addMember('b@x.com', theirs, 'a@x.com')
  assert.deepEqual(await ownersOf(store, mine), ['a@x.com'])
  assert.deepEqual(await ownersOf(store, theirs), ['b@x.com'])
  assert.deepEqual(await ownersOf(store, '0123456789abcdef'), [])
  assert.deepEqual(await projectsOwnedBy(store, 'a@x.com'), [mine])
  assert.deepEqual(await projectsOwnedBy(store, 'b@x.com'), [theirs])
  assert.deepEqual(await projectsOwnedBy(store, 'c@x.com'), [])
})
