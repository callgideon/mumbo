/** The identity of Mumbo's Session, shared by the Host and Client halves. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Fixed id of the person's always-present assistant Session, which the edge and other plugins name. */
export const MUMBO_SESSION_ID = 'mumbo' as SessionId
