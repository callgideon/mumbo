/** The `/mcp` HTTP handler: method and caller checks, then one stateless MCP exchange answered as JSON. */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { type McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server'
import { checkKey, checkPrincipal } from './auth.ts'

/** Largest accepted request body: room for the largest valid tool call after JSON escaping. */
const MAX_BODY_BYTES = 1024 * 1024

/** Request headers the stateless JSON exchange reads; `authorization` stays out of the MCP server. */
const FORWARDED_HEADERS = ['accept', 'content-type', 'content-length', 'mcp-protocol-version'] as const

/** Values the route handler needs, fixed at plugin load. */
export interface RouteOptions {
  /** Trimmed bearer key. */
  readonly key: string
  /** Principal handles allowed to call. */
  readonly allowlist: readonly string[]
  /** Build a fresh MCP server whose tools act for one principal. */
  readonly buildServer: (principal: string) => McpServer
}

/** Answer a refused request with a plain-text reason that carries no request data. */
function refuse(response: ServerResponse, status: 401 | 403 | 405, message: string): void {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
  response.end(message)
}

/**
 * Create the `/mcp` handler. Only `POST` is served (`405` otherwise); a wrong
 * or missing key answers `401` and a malformed or unlisted principal `403`,
 * before any body is read. Each accepted request gets its own server and
 * transport, closed once the JSON response is written; the transport answers
 * `413` for a body over 1 MiB and its JSON-RPC errors for protocol failures.
 * @param options - key, allowlist, and the per-request server factory.
 * @returns the route handler.
 */
export function createRouteHandler(options: RouteOptions): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  return async (request, response) => {
    if (request.method !== 'POST') {
      response.setHeader('allow', 'POST')
      refuse(response, 405, 'method not allowed')
      return
    }
    if (!checkKey(request.headers.authorization, options.key)) {
      refuse(response, 401, 'invalid key')
      return
    }
    // A repeated header joins with a comma, which the handle pattern rejects.
    const principal = request.headersDistinct['x-mcp-principal']?.join()
    if (!checkPrincipal(principal, options.allowlist)) {
      refuse(response, 403, 'principal not allowed')
      return
    }
    const headers = new Headers()
    for (const name of FORWARDED_HEADERS) {
      for (const value of request.headersDistinct[name] ?? []) headers.append(name, value)
    }
    const server = options.buildServer(principal)
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
