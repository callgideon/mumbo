// The box-local GitHub proxy (project boxes only). The box points HTTPS_PROXY at it, so gh, git and superagent keep
// using github.com URLs while the agent account's token stays at the edge.
// - CONNECT to a GitHub host on port 443: TLS ends here, with a leaf for that host signed by the box's own CA, and
//   each request goes to ${EDGE_GITHUB_URL}/<host><path> with `authorization: Bearer ${BOX_TOKEN}` in place of the
//   client's. The edge's GitHub forwarder checks the box token, swaps in the agent token and allows only listed
//   operations.
// - CONNECT to anything else: a raw TCP tunnel. A plain http:// proxy request answers 400.
// Settings (all required): PORT, CA_DIR (holding ca.key, mode 0600, and ca.crt; the start script creates and trusts
// them), EDGE_GITHUB_URL (https only) and BOX_TOKEN. Leaves are issued with openssl at start and cached in ${CA_DIR}/leaf/.
// Node built-ins only. The edge reads this file at start and hands it to startScript as boxFiles.proxy.
import { execFileSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { mkdirSync, readFileSync, statSync } from 'node:fs'
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

const caKey = join(caDir, 'ca.key')
const caCrt = join(caDir, 'ca.crt')
if (statSync(caKey).mode & 0o077) fail(`${caKey} must be private to its owner (mode 0600)`)
const ca = new X509Certificate(readFileSync(caCrt))
const leafDir = join(caDir, 'leaf')
mkdirSync(leafDir, { recursive: true, mode: 0o700 })

// A cached leaf is reused while the current CA signed it and it has more than RENEW_BEFORE_MS left.
const reusable = (crt) => {
  try {
    const leaf = new X509Certificate(readFileSync(crt))
    return leaf.verify(ca.publicKey) && Date.parse(leaf.validTo) - Date.now() > RENEW_BEFORE_MS
  } catch { return false } // missing or unreadable: issue a new leaf
}
const contexts = new Map(HOSTS.map((host) => {
  const key = join(leafDir, `${host}.key`)
  const crt = join(leafDir, `${host}.crt`)
  if (!reusable(crt)) {
    // openssl writes the key with mode 0600.
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
      '-keyout', key, '-out', crt, '-subj', `/CN=${host}`, '-addext', `subjectAltName=DNS:${host}`,
      '-addext', 'basicConstraints=critical,CA:FALSE', '-addext', 'extendedKeyUsage=serverAuth',
      '-CA', caCrt, '-CAkey', caKey, '-days', String(LEAF_DAYS)], { stdio: 'pipe' })
  }
  return [host, createSecureContext({ key: readFileSync(key), cert: readFileSync(crt) })]
}))

const strip = (headers) => Object.fromEntries(Object.entries(headers).filter(([name]) => !HOP.has(name)))

// One intercepted request to the edge. The path is sent as received; the edge decides what it allows.
function forward(host, req, res) {
  if (!req.url.startsWith('/')) return res.writeHead(400).end()
  let clientGone = false
  const out = request({ hostname: edge.hostname, port: edge.port, method: req.method, path: `${edgePath}/${host}${req.url}`,
    headers: { ...strip(req.headers), authorization: `Bearer ${boxToken}` } }, (up) => {
    res.writeHead(up.statusCode, strip(up.headers))
    pipeline(up, res, () => {})
  })
  out.on('error', (e) => {
    if (clientGone) return
    console.error(`github-local-proxy: ${req.method} ${host}: ${e.code ?? e.message}`)
    if (res.headersSent) return res.destroy()
    res.writeHead(502, { 'content-type': 'text/plain' }).end(`github-local-proxy: the edge GitHub forwarder failed (${e.code ?? e.message})\n`)
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
