/** The `/mcp` HTTP handler: method and caller checks, then one stateless MCP exchange answered as JSON. */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { type McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server'
import { checkKey, checkPrincipal, type ProjectId, readKeyName, readReportProject } from './auth.ts'

/** Largest accepted request body: room for the largest valid tool call after JSON escaping. */
const MAX_BODY_BYTES = 1024 * 1024

/** Request headers the stateless JSON exchange reads; `authorization` stays out of the MCP server. */
const FORWARDED_HEADERS = ['accept', 'content-type', 'content-length', 'mcp-protocol-version'] as const

/** Header naming the caller's key, read only once the key authenticated the request. */
const KEY_NAME_HEADER = 'x-mumbo-key-name'

/** Header naming the project whose report the request carries, read only once the key authenticated the request. */
const REPORT_HEADER = 'x-mumbo-report-project'

/** Values the route handler needs, fixed at plugin load. */
export interface RouteOptions {
  /** The current trimmed bearer key, read per request; `undefined` when it cannot be read or is empty. */
  readonly key: () => Promise<string | undefined>
  /** Principal handles allowed to call. */
  readonly allowlist: readonly string[]
  /**
   * Build a fresh MCP server whose tools act for one principal, through the key named `via` when the edge named it, or
   * for the project `report` whose report the edge relays to the principal.
   */
  readonly buildServer: (principal: string, via: string | undefined, report: ProjectId | undefined) => McpServer
}

/** Answer a refused request with a plain-text reason that carries no request data. */
function refuse(response: ServerResponse, status: 400 | 401 | 403 | 405 | 503, message: string): void {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
  response.end(message)
}

/**
 * Create the `/mcp` handler. Only `POST` is served (`405` otherwise); an
 * unreadable or empty key file answers `503`, a wrong or missing key `401`,
 * a malformed or unlisted principal `403`, and a repeated or malformed key
 * name or report project, or both on one request, `400`, before any body is read. Each accepted request gets its own
 * server and transport, closed once the JSON response is written; the
 * transport answers `413` for a body over 1 MiB and its JSON-RPC errors for
 * protocol failures.
 * @param options - key source, allowlist, and the per-request server factory.
 * @returns the route handler.
 */
export function createRouteHandler(options: RouteOptions): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  return async (request, response) => {
    if (request.method !== 'POST') {
      response.setHeader('allow', 'POST')
      refuse(response, 405, 'method not allowed')
      return
    }
    const key = await options.key()
    if (key === undefined) {
      refuse(response, 503, 'key unavailable')
      return
    }
    if (!checkKey(request.headers.authorization, key)) {
      refuse(response, 401, 'invalid key')
      return
    }
    // A repeated header joins with a comma, which the handle pattern rejects.
    const principal = request.headersDistinct['x-mcp-principal']?.join()
    if (!checkPrincipal(principal, options.allowlist)) {
      refuse(response, 403, 'principal not allowed')
      return
    }
    // Node joins a repeated header with `, `, which readKeyName refuses.
    const via = readKeyName(request.headersDistinct[KEY_NAME_HEADER]?.join(', '))
    if (via === false) {
      refuse(response, 400, `malformed ${KEY_NAME_HEADER}`)
      return
    }
    const report = readReportProject(request.headersDistinct[REPORT_HEADER]?.join(', '))
    if (report === false) {
      refuse(response, 400, `malformed ${REPORT_HEADER}`)
      return
    }
    // A report comes from a project, not through a person's key.
    if (report !== undefined && via !== undefined) {
      refuse(response, 400, `${REPORT_HEADER} with ${KEY_NAME_HEADER}`)
      return
    }
    const headers = new Headers()
    for (const name of FORWARDED_HEADERS) {
      for (const value of request.headersDistinct[name] ?? []) headers.append(name, value)
    }
    const server = options.buildServer(principal, via, report)
    try {
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
        maxRequestBodySize: MAX_BODY_BYTES,
      })
      await server.connect(transport)
      // Node's fetch needs `duplex` for a streamed body; the global RequestInit type lacks it.
      const init: RequestInit & { duplex: 'half' } = {
        method: 'POST',
        headers,
        body: Readable.toWeb(request) as ReadableStream<Uint8Array>,
        duplex: 'half',
      }
      const answer = await transport.handleRequest(new Request('http://127.0.0.1/mcp', init))
      const answerHeaders = Object.fromEntries(answer.headers)
      // A refusal before the body was read leaves bytes on the socket; close it rather than reuse it.
      response.writeHead(answer.status, request.readableEnded ? answerHeaders : { ...answerHeaders, connection: 'close' })
      response.end(Buffer.from(await answer.arrayBuffer()))
    } finally {
      await server.close()
    }
  }
}
