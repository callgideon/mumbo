/**
 * Browser half: names the project member above each user message an `edge-member` Peer sent, on the owner's
 * page and on every member's page, through Chat's `conversation.chat.user.before` chain seat.
 *
 * @module @mumbo/edge-member/client
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { MemberOrigin, memberAuthor } from './member-origin.tsx'

/** Required client service: the slot registry. */
export const inject = ['slots']

/**
 * Register the member author line in Chat's message-source seat. Declaration-aware injection makes this
 * independent of whether Chat's user renderer is already registered.
 * @param ctx - browser context carrying the slot registry.
 */
export function apply(ctx: Context): void {
  ctx.slots.inject('conversation.chat.user.before', () => ctx.slots.register({
    name: 'conversation.chat.user.before',
    select: owner => owner.kind === 'user' ? (memberAuthor(owner.source) ?? null) : null,
  }, MemberOrigin))
}
