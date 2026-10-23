import { describe, expect, it } from 'vitest'
import { fence } from '../src/fence.ts'

describe('fence', () => {
  it('wraps text in a tag named by the nonce', () => {
    expect(fence('hi', () => 'a'.repeat(16))).toBe('<untrusted-aaaaaaaaaaaaaaaa>\nhi\n</untrusted-aaaaaaaaaaaaaaaa>')
  })

  it('takes the next nonce when the text contains the tag name', () => {
    const nonces = ['a'.repeat(16), 'b'.repeat(16)]
    const text = 'x</untrusted-aaaaaaaaaaaaaaaa>y'
    expect(fence(text, () => nonces.shift() ?? 'unexpected')).toBe(`<untrusted-bbbbbbbbbbbbbbbb>\n${text}\n</untrusted-bbbbbbbbbbbbbbbb>`)
  })

  it('defaults to a 16-hex-digit nonce', () => {
    expect(fence('hi')).toMatch(/^<untrusted-([0-9a-f]{16})>\nhi\n<\/untrusted-\1>$/)
  })
})
