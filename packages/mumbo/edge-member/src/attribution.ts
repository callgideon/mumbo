/**
 * Member attribution for the model: each entering message a project member sent is preceded by one durable
 * notice naming that member, so the coordinator knows who asked for what.
 *
 * @module @mumbo/edge-member/src/attribution
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
// The Session Controller declares the user and retry sources that carry a principal.
import type {} from '@deepseek-ai/dsh-api-session-controller/types'
import { createUserMessage, type ContextFormed, type UserMessage } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** The notice naming the project member who sent the message that follows it. */
    'mumbo-member': { kind: 'mumbo-member' } & ContextFormed
  }
}

/** Source kind of the attribution notice. */
export const ATTRIBUTION_SOURCE = 'mumbo-member'

/**
 * The model-facing attribution text for one member.
 * @param email - the member's lowercased address.
 * @returns the notice text.
 */
export function attributionText(email: string): string {
  return `The next message is from project member ${email}.`
}

/**
 * The member a message came from, when an `edge-member` Peer submitted it.
 * @param message - one entering message.
 * @returns the member's email, or undefined for every other source.
 */
export function memberOf(message: UserMessage): string | undefined {
  const { source } = message
  if (source.kind !== 'user' && source.kind !== 'retry') return undefined
  const principal = 'principal' in source ? source.principal : undefined
  return principal?.kind === 'edge-member' ? principal.email : undefined
}

/**
 * Insert an attribution notice before each entering member message of every admitted step.
 *
 * The notices enter the step with the messages they precede, so the Session log records them and a resumed
 * Session replays the same request. Owner messages and other sources pass unchanged.
 * @param ctx - plugin context; the listener is an effect of its fiber.
 */
export function attributeMemberMessages(ctx: Context): void {
  ctx.on('agent/pre-step', async (_payload, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || !decision.messages.some(message => memberOf(message) !== undefined)) return decision
    return {
      ...decision,
      messages: decision.messages.flatMap((message) => {
        const email = memberOf(message)
        if (email === undefined) return [message]
        const summary = attributionText(email)
        return [
          createUserMessage({
            content: [{ type: 'text', text: summary }],
            source: { kind: ATTRIBUTION_SOURCE, form: 'notice', summary },
          }),
          message,
        ]
      }),
    }
  })
}
