/** Caller authentication for the MCP route: one shared bearer key plus a named, allowlisted principal. */

import { createHash, timingSafeEqual } from 'node:crypto'

/** Accepted principal handles: lowercase, starting with a letter, at most 32 characters. */
export const HANDLE_PATTERN = /^[a-z][a-z0-9-]{0,31}$/

/** SHA-256 digest, so the comparison runs over equal-length buffers whatever the header length. */
function digest(text: string): Buffer {
  return createHash('sha256').update(text).digest()
}

/**
 * Compare an `authorization` header with the expected bearer key in constant time.
 * @param header - the raw header value, absent when the request carried none.
 * @param key - the trimmed key read from the configured key file.
 * @returns whether the header equals `Bearer <key>` exactly.
 */
export function checkKey(header: string | undefined, key: string): boolean {
  return timingSafeEqual(digest(header ?? ''), digest(`Bearer ${key}`))
}

/**
 * Accept a principal handle only when it is well-formed and allowlisted.
 * @param handle - the raw `x-mcp-principal` header value, absent when the request carried none.
 * @param allowlist - the configured handles.
 * @returns whether the request may act as `handle`.
 */
export function checkPrincipal(handle: string | undefined, allowlist: readonly string[]): handle is string {
  return handle !== undefined && HANDLE_PATTERN.test(handle) && allowlist.includes(handle)
}
