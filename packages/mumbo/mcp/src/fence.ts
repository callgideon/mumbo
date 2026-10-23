/** Fencing for untrusted text returned to the MCP caller. */

import { randomBytes } from 'node:crypto'

/**
 * Wrap untrusted text in a tag whose name the text does not contain, so the text cannot close the fence.
 * @param text - the untrusted text, unchanged inside the fence.
 * @param nonce - source of tag suffixes, asked again while the text contains the tag name; defaults to 16 random hex digits.
 * @returns `<untrusted-N>`, a newline, the text, a newline, and `</untrusted-N>`.
 */
export function fence(text: string, nonce: () => string = () => randomBytes(8).toString('hex')): string {
  let tag = `untrusted-${nonce()}`
  while (text.includes(tag)) tag = `untrusted-${nonce()}`
  return `<${tag}>\n${text}\n</${tag}>`
}
