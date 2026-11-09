// Owner-local: a real Chromium loads the approve page at https://approve.boxes.mumbo.si (mapped to a local HTTPS server
// with a throwaway certificate) and submits its forms, so the browser's own Origin rules meet the exact-Origin check.
// Run: PLAYWRIGHT_CORE=<playwright-core package dir> node --test approve-page.e2e.mjs
// Needs playwright-core (that path, or resolvable from here), a Playwright Chromium and openssl; skips without them.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:https'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { approvePage } from './approve-page.mjs'
import { memoryStore } from './store.mjs'

const HOST = 'approve.boxes.mumbo.si'
const FOUNDER = 'f@x.com'
const ITEM = { id: 'acme/app#7', project: 'aaaaaaaaaaaaaaaa', repo: 'acme/app', number: 7, title: 'Fix', sha: 'a'.repeat(40), additions: 3, deletions: 1,
  protected: [], checks: { static: 'success', unit: 'success' }, review: { verdict: 'pass', excerpt: 'ok' }, lowRisk: true }

/** A self-signed certificate for HOST, or undefined without openssl. */
function certificate() {
  const dir = mkdtempSync(join(tmpdir(), 'approve-e2e-'))
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', `/CN=${HOST}`, '-addext', `subjectAltName=DNS:${HOST}`,
      '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' })
    return { key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) }
  } catch { return undefined } finally { rmSync(dir, { recursive: true, force: true }) }
}
function playwright() {
  try { return createRequire(import.meta.url)(process.env.PLAYWRIGHT_CORE ?? 'playwright-core') } catch { return undefined }
}

const calls = []
const posts = []
const approvals = {
  async list() { return [ITEM] },
  async grant(email, id, sha) { calls.push(['grant', email, id, sha]); return { id, sha, merged: true } },
  async grantLowRisk(email, shown) { calls.push(['grantLowRisk', email, shown]); return shown.map(({ id, sha }) => ({ id, sha, merged: true })) },
}
let stopped = false
const halt = { async get() { return stopped }, async set(email, on) { calls.push(['halt', email, on]); stopped = on } }
const handler = approvePage({ approvals, halt, store: memoryStore(), csrfKey: Buffer.from('k'.repeat(32)), host: HOST, approvers: [FOUNDER] })

const pw = playwright()
const tls = pw && certificate()
let server, browser, skip
if (!pw) skip = 'playwright-core not found; set PLAYWRIGHT_CORE'
else if (!tls) skip = 'openssl not available'
else {
  server = createServer(tls, (req, res) => {
    if (req.method === 'POST') posts.push({ path: req.url, origin: req.headers.origin, referer: req.headers.referer })
    handler(req, res, FOUNDER).catch(e => res.writeHead(500).end(e.stack))
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  try {
    browser = await pw.chromium.launch({ args: [`--host-resolver-rules=MAP ${HOST}:443 127.0.0.1:${server.address().port}`] })
  } catch (e) { skip = `no Playwright Chromium: ${e.message.split('\n')[0]}`; server.close() }
}

test('a real browser submits the approve page forms with the approve Origin, and each acts', { skip }, async (t) => {
  t.after(async () => { await browser.close(); server.close() })
  const page = await (await browser.newContext({ ignoreHTTPSErrors: true })).newPage()
  await page.goto(`https://${HOST}/`)
  const submit = async (name, query) => Promise.all([page.waitForURL(`https://${HOST}/?${query}`), page.getByRole('button', { name, exact: true }).click()])

  await submit('Stop everything', 'm=halted')
  await submit('Resume', 'm=resumed')
  await submit('Approve', 'm=merged')
  await submit('Approve 1 low-risk', 'm=merged')
  assert.deepEqual(calls, [
    ['halt', FOUNDER, true],
    ['halt', FOUNDER, false],
    ['grant', FOUNDER, ITEM.id, ITEM.sha],
    ['grantLowRisk', FOUNDER, [{ id: ITEM.id, sha: ITEM.sha }]],
  ])
  assert.deepEqual(posts.map(p => [p.path, p.origin]), ['/halt', '/halt', '/grant', '/grant-low-risk'].map(path => [path, `https://${HOST}`]))
  assert.ok(posts.every(p => p.referer === `https://${HOST}/` || p.referer?.startsWith(`https://${HOST}/?`)), 'same-origin POSTs carry the page as Referer')
  assert.ok(await page.getByText('Merged.').isVisible())
})
