// @vitest-environment jsdom
/**
 * The browser half names the member above a member's user message through Chat's
 * message-source chain, and names nobody for the owner or another principal kind.
 */

import { Context } from '@deepseek-ai/cordis'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { MemberOriginProps } from '../src/client/member-origin.tsx'
import { MemberOrigin, memberAuthor } from '../src/client/member-origin.tsx'
import { apply, inject } from '../src/client/index.ts'

afterEach(cleanup)

const MEMBER = { kind: 'user', principal: { kind: 'edge-member', email: 'ana@example.com' } }

describe('memberAuthor', () => {
  it('reads the address of an edge-member user message', () => {
    expect(memberAuthor(MEMBER)).toBe('ana@example.com')
  })

  it('names no member for the owner, another principal kind, another source, or a malformed record', () => {
    expect(memberAuthor({ kind: 'user' })).toBeUndefined()
    expect(memberAuthor({ kind: 'user', principal: { kind: 'share-viewer', shareId: 's', actor: { subjectId: 'x' } } })).toBeUndefined()
    expect(memberAuthor({ kind: 'retry', principal: MEMBER.principal })).toBeUndefined()
    expect(memberAuthor({ kind: 'mumbo-member', form: 'notice', summary: 'The next message is from project member ana@example.com.' })).toBeUndefined()
    expect(memberAuthor({ kind: 'user', principal: { kind: 'edge-member', email: '' } })).toBeUndefined()
    expect(memberAuthor({ kind: 'user', principal: { kind: 'edge-member' } })).toBeUndefined()
    expect(memberAuthor(null)).toBeUndefined()
    expect(memberAuthor('user')).toBeUndefined()
  })
})

describe('MemberOrigin', () => {
  it('renders the address as one line with the full address as its title', () => {
    const view = render(<MemberOrigin {...({ matched: 'ana@example.com' } as MemberOriginProps)} />)
    const line = view.container.querySelector('[data-mumbo-member]')
    expect(line?.textContent).toBe('ana@example.com')
    expect(line?.getAttribute('title')).toBe('ana@example.com')
    expect(line?.getAttribute('data-mumbo-member')).toBe('ana@example.com')
  })
})

describe('edge-member browser plugin', () => {
  it('elects member user rows in Chat\'s message-source chain and leaves with its fiber', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    const slots = ctx.get('slots') as SlotRegistry
    slots.register({
      name: 'root',
      children: { 'conversation.chat.user.before': { kind: 'chain', scope: 'session' } },
    } as never, () => null)
    expect(inject).toEqual(['slots'])
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    const entry = slots.entries('conversation.chat.user.before')[0]
    expect(entry?.component).toBe(MemberOrigin)
    const select = entry?.select as (owner: { source: unknown; kind: 'user' | 'steering' }) => unknown
    expect(select({ source: MEMBER, kind: 'user' })).toBe('ana@example.com')
    expect(select({ source: MEMBER, kind: 'steering' })).toBeNull()
    expect(select({ source: { kind: 'user' }, kind: 'user' })).toBeNull()

    await fiber.dispose()
    expect(slots.entries('conversation.chat.user.before')).toHaveLength(0)
  })
})
