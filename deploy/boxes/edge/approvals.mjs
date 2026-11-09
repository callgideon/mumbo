// Merge approvals (design section 5): the edge polls GitHub for the agent's ready pull requests into main, computes
// the low-risk rule itself, and merges only the head SHA the founder saw, with a repository token minted for the
// mumbo-bot GitHub App (github-app.mjs). The agent is that App's bot user, matched by its numeric id. Reads use the
// App's read-only token for the one repository read, separate from the agent's write token and the merge token.
// Store: doc `approval:<id>` per open item, set `approvals:open:<project id>` of item ids.
import { projectsWithRepos, getRepos, ownersOf, projectsOwnedBy } from './projects.mjs'
import { mintToken, tokenCache, githubRequest, githubJson } from './github-app.mjs'

/** The low-risk rule's version, recorded on every item and grant. */
export const RULE_VERSION = 1
const MARKER = /^<!-- mumbo-review sha=([0-9a-f]{40}) verdict=(pass|fail) -->$/
const PROTECTED_DIRS = ['.github/', 'deploy/', 'scripts/', 'packages/mumbo/superagent/']
/** Rule v1's protected paths: those directories, any package.json or pnpm-lock.yaml, and every file at the root. */
const isProtected = (path) => !path.includes('/') || PROTECTED_DIRS.some(d => path.startsWith(d)) || /(^|\/)(package\.json|pnpm-lock\.yaml)$/.test(path)
const MERGE_PERMISSIONS = { contents: 'write', pull_requests: 'write' }
const READ_PERMISSIONS = { contents: 'read', pull_requests: 'read', checks: 'read', statuses: 'read', issues: 'read' }

/**
 * One pull request awaiting the founder.
 * @typedef {object} Approval
 * @property {string} id - `<owner>/<repo>#<n>`, lowercased.
 * @property {string} project - project id.
 * @property {string} repo - `owner/name`, lowercased.
 * @property {number} number
 * @property {string} title
 * @property {string} url
 * @property {string} sha - head SHA the facts below belong to.
 * @property {number} additions
 * @property {number} deletions
 * @property {number} changedFiles - GitHub's `changed_files`.
 * @property {string[]} files
 * @property {string[]} protected - protected paths touched, including a renamed file's previous path.
 * @property {Record<string, string>} checks - required check name to its newest GitHub Actions run's conclusion, its
 *   status while running, or `missing`; runs from any other App are ignored.
 * @property {boolean} checksGreen
 * @property {{ verdict: 'pass'|'fail', url: string, excerpt: string } | null} review - the newest review marker for
 *   `sha` in a comment whose author has the agent's id, or null; `excerpt` is the comment's first 400 characters after
 *   the marker line (the agent's claim).
 * @property {boolean} lowRisk
 * @property {number} ruleVersion
 * @property {number} firstSeen - epoch ms; kept across new heads.
 * @property {string | undefined} notifiedSha
 */
/**
 * @typedef {object} GrantResult
 * @property {string} id
 * @property {boolean} merged
 * @property {string} sha
 * @property {'not_found'|'not_owner'|'sha_moved'|'not_low_risk'|'checks_not_green'|'not_candidate'|'github_error'} [reason] - why it
 *   did not merge; `not_owner` also covers an owner who is not an approver; `not_low_risk` comes only from grantLowRisk.
 */

/**
 * The approval service.
 * @param {{ store: object, github: { app: { appId: string | undefined, privateKey: string | undefined }, agentId: number | undefined, requiredChecks: string[] },
 *   notify: (message: { title: string, body: string, click: string }) => Promise<void>, audit: (record: object) => Promise<void>,
 *   fetchImpl: typeof fetch, now: () => number, approveHost: string, approvers: string[] }} deps - `agentId` is the
 *   agent's numeric GitHub user id (the mumbo-bot App's bot user); unset, nothing is a candidate; `now` is epoch ms;
 *   notifications link to `https://<approveHost>/`; `approvers` (APPROVER_EMAILS, lowercased) are the only emails that
 *   may grant, and only for projects they own; an empty list lets nobody merge.
 * @returns {{ poll(): Promise<void>, list(email: string): Promise<Approval[]>, grant(email: string, id: string, sha: string): Promise<GrantResult>, grantLowRisk(email: string, shown: { id: string, sha: string }[]): Promise<GrantResult[]>, dropRepo(project: string, repo: string): Promise<void> }}
 *   `poll` refreshes the queue from GitHub; a repository GitHub does not answer for, or whose read-only token GitHub
 *   does not mint (logged with mintToken's reason, such as permissions not approved), keeps its items, and an item stays
 *   with the project that first listed it while that project has its repository. `list` gives the items of the
 *   projects `email` owns. `grant` merges item `id` only at `sha`, after re-reading the PR and its checks, then audits
 *   it (with `via` and `mergeCommitSha`) and removes it; a moved head answers `sha_moved` and re-reads that PR.
 *   `grantLowRisk` grants only the `shown` pairs (what the founder's page displayed) that are still low-risk at that
 *   exact SHA, in order, and gives one result per pair. An item whose repository its project no longer has is dropped
 *   by `list` (not listed) and by `grant` (`not_found`). `dropRepo` drops the project's items for one repository, for
 *   removeRepo's caller.
 */
export function approvalsService({ store, github, notify, audit, fetchImpl, now, approveHost, approvers }) {
  const { app, agentId, requiredChecks } = github
  const readTokens = tokenCache({ app, permissions: READ_PERMISSIONS, fetchImpl, now })
  /** GET `path` with the read-only token for `repo` alone; a 401 drops that token, so the next read mints another. */
  const read = async (repo, path) => githubJson(fetchImpl, 'GET', path, await readTokens.get(repo, [repo]))
    .catch((e) => { if (e.status === 401) readTokens.forget(repo); throw e })
  const key = (id) => `approval:${id}`
  const openSet = (project) => `approvals:open:${project}`
  const fail = (what, fields) => console.error(JSON.stringify({ edge: 'approvals', msg: what, ...fields }))

  // ponytail: GitHub serves at most 3,000 files (30 pages); a longer list stays shorter than changed_files, so not low-risk.
  async function pages(repo, path) {
    const out = []
    for (let page = 1; page <= 30; page++) {
      const batch = await read(repo, `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`)
      out.push(...batch)
      if (batch.length < 100) break
    }
    return out
  }
  const isCandidate = (pr) => agentId !== undefined && pr.state === 'open' && !pr.draft && pr.user?.id === agentId
    && pr.base.ref === 'main' && pr.head.repo?.full_name === pr.base.repo.full_name && pr.head.ref.startsWith('agent/')

  async function checksOf(repo, sha) {
    // ponytail: one page of 100 runs; a required run beyond it reads as missing, so not green.
    const { check_runs: runs } = await read(repo, `/repos/${repo}/commits/${sha}/check-runs?per_page=100`)
    const checks = {}
    for (const name of requiredChecks) {
      // Only GitHub Actions runs count: another App, or a token with checks access, could post a run with the same name.
      const newest = runs.filter(r => r.name === name && r.app?.slug === 'github-actions').sort((a, b) => b.id - a.id)[0]
      checks[name] = newest ? (newest.conclusion ?? newest.status) : 'missing'
    }
    return { checks, green: requiredChecks.every(name => checks[name] === 'success') }
  }

  /** Removes `id` from the project's open set, and its doc only when the doc belongs to that project. */
  async function drop(project, id) {
    if ((await store.getDoc(key(id)))?.project === project) await store.deleteDoc(key(id))
    await store.removeFromSet(openSet(project), id)
  }
  /** Whether the item's repository is still bound to its project (removeRepo can take it away). */
  const stillBound = async (doc) => (await getRepos(store, doc.project)).map(r => r.toLowerCase()).includes(doc.repo)

  /** Reads the facts of `listed` (a candidate as GitHub listed it) and saves its item, unless its head moved meanwhile. */
  async function refresh(project, repo, listed) {
    const id = `${repo}#${listed.number}`
    let old = await store.getDoc(key(id))
    if (old && old.project !== project) {
      // addRepo binds a repository to one project; an item never moves while its project still has the repository,
      // even if stored data binds the repo twice. One whose project gave the repository up is dropped and listed anew.
      if (await stillBound(old)) return fail('item belongs to another project; not rebound', { id, project, owner: old.project })
      await drop(old.project, id)
      old = undefined
    }
    const files = await pages(repo, `/repos/${repo}/pulls/${listed.number}/files`)
    const pr = await read(repo, `/repos/${repo}/pulls/${listed.number}`)
    if (!isCandidate(pr)) return drop(project, id)
    // ponytail: the file list takes no SHA, so the head is read before and after it; a push away and back to the
    // same SHA in between goes unseen. compare/{base}...{sha} would bind the files to the SHA.
    if (pr.head.sha !== listed.head.sha) return
    const sha = pr.head.sha
    const { checks, green } = await checksOf(repo, sha)
    const marker = (await pages(repo, `/repos/${repo}/issues/${pr.number}/comments`))
      .filter(c => c.user?.id === agentId)
      .map(c => { const [first, ...rest] = String(c.body).split(/\r?\n/); return { match: MARKER.exec(first), url: c.html_url, excerpt: rest.join('\n').trim().slice(0, 400) } })
      .filter(({ match }) => match?.[1] === sha).at(-1)
    const review = marker ? { verdict: marker.match[2], url: marker.url, excerpt: marker.excerpt } : null
    const touched = [...new Set(files.flatMap(f => [f.filename, f.previous_filename]).filter(p => p && isProtected(p)))]
    const lines = pr.additions + pr.deletions
    const lowRisk = green && review?.verdict === 'pass' && lines < 200 && files.length === pr.changed_files && touched.length === 0
    // The repository may have been removed while this poll read GitHub: then neither notify nor save the item again.
    if (!(await stillBound({ project, repo }))) return drop(project, id)
    let notifiedSha = old?.notifiedSha
    if (notifiedSha !== sha) {
      try {
        await notify({ title: `Approve merge: ${id}`, body: `${pr.title} · ${lines} lines · ${lowRisk ? 'low-risk' : 'needs a look'}`, click: `https://${approveHost}/` })
        notifiedSha = sha
      } catch (e) { fail('notify failed; retried next poll', { id, sha, error: e.message }) }
    }
    await store.putDoc(key(id), {
      id, project, repo, number: pr.number, title: pr.title, url: pr.html_url, sha, additions: pr.additions, deletions: pr.deletions,
      changedFiles: pr.changed_files, files: files.map(f => f.filename), protected: touched, checks, checksGreen: green, review, lowRisk,
      ruleVersion: RULE_VERSION, firstSeen: old?.firstSeen ?? now(), notifiedSha,
    })
    await store.addToSet(openSet(project), id)
  }

  async function repoll(doc) {
    const pr = await read(doc.repo, `/repos/${doc.repo}/pulls/${doc.number}`)
    return isCandidate(pr) ? refresh(doc.project, doc.repo, pr) : drop(doc.project, doc.id)
  }

  async function grant(email, id, sha, lowRiskOnly) {
    const no = (reason) => ({ id, merged: false, sha, reason })
    const doc = await store.getDoc(key(id))
    if (!doc) return no('not_found')
    if (!(await stillBound(doc))) { await drop(doc.project, id); return no('not_found') }
    if (!approvers.includes(email) || !(await ownersOf(store, doc.project)).includes(email)) return no('not_owner')
    if (sha !== doc.sha) return no('sha_moved')
    if (lowRiskOnly && !doc.lowRisk) return no('not_low_risk')
    let checks, mergeCommitSha
    try {
      if (!isCandidate(await read(doc.repo, `/repos/${doc.repo}/pulls/${doc.number}`))) return no('not_candidate')
      const state = await checksOf(doc.repo, sha)
      if (!state.green) return no('checks_not_green')
      checks = state.checks
      const bot = await mintToken({ appId: app.appId, privateKey: app.privateKey, repos: [doc.repo], permissions: MERGE_PERMISSIONS, fetchImpl, now })
      let r
      try { r = await githubRequest(fetchImpl, 'PUT', `/repos/${doc.repo}/pulls/${doc.number}/merge`, bot.token, { sha, merge_method: 'merge' }) }
      // The token expires within the hour anyway; a failed revoke must not hide the merge's outcome.
      finally { await bot.revoke().catch(e => fail('revoke failed', { id, error: e.message })) }
      if (r.status === 409 || r.status === 405) {
        await repoll(doc).catch(e => fail('re-poll failed', { id, error: e.message }))
        return no('sha_moved')
      }
      if (!r.ok) throw new Error(`GitHub PUT merge: HTTP ${r.status}`)
      // The merge happened; an unreadable answer leaves only the commit unrecorded.
      mergeCommitSha = (await r.json().catch(() => undefined))?.sha ?? null
    } catch (e) {
      fail('grant failed', { id, sha, error: e.message })
      return no('github_error')
    }
    const record = {
      at: new Date(now()).toISOString(), email, via: lowRiskOnly ? 'grantLowRisk' : 'grant', id, sha, mergeCommitSha,
      ruleVersion: doc.ruleVersion, lowRisk: doc.lowRisk, files: doc.files, checks, review: doc.review, firstSeen: doc.firstSeen,
    }
    // The merge happened: an audit write that fails is logged, and the edge's audit has already logged the record.
    await audit(record).catch(e => fail('audit write failed', { id, sha, error: e.message }))
    await drop(doc.project, id)
    return { id, merged: true, sha }
  }

  return {
    async poll() {
      for (const project of await projectsWithRepos(store)) {
        const keep = new Set()
        const unread = []
        // Ids use the lowercased name, as GitHub compares names, so one repository is one item in any letter case.
        for (const repo of (await getRepos(store, project)).map(r => r.toLowerCase())) {
          try {
            for (const pr of (await pages(repo, `/repos/${repo}/pulls?state=open`)).filter(isCandidate)) {
              keep.add(`${repo}#${pr.number}`)
              await refresh(project, repo, pr)
            }
          } catch (e) {
            unread.push(`${repo}#`)
            fail('poll failed; items kept', { project, repo, error: e.message })
          }
        }
        for (const id of await store.setMembers(openSet(project))) {
          if (!keep.has(id) && !unread.some(prefix => id.startsWith(prefix))) await drop(project, id)
        }
      }
    },
    async list(email) {
      const out = []
      for (const project of await projectsOwnedBy(store, email)) {
        const repos = (await getRepos(store, project)).map(r => r.toLowerCase())
        for (const id of await store.setMembers(openSet(project))) {
          const doc = await store.getDoc(key(id))
          if (doc?.project !== project) continue
          if (repos.includes(doc.repo)) out.push(doc); else await drop(project, id)
        }
      }
      return out
    },
    async dropRepo(project, repo) {
      const prefix = `${repo.toLowerCase()}#`
      for (const id of await store.setMembers(openSet(project))) if (id.startsWith(prefix)) await drop(project, id)
    },
    grant: (email, id, sha) => grant(email, id, sha, false),
    async grantLowRisk(email, shown) {
      const out = []
      for (const { id, sha } of shown) out.push(await grant(email, id, sha, true))
      return out
    },
  }
}
