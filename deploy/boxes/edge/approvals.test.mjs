// node --test: the merge approval service against a fake GitHub, and the mumbo-bot App's repository tokens.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generateKeyPairSync, verify } from 'node:crypto'
import { memoryStore } from './store.mjs'
import { projects, addRepo } from './projects.mjs'
import { approvalsService } from './approvals.mjs'
import { mintRepoToken } from './github-app.mjs'

const REPO = 'acme/app'
const ID = 'acme/app#1'
const SHA = 'a'.repeat(40)
const NEW = 'b'.repeat(40)
const OLD = 'c'.repeat(40)
const MERGED = 'd'.repeat(40)
const AGENT = 'mumbo-agent'
const FOUNDER = 'founder@x.com'
const NOW = Date.UTC(2026, 10, 9, 12)
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })

const pull = (n, over = {}) => ({
  number: n, state: 'open', draft: false, title: `Change ${n}`, html_url: `https://github.com/${REPO}/pull/${n}`, user: { login: AGENT },
  base: { ref: 'main', repo: { full_name: REPO } }, head: { ref: `agent/t${n}`, sha: SHA, repo: { full_name: REPO } },
  additions: 10, deletions: 2, changed_files: 1, ...over,
})
const file = (filename, extra = {}) => ({ filename, additions: 1, deletions: 0, ...extra })
const run = (name, conclusion = 'success', id = 1) => ({ id, name, status: 'completed', conclusion })
let comments = 0
const comment = (body, login = AGENT) => ({ user: { login }, body, html_url: `https://github.com/${REPO}/pull/1#issuecomment-${++comments}` })
const marker = (sha, verdict, login = AGENT) => comment(`<!-- mumbo-review sha=${sha} verdict=${verdict} -->\nReview report.`, login)

/** A fake api.github.com that routes on method and path; every call is recorded with its authorization and body. */
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
    grantFor: (asked) => ({ token: 'bot-token', repositories: [{ full_name: REPO }], permissions: { ...asked.permissions, metadata: 'read' } }),
    calls: [],
  }
  const json = (body, status = 200) => new Response(status === 204 ? null : JSON.stringify(body), { status })
  const page = (list, q) => { const p = Number(q.get('page') ?? 1), n = Number(q.get('per_page') ?? 30); return json(list.slice((p - 1) * n, p * n)) }
  gh.fetchImpl = async (url, init = {}) => {
    const { pathname: path, searchParams: q } = new URL(url)
    const method = init.method ?? 'GET'
    gh.calls.push({ method, path, auth: init.headers.authorization, body: init.body === undefined ? undefined : JSON.parse(init.body) })
    if (gh.down) return json({ message: 'unavailable' }, 502)
    const m = (re) => path.match(re)?.[1]
    let n
    if (method === 'GET' && path === `/repos/${REPO}/pulls`) {
      // The list endpoint omits additions, deletions and changed_files, as GitHub's does.
      return page(gh.pulls.filter(p => p.state === q.get('state')).map(({ additions, deletions, changed_files, ...simple }) => simple), q)
    }
    if (method === 'GET' && (n = m(/^\/repos\/acme\/app\/pulls\/(\d+)$/))) return json(gh.pulls.find(p => p.number === Number(n)))
    if (method === 'GET' && (n = m(/^\/repos\/acme\/app\/pulls\/(\d+)\/files$/))) { gh.onFiles?.(); return page(gh.files[n] ?? [], q) }
    if (method === 'GET' && (n = m(/^\/repos\/acme\/app\/issues\/(\d+)\/comments$/))) return page(gh.comments[n] ?? [], q)
    if (method === 'GET' && (n = m(/^\/repos\/acme\/app\/commits\/([0-9a-f]{40})\/check-runs$/))) return json({ check_runs: gh.runs[n] ?? [] })
    if (method === 'GET' && path === `/repos/${REPO}/installation`) return json({ id: 77 })
    if (method === 'POST' && path === '/app/installations/77/access_tokens') return json(gh.grantFor(JSON.parse(init.body)), 201)
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

/** A project owned by FOUNDER (with a plain member) that has REPO, and the service over a fake GitHub. */
async function setup() {
  const gh = fakeGithub()
  const store = memoryStore()
  const p = projects({ store, admitted: () => true, log: () => {} })
  const { id: project } = await p.create(FOUNDER, 'App')
  await p.addMember(FOUNDER, project, 'member@x.com')
  await addRepo(store, project, REPO)
  const notes = [], audits = [], clock = { t: NOW }
  const svc = approvalsService({
    store, github: { agentToken: 'agent-token', app: { appId: '5295930', privateKey }, agentLogin: AGENT, requiredChecks: ['static', 'unit'] },
    notify: async (message) => { notes.push(message) }, audit: async (record) => { audits.push(record) },
    fetchImpl: gh.fetchImpl, now: () => clock.t, approveHost: 'approve.boxes.mumbo.si',
  })
  return { gh, store, project, svc, notes, audits, clock }
}
const only = async (svc) => { const items = await svc.list(FOUNDER); assert.equal(items.length, 1); return items[0] }

// ---- what gets listed

test('the poller creates an item with the facts it read, for the owner only, reading with the agent token', async () => {
  const { gh, svc, project } = await setup()
  gh.pulls[0].changed_files = 2
  gh.files[1] = [file('src/a.js', { additions: 8 }), file('src/b.js', { previous_filename: 'src/old.js' })]
  // The newest unit run decides; a check that is not required does not count.
  gh.runs[SHA] = [run('static'), run('unit', 'failure', 1), run('unit', 'success', 2), run('lint', 'failure')]
  // The newest agent marker for the head SHA counts: not a stranger's, and not a marker below the first line.
  gh.comments[1] = [marker(SHA, 'fail'), gh.pass, marker(SHA, 'fail', 'stranger'), comment('Thanks!'), comment(`Note\n<!-- mumbo-review sha=${SHA} verdict=fail -->`)]
  await svc.poll()
  assert.deepEqual(await svc.list(FOUNDER), [{
    id: ID, project, repo: REPO, number: 1, title: 'Change 1', url: `https://github.com/${REPO}/pull/1`, sha: SHA,
    additions: 10, deletions: 2, changedFiles: 2, files: ['src/a.js', 'src/b.js'], protected: [],
    checks: { static: 'success', unit: 'success' }, checksGreen: true, review: { verdict: 'pass', url: gh.pass.html_url, excerpt: 'Review report.' },
    lowRisk: true, ruleVersion: 1, firstSeen: NOW, notifiedSha: SHA,
  }])
  assert.deepEqual(await svc.list('member@x.com'), [])
  assert.ok(gh.calls.every(c => c.method === 'GET' && c.auth === 'Bearer agent-token'))
})

test('only agent PRs into main, from an agent/ branch of the same repository, and ready, are listed', async () => {
  const { gh, svc } = await setup()
  const head = (over) => ({ head: { ref: 'agent/x', sha: SHA, repo: { full_name: REPO }, ...over } })
  gh.pulls = [
    pull(1, { base: { ref: 'dev', repo: { full_name: REPO } } }),
    pull(2, head({ repo: { full_name: 'fork/app' } })),
    pull(3, head({ repo: null })),
    pull(4, head({ ref: 'feature/x' })),
    pull(5, { user: { login: 'someone' } }),
    pull(6, { draft: true }),
    pull(7),
  ]
  await svc.poll()
  assert.deepEqual((await svc.list(FOUNDER)).map(i => i.id), ['acme/app#7'])
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
  ['a required check still running', (gh) => { gh.runs[SHA] = [run('static'), { id: 2, name: 'unit', status: 'in_progress', conclusion: null }] }, { checks: { static: 'success', unit: 'in_progress' } }],
  ['a missing required check', (gh) => { gh.runs[SHA] = [run('static')] }, { checks: { static: 'success', unit: 'missing' } }],
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
  assert.ok(gh.calls.every(c => c.method === 'GET' && c.auth === 'Bearer agent-token'))
  assert.equal((await only(svc)).id, ID)
})

test('grant merges at the SHA with a minted App token, never the agent token, revokes it, audits with firstSeen, and removes the item', async () => {
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
  assert.equal(pr.auth, 'Bearer agent-token')
  assert.equal(runs.auth, 'Bearer agent-token')
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
  const { gh, store, svc, project } = await setup()
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

// ---- mumbo-bot repository tokens

test('mintRepoToken: an RS256 App JWT finds the installation and asks for that one repository and the named permissions', async () => {
  const gh = fakeGithub()
  const bot = await mintRepoToken({ appId: '5295930', privateKey, repo: REPO, permissions: { contents: 'write' }, fetchImpl: gh.fetchImpl, now: () => NOW + 999 })
  assert.equal(bot.token, 'bot-token')
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

test('mintRepoToken refuses and revokes a grant wider than asked', async () => {
  for (const wide of [
    { permissions: { contents: 'read', workflows: 'write', metadata: 'read' } },
    { permissions: { contents: 'write' } },
    { repositories: [{ full_name: REPO }, { full_name: 'acme/other' }] },
    { repositories: [{ full_name: 'evil/app' }] },
    { repositories: undefined },
    { permissions: undefined },
  ]) {
    const gh = fakeGithub()
    gh.grantFor = (asked) => ({ token: 'bot-token', repositories: [{ full_name: REPO }], permissions: asked.permissions, ...wide })
    await assert.rejects(mintRepoToken({ appId: '5295930', privateKey, repo: REPO, permissions: { contents: 'read' }, fetchImpl: gh.fetchImpl, now: () => NOW }), /wider than asked/, JSON.stringify(wide))
    assert.deepEqual(gh.calls.at(-1), { method: 'DELETE', path: '/installation/token', auth: 'Bearer bot-token', body: undefined })
  }
})
