/**
 * Caller authentication for the MCP route: one bearer key from a file, a named, allowlisted principal, the key's name,
 * and the project whose report the request carries.
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { type Branded, brandString } from '@deepseek-ai/dsh-brand'

/** Accepted principal handles: lowercase, starting with a letter, at most 32 characters. */
export const HANDLE_PATTERN = /^[a-z][a-z0-9-]{0,31}$/

/** A mumbo project id, as the edge names projects: 16 lowercase letters and digits. */
export type ProjectId = Branded<'MumboProjectId'>

/** Accepted project ids; a repeated header reaches the route joined by `, `, which falls outside them. */
const PROJECT_ID = /^[a-z0-9]{16}$/

/** Most characters (UTF-16 code units) of a key name once sanitised. */
const KEY_NAME_MAX = 64

/** Characters `encodeURIComponent` emits; a repeated header reaches the route joined by `, `, which falls outside them. */
const PERCENT_ENCODED = /^[\w.!~*'()%-]*$/

/**
 * Read the bearer key. The route reads it for every request, so a key the edge rotates or empties in the file
 * takes effect on the next request without a reload.
 * @param keyFile - path of the key file; surrounding whitespace in it is ignored.
 * @returns the trimmed key.
 * @throws an `Error` naming `keyFile` when the file is missing or unreadable, or holds only whitespace.
 */
export async function readKey(keyFile: string): Promise<string> {
  const text = await readFile(keyFile, 'utf8').catch((error: unknown) => {
    throw new Error(`mumbo-mcp: cannot read keyFile ${keyFile}: ${String(error)}`, { cause: error })
  })
  const key = text.trim()
  if (key === '') throw new Error(`mumbo-mcp: keyFile ${keyFile} is empty`)
  return key
}

/**
 * Read the name of the caller's key from `x-mumbo-key-name`, which the edge sends once, as percent-encoded UTF-8
 * (`encodeURIComponent`). Control, format, unassigned and line-separator characters and square brackets become
 * spaces, whitespace runs collapse to one space, and the name is trimmed and cut to {@link KEY_NAME_MAX} characters,
 * dropping half a surrogate pair at the cut.
 * @param raw - the header value, absent when the request carried none.
 * @returns the name; `undefined` when the header is absent or names nothing visible; `false` when it is repeated, holds
 *   a character `encodeURIComponent` does not emit, or is not valid percent-encoded UTF-8.
 */
export function readKeyName(raw: string | undefined): string | undefined | false {
  if (raw === undefined) return undefined
  if (!PERCENT_ENCODED.test(raw)) return false
  let decoded: string
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    // decodeURIComponent throws only URIError: the name is malformed, so it is refused rather than shown guessed.
    return false
  }
  const name = decoded.replace(/[\p{C}\p{Zl}\p{Zp}[\]]/gu, ' ').replace(/\s+/gu, ' ').trim()
  return name === '' ? undefined : name.slice(0, KEY_NAME_MAX).replace(/\p{Cs}$/u, '').trimEnd()
}

/**
 * Read the project whose report the request carries from `x-mumbo-report-project`, which only the mumbo edge sets,
 * when it relays a project's report to the principal.
 * @param raw - the header value, absent when the request carried none.
 * @returns the project id; `undefined` when the header is absent; `false` when it is repeated or not a project id.
 */
export function readReportProject(raw: string | undefined): ProjectId | undefined | false {
  if (raw === undefined) return undefined
  return PROJECT_ID.test(raw) ? brandString<ProjectId>(raw) : false
}

/** SHA-256 digest, so the comparison runs over equal-length buffers whatever the header length. */
function digest(text: string): Buffer {
  return createHash('sha256').update(text).digest()
}

/**
 * Compare an `authorization` header with the expected bearer key in constant time.
 * @param header - the raw header value, absent when the request carried none.
 * @param key - the trimmed, non-empty key read from the configured key file.
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
