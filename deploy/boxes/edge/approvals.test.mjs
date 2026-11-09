// node --test: the merge approval service against a fake GitHub, and the mumbo-bot App's repository tokens.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generateKeyPairSync, verify } from 'node:crypto'
import { memoryStore } from './store.mjs'
import { projects, addRepo, removeRepo } from './projects.mjs'
import { approvalsService } from './approvals.mjs'
import { mintToken, installationOf } from './github-app.mjs'
import { config } from './edge.mjs'

const REPO = 'acme/app'
const ID = 'acme/app#1'
const SHA = 'a'.repeat(40)
const NEW = 'b'.repeat(40)
const OLD = 'c'.repeat(40)
const MERGED = 'd'.repeat(40)
// The mumbo-bot App's bot user; approvals match it by id, never by login.
const BOT = { login: 'mumbo-bot[bot]', id: 341797844 }
const LOOKALIKE = { login: 'mumbo-bot[bot]', id: 999 }
const READ_PERMISSIONS = { contents: 'read', pull_requests: 'read', checks: 'read', statuses: 'read', issues: 'read' }
const FOUNDER = 'founder@x.com'
const NOW = Date.UTC(2026, 10, 9, 12)
const HOUR = 3_600_000
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })

const pull = (n, over = {}) => ({
  number: n, state: 'open', draft: false, title: `Change ${n}`, html_url: `https://github.com/${REPO}/pull/${n}`, user: BOT,
  base: { ref: 'main', repo: { full_name: REPO } }, head: { ref: `agent/t${n}`, sha: SHA, repo: { full_name: REPO } },
  additions: 10, deletions: 2, changed_files: 1, ...over,
})
const file = (filename, extra = {}) => ({ filename, additions: 1, deletions: 0, ...extra })
const run = (name, conclusion = 'success', id = 1, app = 'github-actions') => ({ id, name, status: 'completed', conclusion, app: { slug: app } })
let comments = 0
const comment = (body, user = BOT) => ({ user, body, html_url: `https://github.com/${REPO}/pull/1#issuecomment-${++comments}` })
const marker = (sha, verdict, user = BOT) => comment(`<!-- mumbo-review sha=${sha} verdict=${verdict} -->\nReview report.`, user)

/** A fake api.github.com that routes on method and path; every call is recorded with its authorization and body. A
 *  read-only mint (contents: read) gets read-token, any other bot-token; `mintStatus` other than 201 refuses mints;
 *  `unauthorized` answers 401 to reads with read-token. */
function fakeGithub() {
  const pass = marker(SHA, 'pass')
  const gh = {
    pulls: [pull(1)],
    files: { 1: [file('src/a.js', { additions: 10, deletions: 2 })] },
    runs: { [SHA]: [run('static'), run('unit')] },
    comments: { 1: [pass] },
    pass,
    mergeStatus: 200,
    down: false,
    mintStatus: 201,
    grantFor: (asked) => ({ token: asked.permissions.contents === 'read' ? 'read-token' : 'bot-token', expires_at: new Date(NOW + HOUR).toISOString(), repositories: [{ full_name: REPO }], permissions: { ...asked.permissions, metadata: 'read' } }),
    calls: [],
  }
  const json = (body, status = 200) => new Response(status === 204 ? null : JSON.stringify(body), { status })
  const page = (list, q) => { const p = Number(q.get('page') ?? 1), n = Number(q.get('per_page') ?? 30); return json(list.slice((p - 1) * n, p * n)) }
  gh.fetchImpl = async (url, init = {}) => {
    const { pathname, searchParams: q } = new URL(url)
    const path = pathname.toLowerCase()  // GitHub compares repository names case-insensitively
    const method = init.method ?? 'GET'
    gh.calls.push({ method, path, auth: init.headers.authorization, body: init.body === undefined ? undefined : JSON.parse(init.body) })
    if (gh.down) return json({ message: 'unavailable' }, 502)
    if (gh.unauthorized && init.headers.authorization === 'Bearer read-token') return json({ message: 'Bad credentials' }, 401)
    const m = (re) => path.match(re)?.[1]
    let n
    if (method === 'GET' && path === `/repos/${REPO}/pulls`) {
      // The list endpoint omits additions, deletions and changed_files, as GitHub's does.
      return page(gh.pulls.filter(p => p.state === q.get('state')).map(({ additions, deletions, changed_files, ...simple }) => simple), q)
    }
    if (method === 'GET' && (n = m(/^\/repos\/acme\/app\/pulls\/(\d+)$/))) return json(gh.pulls.find(p => p.number === Number(n)))
    if (method === 'GET' && (n = m(/^\/repos\/acme\/app\/pulls\/(\d+)\/files$/))) { await gh.onFiles?.(); return page(gh.files[n] ?? [], q) }
    if (method === 'GET' && (n = m(/^\/repos\/acme\/app\/issues\/(\d+)\/comments$/))) return page(gh.comments[n] ?? [], q)
    if (method === 'GET' && (n = m(/^\/repos\/acme\/app\/commits\/([0-9a-f]{40})\/check-runs$/))) return json({ check_runs: gh.runs[n] ?? [] })
    if (method === 'GET' && path === `/repos/${REPO}/installation`) return json({ id: 77 })
    if (method === 'POST' && path === '/app/installations/77/access_tokens') {
      return gh.mintStatus === 201 ? json(gh.grantFor(JSON.parse(init.body)), 201) : json({ message: 'The permissions requested are not granted to this installation.' }, gh.mintStatus)
    }
    if (method === 'DELETE' && path === '/installation/token') return json(null, 204)
    if (method === 'PUT' && (n = m(/^\/repos\/acme\/app\/pulls\/(\d+)\/merge$/))) {
      // GitHub's precondition: the merge names the PR's current head, or it answers 409.
      if (JSON.parse(init.body).sha !== gh.pulls.find(p => p.number === Number(n)).head.sha) return json({ message: 'Head branch was modified' }, 409)
      return json({ merged: gh.mergeStatus === 200, sha: MERGED }, gh.mergeStatus)
    }
    return json({ message: `unrouted ${method} ${path}` }, 500)
  }
  return gh
}

/** A project owned by FOUNDER (with a plain member) that has REPO, and the service over a fake GitHub; FOUNDER is the approver. */
async function setup({ approvers = [FOUNDER] } = {}) {
  const gh = fakeGithub()
  const store = memoryStore()
  const p = projects({ store, admitted: () => true, log: () => {} })
  const { id: project } = await p.create(FOUNDER, 'App')
  // Seeded directly: addMember refuses non-owners (member gate), but a stored member must still not count as owner.
  await store.putDoc(`project:${project}`, { ...(await p.get(project)), members: [FOUNDER, 'member@x.com'] })
  await store.addToSet('projects:member@x.com', project)
  await addRepo(store, project, REPO, { by: FOUNDER, approvers: [FOUNDER], installationOf: async () => 77 })
  const notes = [], audits = [], clock = { t: NOW }
  const svc = approvalsService({
    store, github: { app: { appId: '5295930', privateKey }, agentId: BOT.id, requiredChecks: ['static', 'unit'] },
    notify: async (message) => { notes.push(message) }, audit: async (record) => { audits.push(record) },
    fetchImpl: gh.fetchImpl, now: () => clock.t, approveHost: 'approve.boxes.mumbo.si', approvers,
  })
  return { gh, store, project, svc, notes, audits, clock }
}
const only = async (svc) => { const items = await svc.list(FOUNDER); assert.equal(items.length, 1); return items[0] }

// ---- what gets listed

test('the poller creates an item with the facts it read, for the owner only, reading with its own read-only App token', async () => {
  const { gh, svc, project } = await setup()
  gh.pulls[0].changed_files = 2
  gh.files[1] = [file('src/a.js', { additions: 8 }), file('src/b.js', { previous_filename: 'src/old.js' })]
  // The newest unit run decides; a check that is not required does not count.
  gh.runs[SHA] = [run('static'), run('unit', 'failure', 1), run('unit', 'success', 2), run('lint', 'failure')]
  // The newest agent marker for the head SHA counts: not a stranger's, not one from a look-alike login with another
  // id, and not a marker below the first line.
  gh.comments[1] = [marker(SHA, 'fail'), gh.pass, marker(SHA, 'fail', { login: 'stranger', id: 1 }), marker(SHA, 'fail', LOOKALIKE), comment('Thanks!'), comment(`Note\n<!-- mumbo-review sha=${SHA} verdict=fail -->`)]
  await svc.poll()
  assert.deepEqual(await svc.list(FOUNDER), [{
    id: ID, project, repo: REPO, number: 1, title: 'Change 1', url: `https://github.com/${REPO}/pull/1`, sha: SHA,
    additions: 10, deletions: 2, changedFiles: 2, files: ['src/a.js', 'src/b.js'], protected: [],
    checks: { static: 'success', unit: 'success' }, checksGreen: true, review: { verdict: 'pass', url: gh.pass.html_url, excerpt: 'Review report.' },
    lowRisk: true, ruleVersion: 1, firstSeen: NOW, notifiedSha: SHA,
  }])
  assert.deepEqual(await svc.list('member@x.com'), [])
  const [installation, mint, ...reads] = gh.calls
  assert.equal(installation.path, `/repos/${REPO}/installation`)
  assert.deepEqual(mint, { method: 'POST', path: '/app/installations/77/access_tokens', auth: installation.auth, body: { repositories: ['app'], permissions: READ_PERMISSIONS } })
  assert.ok(reads.length && reads.every(c => c.method === 'GET' && c.auth === 'Bearer read-token'))
  await svc.poll()
  assert.equal(gh.calls.filter(c => c.method === 'POST').length, 1, 'the read token is reused')
})

test('a read GitHub answers 401 drops the cached read token; the next poll mints a new one', async (t) => {
  const { gh, svc } = await setup()
  await svc.poll()
  gh.unauthorized = true
  const errors = t.mock.method(console, 'error', () => {})
  await svc.poll()
  assert.match(errors.mock.calls[0].arguments[0], /HTTP 401/)
  gh.unauthorized = false
  await svc.poll()
  assert.equal(gh.calls.filter(c => c.method === 'POST').length, 2)
  assert.equal((await only(svc)).id, ID)
})

test('a mint the installation refuses stops the poll loudly, naming the permissions, and lists nothing', async (t) => {
  const { gh, svc } = await setup()
  gh.mintStatus = 422
  const errors = t.mock.method(console, 'error', () => {})
  await svc.poll()
  assert.deepEqual(await svc.list(FOUNDER), [])
  assert.match(errors.mock.calls[0].arguments[0], /mumbo-bot App permissions not approved: The permissions requested are not granted to this installation\./)
  assert.ok(gh.calls.every(c => !c.path.startsWith(`/repos/${REPO}/pulls`)), 'no read without the read-only token')
})

test('only agent PRs into main, from an agent/ branch of the same repository, and ready, are listed', async () => {
  const { gh, svc } = await setup()
  const head = (over) => ({ head: { ref: 'agent/x', sha: SHA, repo: { full_name: REPO }, ...over } })
  gh.pulls = [
    pull(1, { base: { ref: 'dev', repo: { full_name: REPO } } }),
    pull(2, head({ repo: { full_name: 'fork/app' } })),
    pull(3, head({ repo: null })),
    pull(4, head({ ref: 'feature/x' })),
    pull(5, { user: { login: 'someone', id: 1 } }),
    pull(6, { draft: true }),
    pull(7),
    pull(8, { user: LOOKALIKE }),
    pull(9, { user: { login: 'renamed-bot[bot]', id: BOT.id } }),
  ]
  await svc.poll()
  assert.deepEqual((await svc.list(FOUNDER)).map(i => i.id), ['acme/app#7', 'acme/app#9'], 'the author is matched by id')
})

// ---- the low-risk rule, version 1 (the default fake PR is low-risk; the facts test asserts it)

for (const [name, change, expect] of [
  ['a marker for an old SHA gives no review', (gh) => { gh.comments[1] = [marker(OLD, 'pass')] }, { review: null }],
  ['a fail verdict', (gh) => { gh.comments[1] = [comment(`<!-- mumbo-review sha=${SHA} verdict=fail -->\r\n\r\nBreaks login.\r\n${'x'.repeat(500)}`)] },
    { review: { verdict: 'fail', url: gh => gh.comments[1][0].html_url, excerpt: `Breaks login.\n${'x'.repeat(386)}` } }],
  ['a protected path', (gh) => { gh.files[1] = [file('.github/CODEOWNERS')] }, { protected: ['.github/CODEOWNERS'] }],
  ['a rename from deploy/', (gh) => { gh.files[1] = [file('src/x.mjs', { previous_filename: 'deploy/x.mjs' })] }, { protected: ['deploy/x.mjs'] }],
  ['a nested package.json', (gh) => { gh.files[1] = [file('apps/web/package.json')] }, { protected: ['apps/web/package.json'] }],
  ['a file at the repository root', (gh) => { gh.files[1] = [file('README.md')] }, { protected: ['README.md'] }],
  ['200 changed lines', (gh) => { Object.assign(gh.pulls[0], { additions: 150, deletions: 50 }) }, {}],
  ['a red required check', (gh) => { gh.runs[SHA] = [run('static'), run('unit', 'failure')] }, { checks: { static: 'success', unit: 'failure' }, checksGreen: false }],
  ['a required check still running', (gh) => { gh.runs[SHA] = [run('static'), { id: 2, name: 'unit', status: 'in_progress', conclusion: null, app: { slug: 'github-actions' } }] }, { checks: { static: 'success', unit: 'in_progress' } }],
  ['a missing required check', (gh) => { gh.runs[SHA] = [run('static')] }, { checks: { static: 'success', unit: 'missing' } }],
  ['a required check from an App other than GitHub Actions', (gh) => { gh.runs[SHA] = [run('static'), run('unit', 'failure', 1), run('unit', 'success', 2, 'agent-bot')] },
    { checks: { static: 'success', unit: 'failure' } }],
]) {
  test(`not low-risk: ${name}`, async () => {
    const { gh, svc } = await setup()
    change(gh)
    await svc.poll()
    const item = await only(svc)
    assert.equal(item.lowRisk, false)
    for (const [k, v] of Object.entries(expect)) assert.deepEqual(item[k], k === 'review' && v ? { ...v, url: v.url(gh) } : v, k)
  })
}

test('the file list is read across pages, and one shorter than changed_files is not low-risk', async () => {
  const { gh, svc } = await setup()
  gh.files[1] = Array.from({ length: 150 }, (_, i) => file(`src/f${i}.js`, { additions: 0 }))
  gh.pulls[0].changed_files = 150
  await svc.poll()
  assert.equal((await only(svc)).files.length, 150)
  assert.equal((await only(svc)).lowRisk, true)
  gh.pulls[0].changed_files = 151
  await svc.poll()
  assert.equal((await only(svc)).lowRisk, false)
})

test('a head that moves while the files are read is not saved with those files; the next poll reads it', async () => {
  const { gh, svc } = await setup()
  gh.onFiles = () => { gh.pulls[0].head.sha = NEW; gh.onFiles = undefined }
  await svc.poll()
  assert.deepEqual(await svc.list(FOUNDER), [])
  await svc.poll()
  assert.equal((await only(svc)).sha, NEW)
})

// ---- notifications and cleanup

test('notify fires once per (id, sha), and again after a new head; firstSeen is kept', async () => {
  const { gh, svc, notes, clock } = await setup()
  await svc.poll()
  clock.t = NOW + 60_000
  await svc.poll()
  assert.deepEqual(notes, [{ title: 'Approve merge: acme/app#1', body: 'Change 1 · 12 lines · low-risk', click: 'https://approve.boxes.mumbo.si/' }])
  gh.pulls[0].head.sha = NEW
  await svc.poll()
  assert.deepEqual(notes[1], { title: 'Approve merge: acme/app#1', body: 'Change 1 · 12 lines · needs a look', click: 'https://approve.boxes.mumbo.si/' })
  await svc.poll()
  assert.equal(notes.length, 2)
  const item = await only(svc)
  assert.equal(item.sha, NEW)
  assert.equal(item.firstSeen, NOW)
})

test('a PR turned back into a draft, closed, or no longer a candidate is removed', async () => {
  const { gh, svc, store, project } = await setup()
  gh.pulls.push(pull(2), pull(3))
  await svc.poll()
  assert.equal((await svc.list(FOUNDER)).length, 3)
  gh.pulls[0].draft = true
  gh.pulls[1].state = 'closed'
  gh.pulls[2].base.ref = 'dev'
  await svc.poll()
  assert.deepEqual(await svc.list(FOUNDER), [])
  assert.deepEqual(await store.setMembers(`approvals:open:${project}`), [])
  assert.equal(await store.getDoc(`approval:${ID}`), undefined)
})

test('a repository GitHub does not answer for keeps its items until a poll reads it', async (t) => {
  const { gh, svc } = await setup()
  await svc.poll()
  const errors = t.mock.method(console, 'error', () => {})
  gh.down = true
  await svc.poll()
  assert.equal((await only(svc)).id, ID)
  assert.equal(errors.mock.callCount(), 1)
})

// ---- grant

test('grant refusals without a GitHub call: not_found before not_owner, then not_owner, then a stale SHA', async () => {
  const { gh, svc } = await setup()
  await svc.poll()
  const before = gh.calls.length
  assert.deepEqual(await svc.grant('stranger@x.com', 'acme/app#9', SHA), { id: 'acme/app#9', merged: false, sha: SHA, reason: 'not_found' })
  assert.deepEqual(await svc.grant('member@x.com', ID, NEW), { id: ID, merged: false, sha: NEW, reason: 'not_owner' })
  assert.deepEqual(await svc.grant(FOUNDER, ID, NEW), { id: ID, merged: false, sha: NEW, reason: 'sha_moved' })
  assert.equal(gh.calls.length, before)
})

test('grant re-reads GitHub: a base changed to dev or a closed PR is not_candidate, then red checks are checks_not_green, with no merge', async () => {
  const { gh, svc } = await setup()
  await svc.poll()
  gh.pulls[0].base.ref = 'dev'
  gh.runs[SHA] = [run('static'), run('unit', 'failure')]
  assert.equal((await svc.grant(FOUNDER, ID, SHA)).reason, 'not_candidate')
  gh.pulls[0].base.ref = 'main'
  gh.pulls[0].state = 'closed'
  assert.equal((await svc.grant(FOUNDER, ID, SHA)).reason, 'not_candidate')
  gh.pulls[0].state = 'open'
  assert.equal((await svc.grant(FOUNDER, ID, SHA)).reason, 'checks_not_green')
  assert.ok(gh.calls.filter(c => c.path.startsWith(`/repos/${REPO}/`) && c.path !== `/repos/${REPO}/installation`).every(c => c.method === 'GET' && c.auth === 'Bearer read-token'))
  assert.equal(gh.calls.filter(c => c.method === 'POST').length, 1, 'only the poll\'s read-only mint')
  assert.equal((await only(svc)).id, ID)
})

test('grant merges at the SHA with a single-repository merge token, never the read token, revokes it, audits with firstSeen, and removes the item', async () => {
  const { gh, svc, audits, clock } = await setup()
  await svc.poll()
  clock.t = NOW + 60_000
  const before = gh.calls.length
  assert.deepEqual(await svc.grant(FOUNDER, ID, SHA), { id: ID, merged: true, sha: SHA })
  const calls = gh.calls.slice(before)
  assert.deepEqual(calls.map(c => `${c.method} ${c.path}`), [
    'GET /repos/acme/app/pulls/1', `GET /repos/acme/app/commits/${SHA}/check-runs`, 'GET /repos/acme/app/installation',
    'POST /app/installations/77/access_tokens', 'PUT /repos/acme/app/pulls/1/merge', 'DELETE /installation/token',
  ])
  const [pr, runs, installation, mint, merge, revoke] = calls
  assert.equal(pr.auth, 'Bearer read-token')
  assert.equal(runs.auth, 'Bearer read-token')
  assert.match(installation.auth, /^Bearer ey[\w-]+\.[\w-]+\.[\w-]+$/)
  assert.equal(mint.auth, installation.auth)
  assert.deepEqual(mint.body, { repositories: ['app'], permissions: { contents: 'write', pull_requests: 'write' } })
  assert.deepEqual(merge.body, { sha: SHA, merge_method: 'merge' })
  assert.equal(merge.auth, 'Bearer bot-token')
  assert.equal(revoke.auth, 'Bearer bot-token')
  assert.deepEqual(audits, [{
    at: new Date(NOW + 60_000).toISOString(), email: FOUNDER, via: 'grant', id: ID, sha: SHA, mergeCommitSha: MERGED, ruleVersion: 1, lowRisk: true, files: ['src/a.js'],
    checks: { static: 'success', unit: 'success' }, review: { verdict: 'pass', url: gh.pass.html_url, excerpt: 'Review report.' }, firstSeen: NOW,
  }])
  assert.deepEqual(await svc.list(FOUNDER), [])
})

test('a head that moved after showing: the merge names the shown SHA, GitHub refuses it, sha_moved re-polls at the new head; another failure is github_error; both revoke', async (t) => {
  const { gh, svc, audits } = await setup()
  await svc.poll()
  gh.pulls[0].head.sha = NEW
  assert.deepEqual(await svc.grant(FOUNDER, ID, SHA), { id: ID, merged: false, sha: SHA, reason: 'sha_moved' })
  assert.deepEqual(gh.calls.filter(c => c.method === 'PUT').map(c => c.body), [{ sha: SHA, merge_method: 'merge' }])
  assert.equal(gh.calls.filter(c => c.method === 'DELETE').length, 1)
  assert.equal((await only(svc)).sha, NEW)
  t.mock.method(console, 'error', () => {})
  gh.runs[NEW] = [run('static'), run('unit')]
  gh.mergeStatus = 500
  assert.deepEqual(await svc.grant(FOUNDER, ID, NEW), { id: ID, merged: false, sha: NEW, reason: 'github_error' })
  assert.equal(gh.calls.filter(c => c.method === 'DELETE').length, 2)
  assert.deepEqual(audits, [])
})

test('grantLowRisk merges only the shown pairs still low-risk at that SHA, and reports each skipped pair', async () => {
  const { gh, svc, audits } = await setup()
  gh.pulls.push(pull(2), pull(3), pull(4))
  gh.files[2] = [file('deploy/main.tf')]
  for (const n of [3, 4]) gh.files[n] = gh.files[1]
  for (const n of [2, 3, 4]) gh.comments[n] = [marker(SHA, 'pass')]
  await svc.poll()
  assert.deepEqual((await svc.list(FOUNDER)).filter(i => i.lowRisk).map(i => i.id), ['acme/app#1', 'acme/app#3', 'acme/app#4'])
  // #3 is low-risk but was not shown; #4 was shown at an older head.
  assert.deepEqual(await svc.grantLowRisk(FOUNDER, [{ id: ID, sha: SHA }, { id: 'acme/app#2', sha: SHA }, { id: 'acme/app#4', sha: OLD }, { id: 'acme/app#9', sha: SHA }]), [
    { id: ID, merged: true, sha: SHA },
    { id: 'acme/app#2', merged: false, sha: SHA, reason: 'not_low_risk' },
    { id: 'acme/app#4', merged: false, sha: OLD, reason: 'sha_moved' },
    { id: 'acme/app#9', merged: false, sha: SHA, reason: 'not_found' },
  ])
  assert.deepEqual(await svc.grantLowRisk('member@x.com', [{ id: 'acme/app#3', sha: SHA }]), [{ id: 'acme/app#3', merged: false, sha: SHA, reason: 'not_owner' }])
  assert.deepEqual(gh.calls.filter(c => c.method === 'PUT').map(c => c.path), ['/repos/acme/app/pulls/1/merge'])
  assert.deepEqual(audits.map(a => [a.id, a.via, a.mergeCommitSha]), [[ID, 'grantLowRisk', MERGED]])
  assert.deepEqual((await svc.list(FOUNDER)).map(i => i.id), ['acme/app#2', 'acme/app#3', 'acme/app#4'])
})

test('an item stays with the project that first listed it, even when stored data binds its repository to a second project', async (t) => {
  const { gh, store, svc, project } = await setup({ approvers: [FOUNDER, 'mallory@x.com'] })
  const { id: other } = await projects({ store, admitted: () => true, log: () => {} }).create('mallory@x.com', 'Mine')
  // addRepo refuses this binding (projects.test.mjs); write it directly, as legacy or corrupted data would hold it.
  await store.putDoc(`project:${other}`, { ...(await store.getDoc(`project:${other}`)), repos: [REPO] })
  await store.addToSet('projects:with-repos', other)
  await store.addToSet(`approvals:open:${other}`, ID)
  const errors = t.mock.method(console, 'error', () => {})
  await svc.poll()
  await svc.poll()
  assert.equal((await only(svc)).project, project)
  assert.deepEqual(await svc.list('mallory@x.com'), [])
  assert.deepEqual(await svc.grant('mallory@x.com', ID, SHA), { id: ID, merged: false, sha: SHA, reason: 'not_owner' })
  assert.equal(gh.calls.filter(c => c.method === 'PUT').length, 0)
  assert.equal(errors.mock.callCount(), 2)  // one "not rebound" line per poll
})

test('removing a project\'s last repository: its item is no longer listed, and a grant does not merge it', async () => {
  const { gh, store, svc, project } = await setup()
  await svc.poll()
  assert.equal((await only(svc)).project, project)
  await removeRepo(store, project, REPO, { by: FOUNDER, approvers: [FOUNDER] })
  await svc.poll()
  assert.deepEqual(await svc.grant(FOUNDER, ID, SHA), { id: ID, merged: false, sha: SHA, reason: 'not_found' })
  assert.deepEqual(await svc.list(FOUNDER), [])
  assert.deepEqual(await store.setMembers(`approvals:open:${project}`), [])
  assert.equal(gh.calls.filter(c => c.method === 'PUT').length, 0, 'never merged')
})

test('a repository given up and bound to a second project: the next poll moves its item there, for the new owner to merge', async () => {
  const SECOND = 'second@x.com'
  const { store, svc, project } = await setup({ approvers: [FOUNDER, SECOND] })
  await svc.poll()
  await removeRepo(store, project, REPO, { by: FOUNDER, approvers: [FOUNDER, SECOND] })
  const { id: second } = await projects({ store, admitted: () => true, log: () => {} }).create(SECOND, 'Second')
  await addRepo(store, second, REPO, { by: SECOND, approvers: [FOUNDER, SECOND], installationOf: async () => 77 })
  await svc.poll()  // nobody listed or granted in between: the poll itself takes the item over
  assert.deepEqual((await svc.list(SECOND)).map(i => [i.id, i.project]), [[ID, second]])
  assert.deepEqual(await store.setMembers(`approvals:open:${project}`), [], 'gone from the first project')
  assert.deepEqual(await svc.list(FOUNDER), [])
  assert.equal((await svc.grant(FOUNDER, ID, SHA)).reason, 'not_owner')
  assert.equal((await svc.grant(SECOND, ID, SHA)).merged, true, 'the new owner merges it')
})

test('list() alone drops an item whose repository was removed, with no dropRepo and no poll in between', async () => {
  const { store, svc, project } = await setup()
  await svc.poll()
  await removeRepo(store, project, REPO, { by: FOUNDER, approvers: [FOUNDER] })
  assert.deepEqual(await svc.list(FOUNDER), [])
  assert.deepEqual(await store.setMembers(`approvals:open:${project}`), [])
  assert.equal(await store.getDoc(`approval:${ID}`), undefined)
})

test('a repository removed while a poll reads its pull request: no notification for the new head, and the item is not saved again', async () => {
  const { gh, store, svc, project, notes } = await setup()
  await svc.poll()
  assert.equal(notes.length, 1)
  gh.pulls[0].head.sha = NEW
  gh.runs[NEW] = [run('static'), run('unit')]
  gh.onFiles = async () => { gh.onFiles = undefined; await removeRepo(store, project, REPO, { by: FOUNDER, approvers: [FOUNDER] }) }
  await svc.poll()
  assert.equal(notes.length, 1, 'no notification after the unbind')
  assert.deepEqual(await store.setMembers(`approvals:open:${project}`), [])
  assert.equal(await store.getDoc(`approval:${ID}`), undefined, 'not resurrected')
})

test('removing one of two repositories: grant refuses its item as not_found and drops it; dropRepo removes a repository\'s items', async (t) => {
  const { gh, store, svc, project } = await setup()
  gh.pulls.push(pull(2))
  await svc.poll()
  await addRepo(store, project, 'acme/lib', { by: FOUNDER, approvers: [FOUNDER], installationOf: async () => 77 })
  await store.addToSet(`approvals:open:${project}`, 'acme/lib#5')
  await store.putDoc('approval:acme/lib#5', { id: 'acme/lib#5', project, repo: 'acme/lib', number: 5, sha: SHA })
  await removeRepo(store, project, REPO, { by: FOUNDER, approvers: [FOUNDER] })
  assert.deepEqual(await svc.grant(FOUNDER, ID, SHA), { id: ID, merged: false, sha: SHA, reason: 'not_found' })
  assert.equal(await store.getDoc(`approval:${ID}`), undefined, 'grant dropped it')
  await svc.dropRepo(project, REPO)
  assert.deepEqual(await store.setMembers(`approvals:open:${project}`), ['acme/lib#5'], 'acme/app#2 dropped, acme/lib kept')
  assert.equal(await store.getDoc('approval:acme/app#2'), undefined)
  assert.deepEqual((await svc.list(FOUNDER)).map(i => i.id), ['acme/lib#5'], 'the other repository\'s item stays')
  t.mock.method(console, 'error', () => {})  // acme/lib is not on the fake GitHub
  await svc.poll()
  assert.equal(gh.calls.filter(c => c.method === 'PUT').length, 0)
})

test('ids use the lowercased repository, and a project never takes or deletes another project\'s item', async (t) => {
  const { store, svc, project } = await setup({ approvers: [FOUNDER, 'mallory@x.com'] })
  const p = projects({ store, admitted: () => true, log: () => {} })
  const { id: mallory } = await p.create('mallory@x.com', 'Same repo, other case')
  const { id: third } = await p.create('mallory@x.com', 'Stale entry')
  // Stored data addRepo now refuses: the same repository in another letter case, and another project's item in an open set.
  await store.putDoc(`project:${mallory}`, { ...(await p.get(mallory)), repos: ['ACME/App'] })
  await store.putDoc(`project:${third}`, { ...(await p.get(third)), repos: [] })
  for (const id of [mallory, third]) await store.addToSet('projects:with-repos', id)
  await store.addToSet(`approvals:open:${third}`, ID)
  t.mock.method(console, 'error', () => {})
  await svc.poll()
  assert.deepEqual((await svc.list(FOUNDER)).map(i => [i.id, i.project]), [[ID, project]])
  assert.deepEqual(await svc.list('mallory@x.com'), [])
  assert.deepEqual(await store.setMembers(`approvals:open:${third}`), [])
  assert.equal((await svc.grant('mallory@x.com', 'ACME/App#1', SHA)).reason, 'not_found')
})

test('only an approver who owns the project merges: an owner who is not an approver, and an approver who is not the owner, get not_owner', async () => {
  const { gh, svc, audits } = await setup({ approvers: ['member@x.com'] })
  await svc.poll()
  const before = gh.calls.length
  assert.deepEqual(await svc.grant(FOUNDER, ID, SHA), { id: ID, merged: false, sha: SHA, reason: 'not_owner' })
  assert.deepEqual(await svc.grantLowRisk(FOUNDER, [{ id: ID, sha: SHA }]), [{ id: ID, merged: false, sha: SHA, reason: 'not_owner' }])
  assert.deepEqual(await svc.grant('member@x.com', ID, SHA), { id: ID, merged: false, sha: SHA, reason: 'not_owner' })
  assert.equal(gh.calls.length, before)
  assert.deepEqual(audits, [])
  assert.equal((await only(svc)).id, ID)
})

test('APPROVER_EMAILS: comma-separated and lowercased; unset or empty means nobody', () => {
  const vars = { PUBLIC_HOST: 'boxes.mumbo.si', LLM_HOST: 'llm.boxes.mumbo.si', BACKUP_BUCKET: 'backups', APPROVER_EMAILS: undefined }
  const saved = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]))
  const apply = (values) => { for (const [k, v] of Object.entries(values)) if (v === undefined) delete process.env[k]; else process.env[k] = v }
  try {
    apply(vars)
    assert.deepEqual(config().approverEmails, [])
    for (const empty of ['', ' , ']) { process.env.APPROVER_EMAILS = empty; assert.deepEqual(config().approverEmails, [], empty) }
    process.env.APPROVER_EMAILS = ' Founder@X.com,b@x.com, '
    assert.deepEqual(config().approverEmails, ['founder@x.com', 'b@x.com'])
  } finally { apply(saved) }
})

// ---- mumbo-bot repository tokens

test('mintToken: an RS256 App JWT finds the installation and asks for those repositories and the named permissions', async () => {
  const gh = fakeGithub()
  const bot = await mintToken({ appId: '5295930', privateKey, repos: [REPO], permissions: { contents: 'write' }, fetchImpl: gh.fetchImpl, now: () => NOW + 999 })
  assert.equal(bot.token, 'bot-token')
  assert.equal(bot.expiresAt, NOW + HOUR)
  const [installation, mint] = gh.calls
  assert.equal(installation.path, `/repos/${REPO}/installation`)
  const [h, p, s] = installation.auth.replace(/^Bearer /, '').split('.')
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'RS256', typ: 'JWT' })
  assert.deepEqual(JSON.parse(Buffer.from(p, 'base64url')), { iat: NOW / 1000 - 60, exp: NOW / 1000 + 540, iss: '5295930' })
  assert.ok(verify('sha256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, 'base64url')))
  assert.deepEqual(mint, { method: 'POST', path: '/app/installations/77/access_tokens', auth: installation.auth, body: { repositories: ['app'], permissions: { contents: 'write' } } })
  await bot.revoke()
  assert.deepEqual(gh.calls.at(-1), { method: 'DELETE', path: '/installation/token', auth: 'Bearer bot-token', body: undefined })
})

test('mintToken refuses and revokes a grant other than asked, wider or narrower', async () => {
  for (const wide of [
    { permissions: { contents: 'read', workflows: 'write', metadata: 'read' } },
    { permissions: { contents: 'write' } },
    { permissions: { metadata: 'read' } },
    { permissions: { contents: 'read', metadata: 'write' } },
    { repositories: [] },
    { repositories: [{ full_name: REPO }, { full_name: 'acme/other' }] },
    { repositories: [{ full_name: 'evil/app' }] },
    { repositories: undefined },
    { permissions: undefined },
  ]) {
    const gh = fakeGithub()
    gh.grantFor = (asked) => ({ token: 'bot-token', repositories: [{ full_name: REPO }], permissions: asked.permissions, ...wide })
    await assert.rejects(mintToken({ appId: '5295930', privateKey, repos: [REPO], permissions: { contents: 'read' }, fetchImpl: gh.fetchImpl, now: () => NOW }), /differs from what was asked/, JSON.stringify(wide))
    assert.deepEqual(gh.calls.at(-1), { method: 'DELETE', path: '/installation/token', auth: 'Bearer bot-token', body: undefined })
  }
})

test('mintToken classifies refusals: unapproved permissions, a repository outside the installation, a rate limit, any other; repositories of two owners, or none, ask nothing', async () => {
  for (const [status, message, headers, code, text] of [
    [422, 'The permissions requested are not granted to this installation.', {}, 'not_approved', 'mumbo-bot App permissions not approved: The permissions requested are not granted to this installation.'],
    [422, 'There is at least one repository that does not exist or is not accessible to the parent installation.', {}, 'repo_not_installed', 'repo_not_installed: There is at least one repository that does not exist or is not accessible to the parent installation.'],
    [403, 'API rate limit exceeded', { 'x-ratelimit-remaining': '0' }, 'rate_limited', "mumbo-bot token mint failed: GitHub's rate limit (HTTP 403); retry later"],
    [403, 'The permissions requested are not granted to this installation.', {}, 'refused', 'mumbo-bot App refused the token (HTTP 403): The permissions requested are not granted to this installation.'],
    [500, undefined, {}, 'refused', 'mumbo-bot App refused the token (HTTP 500): no message'],
  ]) {
    const gh = fakeGithub()
    const fetchImpl = (url, init) => (init.method === 'POST' ? Promise.resolve(new Response(JSON.stringify(message ? { message } : {}), { status, headers })) : gh.fetchImpl(url, init))
    await assert.rejects(mintToken({ appId: '5295930', privateKey, repos: [REPO], permissions: READ_PERMISSIONS, fetchImpl, now: () => NOW }), { code, message: text }, `${status} ${message}`)
    assert.equal(gh.calls.at(-1).path, `/repos/${REPO}/installation`, 'no token, nothing to revoke')
  }
  for (const repos of [[REPO, 'other/app'], []]) {
    const gh = fakeGithub()
    await assert.rejects(mintToken({ appId: '5295930', privateKey, repos, permissions: READ_PERMISSIONS, fetchImpl: gh.fetchImpl, now: () => NOW }), /one owner's repositories/)
    assert.equal(gh.calls.length, 0)
  }
  await assert.rejects(mintToken({ appId: '5295930', privateKey: undefined, repos: [REPO], permissions: READ_PERMISSIONS, fetchImpl: fakeGithub().fetchImpl, now: () => NOW }), /mumbo-bot App is not configured/)
})

test('installationOf: the App JWT reads the repository\'s installation id without minting; 404 is none; other failures reject', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push([init.method, new URL(url).pathname, init.headers.authorization])
    const status = { '/repos/acme/app/installation': 200, '/repos/acme/missing/installation': 404 }[new URL(url).pathname] ?? 502
    return new Response(JSON.stringify(status === 200 ? { id: 77 } : { message: 'no' }), { status })
  }
  const of = installationOf({ appId: '5295930', privateKey, fetchImpl, now: () => NOW })
  assert.equal(await of(REPO), 77)
  assert.equal(await of('acme/missing'), undefined)
  await assert.rejects(of('acme/down'), /GitHub GET \/repos\/acme\/down\/installation: HTTP 502/)
  assert.deepEqual(calls.map(([method, path]) => `${method} ${path}`), ['GET /repos/acme/app/installation', 'GET /repos/acme/missing/installation', 'GET /repos/acme/down/installation'])
  assert.ok(calls.every(([, , auth]) => /^Bearer ey[\w-]+\.[\w-]+\.[\w-]+$/.test(auth)), 'an App JWT, never a token')
})
