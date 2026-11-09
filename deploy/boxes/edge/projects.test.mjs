// node --test: project repositories and ownership lookups used by the M1 edge services.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { memoryStore } from './store.mjs'
import { projects, getRepos, addRepo, projectsWithRepos, ownersOf, projectsOwnedBy } from './projects.mjs'

/** addRepo's caller: `by`, with both test owners as approvers. */
const as = (by) => ({ by, approvers: ['a@x.com', 'm@x.com'] })

test('repos: empty by default, appended once, and the project joins projects:with-repos', async () => {
  const store = memoryStore()
  const p = projects({ store, admitted: () => true, log: () => {} })
  const { id } = await p.create('a@x.com', 'P')
  const { id: other } = await p.create('a@x.com', 'Q')
  assert.deepEqual(await getRepos(store, id), [])
  assert.deepEqual(await getRepos(store, 'not-an-id'), [])
  assert.deepEqual(await projectsWithRepos(store), [])
  await addRepo(store, id, 'callgideon/mumbo', as('a@x.com'))
  await addRepo(store, id, 'callgideon/mumbo', as('a@x.com'))
  await addRepo(store, id, 'CallGideon/Mumbo', as('a@x.com'))
  await addRepo(store, id, 'callgideon/site', as('a@x.com'))
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
  await assert.rejects(addRepo(store, '0123456789abcdef', 'o/r', as('a@x.com')), (e) => e.status === 404)
  for (const bad of ['mumbo', 'o/r/x', 'o r/x', 'o/', '', 'o/r?x', undefined]) await assert.rejects(addRepo(store, id, bad, as('a@x.com')), (e) => e.status === 400, bad)
  assert.deepEqual(await projectsWithRepos(store), [])
})

test('a repository bound to one project cannot be bound to another, in any letter case; its binding is unchanged', async () => {
  const store = memoryStore()
  const p = projects({ store, admitted: () => true, log: () => {} })
  const { id: founder } = await p.create('a@x.com', 'Founder')
  const { id: other } = await p.create('m@x.com', 'Other')
  await addRepo(store, founder, 'callgideon/mumbo', as('a@x.com'))
  for (const repo of ['callgideon/mumbo', 'CallGideon/MUMBO']) {
    await assert.rejects(addRepo(store, other, repo, as('m@x.com')), (e) => e.status === 409 && e.code === 'repo_bound' && /already belongs to another project/.test(e.message), repo)
  }
  await addRepo(store, founder, 'CallGideon/Mumbo', as('a@x.com'))
  assert.deepEqual(await getRepos(store, founder), ['callgideon/mumbo'])
  assert.deepEqual(await getRepos(store, other), [])
  assert.deepEqual(await projectsWithRepos(store), [founder])
  // Two projects racing for one repository, each reading the other's repositories before either writes: exactly one gets it.
  await addRepo(store, other, 'm/own', as('m@x.com'))
  const slow = { ...store, getDoc: async (k) => { const v = await store.getDoc(k); await new Promise(r => setTimeout(r, 5)); return v } }
  const results = await Promise.allSettled([addRepo(slow, founder, 'callgideon/site', as('a@x.com')), addRepo(slow, other, 'callgideon/site', as('m@x.com'))])
  assert.deepEqual(results.map(r => r.status).sort(), ['fulfilled', 'rejected'])
})

test('only an approver who owns the project binds a repository (403 otherwise, nothing bound)', async () => {
  const store = memoryStore()
  const p = projects({ store, admitted: () => true, log: () => {} })
  const { id } = await p.create('o@x.com', 'Owner, not an approver')
  const { id: founder } = await p.create('a@x.com', 'Founder')
  for (const [who, opts] of [['an owner who is not an approver', as('o@x.com')], ['an approver who is not the owner', as('a@x.com')],
    ['no caller', undefined], ['an empty approver list', { by: 'o@x.com', approvers: [] }]]) {
    await assert.rejects(addRepo(store, id, 'o/r', opts), (e) => e.status === 403, who)
  }
  assert.deepEqual(await getRepos(store, id), [])
  assert.deepEqual(await projectsWithRepos(store), [])
  await addRepo(store, founder, 'o/r', as('a@x.com'))
  assert.deepEqual(await getRepos(store, founder), ['o/r'])
})

test('ownersOf and projectsOwnedBy follow the owner field, not membership', async () => {
  const store = memoryStore()
  const p = projects({ store, admitted: () => true, log: () => {} })
  const { id: mine } = await p.create('a@x.com', 'Mine')
  const { id: theirs } = await p.create('b@x.com', 'Theirs')
  // Seeded directly: addMember refuses non-owners (member gate), but a stored member must still not count as owner.
  await store.putDoc(`project:${theirs}`, { ...(await p.get(theirs)), members: ['b@x.com', 'a@x.com'] })
  await store.addToSet('projects:a@x.com', theirs)
  assert.deepEqual(await ownersOf(store, mine), ['a@x.com'])
  assert.deepEqual(await ownersOf(store, theirs), ['b@x.com'])
  assert.deepEqual(await ownersOf(store, '0123456789abcdef'), [])
  assert.deepEqual(await projectsOwnedBy(store, 'a@x.com'), [mine])
  assert.deepEqual(await projectsOwnedBy(store, 'b@x.com'), [theirs])
  assert.deepEqual(await projectsOwnedBy(store, 'c@x.com'), [])
})

test('member gate: addMember refuses a non-owner with 403 member_gate; re-adding the owner changes nothing', async () => {
  const store = memoryStore()
  const p = projects({ store, admitted: () => true, log: () => {} })
  const { id } = await p.create('a@x.com', 'P')
  await assert.rejects(p.addMember('a@x.com', id, 'b@x.com'), (e) => e.status === 403 && e.code === 'member_gate')
  assert.deepEqual((await p.get(id)).members, ['a@x.com'])
  assert.deepEqual(await store.setMembers('projects:b@x.com'), [])
  assert.deepEqual(await p.addMember('a@x.com', id, ' A@X.com '), { id, members: ['a@x.com'] })
})
