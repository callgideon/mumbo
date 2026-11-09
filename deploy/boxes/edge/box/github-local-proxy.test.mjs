// node --test: the box-local GitHub proxy, started as the box starts it (a child process configured by PORT, CA_DIR,
// EDGE_GITHUB_URL and BOX_TOKEN) with a temporary CA and a fake edge GitHub forwarder. GitHub hosts are intercepted and
// reach the edge with the box token; every other host is tunnelled untouched.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes, X509Certificate } from 'node:crypto'
import { copyFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { createServer as createHttpsServer, request as httpsRequest } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect as tlsConnect, createServer as createTlsServer } from 'node:tls'

const PROXY = new URL('./github-local-proxy.mjs', import.meta.url).pathname
const HOSTS = ['github.com', 'api.github.com', 'codeload.github.com', 'objects.githubusercontent.com']
const tmp = mkdtempSync(join(tmpdir(), 'gh-proxy-'))
const caDir = join(tmp, 'ca')
const openssl = (...args) => execFileSync('openssl', args, { stdio: 'pipe' })
const ec = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes']
const listen = (server) => new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port)))

let edgeUrl, proxy, edge, other, otherCert
const seen = []
const proxyEnv = (over = {}) => ({ PATH: process.env.PATH, PORT: '0', CA_DIR: caDir, EDGE_GITHUB_URL: edgeUrl, BOX_TOKEN: 'test-token', NODE_EXTRA_CA_CERTS: join(caDir, 'ca.crt'), ...over })

const startProxy = (env) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [PROXY], { env })
  let out = '', err = ''
  child.stdout.on('data', (c) => { out += c; const m = /listening on 127\.0\.0\.1:(\d+)/.exec(out); if (m) resolve({ child, port: Number(m[1]) }) })
  child.stderr.on('data', (c) => { err += c })
  child.on('exit', (code) => reject(new Error(`proxy exited ${code}: ${err}`)))
})

const connect = (target) => new Promise((resolve, reject) => {
  httpRequest({ host: '127.0.0.1', port: proxy.port, method: 'CONNECT', path: target })
    .on('connect', (res, socket) => (res.statusCode === 200 ? resolve(socket) : reject(new Error(`CONNECT ${res.statusCode}`))))
    .on('error', reject).end()
})

// An HTTPS request through the proxy, as gh and git make one: CONNECT host:443, then TLS trusting only the box CA.
const github = async (host, { method = 'GET', path = '/', headers = {}, body } = {}) => {
  const socket = await connect(`${host}:443`)
  const secure = tlsConnect({ socket, servername: host, ca: readFileSync(join(caDir, 'ca.crt')) })
  return new Promise((resolve, reject) => {
    const req = httpsRequest({ host, method, path, headers, createConnection: () => secure }, (res) => {
      const chunks = []; res.on('data', c => chunks.push(c))
      res.on('end', () => { const peer = secure.getPeerX509Certificate(); secure.destroy(); resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), peer }) })
    })
    req.on('error', reject)
    req.end(body)
  })
}

before(async () => {
  mkdirSync(caDir)
  openssl('req', '-x509', ...ec, '-keyout', join(caDir, 'ca.key'), '-out', join(caDir, 'ca.crt'), '-subj', '/CN=test box CA', '-days', '30')
  // The fake edge's certificate comes from the same CA, so the proxy (given NODE_EXTRA_CA_CERTS) verifies it.
  openssl('req', '-x509', ...ec, '-keyout', join(tmp, 'edge.key'), '-out', join(tmp, 'edge.crt'), '-subj', '/CN=edge',
    '-addext', 'subjectAltName=IP:127.0.0.1', '-addext', 'basicConstraints=critical,CA:FALSE',
    '-CA', join(caDir, 'ca.crt'), '-CAkey', join(caDir, 'ca.key'), '-days', '30')
  openssl('req', '-x509', ...ec, '-keyout', join(tmp, 'other.key'), '-out', join(tmp, 'other.crt'), '-subj', '/CN=other.test', '-days', '30')
  otherCert = new X509Certificate(readFileSync(join(tmp, 'other.crt')))

  edge = createHttpsServer({ key: readFileSync(join(tmp, 'edge.key')), cert: readFileSync(join(tmp, 'edge.crt')) }, (req, res) => {
    const hash = createHash('sha256'); let bytes = 0
    req.on('data', (c) => { hash.update(c); bytes += c.length })
    req.on('end', () => seen.push({ method: req.method, url: req.url, headers: req.headers, bytes, sha: hash.digest('hex') }))
    if (req.method === 'GET') return res.writeHead(200, { 'content-type': 'application/json' }).end('{"login":"mumbo-agent"}')
    res.writeHead(201, { 'x-edge': 'echo' })
    req.pipe(res)
  })
  edgeUrl = `https://127.0.0.1:${await listen(edge)}/github`
  other = createTlsServer({ key: readFileSync(join(tmp, 'other.key')), cert: readFileSync(join(tmp, 'other.crt')) }, (s) => s.end('from other'))
  await listen(other)
  proxy = await startProxy(proxyEnv())
})

after(() => { proxy?.child.kill(); edge?.close(); other?.close(); rmSync(tmp, { recursive: true, force: true }) })

test('a GitHub request is answered with a leaf from the box CA and reaches the edge as /github/<host><path> with the box token', async () => {
  seen.length = 0
  const r = await github('api.github.com', { path: '/user?per_page=1', headers: { accept: 'application/vnd.github+json' } })
  assert.equal(r.status, 200)
  assert.equal(r.body.toString(), '{"login":"mumbo-agent"}')
  assert.equal(r.headers['content-type'], 'application/json')
  assert.equal(r.peer.subject, 'CN=api.github.com')
  assert.equal(seen.length, 1)
  assert.equal(seen[0].method, 'GET')
  assert.equal(seen[0].url, '/github/api.github.com/user?per_page=1')
  assert.equal(seen[0].headers.authorization, 'Bearer test-token')
  assert.equal(seen[0].headers.accept, 'application/vnd.github+json')
  assert.equal(seen[0].headers.host, new URL(edgeUrl).host)
})

test("the client's authorization never reaches the edge", async () => {
  seen.length = 0
  await github('github.com', { path: '/o/r.git/info/refs?service=git-upload-pack', headers: { authorization: 'token client-secret' } })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].url, '/github/github.com/o/r.git/info/refs?service=git-upload-pack')
  assert.equal(seen[0].headers.authorization, 'Bearer test-token')
  assert.doesNotMatch(JSON.stringify(seen[0].headers), /client-secret/)
})

test("a non-GitHub host is tunnelled raw: the client sees that server's own certificate and the edge sees nothing", async () => {
  seen.length = 0
  const socket = await connect(`localhost:${other.address().port}`)
  const secure = tlsConnect({ socket, servername: 'localhost', rejectUnauthorized: false })
  const data = await new Promise((resolve, reject) => {
    let d = ''; secure.on('data', c => { d += c }).on('end', () => resolve(d)).on('error', reject)
  })
  assert.equal(secure.getPeerX509Certificate().fingerprint256, otherCert.fingerprint256)
  assert.equal(data, 'from other')
  assert.equal(seen.length, 0)
})

test('a 5 MB body streams intact to the edge and back, with the status and headers kept', async () => {
  seen.length = 0
  const body = randomBytes(5 * 1024 * 1024)
  const sha = createHash('sha256').update(body).digest('hex')
  const r = await github('github.com', { method: 'POST', path: '/o/r.git/git-receive-pack', headers: { 'content-type': 'application/x-git-receive-pack-request' }, body })
  assert.equal(r.status, 201)
  assert.equal(r.headers['x-edge'], 'echo')
  assert.equal(seen[0].method, 'POST')
  assert.equal(seen[0].headers['content-type'], 'application/x-git-receive-pack-request')
  assert.equal(seen[0].bytes, body.length)
  assert.equal(seen[0].sha, sha)
  assert.equal(r.body.length, body.length)
  assert.equal(createHash('sha256').update(r.body).digest('hex'), sha)
})

test('a plain http:// proxy request answers 400 and reaches no one', async () => {
  seen.length = 0
  const status = await new Promise((resolve, reject) => {
    httpRequest({ host: '127.0.0.1', port: proxy.port, path: 'http://api.github.com/user', headers: { host: 'api.github.com' } }, (res) => { res.resume(); resolve(res.statusCode) })
      .on('error', reject).end()
  })
  assert.equal(status, 400)
  assert.equal(seen.length, 0)
})

test('leaf keys are private to their owner and cached across restarts; a readable CA key or bad settings stop the proxy at start', async () => {
  const leafDir = join(caDir, 'leaf')
  assert.equal(statSync(leafDir).mode & 0o777, 0o700)
  const ca = new X509Certificate(readFileSync(join(caDir, 'ca.crt')))
  const cached = {}
  for (const host of HOSTS) {
    assert.equal(statSync(join(leafDir, `${host}.key`)).mode & 0o777, 0o600, `${host}.key`)
    const leaf = new X509Certificate(cached[host] = readFileSync(join(leafDir, `${host}.crt`)))
    assert.ok(leaf.verify(ca.publicKey), `${host} leaf is signed by the box CA`)
    assert.equal(leaf.checkHost(host), host)
    assert.equal(leaf.ca, false)
  }
  const again = await startProxy(proxyEnv())
  again.child.kill()
  for (const host of HOSTS) assert.deepEqual(readFileSync(join(leafDir, `${host}.crt`)), cached[host], `${host} leaf is reused`)

  const loose = join(tmp, 'loose')
  mkdirSync(loose)
  for (const f of ['ca.key', 'ca.crt']) copyFileSync(join(caDir, f), join(loose, f))
  chmodSync(join(loose, 'ca.key'), 0o644)
  for (const [over, message] of [
    [{ CA_DIR: loose }, /ca\.key must be private to its owner \(mode 0600\)/],
    [{ BOX_TOKEN: '' }, /BOX_TOKEN is required/],
    [{ EDGE_GITHUB_URL: 'http://127.0.0.1:1/github' }, /EDGE_GITHUB_URL must be an https:\/\/ URL/],
  ]) {
    const r = spawnSync(process.execPath, [PROXY], { env: proxyEnv(over), encoding: 'utf8', timeout: 10_000 })
    assert.equal(r.status, 1, JSON.stringify(over))
    assert.match(r.stderr, message)
  }
})
