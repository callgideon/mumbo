// node --test: project repositories and ownership lookups used by the M1 edge services.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { memoryStore } from './store.mjs'
import { projects, projectRelay, getRepos, addRepo, removeRepo, projectsWithRepos, ownersOf, projectsOwnedBy } from './projects.mjs'

/** The mumbo-bot App's installation by repository owner; `other` is another installation, `nowhere` has none. */
const INSTALLATIONS = { acme: 77, callgideon: 77, m: 77, o: 77, other: 88 }
const installationOf = async (repo) => INSTALLATIONS[repo.split('/')[0].toLowerCase()]
/** addRepo's caller: `by`, with both test owners as approvers, and the App's installations. */
const as = (by) => ({ by, approvers: ['a@x.com', 'm@x.com'], installationOf })

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
  for (const bad of ['mumbo', 'o/r/x', 'o r/x', 'o/', '', 'o/r?x', '../x', 'o/..', './r', 'o/.', undefined]) await assert.rejects(addRepo(store, id, bad, as('a@x.com')), (e) => e.status === 400, bad)
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
    ['no caller', undefined], ['an empty approver list', { by: 'o@x.com', approvers: [], installationOf }]]) {
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

test('addRepo binds only a repository in the mumbo-bot App installation that the project\'s repositories share', async () => {
  const store = memoryStore()
  const { id } = await projects({ store, admitted: () => true, log: () => {} }).create('a@x.com', 'P')
  await assert.rejects(addRepo(store, id, 'nowhere/app', as('a@x.com')), (e) => e.status === 400 && e.code === 'repo_not_installed' && /mumbo-bot App is not installed for nowhere\/app/.test(e.message))
  assert.deepEqual(await projectsWithRepos(store), [], 'nothing bound')
  await addRepo(store, id, 'acme/a', as('a@x.com'))
  await addRepo(store, id, 'callgideon/b', as('a@x.com'))
  await assert.rejects(addRepo(store, id, 'other/c', as('a@x.com')), (e) => e.status === 409 && e.code === 'repo_other_installation' && /another mumbo-bot installation than acme\/a/.test(e.message))
  assert.deepEqual(await getRepos(store, id), ['acme/a', 'callgideon/b'])
  // Any other GitHub failure is no answer: it fails with the check named and no HTTP status of its own, so the approve
  // page reports it as an edge error rather than its own 403 or 400, and binds nothing.
  for (const status of [403, 400, 502]) {
    const down = async (repo) => { throw Object.assign(new Error(`GitHub GET /repos/${repo}/installation: HTTP ${status}`), { status }) }
    await assert.rejects(addRepo(store, id, 'acme/c', { ...as('a@x.com'), installationOf: down }),
      (e) => e.status === undefined && e.message === `installation check for acme/c failed: GitHub GET /repos/acme/c/installation: HTTP ${status}` && e.cause?.status === status, String(status))
  }
  assert.deepEqual(await getRepos(store, id), ['acme/a', 'callgideon/b'])
})

test('addRepo refuses with 409 repo_changed when the project\'s first repository changes during the installation check', async () => {
  const store = memoryStore()
  const { id } = await projects({ store, admitted: () => true, log: () => {} }).create('a@x.com', 'P')
  // Another bind lands while GitHub answers this one's installation check.
  const racing = async (repo) => { await store.putDoc(`project:${id}`, { ...(await store.getDoc(`project:${id}`)), repos: ['acme/first'] }); return installationOf(repo) }
  await assert.rejects(addRepo(store, id, 'other/x', { ...as('a@x.com'), installationOf: racing }), (e) => e.status === 409 && e.code === 'repo_changed')
  assert.deepEqual(await getRepos(store, id), ['acme/first'], 'other/x, in another installation than acme/first, is not bound')
})

test('removeRepo: an approver who owns the project unbinds a repository; the last one leaves projects:with-repos and another project may take it', async () => {
  const store = memoryStore()
  const p = projects({ store, admitted: () => true, log: () => {} })
  const { id } = await p.create('a@x.com', 'P')
  const { id: other } = await p.create('m@x.com', 'Q')
  const { id: notApprover } = await p.create('o@x.com', 'R')
  await addRepo(store, id, 'acme/a', as('a@x.com'))
  await addRepo(store, id, 'acme/b', as('a@x.com'))
  await store.putDoc(`project:${notApprover}`, { ...(await p.get(notApprover)), repos: ['acme/r'] })
  for (const [who, project, opts] of [['an approver who is not the owner', id, as('m@x.com')], ['an owner who is not an approver', notApprover, as('o@x.com')], ['no caller', id, undefined]]) {
    await assert.rejects(removeRepo(store, project, project === id ? 'acme/a' : 'acme/r', opts), (e) => e.status === 403, who)
  }
  await assert.rejects(removeRepo(store, '0123456789abcdef', 'acme/a', as('a@x.com')), (e) => e.status === 404, 'unknown project')
  await removeRepo(store, id, 'ACME/A', as('a@x.com'))
  assert.deepEqual(await getRepos(store, id), ['acme/b'])
  await assert.rejects(removeRepo(store, id, 'acme/a', as('a@x.com')), (e) => e.status === 404 && /acme\/a is not a repository of this project/.test(e.message), 'not bound')
  assert.deepEqual(await projectsWithRepos(store), [id])
  await removeRepo(store, id, 'acme/b', as('a@x.com'))
  assert.deepEqual(await getRepos(store, id), [])
  assert.deepEqual(await projectsWithRepos(store), [])
  await addRepo(store, other, 'acme/a', as('m@x.com'))
  assert.deepEqual(await getRepos(store, other), ['acme/a'])
})

test('the relay keeps the coordinator session in its own key: its first write, racing removeRepo, leaves the repository unbound', async () => {
  const store = memoryStore()
  const p = projects({ store, admitted: () => true, log: () => {} })
  const { id } = await p.create('a@x.com', 'P')
  await addRepo(store, id, 'acme/a', as('a@x.com'))
  // removeRepo lands just before the relay's first store write after the session is created.
  let created = false, raced = false
  const racing = { ...store, async putDoc(key, value) {
    if (created && !raced) { raced = true; await removeRepo(store, id, 'acme/a', as('a@x.com')) }
    return store.putDoc(key, value)
  } }
  const methods = []
  const boxFetch = async (target, host, path, init) => {
    const req = JSON.parse(init.body)
    methods.push(req.method)
    if (req.method === 'session/create') created = true
    return { status: 200, setCookie: [], body: JSON.stringify({ result: { ok: true, value: req.method === 'session/create' ? { sessionId: 'S1' } : {} } }) }
  }
  const box = { ensure: async () => ({ id: 'pbox', token: 'TOK', member: (m) => m }) }
  const relay = projectRelay({ store: racing, projects: projects({ store: racing, admitted: () => true, log: () => {} }), box, boxFetch, siteHostOf: () => 'h', log: () => {} })
  assert.equal((await relay.message('a@x.com', id, 'hi')).coordinatorSession, 'S1')
  assert.equal(raced, true)
  assert.deepEqual(await getRepos(store, id), [], 'still unbound')
  assert.deepEqual(await projectsWithRepos(store), [])
  assert.equal((await relay.message('a@x.com', id, 'again')).coordinatorSession, 'S1', 'the session is reused')
  // A project doc written before the session key existed keeps its session.
  const { id: old } = await p.create('a@x.com', 'Old')
  await store.putDoc(`project:${old}`, { ...(await p.get(old)), coordinatorSessionId: 'S0' })
  assert.equal((await relay.message('a@x.com', old, 'hi')).coordinatorSession, 'S0')
  assert.deepEqual(methods, ['session/create', 'session/prompt', 'session/prompt', 'session/prompt'])
})
