// The box-local GitHub proxy (project boxes only). The box points HTTPS_PROXY at it, so gh, git and superagent keep
// using github.com URLs while the agent's GitHub tokens stay at the edge.
// - CONNECT to a GitHub host on port 443: TLS ends here, with a leaf for that host signed by the box's own CA, and
//   each request goes to ${EDGE_GITHUB_URL}/<host><path> with `authorization: Bearer ${BOX_TOKEN}` in place of the
//   client's. The edge's GitHub forwarder checks the box token, swaps in the project's mumbo-bot App token and allows
//   only listed operations.
// - CONNECT to anything else: a raw TCP tunnel. A plain http:// proxy request answers 400.
// Required settings: PORT, CA_DIR (holding ca.key, mode 0600, and ca.crt; the start script creates and trusts them),
// EDGE_GITHUB_URL (https only) and BOX_TOKEN. Optional: EDGE_TIMEOUT_MS (120000), the silence after which a request to
// the edge answers 504; RUN_AS, a user (with its own group) the proxy becomes before it listens, so the box's firewall
// refuses a tunnel whatever it refuses that user; a RUN_AS it cannot become stops it. Leaves are issued with openssl at
// start and cached in ${CA_DIR}/leaf/.
// Node built-ins only. The edge reads this file at start and hands it to startScript as boxFiles.proxy.
import { execFileSync } from 'node:child_process'
import { createPrivateKey, X509Certificate } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { request } from 'node:https'
import { connect } from 'node:net'
import { join } from 'node:path'
import { pipeline } from 'node:stream'
import { createSecureContext, TLSSocket } from 'node:tls'

const HOSTS = ['github.com', 'api.github.com', 'codeload.github.com', 'objects.githubusercontent.com']
// Headers that describe one connection (RFC 9110 7.6.1) or the request to this proxy; never forwarded either way.
const HOP = new Set(['host', 'connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'expect'])
const LEAF_DAYS = 365
const RENEW_BEFORE_MS = 30 * 86_400_000

const fail = (message) => { throw new Error(`github-local-proxy: ${message}`) }
const setting = (name) => process.env[name] || fail(`${name} is required`)
const port = Number(setting('PORT'))
const caDir = setting('CA_DIR')
const boxToken = setting('BOX_TOKEN')
const edge = new URL(setting('EDGE_GITHUB_URL'))
if (edge.protocol !== 'https:') fail('EDGE_GITHUB_URL must be an https:// URL')
const edgePath = edge.pathname.replace(/\/+$/, '')
const edgeTimeoutMs = Number(process.env.EDGE_TIMEOUT_MS || 120_000)
if (!(edgeTimeoutMs > 0)) fail('EDGE_TIMEOUT_MS must be a positive number of milliseconds')

const caKey = join(caDir, 'ca.key')
const caCrt = join(caDir, 'ca.crt')
if (statSync(caKey).mode & 0o077) fail(`${caKey} must be private to its owner (mode 0600)`)
const ca = new X509Certificate(readFileSync(caCrt))
const leafDir = join(caDir, 'leaf')
mkdirSync(leafDir, { recursive: true, mode: 0o700 })

// The cached pair, read once, while the current CA signed the certificate, the key matches it and it has more than
// RENEW_BEFORE_MS left; otherwise undefined.
const cached = (key, crt) => {
  try {
    const pair = { key: readFileSync(key), cert: readFileSync(crt) }
    const leaf = new X509Certificate(pair.cert)
    const good = leaf.verify(ca.publicKey) && leaf.checkPrivateKey(createPrivateKey(pair.key)) && Date.parse(leaf.validTo) - Date.now() > RENEW_BEFORE_MS
    return good ? pair : undefined
  } catch { return undefined } // missing, unreadable or half written: issue a new pair
}
// openssl writes under per-process temporary names, which are renamed into place, so no reader sees a half-written file.
// A start that reads the new key beside the old certificate (between the renames, or after concurrent starts) fails
// the key check and issues its own pair. This process serves the pair it read, never a re-read.
// ponytail: a start killed mid-issue leaves its temporary files behind; they are small and never read.
const issue = (host, key, crt) => {
  const tmp = `.${process.pid}.tmp`
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
    '-keyout', key + tmp, '-out', crt + tmp, '-subj', `/CN=${host}`, '-addext', `subjectAltName=DNS:${host}`,
    '-addext', 'basicConstraints=critical,CA:FALSE', '-addext', 'extendedKeyUsage=serverAuth',
    '-CA', caCrt, '-CAkey', caKey, '-days', String(LEAF_DAYS)], { stdio: 'pipe' }) // the key file gets mode 0600
  const pair = { key: readFileSync(key + tmp), cert: readFileSync(crt + tmp) }
  renameSync(key + tmp, key)
  renameSync(crt + tmp, crt)
  return pair
}
const contexts = new Map(HOSTS.map((host) => {
  const key = join(leafDir, `${host}.key`)
  const crt = join(leafDir, `${host}.crt`)
  return [host, createSecureContext(cached(key, crt) ?? issue(host, key, crt))]
}))
const runAs = process.env.RUN_AS
if (runAs) {
  try { process.setgroups([]); process.setgid(runAs); process.setuid(runAs) } catch (e) { fail(`RUN_AS ${runAs}: ${e.message}`) }
}

const strip = (headers) => Object.fromEntries(Object.entries(headers).filter(([name]) => !HOP.has(name)))

// One intercepted request to the edge. The path is sent as received; the edge decides what it allows.
function forward(host, req, res) {
  if (!req.url.startsWith('/')) return res.writeHead(400).end()
  let clientGone = false
  const out = request({ hostname: edge.hostname, port: edge.port, method: req.method, path: `${edgePath}/${host}${req.url}`,
    headers: { ...strip(req.headers), authorization: `Bearer ${boxToken}` }, timeout: edgeTimeoutMs }, (up) => {
    res.writeHead(up.statusCode, strip(up.headers))
    pipeline(up, res, () => {})
  })
  // The socket timeout fires after edgeTimeoutMs without traffic either way, so a long transfer that keeps moving is kept.
  out.on('timeout', () => out.destroy(Object.assign(new Error(`no traffic to or from the edge for ${edgeTimeoutMs} ms`), { code: 'ETIMEDOUT' })))
  out.on('error', (e) => {
    if (clientGone) return
    console.error(`github-local-proxy: ${req.method} ${host}: ${e.code ?? e.message}`)
    if (res.headersSent) return res.destroy()
    res.writeHead(e.code === 'ETIMEDOUT' ? 504 : 502, { 'content-type': 'text/plain' })
      .end(`github-local-proxy: the edge GitHub forwarder failed (${e.code ?? e.message})\n`)
  })
  res.on('close', () => { if (!res.writableFinished) { clientGone = true; out.destroy() } })
  req.pipe(out)
}
const forwarders = new Map(HOSTS.map((host) => [host, createServer((req, res) => forward(host, req, res))]))

function tunnel(socket, head, host, targetPort) {
  let open = false
  const upstream = connect(targetPort, host, () => {
    open = true
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    upstream.write(head)
    socket.pipe(upstream).pipe(socket)
  })
  upstream.on('error', () => (open ? socket.destroy() : socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')))
  socket.on('error', () => upstream.destroy())
}

const server = createServer((req, res) => res.writeHead(400, { 'content-type': 'text/plain' }).end('github-local-proxy: only HTTPS (CONNECT) is proxied\n'))
server.on('connect', (req, socket, head) => {
  socket.on('error', () => socket.destroy())
  let target
  try { target = new URL(`http://${req.url}`) } catch { return socket.end('HTTP/1.1 400 Bad Request\r\n\r\n') } // not host:port
  const targetPort = Number(target.port || 80)
  if (targetPort !== 443 || !contexts.has(target.hostname)) return tunnel(socket, head, target.hostname, targetPort)
  socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
  if (head.length) socket.unshift(head)
  forwarders.get(target.hostname).emit('connection', new TLSSocket(socket, { isServer: true, secureContext: contexts.get(target.hostname) }))
})
server.listen(port, '127.0.0.1', () => console.log(`github-local-proxy: listening on 127.0.0.1:${server.address().port}`))
