/**
 * The edge-signed member header: `x-mumbo-member: <email>.<expiry>.<mac>`.
 *
 * `email` is the member's lowercased address in unpadded base64url, `expiry` is a Unix time in whole seconds,
 * and `mac` is the unpadded base64url HMAC-SHA256 of `<email>.<expiry>`, exactly as sent, under the box's
 * member key. The mumbo edge derives that key per box and mints a fresh header on every request it proxies.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

/** Request header carrying the signed member identity; the edge strips it from browser requests. */
export const MEMBER_HEADER = 'x-mumbo-member'

/** Latest expiry accepted, in seconds after now; the edge signs five minutes ahead. */
export const MAX_FUTURE_SECONDS = 600

/** Longest accepted email address, in characters. */
const MAX_EMAIL_LENGTH = 320

const BASE64URL = /^[A-Za-z0-9_-]+$/
const EXPIRY = /^[1-9][0-9]{0,11}$/
/** One `@` between non-empty parts, with no whitespace or control characters. */
const EMAIL = /^[^\s\p{Cc}@]+@[^\s\p{Cc}@]+$/u

/**
 * Decode the configured member key.
 * @param key - unpadded base64url key bytes.
 * @returns the key bytes.
 * @throws when the key is not base64url or decodes to fewer than 32 bytes.
 */
export function decodeMemberKey(key: string): Buffer {
  const bytes = BASE64URL.test(key) ? Buffer.from(key, 'base64url') : Buffer.alloc(0)
  if (bytes.length < 32) throw new Error('mumbo-edge-member: key must be at least 32 bytes in unpadded base64url')
  return bytes
}

/**
 * Sign one member header value, as the edge does.
 * @param key - member key bytes.
 * @param email - lowercased member address.
 * @param expiry - Unix time in seconds after which the box refuses the header.
 * @returns the header value.
 */
export function signMemberHeader(key: Buffer, email: string, expiry: number): string {
  const signed = `${Buffer.from(email).toString('base64url')}.${String(expiry)}`
  return `${signed}.${createHmac('sha256', key).update(signed).digest('base64url')}`
}

/**
 * Verify one member header value.
 * @param key - member key bytes.
 * @param value - the header value as received.
 * @param nowSeconds - current Unix time in seconds.
 * @returns the member's email, or undefined for a malformed, expired, too-distant, or wrongly signed value.
 */
export function verifyMemberHeader(key: Buffer, value: string, nowSeconds: number): string | undefined {
  const parts = value.split('.')
  if (parts.length !== 3) return undefined
  const [encodedEmail, expiryText, mac] = parts as [string, string, string]
  if (!BASE64URL.test(encodedEmail) || !EXPIRY.test(expiryText) || !BASE64URL.test(mac)) return undefined
  const expected = createHmac('sha256', key).update(`${encodedEmail}.${expiryText}`).digest()
  const presented = Buffer.from(mac, 'base64url')
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return undefined
  const expiry = Number(expiryText)
  if (expiry < nowSeconds || expiry > nowSeconds + MAX_FUTURE_SECONDS) return undefined
  const email = Buffer.from(encodedEmail, 'base64url').toString('utf8')
  if (email.length > MAX_EMAIL_LENGTH || !EMAIL.test(email) || email !== email.toLowerCase()) return undefined
  return email
}
