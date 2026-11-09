/**
 * Reads free, writes ask: consent for the assistant's actions in a person's own signed-in Chromium,
 * driven through the Playwright MCP browser provider.
 * @module @mumbo/browser-consent
 */

import type { Context } from '@deepseek-ai/cordis'
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
/** The approval service is read per call, so a missing one denies writes instead of leaving them ungated. */
export const inject = ['tools']

/** Public tool-name prefix of `dsh-experimental-browser-use-playwright-mcp`, whose MCP server name is fixed. */
const PREFIX = 'mcp__playwright-mcp__'
/** Upstream tool whose `list` action reports Playwright's current tab. */
const TABS = 'browser_tabs'

/** Upstream tools that only read the page or browser state, plus history navigation. */
const READS: ReadonlySet<string> = new Set([
  'browser_snapshot', 'browser_take_screenshot', 'browser_find', 'browser_console_messages',
  'browser_network_requests', 'browser_network_request', 'browser_wait_for', 'browser_navigate_back',
])
/** Upstream tools that act only on Playwright's current tab, so a site allowance can cover them. */
const SITE_WRITES: ReadonlySet<string> = new Set([
  'browser_click', 'browser_type', 'browser_fill_form', 'browser_press_key', 'browser_select_option', 'browser_hover',
  'browser_drag', 'browser_drop', 'browser_file_upload', 'browser_handle_dialog', 'browser_resize', 'browser_close',
])

/**
 * How consent treats one browser call. `site-write` acts on the current tab; `unbounded` runs code, leaves the web,
 * closes a tab by index, or is a tool this list does not know, so only a user approval allows it.
 */
export type BrowserActionKind = 'read' | 'site-write' | 'unbounded'

/** Consent configuration. */
export interface Config {
  /** Origins (`https://host[:port]`) where site writes proceed without asking. */
  readonly allowedSites: string[]
}

export const Config: z<Config> = z.object({
  allowedSites: z.array(z.string()).default([]),
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
  const { url, action } = fieldsOf(args)
  if (tool === 'browser_navigate') return webOrigin(url) === undefined ? 'unbounded' : 'read'
  if (tool === TABS && (action === 'list' || action === 'select')) return 'read'
  if (tool === TABS && action === 'new') return url === undefined || webOrigin(url) !== undefined ? 'read' : 'unbounded'
  return 'unbounded'
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
 * Gate Playwright MCP browser writes. Reads pass; a site write on an allowed origin proceeds without asking; every
 * other write asks the approval service once. A guard denies any write that reaches dispatch without a consent this
 * plugin recorded, so another `tools/pre-execute` listener cannot allow it, and an Agent-less write has no one to ask.
 * Each allowed write appends `browser-consent/write` to its Session when its result is final.
 * @param ctx - plugin context carrying the tool registry.
 * @param config - validated configuration.
 * @throws when an allowed site is not an exact `http:` or `https:` origin.
 */
export function apply(ctx: Context, config: Config): void {
  for (const site of config.allowedSites) {
    if (webOrigin(site) !== site) throw new Error(`${name}: allowedSites entry "${site}" is not an origin such as https://mail.google.com`)
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
    const { element } = fieldsOf(exec.arguments)
    const target = typeof element === 'string' ? { en: ` (the assistant describes the target as "${element}")`, zh: `（助手描述的目标："${element}"）` } : { en: '', zh: '' }
    const scope = kind === 'unbounded' ? { en: '; this action can reach beyond the current site, so site allowances do not cover it', zh: '；此操作可越出当前站点，站点许可不适用' } : { en: '', zh: '' }
    const reason = `Browser write: ${tool} on ${where}${target.en}${scope.en}`
    const approval = ctx.get('approval')
    const outcome: ApprovalOutcome = approval === undefined ? 'unavailable' : await approval.request({
      agent, toolName: exec.name, callId: exec.callId, reason, signal: exec.signal,
      displayReason: { en: reason, zh: `浏览器写操作：${tool}，页面 ${where}${target.zh}${scope.zh}` },
    })
    switch (outcome) {
      case 'allowed-once':
        return grant('approval')
      case 'rejected':
        return { kind: 'deny', reason: `The user declined ${tool} on ${where}.` }
      case 'cancelled':
        return { kind: 'deny', reason: `The approval request for ${tool} on ${where} was cancelled.` }
      case 'unavailable':
        return { kind: 'deny', reason: `${tool} on ${where} needs the user's approval, and no approval channel is available.` }
      /* v8 ignore next -- closed-union exhaustiveness guard */
      default:
        return assertNever(outcome, 'ApprovalOutcome')
    }
  })

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
}
