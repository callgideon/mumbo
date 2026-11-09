/**
 * Reads free, writes ask: consent for the assistant's actions in a person's own signed-in Chromium. The plugin mounts
 * the Playwright MCP browser provider itself, so the browser tools exist only while consent is loaded and valid.
 * @module @mumbo/browser-consent
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-browser-use'
import * as PlaywrightBrowser from '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp'
import { validateBrowserMcpConfig } from '@deepseek-ai/dsh-experimental-browser-use-runtime/mcp'
import type { McpResult } from '@deepseek-ai/dsh-mcp-client'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ToolExecution, PreToolDecision } from '@deepseek-ai/dsh-tools'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import z from '@deepseek-ai/schemastery'
import type { BrowserWriteGrant } from './types.ts'

export type * from './types.ts'

/** Cordis function-plugin name. */
export const name = 'mumbo-browser-consent'
/** The mounted provider's services; the approval service is read per call, so a missing one denies writes. */
export const inject = ['browserUse', 'agents', 'tools', 'systemPrompt', 'workingDirectory']

/** Public tool-name prefix of `dsh-experimental-browser-use-playwright-mcp`, whose MCP server name is fixed. */
const PREFIX = 'mcp__playwright-mcp__'
/** Service this plugin provides and the mounted provider requires, so the provider runs only inside the gate. */
const GATE = 'mumbo-browser-consent'
/** Upstream tool whose `list` action reports Playwright's current tab. */
const TABS = 'browser_tabs'
/** Characters shown of one argument key or value in an approval prompt; the rest is counted as not shown. */
const VALUE_LIMIT = 300
/** Characters of arguments listed in an approval prompt; further arguments are counted as not shown. */
const SUMMARY_LIMIT = 1200

/** Upstream tools that only read the page or browser state, plus history navigation. */
const READS: ReadonlySet<string> = new Set([
  'browser_snapshot', 'browser_take_screenshot', 'browser_find', 'browser_console_messages', 'browser_network_requests',
  'browser_network_request', 'browser_wait_for', 'browser_navigate_back', 'browser_navigate_forward',
])
/** Upstream tools that act only on Playwright's current tab, so a site allowance can cover them. */
const SITE_WRITES: ReadonlySet<string> = new Set([
  'browser_click', 'browser_type', 'browser_fill_form', 'browser_press_key', 'browser_press_sequentially', 'browser_keydown',
  'browser_keyup', 'browser_select_option', 'browser_check', 'browser_uncheck', 'browser_hover', 'browser_drag',
  'browser_handle_dialog', 'browser_resize', 'browser_reload', 'browser_close',
])

/**
 * How consent treats one browser call. `site-write` acts on the current tab; `always-ask` runs code, sends local files,
 * leaves the web, closes a tab by index, or is a tool this list does not know, so only a user approval allows it.
 */
export type BrowserActionKind = 'read' | 'site-write' | 'always-ask'

/** Consent configuration. */
export interface Config {
  /** Playwright MCP provider settings; the plugin mounts the provider with them. */
  readonly browser: PlaywrightBrowser.Config
  /** Origins (`https://host[:port]`) where site writes proceed without asking. */
  readonly allowedSites: string[]
  /** Milliseconds a write waits for the person's answer before it is denied as unanswered. */
  readonly approvalTimeoutMs: number
}

/** Consent configuration as written: provider settings in their input form, the other fields defaulted. */
export type ConfigInput = Partial<Omit<Config, 'browser'>> & { readonly browser: NonNullable<Parameters<typeof PlaywrightBrowser.Config>[0]> }

export const Config: z<ConfigInput, Config> = z.object({
  browser: PlaywrightBrowser.Config.required(),
  allowedSites: z.array(z.string()).default([]),
  approvalTimeoutMs: z.natural().min(1).default(300_000),
})

/** One write's consent, kept from its decision to its final result. */
interface Consent {
  readonly session: Session
  readonly tool: string
  readonly site: string | undefined
  readonly grant: BrowserWriteGrant
}

/**
 * Classify one Playwright MCP call. Navigation counts as a read only to an `http:` or `https:` URL.
 * @param tool - upstream tool name, without the MCP prefix.
 * @param args - the call's parsed arguments.
 * @returns how consent treats the call.
 */
export function classify(tool: string, args: unknown): BrowserActionKind {
  if (READS.has(tool)) return 'read'
  if (SITE_WRITES.has(tool)) return 'site-write'
  const { url, action, paths } = fieldsOf(args)
  if (tool === 'browser_navigate') return webOrigin(url) === undefined ? 'always-ask' : 'read'
  if (tool === TABS && (action === 'list' || action === 'select')) return 'read'
  if (tool === TABS && action === 'new') return url === undefined || webOrigin(url) !== undefined ? 'read' : 'always-ask'
  if (tool === 'browser_drop') return Array.isArray(paths) && paths.length > 0 ? 'always-ask' : 'site-write'
  return 'always-ask'
}

/**
 * Read the current tab's origin from a `browser_tabs` listing (`- 0: (current) [title](url)`). Page titles are not
 * escaped upstream, so a current-tab line holding `](` more than once is ambiguous and yields no origin.
 * @param text - the listing's text content.
 * @returns the `http:` or `https:` origin, or `undefined` when none can be read without ambiguity.
 */
export function currentTabOrigin(text: string): string | undefined {
  const [line, ...others] = text.split('\n').filter(candidate => /^- \d+: \(current\) \[/u.test(candidate))
  if (line === undefined || others.length > 0) return undefined
  const [, url, ...rest] = line.replace(/ \[crashed\]$/u, '').split('](')
  if (url === undefined || rest.length > 0 || !url.endsWith(')')) return undefined
  return webOrigin(url.slice(0, -1))
}

/**
 * Summarize a call's arguments for the person deciding it. Only keys the tool's input schema declares are listed, since
 * the model may add others that the tool ignores. Each key and value is JSON with invisible format characters
 * percent-encoded and is cut at {@link VALUE_LIMIT} characters; entries that would pass {@link SUMMARY_LIMIT} are counted
 * instead of shown. `element` is returned apart because the model writes it.
 * @param args - the call's parsed arguments.
 * @param declared - the argument names the tool's input schema declares.
 * @returns the `"key": value` summary, `none` without declared arguments, and the model's element description.
 */
export function describeArguments(args: unknown, declared: ReadonlySet<string>): { summary: string; element: string | undefined } {
  const fields = fieldsOf(args)
  const entries = Object.entries(fields).filter(([key]) => key !== 'element' && declared.has(key)).map(([key, value]) => `${shown(key)}: ${shown(value)}`)
  const listed: string[] = []
  let length = 0
  for (const entry of entries) {
    if (length + entry.length > SUMMARY_LIMIT) break
    listed.push(entry)
    length += entry.length + 2
  }
  const hidden = entries.length - listed.length
  if (hidden > 0) listed.push(`… ${String(hidden)} more ${hidden === 1 ? 'argument' : 'arguments'} not shown`)
  const element = declared.has('element') && fields.element !== undefined ? shown(fields.element) : undefined
  return { summary: listed.length === 0 ? 'none' : listed.join(', '), element }
}

/** One JSON value cut at {@link VALUE_LIMIT} characters, with invisible format and separator characters percent-encoded. */
function shown(value: unknown): string {
  const characters = Array.from(JSON.stringify(value).replace(/[\p{Cf}\p{Zl}\p{Zp}]/gu, char => encodeURIComponent(char)))
  if (characters.length <= VALUE_LIMIT) return characters.join('')
  return `${characters.slice(0, VALUE_LIMIT).join('')}… (${String(characters.length - VALUE_LIMIT)} more characters not shown)`
}

/** The origin of an `http:` or `https:` URL string. */
function webOrigin(url: unknown): string | undefined {
  const parsed = typeof url === 'string' ? URL.parse(url) : null
  return parsed !== null && (parsed.protocol === 'http:' || parsed.protocol === 'https:') ? parsed.origin : undefined
}

/** The fields of a call's parsed arguments, which a malformed call may give as a non-object. */
function fieldsOf(args: unknown): Record<string, unknown> {
  return typeof args === 'object' && args !== null ? args as Record<string, unknown> : {}
}

/** MCP tool bodies neither defer context nor conclude turns. */
/* v8 ignore next */
const INERT_RUN = { deferContext() {}, concludeTurn() {} }

/**
 * Ask Playwright which tab the next action runs on, through the same Session's `browser_tabs` tool.
 * Native execution runs MCP tools one at a time, so no other call of this Session's browser is in flight.
 * @returns the current tab's origin, or `undefined` when the tool is absent, fails, or lists ambiguously.
 */
async function currentSite(ctx: Context, exec: ToolExecution): Promise<string | undefined> {
  const tabs = ctx.tools.get(PREFIX + TABS, exec.agent)
  if (tabs === undefined) return undefined
  const args = { action: 'list' }
  try {
    const listing = await tabs.execute(args, { ...exec, ...INERT_RUN, name: PREFIX + TABS, arguments: args }) as McpResult
    return currentTabOrigin(listing.content.map(block => (block as { text?: unknown }).text).filter(text => typeof text === 'string').join('\n'))
  } catch (error: unknown) {
    // A failed listing leaves the site unknown, so the caller asks the user instead.
    ctx.logger.debug(`current tab listing failed: ${String(error)}`)
    return undefined
  }
}

/**
 * Refuse every call to the tools of a browser provider that holds `browserUse` without this plugin, and the Playwright
 * MCP namespace, so a provider row loaded ahead of consent cannot drive the person's browser ungated.
 * @param ctx - plugin context carrying the tool registry.
 * @param holder - the registered provider's name, which is also its MCP tool namespace.
 */
function refuseRival(ctx: Context, holder: string): void {
  ctx.logger.error(`browser provider "${holder}" already holds browserUse, so its browser tools are refused; remove the row that mounts it and mount the browser only through ${name}`)
  const prefixes = [PREFIX, `mcp__${holder}__`]
  const refusal = (exec: ToolExecution): string | undefined => prefixes.some(prefix => exec.name.startsWith(prefix))
    ? `${exec.name} did not run: browser tools are disabled because this browser was set up without consent checks.`
    : undefined
  ctx.tools.guard(refusal)
  ctx.on('tools/pre-execute', (exec, next): Promise<PreToolDecision> => {
    const reason = refusal(exec)
    return reason === undefined ? next() : Promise.resolve({ kind: 'deny', reason })
  }, { prepend: true })
}

/**
 * Gate Playwright MCP browser writes, then mount the provider. Reads pass; a site write on an allowed origin proceeds
 * without asking; every other write asks the approval service once and is denied when unanswered for
 * `approvalTimeoutMs`. A guard denies any write that reaches dispatch without a consent this plugin recorded, so no
 * other `tools/pre-execute` listener can allow it, and an Agent-less write has no one to ask. The provider is a child of
 * this plugin that requires its service: it starts once the gate is active, finishes unloading before the gate goes, and
 * invalid configuration mounts no browser at all.
 * Each allowed write appends `browser-consent/write` to its Session when its result is final.
 * When another provider already holds `browserUse`, the plugin mounts nothing and refuses that provider's tools instead.
 * @param ctx - plugin context carrying the provider's services.
 * @param config - validated configuration.
 * @throws when an allowed site is not an exact `http:` or `https:` origin, or the browser endpoint is not a valid URL.
 */
export function apply(ctx: Context, config: Config): void {
  for (const site of config.allowedSites) {
    const origin = webOrigin(site)
    if (origin !== site) {
      throw new Error(`${name}: allowedSites entry "${site}" is not an origin${origin === undefined ? '; use one such as https://mail.google.com' : `; use "${origin}"`}`)
    }
  }
  validateBrowserMcpConfig(config.browser)
  const holder = ctx.browserUse.providerName
  if (holder !== undefined) {
    refuseRival(ctx, holder)
    return
  }
  const allowed = new Set(config.allowedSites)
  const consents = new WeakMap<ToolExecution, Consent>()
  const toolOf = (exec: ToolExecution): string | undefined => exec.name.startsWith(PREFIX) ? exec.name.slice(PREFIX.length) : undefined

  ctx.tools.guard((exec) => {
    const tool = toolOf(exec)
    if (tool === undefined || consents.has(exec) || classify(tool, exec.arguments) === 'read') return undefined
    return `${tool} needs the user's consent, which was not given.`
  })

  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const tool = toolOf(exec)
    const agent = exec.agent
    if (tool === undefined || agent === undefined) return next()
    const kind = classify(tool, exec.arguments)
    if (kind === 'read') return next()
    const site = await currentSite(ctx, exec)
    const grant = (granted: BrowserWriteGrant): Promise<PreToolDecision> => {
      consents.set(exec, { session: agent.session, tool, site, grant: granted })
      return next()
    }
    if (kind === 'site-write' && site !== undefined && allowed.has(site)) return grant('site')
    const where = site ?? 'an unidentified page'
    const properties = ctx.tools.get(exec.name, agent)?.parameters.properties
    const { summary, element } = describeArguments(exec.arguments, new Set(typeof properties === 'object' && properties !== null ? Object.keys(properties) : []))
    const always = kind === 'always-ask'
    const reason = `Browser write: ${tool} on ${where}. Arguments: ${summary}.`
      + (element === undefined ? '' : ` Model-written target description: ${element}.`)
      + (always ? ' Site allowances do not cover this action.' : '')
    const zh = `浏览器写操作：${tool}，页面 ${where}。参数：${summary}。`
      + (element === undefined ? '' : `模型撰写的目标描述：${element}。`)
      + (always ? '站点许可不适用于此操作。' : '')
    const unavailable: PreToolDecision = { kind: 'deny', reason: `${tool} on ${where} needs the user's approval, and no approval channel is available.` }
    const approval = ctx.get('approval')
    if (approval === undefined) return unavailable
    const timeout = AbortSignal.timeout(config.approvalTimeoutMs)
    const outcome: ApprovalOutcome = await approval.request({
      agent, toolName: exec.name, callId: exec.callId, reason, displayReason: { en: reason, zh },
      signal: AbortSignal.any([exec.signal, timeout]),
    })
    switch (outcome) {
      case 'allowed-once':
        return grant('approval')
      case 'rejected':
        return (approval.overrideOf(agent.session) ?? approval.config.policy) === 'never'
          ? { kind: 'deny', reason: `Approval prompts are disabled in this session, so ${tool} on ${where} did not run.` }
          : { kind: 'deny', reason: `The user declined ${tool} on ${where}.` }
      case 'cancelled':
        return timeout.aborted && !exec.signal.aborted
          ? { kind: 'deny', reason: `${tool} on ${where} got no answer from the user within ${String(config.approvalTimeoutMs / 1000)} seconds.` }
          : { kind: 'cancel' }
      case 'unavailable':
        return unavailable
      /* v8 ignore next -- closed-union exhaustiveness guard */
      default:
        return assertNever(outcome, 'ApprovalOutcome')
    }
  }, { prepend: true })

  ctx.on('tools/result', (exec, result) => {
    const consent = consents.get(exec)
    if (consent === undefined) return
    consent.session.append('browser-consent/write', {
      callId: exec.callId,
      tool: consent.tool,
      ...consent.site === undefined ? {} : { site: consent.site },
      grant: consent.grant,
      outcome: result.isError ? 'failed' : 'succeeded',
    })
  })

  // The provider depends on this plugin's service, so it unloads before the guard and listeners go.
  ctx.provide(GATE, {})
  const { name: providerName, Config: ProviderConfig, apply: applyProvider } = PlaywrightBrowser
  ctx.plugin({ name: providerName, inject: [...inject, GATE], Config: ProviderConfig, apply: applyProvider }, config.browser)
}
