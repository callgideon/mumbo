// The approve page on its own origin, https://<approveHost>/, which no box serves (design section 5): the founder's
// queue of merges, "Approve all low-risk", the stop switch and repository access for projects.

/**
 * Stub until B3: answers 501.
 * @param {{ approvals: ReturnType<typeof import('./approvals.mjs').approvalsService>, halt: ReturnType<typeof import('./halt.mjs').haltService>, store: object, csrfKey: Buffer, host: string }} deps
 *   `csrfKey` is HMAC-SHA256(edge key, 'approve-csrf'); `host` is the approve host, the only origin its POSTs accept.
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, email: string) => Promise<void>}
 *   handles one request from the signed-in, allowlisted `email`.
 */
export function approvePage({ approvals, halt, store, csrfKey, host }) {
  return async (req, res, email) => {
    res.writeHead(501, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }).end('The approve page is not implemented yet.')
  }
}
