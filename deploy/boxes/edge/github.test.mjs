// node --test: the GitHub forwarder for project boxes (github.mjs, design section 9).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer, request } from 'node:http'
import { gzipSync } from 'node:zlib'
import { parse, print } from 'graphql'
import { memoryStore } from './store.mjs'
import { githubForwarder } from './github.mjs'

const P1 = 'p1'.repeat(8)  // project ids are 16 lowercase letters and digits
const ME = `project:${P1}`
const A = 'a'.repeat(40), B = 'b'.repeat(40), Z = '0'.repeat(40)
const pkt = (s) => (s.length + 4).toString(16).padStart(4, '0') + s
const ok = () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })

/** A forwarder behind a local server; project P1 has callgideon/mumbo and the claim's principal is `state.principal`. */
async function forwarder({ reply = ok, agentToken = 'AGENT' } = {}) {
  const store = memoryStore()
  await store.putDoc(`project:${P1}`, { id: P1, name: 'P1', owner: 'a@x.com', members: ['a@x.com'], createdAt: '2026-11-09T00:00:00Z', repos: ['callgideon/mumbo'] })
  const calls = [], logs = [], halted = new Set(), state = { principal: ME }
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return reply(url, init) }
  const forward = githubForwarder({ store, halt: { isHalted: async (u) => halted.has(u) }, agentToken, fetchImpl, log: (line) => logs.push(JSON.parse(line)) })
  const server = createServer((req, res) => forward(req, res, { u: state.principal, b: 'b1' }))
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const call = (path, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path: `/github/${path}`, headers }, (res) => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => { const text = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode, headers: res.headers, body: text, json: () => JSON.parse(text) }) })
    })
    req.on('error', reject); req.end(body)
  })
  return { call, calls, logs, halted, state, port, close: () => { server.closeAllConnections(); server.close() } }
}

test('reads: a project repository is read with the agent token; the box token and x-api-key stay behind', async (t) => {
  const f = await forwarder(); t.after(f.close)
  const r = await f.call('api.github.com/repos/callgideon/mumbo/pulls?state=open', { headers: { authorization: 'Bearer BOXTOKEN', 'x-api-key': 'BOXTOKEN', accept: 'application/vnd.github+json', cookie: '_oauth2_proxy=s' } })
  assert.equal(r.status, 200)
  assert.equal(r.body, '{"ok":true}')
  assert.equal(f.calls[0].url, 'https://api.github.com/repos/callgideon/mumbo/pulls?state=open')
  assert.equal(f.calls[0].init.method, 'GET')
  assert.equal(f.calls[0].init.redirect, 'manual')
  assert.deepEqual(f.calls[0].init.headers, { accept: 'application/vnd.github+json', authorization: 'token AGENT' })
  for (const p of ['api.github.com/repos/CallGideon/Mumbo', 'api.github.com/user', 'api.github.com/rate_limit', 'api.github.com/notifications?all=true', 'api.github.com/users/octocat', 'api.github.com/users/mumbo-bot[bot]']) {
    assert.equal((await f.call(p)).status, 200, p)
  }
  for (const p of ['codeload.github.com/callgideon/mumbo/tar.gz/refs/heads/main', 'objects.githubusercontent.com/github-production-release-asset/1']) {
    assert.equal((await f.call(p, { headers: { authorization: 'Bearer BOXTOKEN' } })).status, 200, p)
    assert.equal(f.calls.at(-1).init.headers.authorization, undefined, `${p} carries no credentials`)
  }
})

test('reads: another repository, an unlisted path, or a path the URL parser would rewrite is refused', async (t) => {
  const f = await forwarder(); t.after(f.close)
  const evil = await f.call('api.github.com/repos/callgideon/mumbo-evil')
  assert.equal(evil.status, 403)
  assert.deepEqual(evil.json(), { message: 'Mumbo edge refused GET /repos/callgideon/mumbo-evil' })
  for (const p of [
    'api.github.com/repos/callgideon/mumbo/pulls/%2e%2e/issues',  // the parser would make this /repos/callgideon/mumbo/issues
    'api.github.com/repos/callgideon/mumbo-evil/%2e%2e/mumbo/pulls',
    'api.github.com/repos/callgideon%2fmumbo/pulls',
    'api.github.com/repos/callgideon/mumbo/pulls/%31',
    'objects.githubusercontent.com/a%2Fb',
    'api.github.com/users/octocat/repos',
    'api.github.com/repos/callgideon/mumbo/./pulls',
    'api.github.com/repos/callgideon\\mumbo/pulls',
    'api.github.com/repos/callgideon//mumbo',
    'api.github.com/repos/callgideon/mumbo/',
    'api.github.com/repos/callgideon',
    'api.github.com/orgs/callgideon/repos',
    'api.github.com/repositories/1',
    'api.github.com/notifications/threads/1',
    'api.github.com/graphql',
    'codeload.github.com/callgideon/other/tar.gz/main',
    'codeload.github.com/callgideon/mumbo',
    'github.com/callgideon/mumbo/info/refs',
    'github.com/callgideon/mumbo/info/refs?service=git-evil',
    'github.com/callgideon/other/info/refs?service=git-upload-pack',
    'gist.github.com/x',
    'API.GITHUB.COM/user',
  ]) assert.equal((await f.call(p)).status, 403, p)
  assert.equal(f.calls.length, 0)
})

test('REST writes: comments and pull requests pass; merges, contents, refs, reviews and retargeting are refused', async (t) => {
  const f = await forwarder(); t.after(f.close)
  // content-length set: Node's client frames a DELETE body only when told its length.
  const write = (method, p, body = {}, repo = 'callgideon/mumbo') => f.call(`api.github.com/repos/${repo}${p}`, { method, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(JSON.stringify(body)) }, body: JSON.stringify(body) })
  const merge = await write('PUT', '/pulls/5/merge', { sha: A, merge_method: 'merge' })
  assert.equal(merge.status, 403)
  assert.deepEqual(merge.json(), { message: 'Mumbo edge refused PUT /repos/callgideon/mumbo/pulls/5/merge' })
  for (const [method, p, body, repo] of [
    ['POST', '/merges', { base: 'main', head: 'agent/a' }],
    ['PUT', '/contents/x', { message: 'm', content: '' }],
    ['POST', '/git/refs', { ref: 'refs/heads/main', sha: A }],
    ['PATCH', '/git/refs/heads/main', { sha: A }],
    ['DELETE', '/git/refs/heads/agent/a'],
    ['POST', '/pulls/5/reviews', { event: 'APPROVE' }],
    ['PUT', '/pulls/5/update-branch'],
    ['PUT', '/pulls/5/merge'],
    ['PATCH', '', { default_branch: 'agent/a' }],
    ['PATCH', '/pulls/5', { base: 'dev' }],
    ['PATCH', '/pulls/5', { title: 't', base: 'dev' }],
    ['PATCH', '/pulls/5', { state: 'open' }],
    ['PATCH', '/pulls/5', ['title']],
    ['POST', '/pulls/5/comments', {}, 'callgideon/other'],
    ['POST', '/issues/5/comments', {}, 'callgideon/mumbo-evil'],
  ]) assert.equal((await write(method, p, body, repo)).status, 403, `${method} ${p}`)
  assert.equal((await f.call('api.github.com/repos/callgideon/mumbo/pulls/5', { method: 'PATCH', body: '{"title":' })).status, 403, 'not JSON')
  assert.equal((await write('PATCH', '/pulls/5?base=dev', { title: 't' })).status, 403, 'parameters in the query string')
  assert.equal((await f.call('api.github.com/graphql?variables=%7B%7D', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: '{ viewer { login } }' }) })).status, 403, 'GraphQL variables in the query string')
  assert.equal(f.calls.length, 0)
  const allowed = [
    ['POST', '/issues/5/comments', { body: 'hi' }],
    ['PATCH', '/issues/comments/9', { body: 'edited' }],
    ['POST', '/pulls', { title: 't', head: 'agent/a', base: 'main' }],
    ['PATCH', '/pulls/5', { title: 't', body: 'b', state: 'closed' }],
    ['POST', '/pulls/5/comments', { body: 'c', commit_id: A, path: 'a.ts', line: 1 }],
    ['POST', '/pulls/5/comments/9/replies', { body: 'r' }],
    ['POST', '/pulls/5/requested_reviewers', { reviewers: ['someone'] }],
    ['POST', '/issues/5/reactions', { content: '+1' }],
    ['POST', '/issues/comments/9/reactions', { content: 'eyes' }],
  ]
  for (const [method, p, body] of allowed) assert.equal((await write(method, p, body)).status, 200, `${method} ${p}`)
  assert.equal(f.calls.length, allowed.length)
  const edit = f.calls[3]
  assert.equal(edit.url, 'https://api.github.com/repos/callgideon/mumbo/pulls/5')
  assert.equal(edit.init.method, 'PATCH')
  assert.deepEqual(JSON.parse(edit.init.body), { title: 't', body: 'b', state: 'closed' })
  assert.deepEqual(edit.init.headers, { 'content-type': 'application/json', authorization: 'token AGENT' })
})

test('GraphQL: listed mutations by field name only, no fragments, every operation checked; queries pass', async (t) => {
  const f = await forwarder(); t.after(f.close)
  const gql = (query, variables, operationName, type = 'application/json; charset=utf-8') =>
    f.call('api.github.com/graphql', { method: 'POST', headers: { 'content-type': type }, body: JSON.stringify({ query, variables, operationName }) })
  const merge = 'mergePullRequest(input: {pullRequestId: "PR_1"}) { clientMutationId }'
  const refused = [
    [`mutation { ${merge} }`],
    [`mutation { createPullRequest: ${merge} }`],
    [`mutation { ...createPullRequest } fragment createPullRequest on Mutation { ${merge} }`],
    [`mutation { ... on Mutation { ${merge} } }`],
    [`query Q { viewer { login } } mutation M { ${merge} }`, undefined, 'Q'],
    ['mutation($i: UpdatePullRequestInput!) { updatePullRequest(input: $i) { clientMutationId } }', { i: { pullRequestId: 'PR_1', baseRefName: 'dev' } }],
    ['mutation { updatePullRequest(input: {pullRequestId: "PR_1", baseRefName: "dev"}) { clientMutationId } }'],
    ['mutation { enablePullRequestAutoMerge(input: {pullRequestId: "PR_1"}) { clientMutationId } }'],
    ['mutation { createCommitOnBranch(input: {}) { clientMutationId } }'],
    ['mutation { addComment(input: {subjectId: "I_1", body: "x"}) { clientMutationId } __typename }'],
    ['subscription { addComment(input: {subjectId: "I_1", body: "x"}) { clientMutationId } }'],
    ['mutation { createPullRequest('],
  ]
  for (const [query, variables, operationName] of refused) {
    const r = await gql(query, variables, operationName)
    assert.equal(r.status, 403, query)
    assert.match(r.json().errors[0].message, /^Mumbo edge refused POST \/graphql: /, query)
  }
  for (const body of ['[{"query":"{ viewer { login } }"}]', 'nope', '{"query":1}', 'null']) {
    assert.equal((await f.call('api.github.com/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body })).status, 403, body)
  }
  for (const type of ['text/plain', 'application/graphql', 'application/x-www-form-urlencoded', '']) {
    const r = await gql('{ viewer { login } }', undefined, undefined, type)
    assert.equal(r.status, 415, type)
    assert.ok(r.json().errors[0].message)
  }
  assert.equal(f.calls.length, 0)

  const create = 'mutation Open($i: CreatePullRequestInput!) { pr: createPullRequest(input: $i) { pullRequest { number } } }'
  const variables = { i: { repositoryId: 'R_1', baseRefName: 'main', headRefName: 'agent/a', title: 't' } }
  assert.equal((await gql(create, variables, 'Open')).status, 200)
  assert.equal(f.calls[0].url, 'https://api.github.com/graphql')
  assert.deepEqual(f.calls[0].init.headers, { 'content-type': 'application/json', authorization: 'token AGENT' })
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { query: print(parse(create)), variables, operationName: 'Open' })
  assert.equal((await gql('{ viewer { login } }')).status, 200)
  assert.equal((await gql('mutation { updatePullRequest(input: {pullRequestId: "PR_1", title: "t"}) { clientMutationId } markPullRequestReadyForReview(input: {pullRequestId: "PR_1"}) { clientMutationId } }')).status, 200)
  assert.equal((await gql('{ viewer { login } }', undefined, undefined, 'Application/JSON')).status, 200)
})

test('git: a push updates refs/heads/agent/* only, unencoded; the probe, fetches and ref adverts pass', async (t) => {
  const f = await forwarder(); t.after(f.close)
  const push = (body, headers = {}) => f.call('github.com/callgideon/mumbo.git/git-receive-pack', { method: 'POST', headers: { 'content-type': 'application/x-git-receive-pack-request', ...headers }, body })
  const update = Buffer.from(pkt(`${A} ${B} refs/heads/agent/a\0 report-status side-band-64k agent=git/2.47.0\n`) + '0000' + 'PACK\0\0\0\x02\0\0\0\x01', 'latin1')
  assert.equal((await push(update, { authorization: 'Bearer BOXTOKEN' })).status, 200)
  assert.equal(f.calls[0].url, 'https://github.com/callgideon/mumbo.git/git-receive-pack')
  assert.deepEqual(Buffer.from(f.calls[0].init.body), update)
  assert.deepEqual(f.calls[0].init.headers, { 'content-type': 'application/x-git-receive-pack-request', authorization: `Basic ${Buffer.from('x-access-token:AGENT').toString('base64')}` })
  assert.equal((await push(pkt(`shallow ${A}\n`) + pkt(`${Z} ${B} refs/heads/agent/b\0report-status\n`) + pkt(`${A} ${B} refs/heads/agent/c/d\n`) + '0000')).status, 200, 'shallow lines, a new branch and a second command')
  assert.equal((await push('0000')).status, 200, 'the probe')
  const forwarded = f.calls.length
  for (const [why, body, headers] of [
    ['agent/a plus main', pkt(`${A} ${B} refs/heads/agent/a\0report-status\n`) + pkt(`${A} ${B} refs/heads/main\n`) + '0000'],
    ['deleting agent/a', pkt(`${A} ${Z} refs/heads/agent/a\0report-status\n`) + '0000'],
    ['gzip', gzipSync(update), { 'content-encoding': 'gzip' }],
    ['identity encoding', update, { 'content-encoding': 'identity' }],
    ['push-cert', pkt('push-cert\0report-status\n') + pkt('certificate version 0.1\n') + '0000'],
    ['a tag', pkt(`${A} ${B} refs/tags/agent/a\0\n`) + '0000'],
    ['a lookalike prefix', pkt(`${A} ${B} refs/heads/agentx\0\n`) + '0000'],
    ['dot-dot', pkt(`${A} ${B} refs/heads/agent/../main\0\n`) + '0000'],
    ['NUL past the first command', pkt(`${A} ${B} refs/heads/agent/a\0\n`) + pkt(`${A} ${B} refs/heads/agent/b\0x\n`) + '0000'],
    ['shallow after a command', pkt(`${A} ${B} refs/heads/agent/a\0\n`) + pkt(`shallow ${A}\n`) + '0000'],
    ['no commands', '0000PACK'],
    ['no flush', pkt(`${A} ${B} refs/heads/agent/a\0\n`)],
    ['a short length', '0003'],
    ['a length past the body', `00ff${A}`],
    ['not hex', 'zzzz'],
    ['empty', ''],
  ]) assert.equal((await push(body, headers)).status, 403, why)
  assert.equal(f.calls.length, forwarded)

  const want = gzipSync(pkt('command=fetch\n') + '0001' + pkt(`want ${A}\n`) + '0000')
  assert.equal((await f.call('github.com/callgideon/mumbo/git-upload-pack', { method: 'POST', headers: { 'content-type': 'application/x-git-upload-pack-request', 'content-encoding': 'gzip', 'git-protocol': 'version=2' }, body: want })).status, 200)
  assert.equal(f.calls.at(-1).url, 'https://github.com/callgideon/mumbo/git-upload-pack')
  assert.deepEqual(Buffer.from(f.calls.at(-1).init.body), want)
  assert.equal(f.calls.at(-1).init.headers['content-encoding'], 'gzip', 'git gzips larger fetch requests')
  assert.equal(f.calls.at(-1).init.headers['git-protocol'], 'version=2')
  assert.equal((await f.call('github.com/callgideon/other/git-upload-pack', { method: 'POST', body: want })).status, 403)
  for (const p of ['callgideon/mumbo/info/refs?service=git-upload-pack', 'callgideon/mumbo.git/info/refs?service=git-upload-pack', 'callgideon/mumbo/info/refs?service=git-receive-pack', 'callgideon/mumbo.git/info/refs?service=git-receive-pack']) {
    assert.equal((await f.call(`github.com/${p}`)).status, 200, p)
    assert.equal(f.calls.at(-1).url, `https://github.com/${p}`)
  }
})

test('a body declared over 256 MB answers 413 without being read', { timeout: 10_000 }, async (t) => {
  const f = await forwarder(); t.after(f.close)
  const status = await new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: f.port, method: 'POST', path: '/github/github.com/callgideon/mumbo.git/git-receive-pack', headers: { 'content-length': String(256 * 1024 * 1024 + 1) } }, (res) => { resolve(res.statusCode); req.destroy() })
    req.on('error', reject); req.flushHeaders()
  })
  assert.equal(status, 413)
  assert.equal(f.calls.length, 0)
})

test('caller and stop switch: only project principals; a halted project reads, fetches and queries but writes nothing', async (t) => {
  const f = await forwarder(); t.after(f.close)
  f.state.principal = 'a@x.com'
  const email = await f.call('api.github.com/repos/callgideon/mumbo/pulls')
  assert.equal(email.status, 403)
  assert.deepEqual(f.logs, [{ edge: 'github', refused: 'GitHub is only for project boxes', principal: 'a@x.com', method: 'GET', host: 'api.github.com', path: '/repos/callgideon/mumbo/pulls' }])
  f.state.principal = `project:${P1}x`
  assert.equal((await f.call('api.github.com/repos/callgideon/mumbo/pulls')).status, 403)
  f.state.principal = ME
  const unconfigured = await forwarder({ agentToken: null }); t.after(unconfigured.close)
  assert.equal((await unconfigured.call('api.github.com/repos/callgideon/mumbo/pulls')).status, 503)
  assert.equal(unconfigured.calls.length, 0)

  f.halted.add(ME)
  const comment = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"body":"hi"}' }
  const gql = (query) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }) })
  const fetchPack = { method: 'POST', headers: { 'content-type': 'application/x-git-upload-pack-request' }, body: pkt(`want ${A}\n`) + '0000' + pkt('done\n') }
  const pushPack = { method: 'POST', body: pkt(`${A} ${B} refs/heads/agent/a\0report-status\n`) + '0000' }
  for (const [p, init] of [
    ['api.github.com/repos/callgideon/mumbo/pulls', {}],
    ['api.github.com/repos/callgideon/mumbo/pulls', { method: 'HEAD' }],
    ['github.com/callgideon/mumbo/info/refs?service=git-upload-pack', {}],
    ['github.com/callgideon/mumbo/git-upload-pack', fetchPack],
    ['api.github.com/graphql', gql('query { viewer { login } } fragment F on User { login }')],
  ]) assert.equal((await f.call(p, init)).status, 200, `halted: ${init.method ?? 'GET'} ${p} passes`)
  const passed = f.calls.length
  f.logs.length = 0
  const stopped = await f.call('api.github.com/repos/callgideon/mumbo/issues/5/comments', comment)
  assert.equal(stopped.status, 403)
  assert.deepEqual(stopped.json(), { message: 'Mumbo edge refused POST /repos/callgideon/mumbo/issues/5/comments: stopped by the founder' })
  assert.deepEqual(f.logs, [{ edge: 'github', refused: 'stopped by the founder', principal: ME, method: 'POST', host: 'api.github.com', path: '/repos/callgideon/mumbo/issues/5/comments' }])
  for (const [p, init] of [
    ['api.github.com/repos/callgideon/mumbo/pulls/5', { ...comment, method: 'PATCH', body: '{"title":"t"}' }],
    ['github.com/callgideon/mumbo.git/git-receive-pack', pushPack],
    ['github.com/callgideon/mumbo.git/git-receive-pack', { method: 'POST', body: '0000' }],
    ['api.github.com/graphql', gql('query Q { viewer { login } } mutation M { addComment(input: {subjectId: "I_1", body: "x"}) { clientMutationId } }')],
  ]) assert.equal((await f.call(p, init)).status, 403, `halted: ${init.method} ${p} is refused`)
  assert.equal(f.calls.length, passed)
  f.halted.clear()
  assert.equal((await f.call('api.github.com/repos/callgideon/mumbo/issues/5/comments', comment)).status, 200)
  assert.equal((await f.call('github.com/callgideon/mumbo.git/git-receive-pack', pushPack)).status, 200)
})

test('pass-through: a 302 comes back unfollowed; content-encoding, framing and cookies are not passed back', async (t) => {
  const location = 'https://codeload.github.com/callgideon/mumbo/legacy.tar.gz/refs/heads/main'
  const f = await forwarder({ reply: (url) => url.endsWith('/tarball/main')
    ? new Response(null, { status: 302, headers: { location } })
    : new Response('{"a":1}', { status: 200, headers: { 'content-type': 'application/json', 'content-encoding': 'gzip', 'set-cookie': 'logged_in=no; Domain=.github.com', 'x-ratelimit-remaining': '4999' } }) })
  t.after(f.close)
  const moved = await f.call('api.github.com/repos/callgideon/mumbo/tarball/main')
  assert.equal(moved.status, 302)
  assert.equal(moved.headers.location, location)
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].init.redirect, 'manual')
  const r = await f.call('api.github.com/repos/callgideon/mumbo')
  assert.equal(r.status, 200)
  assert.equal(r.body, '{"a":1}')
  assert.equal(r.headers['content-encoding'], undefined)
  assert.equal(r.headers['set-cookie'], undefined)
  assert.equal(r.headers['x-ratelimit-remaining'], '4999')
})
