import { createHmac, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { decodeMemberKey, signMemberHeader, verifyMemberHeader } from '../src/header.ts'

const KEY = randomBytes(32)
const NOW = 1_800_000_000

describe('member header', () => {
  it('accepts a header signed with the key until its expiry', () => {
    const value = signMemberHeader(KEY, 'ann@example.com', NOW + 300)
    expect(verifyMemberHeader(KEY, value, NOW)).toBe('ann@example.com')
    expect(verifyMemberHeader(KEY, value, NOW + 300)).toBe('ann@example.com')
    expect(verifyMemberHeader(KEY, value, NOW + 301)).toBeUndefined()
  })

  it('signs exactly the first two fields as sent, in unpadded base64url', () => {
    const value = signMemberHeader(KEY, 'ann@example.com', NOW + 60)
    const [email, expiry, mac] = value.split('.')
    expect(email).toBe(Buffer.from('ann@example.com').toString('base64url'))
    expect(expiry).toBe(String(NOW + 60))
    expect(mac).toBe(createHmac('sha256', KEY).update(`${email}.${expiry}`).digest('base64url'))
    expect(value).not.toContain('=')
  })

  it('refuses an expiry more than ten minutes ahead', () => {
    expect(verifyMemberHeader(KEY, signMemberHeader(KEY, 'ann@example.com', NOW + 600), NOW)).toBe('ann@example.com')
    expect(verifyMemberHeader(KEY, signMemberHeader(KEY, 'ann@example.com', NOW + 601), NOW)).toBeUndefined()
  })

  it('refuses another key, a changed field, and malformed values', () => {
    const value = signMemberHeader(KEY, 'ann@example.com', NOW + 60)
    const [email, expiry, mac] = value.split('.') as [string, string, string]
    const bo = Buffer.from('bo@example.com').toString('base64url')
    for (const candidate of [
      signMemberHeader(randomBytes(32), 'ann@example.com', NOW + 60),
      `${bo}.${expiry}.${mac}`,
      `${email}.${String(NOW + 61)}.${mac}`,
      `${email}.${expiry}.${mac.slice(0, -2)}`,
      `${email}.${expiry}`,
      `${email}.${expiry}.${mac}.x`,
      `${email}.0${expiry}.${mac}`,
      `${email}.${expiry}.${mac}=`,
      '',
    ]) expect(verifyMemberHeader(KEY, candidate, NOW), candidate).toBeUndefined()
  })

  it('refuses a signed address that is not one lowercased email', () => {
    for (const address of ['Ann@example.com', 'ann', 'a@b@c', 'ann @example.com', 'ann@example.com\n', '']) {
      expect(verifyMemberHeader(KEY, signMemberHeader(KEY, address, NOW + 60), NOW), address).toBeUndefined()
    }
  })

  it('decodes a key of at least 32 bytes and refuses anything else', () => {
    expect(decodeMemberKey(KEY.toString('base64url'))).toEqual(KEY)
    expect(() => decodeMemberKey(randomBytes(31).toString('base64url'))).toThrow(/at least 32 bytes/)
    expect(() => decodeMemberKey(`${KEY.toString('base64url')}=`)).toThrow(/at least 32 bytes/)
    expect(() => decodeMemberKey('')).toThrow(/at least 32 bytes/)
  })
})
