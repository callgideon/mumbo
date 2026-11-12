/** Signs release notes with the operator's HMAC key. The operator issues config/signing.key; it is not kept in this repository. */
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'

/**
 * @param {string} text - the note.
 * @returns {string} the note's hex HMAC-SHA-256 under the operator's key.
 */
export function sign(text) {
  const key = readFileSync(new URL('../config/signing.key', import.meta.url))
  return createHmac('sha256', key).update(text).digest('hex')
}
