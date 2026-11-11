// The approve page on its own origin, https://<approveHost>/, which no box serves (design section 5): the founder's
// queue of merges, "Approve N low-risk", the stop switch and repository access for projects. An item without a pass
// review marker for its commit shows why it is not approvable, with no Approve form.
// Every POST needs `Origin: https://<approveHost>` exactly and the day's CSRF token, so neither another site nor a
// script served from a box (on another origin) can act here. The page runs no script (CSP default-src 'none').
import { createHmac, timingSafeEqual } from 'node:crypto'
import { STATUS_CODES } from 'node:http'
import { esc, PAGE_SECURITY as SECURITY } from './edge.mjs'
import { addRepo, getRepos, projectsOwnedBy, removeRepo } from './projects.mjs'

const MAX_BODY = 8192
const DAY_MS = 86_400_000
const ITEM_ID = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+$/
/** `?m=<code>` after a POST, and each `?s=<reason>:<id>` skip line, shows this fixed text; any other code shows nothing. */
const NOTICES = new Map([
  ['merged', 'Merged.'],
  // B2 answers sha_moved for GitHub's 409 (head moved) and 405 (conflict or branch protection) alike.
  ['sha_moved', 'The pull request changed or cannot be merged as it stands. Review it again.'],
  ['checks_not_green', 'Required checks are not green on that commit, so it was not merged.'],
  ['not_low_risk', 'No longer low-risk at that commit, so it was not merged.'],
  ['not_reviewed', 'The agent\'s review has not passed that commit, so it was not merged.'],
  ['not_candidate', 'That pull request is no longer ready to merge: closed, a draft, or not into main.'],
  ['not_owner', 'You do not own the project of that pull request.'],
  ['not_found', 'That approval is no longer open.'],
  ['github_error', 'GitHub refused the merge. Try again in a minute.'],
  ['halted', 'Everything is stopped. Model calls and GitHub writes are refused until you resume.'],
  ['resumed', 'Resumed. Model calls and GitHub writes pass again.'],
  ['repo_added', 'Repository access given.'],
  ['repo_bound', 'That repository already belongs to another project.'],
  ['repo_not_installed', 'The mumbo-bot GitHub App is not installed for that repository.'],
  ['repo_other_installation', 'That repository is in another mumbo-bot App installation than this project\'s repositories.'],
  ['repo_removed', 'Repository access removed.'],
  ['repo_changed', 'The project\'s repositories changed meanwhile. Try again.'],
])
/** The edge form pages' stylesheet (this page and the key manager, keys.mjs). */
export const STYLE = `body{margin:0;background:#fff;color:rgb(15,17,21);font:14px/24px system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:40rem;margin:0 auto;padding:24px 16px}h1{font-size:20px;line-height:28px;margin:0}h2{font-size:14px;margin:32px 0 0}
a{color:rgb(65,118,230);text-decoration:none}.muted{color:rgb(97,102,107)}p{margin:0}form{margin:0}
.card{border:0.5px solid rgba(0,0,0,.12);border-radius:12px;padding:16px;margin:12px 0}
.row{display:flex;gap:8px;align-items:center;justify-content:space-between;flex-wrap:wrap}
.notice{border:0.5px solid rgba(0,0,0,.12);border-radius:12px;padding:8px 16px;margin:16px 0 0}.skipped{margin:8px 0 0;padding-left:20px}
.tag{border:0.5px solid rgba(0,0,0,.12);border-radius:12px;padding:0 8px;font-size:12px;color:rgb(97,102,107)}.tag.low{color:rgb(65,118,230)}
button,input{font:inherit;border-radius:12px;border:0.5px solid rgba(0,0,0,.12);padding:4px 12px;background:#fff;color:rgb(15,17,21)}
button{border-radius:999px;padding:4px 16px;cursor:pointer}button.primary{background:rgb(15,17,21);border-color:rgb(15,17,21);color:#fff}
button:disabled{opacity:.4;cursor:default}code{font:12px/24px ui-monospace,SFMono-Regular,Menlo,monospace}`

const fail = (status) => Object.assign(new Error(STATUS_CODES[status]), { status })
const text = (res, status) => res.writeHead(status, { ...SECURITY, 'content-type': 'text/plain; charset=utf-8' }).end(STATUS_CODES[status])
/** Hidden form inputs; values are escaped, names are the caller's literals. */
export const hidden = (fields) => Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v)}">`).join('')
/** The request body as form fields; undefined when it exceeds MAX_BODY (an oversized chunked body is cut off). */
async function readForm(req) {
  if (Number(req.headers['content-length'] ?? 0) > MAX_BODY) return undefined
  const chunks = []; let size = 0
  for await (const c of req) { if ((size += c.length) > MAX_BODY) return undefined; chunks.push(c) }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
}
/**
 * CSRF tokens bound to a person and the UTC day: base64url HMAC-SHA256(csrfKey, `<email>:<yyyy-mm-dd>`).
 * @param {Buffer} csrfKey - HMAC-SHA256(edge key, <purpose>); one per page, so one page's token is refused by another.
 * @param {() => number} now - epoch ms.
 * @returns {{ token: (email: string) => string, valid: (email: string, given: string | null) => boolean }} today's token,
 *   and a constant-time check that accepts today's or yesterday's.
 */
export function csrfTokens(csrfKey, now) {
  const token = (email, ms) => createHmac('sha256', csrfKey).update(`${email}:${new Date(ms).toISOString().slice(0, 10)}`).digest('base64url')
  return {
    token: (email) => token(email, now()),
    valid: (email, given) => {
      const got = Buffer.from(given ?? '')
      return [0, DAY_MS].some(back => { const want = Buffer.from(token(email, now() - back)); return got.length === want.length && timingSafeEqual(got, want) })
    },
  }
}
/**
 * A state-changing POST's form fields, once its Origin is exactly `origin`, its body is a form of at most MAX_BODY bytes
 * and its `csrf` field is `email`'s token. Otherwise answers 403, 415 or 413 and returns undefined.
 */
export async function checkedForm(req, res, email, origin, csrf) {
  if (req.headers.origin !== origin) return void text(res, 403)
  if (String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() !== 'application/x-www-form-urlencoded') return void text(res, 415)
  const form = await readForm(req)
  if (!form) return void text(res, 413)
  if (!csrf.valid(email, form.get('csrf'))) return void text(res, 403)
  return form
}

/**
 * The approve page.
 * @param {{ approvals: ReturnType<typeof import('./approvals.mjs').approvalsService>, halt: ReturnType<typeof import('./halt.mjs').haltService>, store: object, csrfKey: Buffer, host: string, approvers: string[], installationOf: ReturnType<typeof import('./github-app.mjs').installationOf>, now?: () => number, bindRepo?: typeof addRepo }} deps
 *   `csrfKey` is HMAC-SHA256(edge key, 'approve-csrf'); `host` is the approve host, the only origin its POSTs accept;
 *   `approvers` is APPROVER_EMAILS (lowercased; empty means nobody): only they see Approve controls and may give a
 *   project a repository or take one away, and approvals.grant refuses everyone else; `installationOf` is passed to
 *   addRepo; `now` is epoch ms; `bindRepo` is projects.mjs addRepo unless a test replaces it. The CSRF token is
 *   base64url HMAC-SHA256(csrfKey, `<email>:<yyyy-mm-dd>`) for the UTC day; the page embeds today's, and a POST may
 *   carry today's or yesterday's.
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, email: string) => Promise<void>}
 *   handles one request from the signed-in, allowlisted `email`: `GET /` shows the page; `POST /grant`,
 *   `/grant-low-risk`, `/halt`, `/repo` and `/repo-remove` act and answer 303 to `/?m=<code>`; anything else answers 404.
 */
export function approvePage({ approvals, halt, store, csrfKey, host, approvers, installationOf, now = () => Date.now(), bindRepo = addRepo }) {
  if (!Array.isArray(approvers)) throw new Error('approvePage: approvers must be the list of approver emails (APPROVER_EMAILS)')
  const origin = `https://${host}`
  const csrfs = csrfTokens(csrfKey, now)

  // Each action returns the redirect's query fields, or throws fail(status).
  const actions = {
    async '/grant'(email, form) {
      const id = form.get('id'), sha = form.get('sha')
      if (!id || !sha) throw fail(400)
      const r = await approvals.grant(email, id, sha)
      return [['m', r.merged ? 'merged' : r.reason]]
    },
    // Grants only the [id, sha] pairs the page showed, so an item whose head moved since is skipped, not merged.
    async '/grant-low-risk'(email, form) {
      const ids = form.getAll('id'), shas = form.getAll('sha')
      if (!ids.length || ids.length !== shas.length || ids.some(v => !v) || shas.some(v => !v)) throw fail(400)
      const results = await approvals.grantLowRisk(email, ids.map((id, i) => ({ id, sha: shas[i] })))
      const skipped = results.filter(r => !r.merged)
      const m = results.some(r => r.merged) ? 'merged' : skipped[0]?.reason ?? 'not_found'
      return [['m', m], ...skipped.map(r => ['s', `${r.reason}:${r.id}`])]
    },
    async '/halt'(email, form) {
      const on = form.get('on')
      if (on !== '1' && on !== '0') throw fail(400)
      await halt.set(email, on === '1')
      return [['m', on === '1' ? 'halted' : 'resumed']]
    },
    async '/repo'(email, form) {
      const project = form.get('project'), repo = form.get('repo')
      if (!approvers.includes(email) || !(await projectsOwnedBy(store, email)).includes(project)) throw fail(403)
      // addRepo checks again: 403 unless `by` is an approver who owns the project, 400 unless repo is owner/name.
      // A refusal with a code (bound elsewhere, App not installed, another installation) shows its notice.
      try { await bindRepo(store, project, repo, { by: email, approvers, installationOf }) } catch (e) {
        if (NOTICES.has(e.code)) return [['m', e.code]]
        throw e
      }
      return [['m', 'repo_added']]
    },
    async '/repo-remove'(email, form) {
      const project = form.get('project'), repo = form.get('repo')
      if (!repo) throw fail(400)
      if (!approvers.includes(email) || !(await projectsOwnedBy(store, email)).includes(project)) throw fail(403)
      // removeRepo checks again, and answers 404 for a repository the project does not have. Its approval items go
      // with it, so none stays mergeable or blocks a project that binds the repository later.
      await removeRepo(store, project, repo, { by: email, approvers })
      await approvals.dropRepo(project, repo)
      return [['m', 'repo_removed']]
    },
  }

  async function page(res, email, query) {
    const [items, stopped, owned] = await Promise.all([approvals.list(email), halt.get(email), projectsOwnedBy(store, email)])
    const csrf = csrfs.token(email)
    const notice = NOTICES.get(query.get('m'))
    const skips = query.getAll('s').map(s => /^([a-z_]+):(.+)$/.exec(s)).filter(m => m && NOTICES.has(m[1]) && ITEM_ID.test(m[2]))
    const low = items.filter(i => i.lowRisk)
    const approver = approvers.includes(email)
    const card = (i) => `<section class="card">
<div class="row"><a href="https://github.com/${esc(i.repo)}/pull/${esc(i.number)}">${esc(i.repo)}#${esc(i.number)}</a>${i.lowRisk ? '<span class="tag low">low-risk</span>' : '<span class="tag">needs a look</span>'}</div>
<p><strong>${esc(i.title)}</strong></p>
<p class="muted"><code>${esc(String(i.sha).slice(0, 7))}</code> · ${esc(i.additions + i.deletions)} lines changed</p>
<p>Protected paths: ${i.protected.length ? i.protected.map(p => `<code>${esc(p)}</code>`).join(', ') : '<span class="muted">none</span>'}</p>
<p>Checks: ${Object.entries(i.checks).map(([name, state]) => `${esc(name)}: ${esc(state)}`).join(' · ')}</p>
<p>Agent's review (claim): ${i.review ? `${esc(i.review.verdict)}<br><span class="muted">${esc(String(i.review.excerpt ?? i.review.body ?? '').slice(0, 400))}</span>` : '<span class="muted">none for this commit</span>'}</p>
${!approver ? '' : i.review?.verdict === 'pass'
    ? `<form method="post" action="/grant">${hidden({ id: i.id, sha: i.sha, csrf })}<div class="row"><span></span><button class="primary">Approve</button></div></form>\n`
    : '<div class="row"><span class="muted">Not approvable: the agent\'s review has not passed this commit.</span><button class="primary" disabled>Approve</button></div>\n'}</section>`
    const bound = (id, list) => list.length ? list.map(r => approver
      ? `<form method="post" action="/repo-remove">${hidden({ project: id, repo: r, csrf })}<div class="row"><code>${esc(r)}</code><button>Remove</button></div></form>`
      : `<p><code>${esc(r)}</code></p>`).join('\n') : '<p class="muted">No repositories yet.</p>'
    const repos = await Promise.all(owned.map(async (id) => `<section class="card">
<p><strong>${esc((await store.getDoc(`project:${id}`))?.name ?? id)}</strong></p>
${bound(id, await getRepos(store, id))}
${approver ? `<form method="post" action="/repo">${hidden({ project: id, csrf })}<div class="row"><input name="repo" placeholder="owner/name" required aria-label="Repository (owner/name)"><button class="primary">Give access</button></div></form>\n` : ''}</section>`))
    res.writeHead(200, { ...SECURITY, 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>mumbo approvals</title>
<style>${STYLE}</style>
<main>
<div class="row"><h1>Approvals</h1><span class="muted">${esc(email)}</span></div>
${notice ? `<p class="notice">${notice}</p>` : ''}${skips.length ? `<ul class="skipped">${skips.map(([, reason, id]) => `<li>${esc(id)}: ${NOTICES.get(reason)}</li>`).join('')}</ul>` : ''}
<section class="card"><div class="row">
${approver ? `<form method="post" action="/grant-low-risk">${low.map(i => hidden({ id: i.id, sha: i.sha })).join('')}${hidden({ csrf })}<button class="primary"${low.length ? '' : ' disabled'}>Approve ${low.length} low-risk</button></form>` : '<span class="muted">Only approvers can merge.</span>'}
<form method="post" action="/halt">${hidden({ on: stopped ? '0' : '1', csrf })}${stopped ? '<span>Everything is stopped. </span><button>Resume</button>' : '<button>Stop everything</button>'}</form>
</div></section>
${items.length ? items.map(card).join('\n') : '<p class="muted">Nothing to approve.</p>'}
${repos.length ? `<h2>Repository access</h2>\n${repos.join('\n')}` : ''}
</main>`)
  }

  return async (req, res, email) => {
    const q = req.url.indexOf('?')
    const path = q < 0 ? req.url : req.url.slice(0, q)
    if (req.method === 'GET' && path === '/') return page(res, email, new URLSearchParams(q < 0 ? '' : req.url.slice(q + 1)))
    const action = req.method === 'POST' && Object.hasOwn(actions, path) ? actions[path] : undefined
    if (!action) return text(res, 404)
    const form = await checkedForm(req, res, email, origin, csrfs)
    if (!form) return
    let query
    try { query = await action(email, form) } catch (e) { if ([400, 403, 404].includes(e.status)) return text(res, e.status); throw e }
    res.writeHead(303, { ...SECURITY, location: `/?${new URLSearchParams(query)}` }).end()
  }
}
