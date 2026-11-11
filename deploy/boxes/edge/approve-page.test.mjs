// node --test: the approve page with fake approvals and halt services and a memory store. POSTs need the approve
// origin and a CSRF token; every interpolated value is escaped; the low-risk form grants exactly the pairs it showed.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHmac } from 'node:crypto'
import { createServer, request } from 'node:http'
import { approvePage } from './approve-page.mjs'
import { memoryStore } from './store.mjs'
import { addRepo, getRepos } from './projects.mjs'

const HOST = 'approve.boxes.mumbo.si'
const FOUNDER = 'f@x.com'
const OTHER = 'o@x.com'
const KEY = Buffer.from('k'.repeat(32))
const NOW = Date.parse('2026-11-09T12:00:00Z')
const MINE = 'aaaaaaaaaaaaaaaa'
const THEIRS = 'bbbbbbbbbbbbbbbb'
const csrf = (email, day) => createHmac('sha256', KEY).update(`${email}:${day}`).digest('base64url')
const TOKEN = csrf(FOUNDER, '2026-11-09')
const EVIL = '"><form action=x><script>'
/** The mumbo-bot App's installations: acme repositories share 77, elsewhere is 88, nowhere has none. */
const installationOf = async (repo) => ({ acme: 77, elsewhere: 88 })[repo.split('/')[0]]

const item = (over) => ({
  project: MINE, repo: 'acme/app', additions: 10, deletions: 2, changedFiles: 1, files: ['src/a.ts'], protected: [],
  checks: { static: 'success', unit: 'success' }, checksGreen: true, review: { verdict: 'pass', excerpt: 'Small and tested.' },
  lowRisk: true, ruleVersion: 1, firstSeen: NOW, ...over,
})
const ITEMS = [
  item({ id: 'acme/app#7', number: 7, title: EVIL, sha: 'a'.repeat(40) }),
  item({ id: 'acme/app#8', number: 8, title: 'Touch deploy', sha: `${'b'.repeat(39)}"`, additions: 300, files: ['deploy/x.tf'], protected: ['deploy/x.tf'],
    checks: { static: 'success', unit: 'failure' }, checksGreen: false, review: { verdict: 'fail', excerpt: `bad ${EVIL}` }, lowRisk: false }),
  item({ id: 'acme/lib#2', repo: 'acme/lib', number: 2, title: 'Lib fix', sha: 'c'.repeat(40) }),
  item({ id: 'acme/app#9', number: 9, title: 'Big change', sha: `${'e'.repeat(39)}"`, additions: 300, lowRisk: false }),
  item({ id: 'acme/app#10', number: 10, title: 'Unreviewed', sha: 'f'.repeat(40), review: null, lowRisk: false }),
]

const listen = (server) => new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port)))
const call = (port, { method = 'GET', path = '/', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port, method, path, headers: body === undefined ? headers : { 'content-length': Buffer.byteLength(body), ...headers } }, (res) => {
    let text = ''; res.setEncoding('utf8'); res.on('data', c => { text += c }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }))
  })
  req.on('error', reject)
  req.end(body)
})
const FORM = { origin: `https://${HOST}`, 'content-type': 'application/x-www-form-urlencoded' }
const post = (port, path, fields, headers = FORM) => call(port, { method: 'POST', path, headers, body: new URLSearchParams(fields).toString() })
/** The hidden fields of the page's form posting to `action`, in order. */
const formFields = (html, action) => {
  const form = new RegExp(`<form method="post" action="${action}">([\\s\\S]*?)</form>`).exec(html)?.[1] ?? ''
  return [...form.matchAll(/<input type="hidden" name="([a-z]+)" value="([^"]*)">/g)].map(m => [m[1], m[2]])
}

async function setup(t, { approvers = [FOUNDER] } = {}) {
  const store = memoryStore()
  await store.putDoc(`project:${MINE}`, { id: MINE, name: 'App <b>', owner: FOUNDER, members: [FOUNDER], repos: ['acme/app'] })
  await store.putDoc(`project:${THEIRS}`, { id: THEIRS, name: 'Theirs', owner: OTHER, members: [OTHER, FOUNDER], repos: ['acme/theirs'] })
  await store.addToSet(`projects:${FOUNDER}`, MINE); await store.addToSet(`projects:${FOUNDER}`, THEIRS); await store.addToSet(`projects:${OTHER}`, THEIRS)
  const calls = []
  let stopped = false
  const skips = { 'acme/lib#2': 'sha_moved' }  // grantLowRisk's skip reason by id; any other shown pair merges
  const approvals = {
    async list(email) { calls.push(['list', email]); return email === FOUNDER ? ITEMS : [] },
    async grant(email, id, sha) { calls.push(['grant', email, id, sha]); return { id, sha, merged: true } },
    async grantLowRisk(email, shown) {
      calls.push(['grantLowRisk', email, shown])
      return shown.map(({ id, sha }) => (skips[id] ? { id, sha, merged: false, reason: skips[id] } : { id, sha, merged: true }))
    },
    async poll() { throw new Error('the page never polls') },
    async dropRepo(project, repo) { calls.push(['dropRepo', project, repo]) },
  }
  const halt = { async get(email) { return email === FOUNDER && stopped }, async set(email, on) { calls.push(['halt', email, on]); stopped = on } }
  let now = NOW
  const binds = []  // addRepo calls; `bindError` makes the next one fail with those fields
  let bindError
  const bindRepo = async (...args) => {
    binds.push(args)
    if (bindError) { const fields = bindError; bindError = undefined; throw Object.assign(new Error('refused'), fields) }
    return addRepo(...args)
  }
  const handler = approvePage({ approvals, halt, store, csrfKey: KEY, host: HOST, approvers, now: () => now, bindRepo, installationOf })
  // The signed-in email is FOUNDER unless a test names another in `x-as` (userServer passes it in production).
  const server = createServer((req, res) => handler(req, res, req.headers['x-as'] ?? FOUNDER).catch(e => res.writeHead(500).end(e.stack)))
  const port = await listen(server)
  t.after(() => server.close())
  return { port, calls, store, skips, binds, failBind: (status, code) => { bindError = { status, code } }, setNow: (ms) => { now = ms } }
}

test('GET / shows only list(email) items with their facts, escaped, and embeds the CSRF token', async (t) => {
  const { port, calls } = await setup(t)
  const r = await call(port)
  assert.equal(r.status, 200)
  assert.deepEqual(calls, [['list', FOUNDER]])
  assert.ok(r.body.includes('<a href="https://github.com/acme/app/pull/7">acme/app#7</a>'))
  assert.ok(r.body.includes('acme/app#8') && r.body.includes('acme/lib#2'))
  assert.ok(!r.body.includes(EVIL) && !r.body.includes('<script') && !r.body.includes('<b>'), 'title, excerpt and project name are escaped')
  assert.ok(r.body.includes('&#34;&#62;&#60;form action=x&#62;&#60;script&#62;'))
  assert.ok(r.body.includes(`name="sha" value="${'e'.repeat(39)}&#34;"`), 'hidden form values are escaped')
  assert.ok(r.body.includes('<code>aaaaaaa</code>'), 'short SHA')
  assert.ok(r.body.includes('· 302 lines changed') && r.body.includes('· 12 lines changed'))
  assert.ok(r.body.includes('deploy/x.tf'), 'protected paths are listed')
  assert.ok(r.body.includes('unit: failure'), 'each required check state')
  assert.equal((r.body.match(/Agent's review \(claim\): /g) ?? []).length, 5, 'every review is labelled a claim')
  assert.ok(r.body.includes('Small and tested.') && !/verif/i.test(r.body), 'never called verified')
  assert.equal((r.body.match(/>low-risk</g) ?? []).length, 2)
  assert.deepEqual(formFields(r.body, '/grant').filter(([k]) => k !== 'csrf'), [['id', 'acme/app#7'], ['sha', 'a'.repeat(40)]])
  assert.deepEqual(formFields(r.body, '/grant').find(([k]) => k === 'csrf'), ['csrf', TOKEN])
  assert.ok(r.body.includes('Approve 2 low-risk') && r.body.includes('Stop everything'))
  assert.ok(!r.body.includes('Theirs'), 'repository forms only for projects the email owns')

  const other = await call(port, { headers: { 'x-as': 'a<i>@x.com' } })
  assert.ok(other.body.includes('a&#60;i&#62;@x.com') && !other.body.includes('<i>'), 'the email is escaped')
  assert.ok(!other.body.includes('acme/app#7') && other.body.includes('Nothing to approve.'), "another person sees only their list(email) items")
})

test('every response carries the CSP and framing headers; any other path answers 404', async (t) => {
  const { port } = await setup(t)
  for (const r of [await call(port), await call(port, { path: '/x' }), await call(port, { path: '/grant' }), await post(port, '/x', {}), await post(port, '/grant', {}, {})]) {
    assert.equal(r.headers['content-security-policy'], "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")
    assert.equal(r.headers['x-frame-options'], 'DENY')
    assert.equal(r.headers['cache-control'], 'no-store')
    assert.equal(r.headers['referrer-policy'], 'same-origin', "no-referrer would make the page's own POSTs send Origin: null")
  }
  assert.equal((await call(port, { path: '/x' })).status, 404)
  assert.equal((await call(port, { path: '/grant' })).status, 404)
  assert.equal((await post(port, '/x', { csrf: TOKEN })).status, 404)
})

test('a POST without the exact approve origin, or with a bad CSRF token, is refused before any action', async (t) => {
  const { port, calls, store, setNow } = await setup(t)
  const fields = { id: 'acme/app#7', sha: 'a'.repeat(40), csrf: TOKEN }
  for (const origin of ['https://boxes.mumbo.si', 'http://approve.boxes.mumbo.si', 'https://approve.boxes.mumbo.si.evil.com', 'null']) {
    assert.equal((await post(port, '/grant', fields, { ...FORM, origin })).status, 403, origin)
  }
  const { origin, ...noOrigin } = FORM
  assert.equal((await post(port, '/grant', fields, noOrigin)).status, 403, 'missing Origin')
  for (const bad of ['', 'x', csrf(OTHER, '2026-11-09'), csrf(FOUNDER, '2026-11-07')]) {
    assert.equal((await post(port, '/grant', { ...fields, csrf: bad })).status, 403, bad)
  }
  assert.equal((await post(port, '/grant', { id: fields.id, sha: fields.sha })).status, 403, 'missing csrf')
  assert.equal((await post(port, '/halt', { on: '1', csrf: 'x' })).status, 403)
  assert.equal((await post(port, '/grant', fields, { ...FORM, 'content-type': 'text/plain' })).status, 415)
  assert.equal((await post(port, '/grant', { ...fields, pad: 'x'.repeat(8192) })).status, 413)
  // Every action, the repository ones included, needs the exact origin and a valid CSRF token.
  const actions = [['/grant', { id: fields.id, sha: fields.sha }], ['/grant-low-risk', { id: fields.id, sha: fields.sha }], ['/halt', { on: '1' }],
    ['/repo', { project: MINE, repo: 'acme/new' }], ['/repo-remove', { project: MINE, repo: 'acme/app' }]]
  for (const [action, form] of actions) {
    assert.equal((await post(port, action, { ...form, csrf: TOKEN }, { ...FORM, origin: 'https://boxes.mumbo.si' })).status, 403, `${action}: another origin`)
    assert.equal((await post(port, action, { ...form, csrf: TOKEN }, noOrigin)).status, 403, `${action}: no origin`)
    assert.equal((await post(port, action, { ...form, csrf: csrf(OTHER, '2026-11-09') })).status, 403, `${action}: another person's token`)
    assert.equal((await post(port, action, form)).status, 403, `${action}: no token`)
  }
  assert.deepEqual(await getRepos(store, MINE), ['acme/app'], 'no repository bound or removed')
  assert.deepEqual(calls, [], 'nothing was granted or halted')

  setNow(Date.parse('2026-11-10T00:30:00Z'))
  assert.equal((await post(port, '/grant', fields)).status, 303, "yesterday's token still works")
  setNow(Date.parse('2026-11-11T00:30:00Z'))
  assert.equal((await post(port, '/grant', fields)).status, 403, 'a token two days old does not')
})

test('a valid grant merges exactly the posted item at the posted SHA; notices show fixed text only', async (t) => {
  const { port, calls } = await setup(t)
  const r = await post(port, '/grant', { id: 'acme/app#7', sha: 'a'.repeat(40), csrf: TOKEN }, { ...FORM, 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' })
  assert.equal(r.status, 303)
  assert.equal(r.headers.location, '/?m=merged')
  assert.deepEqual(calls, [['grant', FOUNDER, 'acme/app#7', 'a'.repeat(40)]])
  assert.equal((await post(port, '/grant', { id: 'acme/app#7', csrf: TOKEN })).status, 400, 'no sha')

  assert.ok((await call(port, { path: '/?m=merged' })).body.includes('class="notice">Merged.'))
  for (const m of ['%3Cscript%3E', 'constructor', '__proto__', 'nope']) {
    const page = await call(port, { path: `/?m=${m}` })
    assert.ok(!page.body.includes('class="notice"') && !page.body.includes('<script'), m)
  }
})

test('an item without a pass review on its commit is not approvable: the reason, a disabled button, no form; a not_reviewed grant shows its notice', async (t) => {
  const { port } = await setup(t)
  const body = (await call(port)).body
  const cards = body.split('<section class="card">')
  for (const id of ['acme/app#8', 'acme/app#10']) {  // a fail marker; no marker
    const card = cards.find(c => c.includes(`>${id}</a>`))
    assert.ok(card.includes("Not approvable: the agent's review has not passed this commit.") && card.includes('<button class="primary" disabled>Approve</button>'), id)
    assert.ok(!card.includes('action="/grant"'), id)
  }
  assert.equal((body.match(/action="\/grant"/g) ?? []).length, 3, 'acme/app#7, acme/lib#2 and acme/app#9 pass')
  assert.ok((await call(port, { path: '/?m=not_reviewed' })).body.includes('class="notice">The agent\'s review has not passed that commit, so it was not merged.'))
})

test('"Approve N low-risk" posts the displayed low-risk pairs, grants exactly those, and reports each skipped pair', async (t) => {
  const { port, calls, skips } = await setup(t)
  const fields = formFields((await call(port)).body, '/grant-low-risk')
  assert.deepEqual(fields, [['id', 'acme/app#7'], ['sha', 'a'.repeat(40)], ['id', 'acme/lib#2'], ['sha', 'c'.repeat(40)], ['csrf', TOKEN]])
  const r = await post(port, '/grant-low-risk', fields)
  assert.equal(r.status, 303)
  assert.deepEqual(calls.at(-1), ['grantLowRisk', FOUNDER, [{ id: 'acme/app#7', sha: 'a'.repeat(40) }, { id: 'acme/lib#2', sha: 'c'.repeat(40) }]])
  assert.equal(r.headers.location, `/?${new URLSearchParams([['m', 'merged'], ['s', 'sha_moved:acme/lib#2']])}`)
  const page = await call(port, { path: r.headers.location })
  assert.ok(page.body.includes('class="notice">Merged.'))
  assert.ok(page.body.includes('<li>acme/lib#2: The pull request changed or cannot be merged as it stands. Review it again.</li>'))
  const forged = await call(port, { path: `/?m=merged&s=${encodeURIComponent(`sha_moved:${EVIL}`)}&s=evil:acme/lib%232` })
  assert.ok(!forged.body.includes('class="skipped"') && !forged.body.includes('<script'), 'a skip line needs a known reason and an item id')

  skips['acme/app#7'] = 'not_low_risk'
  const none = await post(port, '/grant-low-risk', fields)
  assert.equal(none.headers.location, `/?${new URLSearchParams([['m', 'not_low_risk'], ['s', 'not_low_risk:acme/app#7'], ['s', 'sha_moved:acme/lib#2']])}`)
  const nonePage = (await call(port, { path: none.headers.location })).body
  assert.ok(nonePage.includes('class="notice">No longer low-risk at that commit, so it was not merged.'))
  assert.ok(nonePage.includes('<li>acme/app#7: No longer low-risk at that commit') && nonePage.includes('<li>acme/lib#2: The pull request changed or cannot be merged as it stands.'))

  const before = calls.length
  assert.equal((await post(port, '/grant-low-risk', [['id', 'acme/app#7'], ['csrf', TOKEN]])).status, 400, 'unpaired id')
  assert.equal((await post(port, '/grant-low-risk', [['csrf', TOKEN]])).status, 400, 'nothing shown')
  assert.equal(calls.length, before)
})

test('the stop switch toggles the signed-in person', async (t) => {
  const { port, calls } = await setup(t)
  let r = await post(port, '/halt', { on: '1', csrf: TOKEN })
  assert.equal(r.headers.location, '/?m=halted')
  assert.deepEqual(calls.at(-1), ['halt', FOUNDER, true])
  const page = (await call(port, { path: '/?m=halted' })).body
  assert.deepEqual(formFields(page, '/halt'), [['on', '0'], ['csrf', TOKEN]])
  assert.ok(page.includes('Everything is stopped'))
  r = await post(port, '/halt', { on: '0', csrf: TOKEN })
  assert.equal(r.headers.location, '/?m=resumed')
  assert.deepEqual(calls.at(-1), ['halt', FOUNDER, false])
  assert.deepEqual(formFields((await call(port)).body, '/halt'), [['on', '1'], ['csrf', TOKEN]])
  assert.equal((await post(port, '/halt', { on: 'yes', csrf: TOKEN })).status, 400)
})

test('repository access: only for a project the email owns, only an owner/name repository', async (t) => {
  const { port, store, binds, failBind } = await setup(t)
  assert.equal((await post(port, '/repo', { project: THEIRS, repo: 'acme/x', csrf: TOKEN })).status, 403, 'a member, not the owner')
  assert.equal((await post(port, '/repo', { project: 'cccccccccccccccc', repo: 'acme/x', csrf: TOKEN })).status, 403, 'unknown project')
  for (const repo of ['acme', 'acme/x/y', 'acme/x y', 'acme/<x>', '']) {
    assert.equal((await post(port, '/repo', { project: MINE, repo, csrf: TOKEN })).status, 400, repo)
  }
  assert.deepEqual(await getRepos(store, THEIRS), ['acme/theirs'])
  const r = await post(port, '/repo', { project: MINE, repo: 'acme/new', csrf: TOKEN })
  assert.equal(r.headers.location, '/?m=repo_added')
  assert.deepEqual(binds.at(-1), [store, MINE, 'acme/new', { by: FOUNDER, approvers: [FOUNDER], installationOf }], 'addRepo gets the caller, the approvers and the App\'s installations')
  assert.deepEqual(await getRepos(store, MINE), ['acme/app', 'acme/new'])
  const page = (await call(port, { path: '/?m=repo_added' })).body
  assert.ok(page.includes('acme/new') && page.includes('Repository access given.'))

  // addRepo answers 409 for a repository bound to another project, and 403 when it refuses the caller (Amendment 4).
  failBind(409, 'repo_bound')
  const bound = await post(port, '/repo', { project: MINE, repo: 'acme/other', csrf: TOKEN })
  assert.equal(bound.headers.location, '/?m=repo_bound')
  assert.ok((await call(port, { path: bound.headers.location })).body.includes('class="notice">That repository already belongs to another project.'))
  failBind(403)
  assert.equal((await post(port, '/repo', { project: MINE, repo: 'acme/other', csrf: TOKEN })).status, 403)
  failBind(409, 'repo_changed')
  const changed = await post(port, '/repo', { project: MINE, repo: 'acme/other', csrf: TOKEN })
  assert.equal(changed.headers.location, '/?m=repo_changed')
  assert.ok((await call(port, { path: changed.headers.location })).body.includes('class="notice">The project\'s repositories changed meanwhile. Try again.'))
  // addRepo checks the App's installation: none for the repository, or another than the project's repositories.
  for (const [repo, code, notice] of [['nowhere/app', 'repo_not_installed', 'The mumbo-bot GitHub App is not installed for that repository.'],
    ['elsewhere/app', 'repo_other_installation', 'That repository is in another mumbo-bot App installation than this project\'s repositories.']]) {
    const r = await post(port, '/repo', { project: MINE, repo, csrf: TOKEN })
    assert.equal(r.headers.location, `/?m=${code}`, repo)
    assert.ok((await call(port, { path: r.headers.location })).body.includes(`class="notice">${notice}`), repo)
  }
  assert.deepEqual(await getRepos(store, MINE), ['acme/app', 'acme/new'])
})

test('repository access: an approver who owns the project removes a repository, and its approval items go with it', async (t) => {
  const { port, store, calls } = await setup(t)
  await addRepo(store, MINE, 'acme/new', { by: FOUNDER, approvers: [FOUNDER], installationOf })
  const page = (await call(port)).body
  assert.deepEqual(formFields(page, '/repo-remove'), [['project', MINE], ['repo', 'acme/app'], ['csrf', TOKEN]], 'one remove form per repository')
  assert.equal((page.match(/action="\/repo-remove"/g) ?? []).length, 2)
  assert.equal((await post(port, '/repo-remove', { project: THEIRS, repo: 'acme/theirs', csrf: TOKEN })).status, 403, 'a member, not the owner')
  assert.deepEqual(await getRepos(store, THEIRS), ['acme/theirs'], 'their binding survives')
  assert.equal((await post(port, '/repo-remove', { project: THEIRS, repo: 'acme/app', csrf: TOKEN })).status, 403, 'my repository named against their project')
  assert.equal(calls.filter(([name]) => name === 'dropRepo').length, 0)
  const r = await post(port, '/repo-remove', { project: MINE, repo: 'acme/app', csrf: TOKEN })
  assert.equal(r.headers.location, '/?m=repo_removed')
  assert.deepEqual(await getRepos(store, MINE), ['acme/new'])
  assert.deepEqual(calls.filter(([name]) => name === 'dropRepo'), [['dropRepo', MINE, 'acme/app']], 'the repository\'s approval items are dropped')
  assert.ok((await call(port, { path: r.headers.location })).body.includes('class="notice">Repository access removed.'))
  assert.equal((await post(port, '/repo-remove', { project: MINE, repo: 'acme/app', csrf: TOKEN })).status, 404, 'no longer bound')
  assert.equal((await post(port, '/repo-remove', { project: MINE, csrf: TOKEN })).status, 400, 'no repository named')
})

test('a project owner who is not an approver sees their items read-only and cannot give a repository', async (t) => {
  const { port, store, calls } = await setup(t, { approvers: [OTHER] })
  const page = (await call(port)).body
  assert.ok(page.includes('acme/app#7') && page.includes("Agent's review (claim): "), 'items are shown')
  assert.ok(page.includes('Only approvers can merge.') && page.includes('Stop everything'))
  for (const action of ['/grant', '/grant-low-risk', '/repo', '/repo-remove']) assert.ok(!page.includes(`action="${action}"`), `no ${action} form`)
  assert.ok(page.includes('acme/app'), 'repositories are listed')
  assert.equal((await post(port, '/repo', { project: MINE, repo: 'acme/new', csrf: TOKEN })).status, 403)
  assert.equal((await post(port, '/repo-remove', { project: MINE, repo: 'acme/app', csrf: TOKEN })).status, 403)
  assert.deepEqual(await getRepos(store, MINE), ['acme/app'])
  assert.ok(!calls.some(([name]) => name === 'grant' || name === 'grantLowRisk'))
  assert.throws(() => approvePage({ approvals: {}, halt: {}, store, csrfKey: KEY, host: HOST }), /approvers/, 'approvers must be wired')
})
