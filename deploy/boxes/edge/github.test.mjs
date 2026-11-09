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
// GitHub's answer to the forwarder's nodes(ids:) lookup: a type outside its fragments comes back with __typename only.
const mumbo = { nameWithOwner: 'callgideon/mumbo' }
const NODES = {
  R_1: { __typename: 'Repository', nameWithOwner: 'CallGideon/Mumbo' },
  PR_1: { __typename: 'PullRequest', repository: mumbo },
  I_1: { __typename: 'Issue', repository: mumbo },
  IC_1: { __typename: 'IssueComment', repository: mumbo },
  RC_1: { __typename: 'PullRequestReviewComment', repository: mumbo },
  R_OTHER: { __typename: 'Repository', nameWithOwner: 'callgideon/other' },
  I_OTHER: { __typename: 'Issue', repository: { nameWithOwner: 'callgideon/other' } },
  PR_OTHER: { __typename: 'PullRequest', repository: { nameWithOwner: 'callgideon/other' } },
  U_1: { __typename: 'User' },
  L_1: { __typename: 'Label' },
}
const lookupOk = (ids) => Response.json({ data: { nodes: ids.map(i => NODES[i] ?? null) }, ...(ids.every(i => NODES[i]) ? {} : { errors: [{ type: 'NOT_FOUND' }] }) })

const until = async (cond) => { while (!cond()) await new Promise(r => setTimeout(r, 5)) }
// Projects for the push tests: P1 (callgideon/mumbo) plus three more, each with its own repository.
const repoOf = (id) => (id === P1 ? 'callgideon/mumbo' : `callgideon/${id}`)
const addProjects = async (f) => {
  const others = ['p2', 'p3', 'p4'].map(p => p.repeat(8))
  for (const id of others) await f.store.putDoc(`project:${id}`, { id, name: id, owner: 'a@x.com', members: ['a@x.com'], createdAt: '2026-11-09T00:00:00Z', repos: [repoOf(id)] })
  return [P1, ...others]
}
const pushAs = (f, id) => {
  f.state.principal = `project:${id}`
  return f.call(`github.com/${repoOf(id)}.git/git-receive-pack`, { method: 'POST', body: pkt(`${A} ${B} refs/heads/agent/a\0report-status\n`) + '0000' })
}
const sendThenReset = (port, path, afterMs) => {
  const q = request({ host: '127.0.0.1', port, method: 'POST', path: `/github/${path}`, headers: { 'content-type': 'application/json', 'content-length': '100' } })
  q.on('error', () => {})  // reset on purpose
  q.flushHeaders()
  setTimeout(() => q.destroy(), afterMs)
}

/**
 * A forwarder behind a local server; project P1 has callgideon/mumbo and the claim's principal is `state.principal`.
 * Node id lookups are answered by `lookup(ids)` and recorded in `lookups`, apart from the forwarded `calls`.
 * `isHalted` takes `haltMs` and records each principal it is asked about in `haltChecks`; `state.settled` counts
 * handlers that have returned.
 */
async function forwarder({ reply = ok, lookup = lookupOk, agentToken = 'AGENT', haltMs = 0, pushTimeoutMs } = {}) {
  const store = memoryStore()
  await store.putDoc(`project:${P1}`, { id: P1, name: 'P1', owner: 'a@x.com', members: ['a@x.com'], createdAt: '2026-11-09T00:00:00Z', repos: ['callgideon/mumbo'] })
  const calls = [], lookups = [], logs = [], haltChecks = [], halted = new Set(), state = { principal: ME, settled: 0 }
  const isHalted = async (u) => { haltChecks.push(u); if (haltMs) await new Promise(r => setTimeout(r, haltMs)); return halted.has(u) }
  // Records each call with its body read into a Buffer; `streamed` says the forwarder sent a stream, not a buffer.
  const fetchImpl = async (url, init) => {
    const body = init.body == null ? undefined : Buffer.from(await new Response(init.body).arrayBuffer())
    const gql = url === 'https://api.github.com/graphql' ? JSON.parse(body) : undefined
    if (gql?.query.startsWith('query($ids: [ID!]!) { nodes(ids: $ids)')) {
      lookups.push({ ids: gql.variables.ids, authorization: init.headers.authorization })
      return lookup(gql.variables.ids)
    }
    calls.push({ url, init: { ...init, body }, streamed: init.body instanceof ReadableStream })
    return reply(url, init)
  }
  const forward = githubForwarder({ store, halt: { isHalted }, agentToken, fetchImpl, log: (line) => logs.push(JSON.parse(line)), pushTimeoutMs })
  const server = createServer((req, res) => forward(req, res, { u: state.principal, b: 'b1' }).finally(() => { state.settled++ }))
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
  return { call, calls, lookups, logs, haltChecks, halted, state, store, port, close: () => { server.closeAllConnections(); server.close() } }
}

test('reads: a project repository is read with the agent token; the box token and x-api-key stay behind', async (t) => {
  const f = await forwarder(); t.after(f.close)
  const r = await f.call('api.github.com/repos/callgideon/mumbo/pulls?state=open', { headers: { authorization: 'Bearer BOXTOKEN', 'x-api-key': 'BOXTOKEN', accept: 'application/vnd.github+json', cookie: '_oauth2_proxy_mumbo=s' } })
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
    // Reopening: updatePullRequest may set state only to CLOSED, inline, in variables or in a variable's default.
    ['mutation { updatePullRequest(input: {pullRequestId: "PR_1", state: OPEN}) { clientMutationId } }'],
    ['mutation($i: UpdatePullRequestInput!) { updatePullRequest(input: $i) { clientMutationId } }', { i: { pullRequestId: 'PR_1', state: 'OPEN' } }],
    ['mutation($s: PullRequestUpdateState) { updatePullRequest(input: {pullRequestId: "PR_1", state: $s}) { clientMutationId } }', { s: 'OPEN' }],
    ['mutation($i: UpdatePullRequestInput = {pullRequestId: "PR_1", state: OPEN}) { updatePullRequest(input: $i) { clientMutationId } }'],
  ]
  for (const [query, variables, operationName] of refused) {
    const r = await gql(query, variables, operationName)
    assert.equal(r.status, 403, query)
    assert.match(r.json().errors[0].message, /^Mumbo edge refused POST \/graphql: /, query)
  }
  const post = (body) => f.call('api.github.com/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body })
  // variables as a JSON string would reach GitHub unread: the escape hides baseRefName from a text search.
  const hidden = String.raw`{"query":"mutation($i: UpdatePullRequestInput!){updatePullRequest(input:$i){clientMutationId}}","variables":"{\"i\":{\"pullRequestId\":\"PR_1\",\"baseRef\\u004eame\":\"dev\"}}"}`
  assert.equal(typeof JSON.parse(hidden).variables, 'string')
  for (const body of [hidden, '{"query":"{ viewer { login } }","variables":[]}', '{"query":"{ viewer { login } }","variables":1}', '{"query":"{ viewer { login } }","operationName":1}', '[{"query":"{ viewer { login } }"}]', 'nope', '{"query":1}', 'null']) {
    assert.equal((await post(body)).status, 403, body)
  }
  assert.equal((await post('{"query":"mutation { createPullRequest("}')).status, 400, 'a query that does not parse')
  // Repeated names would let the last one win past the checks; refused before any lookup.
  for (const [why, query] of [
    ['a repeated input field', 'mutation { addComment(input: {subjectId: "I_OTHER", subjectId: "I_1", body: "x"}) { clientMutationId } }'],
    ['a repeated field deeper, in a query', '{ repository(owner: "callgideon", name: "mumbo") { issues(first: 1, filterBy: {states: OPEN, states: CLOSED}) { totalCount } } }'],
    ['a repeated field in a variable default', 'mutation($i: AddCommentInput = {subjectId: "I_1", body: "x", body: "y"}) { addComment(input: $i) { clientMutationId } }'],
    ['a repeated variable', 'mutation($s: ID = "I_OTHER", $s: ID = "I_1") { addComment(input: {subjectId: $s, body: "x"}) { clientMutationId } }'],
  ]) {
    const r = await gql(query)
    assert.equal(r.status, 400, why)
    assert.match(r.json().errors[0].message, /repeats a (field|variable) name/, why)
  }
  assert.equal(f.lookups.length, 0)
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
  assert.equal((await post('{"query":"{ viewer { login } }","variables":null,"operationName":null}')).status, 200)
  assert.equal((await gql('mutation { updatePullRequest(input: {pullRequestId: "PR_1", state: CLOSED}) { clientMutationId } }')).status, 200)
  assert.equal((await gql('mutation($i: UpdatePullRequestInput!) { updatePullRequest(input: $i) { clientMutationId } }', { i: { pullRequestId: 'PR_1', state: 'CLOSED' } })).status, 200)
})

test('GraphQL mutations stay in the project repositories: every node id, inline or in variables, resolves there', async (t) => {
  const f = await forwarder(); t.after(f.close)
  const gql = (query, variables) => f.call('api.github.com/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }) })
  const comment = (subject) => `mutation { addComment(input: {subjectId: "${subject}", body: "x"}) { clientMutationId } }`
  const byVariable = 'mutation($i: AddCommentInput!) { addComment(input: $i) { clientMutationId } }'
  for (const [why, query, variables] of [
    ['addComment on another repository\'s issue', comment('I_OTHER')],
    ['createPullRequest in another repository', 'mutation { createPullRequest(input: {repositoryId: "R_OTHER", baseRefName: "main", headRefName: "agent/a", title: "t"}) { clientMutationId } }'],
    ['a head repository elsewhere', 'mutation { createPullRequest(input: {repositoryId: "R_1", headRepositoryId: "R_OTHER", baseRefName: "main", headRefName: "agent/a", title: "t"}) { clientMutationId } }'],
    ['an id passed through variables', byVariable, { i: { subjectId: 'I_OTHER', body: 'x' } }],
    ['an id in a variable default', 'mutation($s: ID = "I_OTHER") { addComment(input: {subjectId: $s, body: "x"}) { clientMutationId } }'],
    ['one of two mutations elsewhere', `mutation { a: addComment(input: {subjectId: "I_1", body: "x"}) { clientMutationId } b: addComment(input: {subjectId: "I_OTHER", body: "x"}) { clientMutationId } }`],
    ['a node type outside the list (User)', comment('U_1')],
    ['a label', 'mutation { updatePullRequest(input: {pullRequestId: "PR_1", labelIds: ["L_1"]}) { clientMutationId } }'],
    ['an assignee (user ids resolve outside requestReviews)', 'mutation { updatePullRequest(input: {pullRequestId: "PR_1", assigneeIds: ["U_1"]}) { clientMutationId } }'],
    ['an id that does not resolve', comment('NOPE')],
  ]) {
    const r = await gql(query, variables)
    assert.equal(r.status, 403, why)
    assert.match(r.json().errors[0].message, /is not in this project's repositories/, why)
  }
  assert.equal(f.calls.length, 0)
  const looked = f.lookups.length
  for (const [why, query, variables] of [
    ['a mutation with no node id', 'mutation { addComment(input: {body: "x"}) { clientMutationId } }'],
    ['a mutation with no input', 'mutation { markPullRequestReadyForReview { clientMutationId } }'],
    ['an input key that is neither a known scalar nor an id', 'mutation { addComment(input: {subjectId: "I_1", body: "x", subject: "I_OTHER"}) { clientMutationId } }'],
    ['an id key holding an object', byVariable, { i: { subjectId: { id: 'I_1' }, body: 'x' } }],
    ['an argument besides input', 'mutation { addComment(input: {subjectId: "I_1", body: "x"}, extra: 1) { clientMutationId } }'],
    ['more than 50 node ids', `mutation { updatePullRequest(input: {pullRequestId: "PR_1", labelIds: [${Array.from({ length: 50 }, (_, i) => `"L_${i}"`).join(', ')}]}) { clientMutationId } }`],
  ]) assert.equal((await gql(query, variables)).status, 403, why)
  assert.equal(f.lookups.length, looked, 'refused before any lookup')

  assert.equal((await gql(byVariable, { i: { subjectId: 'I_1', body: 'x', clientMutationId: 'c1' } })).status, 200)
  assert.deepEqual(f.lookups.at(-1), { ids: ['I_1'], authorization: 'token AGENT' })
  assert.equal((await gql('mutation { a: updateIssueComment(input: {id: "IC_1", body: "x"}) { clientMutationId } b: addReaction(input: {subjectId: "RC_1", content: EYES}) { clientMutationId } c: createPullRequest(input: {repositoryId: "R_1", baseRefName: "main", headRefName: "agent/a", title: "t"}) { clientMutationId } d: addComment(input: {subjectId: "PR_1", body: "x"}) { clientMutationId } }')).status, 200)
  assert.deepEqual(f.lookups.at(-1).ids, ['IC_1', 'RC_1', 'R_1', 'PR_1'], 'one lookup for every id in the document')
  const reads = f.lookups.length
  assert.equal((await gql('{ repository(owner: "callgideon", name: "other") { id } }')).status, 200, 'reads stay unscoped')
  assert.equal(f.lookups.length, reads)
  assert.equal(f.calls.length, 3)

  const down = await forwarder({ lookup: () => new Response('busy', { status: 502 }) }); t.after(down.close)
  assert.equal((await down.call('api.github.com/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: comment('I_1') }) })).status, 502)
  assert.equal(down.calls.length, 0, 'a failed lookup forwards nothing')
})

test('requestReviews is scoped by its pull request; reviewer user, team and bot ids are not resolved', async (t) => {
  const f = await forwarder(); t.after(f.close)
  const review = (input) => f.call('api.github.com/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: `mutation { requestReviews(input: {${input}}) { clientMutationId } }` }) })
  assert.equal((await review('pullRequestId: "PR_1", userIds: ["U_1"], teamIds: ["T_1"], botIds: ["B_1"], union: true')).status, 200)
  assert.deepEqual(f.lookups.at(-1).ids, ['PR_1'], 'only the pull request is resolved')
  assert.equal(f.calls.length, 1)
  for (const [why, input] of [
    ['another repository\'s pull request', 'pullRequestId: "PR_OTHER", userIds: ["U_1"]'],
    ['a pull request id that does not resolve', 'pullRequestId: "NOPE", userIds: ["U_1"]'],
    ['an id key other than the reviewer ids (still resolved)', 'pullRequestId: "PR_1", labelIds: ["L_1"]'],
  ]) {
    const r = await review(input)
    assert.equal(r.status, 403, why)
    assert.match(r.json().errors[0].message, /is not in this project's repositories/, why)
  }
  // The exception is requestReviews only: the same key on another mutation is resolved, and a User is refused.
  const elsewhere = await f.call('api.github.com/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'mutation { updatePullRequest(input: {pullRequestId: "PR_1", userIds: ["U_1"]}) { clientMutationId } }' }) })
  assert.equal(elsewhere.status, 403)
  assert.match(elsewhere.json().errors[0].message, /node U_1 \(User\) is not in this project's repositories/)
  const looked = f.lookups.length
  for (const [why, input] of [
    ['no pullRequestId', 'userIds: ["U_1"]'],
    ['no pullRequestId, another id key in the project instead', 'subjectId: "I_1", userIds: ["U_1"]'],
    ['reviewer ids that are not strings', 'pullRequestId: "PR_1", userIds: [1]'],
  ]) assert.equal((await review(input)).status, 403, why)
  assert.equal(f.lookups.length, looked, 'refused before any lookup')
  assert.equal(f.calls.length, 1)
})

test('JSON bodies stop at 1 MiB and GraphQL documents at 50000 tokens, so one request cannot exhaust the edge', { timeout: 10_000 }, async (t) => {
  const f = await forwarder(); t.after(f.close)
  const json = { 'content-type': 'application/json' }
  const pad = (n) => JSON.stringify({ query: '{ viewer { login } }', pad: 'x'.repeat(n) })
  const fits = pad(1024 * 1024 - pad(0).length)
  assert.equal(Buffer.byteLength(fits), 1024 * 1024)
  assert.equal((await f.call('api.github.com/graphql', { method: 'POST', headers: json, body: fits })).status, 200)
  const over = await f.call('api.github.com/graphql', { method: 'POST', headers: json, body: pad(1024 * 1024 - pad(0).length + 1) })
  assert.equal(over.status, 413)
  assert.equal(over.headers.connection, 'close')
  assert.equal((await f.call('api.github.com/repos/callgideon/mumbo/issues/5/comments', { method: 'POST', headers: json, body: JSON.stringify({ body: 'x'.repeat(1024 * 1024) }) })).status, 413)
  const tokens = await f.call('api.github.com/graphql', { method: 'POST', headers: json, body: JSON.stringify({ query: `{ ${'a '.repeat(50_000)}}` }) })
  assert.equal(tokens.status, 400)
  assert.match(tokens.json().errors[0].message, /50000 tokens/)
  assert.equal(f.calls.length, 1)
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
  assert.equal(f.calls.at(-1).streamed, true, 'a fetch request is streamed, never buffered')
  assert.equal(f.calls[0].streamed, false, 'a push is buffered for its checks')
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

test('one push at a time per project: a second concurrent push answers 429, and the slot frees when the first ends', { timeout: 10_000 }, async (t) => {
  let open
  const gate = new Promise(r => { open = r })
  const f = await forwarder({ reply: async (url) => { if (url.endsWith('/git-receive-pack')) await gate; return ok() } })
  t.after(f.close)
  const body = pkt(`${A} ${B} refs/heads/agent/a\0report-status\n`) + '0000'
  const push = () => f.call('github.com/callgideon/mumbo.git/git-receive-pack', { method: 'POST', body })
  const first = push()
  while (f.calls.length === 0) await new Promise(r => setTimeout(r, 5))
  const second = await push()
  assert.equal(second.status, 429)
  assert.match(second.json().message, /another push/)
  assert.equal((await f.call('api.github.com/repos/callgideon/mumbo/pulls')).status, 200, 'other requests are not held up')
  open()
  assert.equal((await first).status, 200)
  assert.equal((await push()).status, 200)
  assert.equal(f.calls.filter(c => c.url.endsWith('/git-receive-pack')).length, 2)
})

test('at most 3 buffered pushes per replica: a fourth project\'s push answers 429 until one ends', { timeout: 10_000 }, async (t) => {
  let open
  const gate = new Promise(r => { open = r })
  const f = await forwarder({ reply: async (url) => { if (url.endsWith('/git-receive-pack')) await gate; return ok() } })
  t.after(f.close)
  const projects = await addProjects(f)
  const pending = []
  for (const id of projects.slice(0, 3)) {
    pending.push(pushAs(f, id))
    await until(() => f.calls.length === pending.length)
  }
  const fourth = await pushAs(f, projects[3])
  assert.equal(fourth.status, 429)
  assert.match(fourth.json().message, /taking 3 other pushes/)
  open()
  for (const p of pending) assert.equal((await p).status, 200)
  assert.equal((await pushAs(f, projects[3])).status, 200)
  assert.equal(f.calls.length, 4)
})

test('pushes whose clients reset during the checks hold no slot: the same project and another push afterwards', { timeout: 10_000 }, async (t) => {
  const f = await forwarder({ haltMs: 100 }); t.after(f.close)
  const projects = await addProjects(f)
  for (const [i, id] of projects.slice(0, 3).entries()) {
    f.state.principal = `project:${id}`
    sendThenReset(f.port, `github.com/${repoOf(id)}.git/git-receive-pack`, 20)  // resets during the 100 ms halt check
    await until(() => f.haltChecks.length === i + 1)
  }
  await until(() => f.state.settled === 3)
  assert.equal((await pushAs(f, P1)).status, 200, 'the same project')
  assert.equal((await pushAs(f, projects[3])).status, 200, 'a fourth project, under the replica cap')
  assert.equal(f.calls.length, 2)
})

test('a push GitHub does not answer gets 504 after pushTimeoutMs, and its slot frees', { timeout: 10_000 }, async (t) => {
  let stalls = 1, signal
  const f = await forwarder({ pushTimeoutMs: 100, reply: (url, init) => {
    if (!url.endsWith('/git-receive-pack') || stalls-- <= 0) return ok()
    signal = init.signal
    return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)))
  } })
  t.after(f.close)
  const stalled = await pushAs(f, P1)
  assert.equal(stalled.status, 504)
  assert.match(stalled.json().message, /GitHub did not answer the push within 0\.1 s/)
  assert.equal(signal.reason.name, 'TimeoutError')
  assert.equal((await pushAs(f, P1)).status, 200, 'the slot is free')
})

test('a mutation whose client leaves during the node lookup is not forwarded', { timeout: 10_000 }, async (t) => {
  const f = await forwarder({ lookup: async (ids) => { await new Promise(r => setTimeout(r, 100)); return lookupOk(ids) } })
  t.after(f.close)
  const q = request({ host: '127.0.0.1', port: f.port, method: 'POST', path: '/github/api.github.com/graphql', headers: { 'content-type': 'application/json' } })
  q.on('error', () => {})  // destroyed on purpose
  q.end(JSON.stringify({ query: 'mutation { addComment(input: {subjectId: "I_1", body: "x"}) { clientMutationId } }' }))
  await until(() => f.lookups.length === 1)
  q.destroy()
  await until(() => f.state.settled === 1)
  assert.equal(f.calls.length, 0)
})

test('a client that leaves mid-response cancels the upstream body', { timeout: 10_000 }, async (t) => {
  let cancelled
  const done = new Promise(r => { cancelled = r })
  const f = await forwarder({ reply: () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('first')) }, cancel: () => cancelled() })) })
  t.after(f.close)
  await new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port: f.port, path: '/github/codeload.github.com/callgideon/mumbo/tar.gz/refs/heads/main' }, (res) => res.once('data', () => { req.destroy(); resolve() }))
    req.on('error', () => {})  // destroyed on purpose
    req.end()
  })
  await done
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
