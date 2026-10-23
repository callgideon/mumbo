/** `agent_send` and `agent_read`: an allowlisted person's messages to the assistant Session, and its conversation back. */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionWireEvent } from '@deepseek-ai/dsh-api-session-controller'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { ToolError } from './errors.ts'
import { fence } from './fence.ts'
import { isHalted } from './halt.ts'
import { once } from './store.ts'
import { defineTool, requestId, type ToolDeps } from './tool.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** A message an allowlisted person sent through the MCP door; `principal` is their handle. */
    mcp: { readonly kind: 'mcp'; readonly principal: string }
  }
}

/** Most fenced message text in one `agent_read` reply; a longer message still goes out whole, alone. */
const READ_LIMIT_CHARS = 65_536

const MESSAGE_TYPES: ReadonlySet<string> = new Set(['user/message', 'assistant/message'])

const sendArgs = z.object({
  text: z.string().min(1).max(32_768).describe('The message, as you would type it to the assistant.'),
  request_id: requestId('send'),
})

const readArgs = z.object({
  after_seq: z.number().int().min(0).describe('Read messages after this seq: after_seq from agent_send, or next_seq from agent_read.'),
  wait_s: z.number().int().min(0).max(40).default(0).describe('Seconds to wait for a first message when none is there yet.'),
})

/** The logged message fields `agent_read` reports. */
const messageData = z.object({
  content: z.array(z.object({ type: z.string(), text: z.unknown().optional() })),
  source: z.object({ kind: z.string(), principal: z.unknown().optional() }),
})

/** One message as `agent_read` reports it. */
interface ReadMessage {
  readonly seq: number
  readonly role: 'user' | 'assistant'
  /** `<kind>:<principal>` when the source names a person, else the source kind. */
  readonly source: string
  /** Fenced text blocks joined by newlines. */
  readonly text: string
}

/** Report one logged message, or nothing for other events, compaction re-surfaces, and messages without text. */
function toMessage(event: SessionWireEvent): ReadMessage[] {
  if (!MESSAGE_TYPES.has(event.type) || event.surfaceOp !== 'append') return []
  const { content, source } = messageData.parse(event.data)
  const text = content.flatMap(block => block.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('\n')
  if (text === '') return []
  return [{
    seq: event.seq,
    role: event.type === 'user/message' ? 'user' : 'assistant',
    source: typeof source.principal === 'string' ? `${source.kind}:${source.principal}` : source.kind,
    text: fence(text),
  }]
}

/** One `agent_read` result. */
interface ReadReply {
  readonly messages: ReadMessage[]
  readonly next_seq: number
  /** Whether the text limit held back messages that `next_seq` reads on to. */
  readonly more: boolean
}

/**
 * Messages after `afterSeq`, oldest first, up to {@link READ_LIMIT_CHARS} of text.
 * `next_seq` precedes the first message the limit held back, else it is the log cursor.
 */
async function messagesAfter(deps: ToolDeps, agent: Agent, afterSeq: number, signal: AbortSignal): Promise<ReadReply> {
  const cursor = agent.session.seq - 1
  // ponytail: one page of the whole log per read, as the observation behind `page` reads it whole anyway;
  // page back from the cursor with `beforeSeq` once observations stop reading whole logs.
  const page = await deps.ctx.sessionController.page({
    address: { kind: 'session', sessionId: agent.id },
    throughSeq: cursor,
    maxMessages: Number.MAX_SAFE_INTEGER,
  }, signal)
  const found = page.records.filter(({ event }) => event.seq > afterSeq).flatMap(({ event }) => toMessage(event))
  const messages: ReadMessage[] = []
  let size = 0
  for (const message of found) {
    size += message.text.length
    if (messages.length > 0 && size > READ_LIMIT_CHARS) return { messages, next_seq: message.seq - 1, more: true }
    messages.push(message)
  }
  return { messages, next_seq: cursor, more: false }
}

/**
 * Register `agent_send` and `agent_read` for one principal.
 * @param server - the request's MCP server.
 * @param deps - plugin state and the principal.
 */
export function register(server: McpServer, deps: ToolDeps): void {
  defineTool(
    server,
    'agent_send',
    'Send a message to the assistant as yourself; it reads it as a new user turn. '
    + 'Returns message_id and after_seq: pass after_seq to agent_read to read the reply.',
    sendArgs,
    async (args) => {
      let deliver: (() => void) | undefined
      const result = await once(deps.idem, 'agent_send', deps.principal, args.request_id, args, async () => {
        if (isHalted(deps.halt)) throw new ToolError('halted', 'runs are halted; runs_resume ends the halt')
        const agent = await deps.assistant()
        const afterSeq = agent.session.seq - 1
        const sent = createUserMessage({ content: [{ type: 'text', text: args.text }], source: { kind: 'mcp', principal: deps.principal } })
        deliver = () => { agent.followup(sent) }
        return JSON.stringify({ message_id: sent.id, after_seq: afterSeq })
      })
      // Only the call that ran delivers, and only once its result is stored: a retry never sends twice.
      deliver?.()
      return result
    },
  )
  defineTool(
    server,
    'agent_read',
    'Read the assistant conversation after after_seq: user and assistant messages, oldest first, each with seq, role, source and text. '
    + 'Pass next_seq as after_seq to read on; more says the reply was cut short.',
    readArgs,
    async (args, signal) => {
      const agent = await deps.assistant()
      if (args.wait_s === 0 || deps.closing.aborted) return JSON.stringify(await messagesAfter(deps, agent, args.after_seq, signal))
      // Listen before each read, so a message logged during the read still wakes the wait after it.
      let wake = Promise.withResolvers<void>()
      const stop = deps.ctx.on('session/event', (session, event) => {
        if (session.id === agent.id && MESSAGE_TYPES.has(event.type)) wake.resolve()
      })
      const done = AbortSignal.any([deps.closing, AbortSignal.timeout(args.wait_s * 1000)])
      const end = (): void => { wake.resolve() }
      done.addEventListener('abort', end)
      try {
        for (;;) {
          const reply = await messagesAfter(deps, agent, args.after_seq, signal)
          // A woken read can still find nothing, such as after a tool-call-only message; wait on until wait_s.
          if (reply.messages.length > 0 || done.aborted) return JSON.stringify(reply)
          await wake.promise
          wake = Promise.withResolvers<void>()
        }
      } finally {
        done.removeEventListener('abort', end)
        stop()
      }
    },
  )
}
