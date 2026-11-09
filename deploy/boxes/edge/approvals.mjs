// Merge approvals (design section 5): the edge polls GitHub for the agent's ready pull requests into main, computes
// the low-risk rule itself, and merges only the head SHA the founder saw, with a repository token minted for the
// mumbo-bot GitHub App (github-app.mjs). Reads use the agent token.

/**
 * One pull request awaiting the founder.
 * @typedef {object} Approval
 * @property {string} id - `<owner>/<repo>#<n>`.
 * @property {string} project - project id.
 * @property {string} repo - `owner/name`.
 * @property {number} number
 * @property {string} title
 * @property {string} url
 * @property {string} sha - head SHA the facts below belong to.
 * @property {number} additions
 * @property {number} deletions
 * @property {number} changedFiles - GitHub's `changed_files`.
 * @property {string[]} files
 * @property {string[]} protected - protected paths touched.
 * @property {object} checks - required check name to state.
 * @property {boolean} checksGreen
 * @property {object | null} review - the review marker for `sha`, or null.
 * @property {boolean} lowRisk
 * @property {number} ruleVersion
 * @property {number} firstSeen - epoch ms.
 * @property {string | undefined} notifiedSha
 */
/**
 * @typedef {object} GrantResult
 * @property {string} id
 * @property {boolean} merged
 * @property {string} sha
 * @property {'not_found'|'not_owner'|'sha_moved'|'checks_not_green'|'not_candidate'|'github_error'} [reason] - why it did not merge.
 */

/**
 * Stub until B2: every method throws.
 * @param {{ store: object, github: { agentToken: string | undefined, app: { appId: string | undefined, privateKey: string | undefined }, agentLogin: string | undefined, requiredChecks: string[] },
 *   notify: (message: { title: string, body: string, click: string }) => Promise<void>, audit: (record: object) => Promise<void>,
 *   fetchImpl: typeof fetch, now: () => number, approveHost: string }} deps - `now` is epoch ms; notifications link to
 *   `https://<approveHost>/`.
 * @returns {{ poll(): Promise<void>, list(email: string): Promise<Approval[]>, grant(email: string, id: string, sha: string): Promise<GrantResult>, grantLowRisk(email: string, shown: { id: string, sha: string }[]): Promise<GrantResult[]> }}
 *   `poll` refreshes the queue from GitHub; `list` gives the items of the projects `email` owns; `grant` merges item `id`
 *   only at `sha`; `grantLowRisk` grants only the `shown` pairs (what the founder's page displayed) that are still
 *   low-risk at that exact SHA, and reports every skipped pair with its reason.
 */
export function approvalsService({ store, github, notify, audit, fetchImpl, now, approveHost }) {
  const notImplemented = async () => { throw new Error('not implemented') }
  return { poll: notImplemented, list: notImplemented, grant: notImplemented, grantLowRisk: notImplemented }
}
