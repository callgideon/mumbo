/** The person-box browser composition booted through the Loader, with a scripted model and a scripted person. */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import type { Plugin } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Agents from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import BrowserUse from '@deepseek-ai/dsh-browser-use'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import Llm, { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import Tools from '@deepseek-ai/dsh-tools'
import Approval from '@deepseek-ai/dsh-user-approval'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import * as Consent from '../src/index.ts'

/** One scripted model step: a browser tool call by its upstream name. */
export interface ScriptStep {
  readonly name: string
  readonly args: Record<string, unknown>
}

/**
 * Public name of an upstream Playwright MCP tool.
 * @param name - upstream tool name.
 * @returns the model-facing tool name.
 */
export const tool = (name: string): string => `mcp__playwright-mcp__${name}`

/** Scripted model: one browser call per step, then a final reply. */
class ScriptedModel extends LlmAdapter {
  constructor(private readonly script: readonly ScriptStep[]) { super() }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text'] })
  }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const step = options.messages.filter(message => message.role === 'tool').length
    const next = this.script[step]
    if (next === undefined) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'Done.' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Done.' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    const call = { type: 'tool-call' as const, id: ToolCallId(`call-${String(step)}`), name: tool(next.name), arguments: JSON.stringify(next.args) }
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id: call.id, name: call.name, argumentsDelta: call.arguments }
    yield { type: 'block-end', index: 0, block: call }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

/**
 * Boot the composition in `root`: approval and the consent row, which mounts the real Playwright MCP provider.
 * @param root - scratch directory holding the config and serving as the Session's working directory.
 * @param options - consent config, approval policy, model script, the person's answers in order (`hang` never answers),
 *   rows placed before and after consent, and extra services the consent row waits for.
 * @returns the booted context and Session, the approval reasons asked, every Session event, logged errors, and the
 *   consent Fiber.
 */
export async function bootComposition(root: string, options: {
  consent: Record<string, unknown>
  approvalPolicy?: 'ask' | 'never'
  script?: readonly ScriptStep[]
  answers?: Array<ApprovalOutcome | 'hang'>
  withoutApproval?: boolean
  before?: ReadonlyArray<readonly [string, Plugin]>
  after?: ReadonlyArray<readonly [string, Plugin]>
  consentInject?: string[]
}) {
  const asked: string[] = []
  const answers = [...options.answers ?? []]
  const model = new ScriptedModel(options.script ?? [])
  const modules = new Map<string, unknown>([
    ['tools', Tools], ['toolExecutor', NativeToolExecutor], ['prompt', SystemPrompt], ['llm', Llm], ['sessions', Sessions],
    ['agents', Agents], ['loop', AgentLoop], ['projections', Projections], ['fs', LocalFileSystem], ['workingDirectory', WorkingDirectory],
    ...options.withoutApproval === true ? [] : [['approval', Approval] as const],
    ['browserUse', BrowserUse], ...options.before ?? [], ['consent', Consent], ...options.after ?? [],
    ['model', { inject: ['llm'], apply(ctx: Context) { ctx.effect(() => ctx.llm.registerAdapter(['fixture'], model)) } }],
    // The person answering in the browser is an external input.
    ['person', { apply(ctx: Context) {
      ctx.on('approval/request', (request) => {
        asked.push(request.reason ?? '')
        const answer = answers.shift() ?? 'rejected'
        if (answer !== 'hang') return Promise.resolve(answer)
        return new Promise<ApprovalOutcome>((resolve) => { request.signal?.addEventListener('abort', () => { resolve('cancelled') }) })
      })
    } }],
  ])
  const configs: Record<string, unknown> = {
    loop: { agents: [] },
    approval: { policy: options.approvalPolicy ?? 'ask' },
    consent: options.consent,
  }
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, JSON.stringify([...modules.keys()].map(name => ({
    id: name, name, config: configs[name] ?? {}, ...name === 'consent' && options.consentInject !== undefined ? { inject: options.consentInject } : {},
  }))))
  const ctx = new Context()
  const errors: string[] = []
  ctx.logger.exporter({ levels: { default: 3 }, export: (message) => { if (message.type === 'error') errors.push(message.args.map(String).join(' ')) } })
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = class FixtureInclude extends Include {
    override import(specifier: string, getOuterStack?: () => string[]): unknown {
      if (specifier.startsWith('cordis:')) return super.import(specifier, getOuterStack)
      if (!modules.has(specifier)) throw new Error(`Unexpected fixture module ${specifier}`)
      return modules.get(specifier)
    }
  }
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  const events: SessionEvent[] = []
  ctx.on('session/event', (_session, event) => { events.push(event) })
  const handle = await ctx.agents.create({ sessionId: SessionId('person'), meta: { cwd: root }, agentOptions: { provider: 'fixture', model: 'fixture' } })
  await handle.agent.whenIdle()
  const consentFiber = [...ctx.loader.entries()].find(entry => entry.options.id === 'consent')!.fiber
  return { ctx, agent: handle.agent, asked, events, errors, consentFiber }
}

/**
 * Model-visible content of each tool result, in order.
 * @param events - Session events captured by {@link bootComposition}.
 * @returns each `tool/result` message's content.
 */
export function toolResults(events: readonly SessionEvent[]) {
  return events.flatMap(event => event.type === 'tool/result' ? [event.data.message.content] : [])
}

/**
 * Data of each `browser-consent/write` audit record, in order.
 * @param events - Session events captured by {@link bootComposition}.
 * @returns the records' payloads.
 */
export function consentRecords(events: readonly SessionEvent[]) {
  return events.flatMap(event => event.type === 'browser-consent/write' ? [event.data] : [])
}
