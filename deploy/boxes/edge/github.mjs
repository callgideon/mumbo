// GitHub for project boxes, on the model host at /github/<host>/<path and query> (host: github.com, api.github.com,
// codeload.github.com or objects.githubusercontent.com). The box authenticates with its box token, already verified
// by modelServer; the edge holds the agent token and forwards only what its rules allow.

/**
 * Stub until B1: answers 501.
 * @param {{ store: object, halt: { isHalted(principal: string): Promise<boolean> }, agentToken: string | undefined, fetchImpl: typeof fetch }} deps
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, claim: { u: string, b: string }) => Promise<void>}
 *   handles one request; `claim` is the verified box token (`u` the principal, `b` the box id).
 */
export function githubForwarder({ store, halt, agentToken, fetchImpl }) {
  return async (req, res, claim) => {
    res.writeHead(501, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ message: 'Mumbo edge: GitHub forwarding is not implemented yet' }))
  }
}
