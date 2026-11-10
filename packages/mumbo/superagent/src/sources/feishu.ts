/** Feishu source kind definition, policy synchronization, and Cordis plugin entry. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { FeishuBotSchema } from '../deployment.ts'
import { feishuLink, sendFeishu } from './feishu-channel.ts'
import { feishuThreadContext } from './feishu-read.ts'
import { refreshChatNames, runFeishu } from './feishu-loops.ts'
import { SOURCE, feishuTriggerId } from './feishu-trigger.ts'
import { sourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'
import type { SourceRegistry } from './registry.ts'

export { SOURCE, feishuRef, feishuThreadId, feishuTime, feishuTrigger, feishuTriggerId, historyEvent, withMentionNames }
  from './feishu-trigger.ts'
export type { FeishuEvent } from './feishu-trigger.ts'
export { backfillChat, consumerRetry, pollThreads, refreshChatNames, threadRef } from './feishu-loops.ts'
const MembersSchema = z.looseObject({
  users: z.array(z.looseObject({ member_id: z.string(), name: z.string() })),
  has_more: z.boolean(), truncations: z.array(z.unknown()).optional(),
})
const FeishuConfigSchema = FeishuBotSchema.extend({
  readPageSize: z.number().int().min(1).max(50).default(20),
  linkTimeoutMs: z.number().int().min(1).max(90000).default(5000),
  chats: z.array(z.object({ chatId: z.string().regex(/^oc_[a-zA-Z0-9]+$/), name: z.string().trim().max(60).optional(), listen: z.enum(['mentions', 'all']) }).strict())
    .refine(chats => new Set(chats.map(chat => chat.chatId)).size === chats.length, 'Duplicate chat IDs')
    .default([]),
  directMessages: z.boolean().default(true),
  otherChats: z.enum(['none', 'mentions']).default('none'),
}).strict()
export type FeishuConfig = z.infer<typeof FeishuConfigSchema>
export const feishuKind: SourceKind<FeishuConfig> = {
  kind: SOURCE,
  refreshLabels: (host, signal) => refreshChatNames(sourceContext(host, feishuKind), signal),
  title: 'Feishu',
  description: 'Receives messages to the bot in these chats and direct messages, recovers chat history and polls subscribed Threads.',
  schema: FeishuConfigSchema,
  fields: [
    { key: 'cli', type: 'text', label: 'Bot lark-cli',
      hint: 'A command name or absolute path of a lark-cli configuration that allows only the bot identity (strict mode bot); the Executor calls it as lark-cli. Saving reads the app and the bot, then restarts dsh-superagent.' },
    { key: 'chats', type: 'rows', label: 'Chats',
      hint: '"@ only" receives messages that mention the bot and Threads that have Tickets; "All" also receives the rest, from which Eval may infer work under the rules; the bot needs permission to read all messages.',
      columns: [
        { key: 'chatId', type: 'text', label: 'Chat', pattern: 'oc_[a-zA-Z0-9]+', choose: 'Choose a chat the bot has joined', refresh: 'Refresh chats' },
        { key: 'listen', type: 'select', label: 'Receive', options: [{ value: 'mentions', label: '@ only' }, { value: 'all', label: 'All' }] },
      ] },
    { key: 'otherChats', type: 'select', label: 'Other chats', options: [{ value: 'none', label: 'Not received' }, { value: 'mentions', label: '@ only' }],
      hint: 'Chats the bot has joined that are not listed above. "@ only" receives messages there that mention the bot; whose messages may originate work is the Policy\'s admission.' },
    { key: 'directMessages', type: 'switch', label: 'Direct messages' },
    { key: 'readPageSize', type: 'number', advanced: true, min: 1, max: 50, label: 'Messages per page', hint: 'Messages per page when agents read Threads and chat history.' },
    { key: 'linkTimeoutMs', type: 'number', advanced: true, min: 1, max: 90000, label: 'Original message link time limit / ms',
      hint: 'How long to wait for an original message\'s link; after that, agents read the message itself.' },
  ],
  health: ['feishu', 'history'],
  scope({ meta }, config) {
    if (meta.direct === true) return config.directMessages ? { listened: true, observed: false, row: 'direct' } : { listened: false, reason: 'direct_messages_not_allowed' }
    const chat = config.chats.find(item => item.chatId === meta.chatId)
    if (chat) return { listened: true, observed: chat.listen === 'all', row: chat.chatId }
    return config.otherChats === 'mentions' ? { listened: true, observed: false, row: 'other' } : { listened: false, reason: 'chat_not_allowed' }
  },
  // A reply goes only to a chat the Source still receives.
  channel: {
    allowed: (address, config) =>
      feishuKind.scope!({ meta: { chatId: address.chatId ?? '', direct: address.direct === 'true' } }, config).listened,
    send: sendFeishu, link: feishuLink,
  },
  threadContext: feishuThreadContext,
  find: query => ({ threads: [], terms: [...new Set(query.match(/om_[A-Za-z0-9_-]+/g) ?? [])] }),
  // A message's Trigger is named after the message, so the one it answers is named after its parent.
  repliesTo: trigger => typeof trigger.meta.parentId === 'string' ? feishuTriggerId(trigger.meta.parentId) : undefined,
  policy: {
    unnamed: { person: 'Feishu user', bot: 'Feishu bot' },
    schema: z.object({
      allowed: z.array(z.object({ id: z.string().regex(/^ou_[a-zA-Z0-9]+$/), name: z.string().trim().max(100).optional() }).strict())
        .refine(users => new Set(users.map(user => user.id)).size === users.length, 'Duplicate open_ids').default([]),
      syncChat: z.string().regex(/^(oc_[a-zA-Z0-9]+)?$/).default(''),
      bots: z.array(z.object({ id: z.string().regex(/^(cli|ou)_[a-zA-Z0-9]+$/), name: z.string().trim().max(100).optional() }).strict())
        .refine(bots => new Set(bots.map(bot => bot.id)).size === bots.length, 'Duplicate bot ids').optional(),
    }).strict(),
    fields: [
      { key: 'allowed', type: 'rows', label: 'Feishu users who may originate work',
        columns: [{ key: 'id', type: 'text', label: 'open_id', pattern: 'ou_[a-zA-Z0-9]+' }, { key: 'name', type: 'text', label: 'Name', optional: true }] },
      { key: 'syncChat', type: 'text', pattern: '(oc_[a-zA-Z0-9]+)?', label: 'Sync chat', choose: 'Do not sync',
        hint: 'Syncing makes the list the people in this chat: new members join, people who left are removed, and names follow the chat. It runs at startup and on Sync.' },
      { key: 'bots', type: 'rows', label: 'Bots whose messages may become candidates',
        hint: 'Messages of a bot on this list, in chats the Source receives, become inferred candidates for an assessment; they never make an explicit request or stop a ticket. Other bots\' messages are not admitted. A listed bot\'s messages on a thread that tickets subscribe to also go straight to those tickets\' Executors.',
        columns: [{ key: 'id', type: 'text', label: 'App ID or open_id', pattern: '(cli|ou)_[a-zA-Z0-9]+' },
          { key: 'name', type: 'text', label: 'Name', optional: true }] },
    ],
    explicit: 'Someone on the list who mentions the bot or messages it directly always makes an explicit request; that needs no setting.',
    rows(stored) {
      const config = FeishuConfigSchema.parse(stored)
      const mentions = '@ only'
      return [
        ...config.chats.map(chat => ({ id: chat.chatId, label: chat.name || chat.chatId, note: chat.listen === 'all' ? 'All' : mentions,
          cells: { listedUnaddressed: chat.listen === 'all', unlistedAddressed: true, unlistedUnaddressed: chat.listen === 'all' } })),
        { id: 'other', label: 'Other chats', note: config.otherChats === 'mentions' ? mentions : 'Not received',
          cells: { listedUnaddressed: false, unlistedAddressed: config.otherChats === 'mentions', unlistedUnaddressed: false } },
        { id: 'direct', label: 'Direct messages', note: config.directMessages ? 'Received' : 'Not received',
          cells: { listedUnaddressed: false, unlistedAddressed: config.directMessages, unlistedUnaddressed: false } },
      ]
    },
    sync: {
      label: 'Sync now',
      ready: part => !!part.syncChat,
      async run(host, part, signal) {
        const commands = sourceContext(host, feishuKind).commands.withSignal(signal)
        const chat = String(part.syncChat)
        const members = ['im', '+chat-members-list', '--chat-id', chat, '--member-types', 'user', '--page-all', '--page-limit', '0']
        const result = MembersSchema.parse(await commands.lark(members))
        if (result.has_more || result.truncations?.length) throw new Error('Feishu returned an incomplete member list')
        // Preserve existing member order so policy version hashes stay stable; update names in place and append new members.
        const users = new Map(result.users.map(user => [user.member_id, user.name]))
        const known = new Set(part.allowed.map(entry => entry.id))
        return { ...part, allowed: [...part.allowed.filter(entry => users.has(entry.id)).map(entry => ({ ...entry, name: users.get(entry.id)! })), ...result.users.filter(user => !known.has(user.member_id)).map(user => ({ id: user.member_id, name: user.name }))] }
      },
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_FEISHU_BOT', description: 'The Feishu bot; lark-cli acts as it' },
      { key: 'DSH_SUPERAGENT_FEISHU_CHAT', description: 'chat_id of the Feishu chat that started the ticket; empty when the ticket did not start on Feishu' },
    ],
    values: ({ deployment, trigger }) => ({ DSH_SUPERAGENT_FEISHU_BOT: deployment.feishu ? deployment.feishu.name || deployment.feishu.botId : '', DSH_SUPERAGENT_FEISHU_CHAT: trigger?.source === SOURCE ? String(trigger.meta.chatId ?? '') : '' }),
  },
  facts: (deployment): Record<string, string> => deployment?.feishu ? { cli: `Current bot ${deployment.feishu.name || deployment.feishu.botId}` } : {},
}
/** Returns the Feishu Source's settings, falling back to schema defaults while the Feishu plugin is disabled. */
export const feishuSettings = (sources: SourceRegistry): FeishuConfig => sources.instance<FeishuConfig>(SOURCE)?.config ?? FeishuConfigSchema.parse({})

export const name = 'dsh-superagent-feishu'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(feishuKind), 'feishu: source kind')
  ctx.effect(() => {
    const controller = new AbortController()
    const running = runFeishu(sourceContext(ctx.orchestrator, feishuKind), controller.signal)
    return async () => { controller.abort(); await running }
  })
}
