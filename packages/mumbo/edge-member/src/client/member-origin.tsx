/**
 * The author line above a user message a project member sent.
 *
 * The durable `user/message` source records the `edge-member` principal of the member who sent it. Chat's
 * `conversation.chat.user.before` chain seat elects that source above the official user bubble; this entry
 * supplies only the member's address and leaves the bubble, actions, and text interaction to Chat. Chat
 * dispatches the seat for `user` rows alone and passes the durable source unparsed, so this module is the only
 * place that recognizes the principal.
 *
 * @module @mumbo/edge-member/src/client/member-origin
 */

import type { ReactNode } from 'react'
import type { MatchedShare, PropsRuntime, SlotMap } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: merges Chat's SlotMap and standard declarations into this program.
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import css from './member-origin.module.css'

/**
 * The project member a durable message source names.
 *
 * Session data is persisted, so every field the line relies on is checked; an owner, legacy, malformed, or
 * other non-owner source names no member.
 * @param source - Recorded `user/message` source.
 * @returns The member's address, or undefined for every other author.
 */
export function memberAuthor(source: unknown): string | undefined {
  if (typeof source !== 'object' || source === null) return undefined
  const { kind, principal } = source as { kind?: unknown; principal?: unknown }
  if (kind !== 'user' || typeof principal !== 'object' || principal === null) return undefined
  const member = principal as { kind?: unknown; email?: unknown }
  return member.kind === 'edge-member' && typeof member.email === 'string' && member.email !== '' ? member.email : undefined
}

/** Props of the member author entry above a user message. */
export type MemberOriginProps =
  PropsRuntime<'conversation.chat.user.before'>
  & MatchedShare<SlotMap['conversation.chat.user.before'], string>

/**
 * Render the member address elected for a durable `edge-member` message.
 * @param props - Chat's elected chain match: the member's address.
 * @returns The author line.
 */
export function MemberOrigin({ matched: email }: MemberOriginProps): ReactNode {
  return <span className={css.origin} data-mumbo-member={email} title={email}>{email}</span>
}
