/**
 * Reads free, writes ask, denied pages never: consent for the assistant's actions in a person's own signed-in Chromium
 * and on their desktop. The plugin mounts the Playwright MCP browser provider itself, so the browser tools exist only
 * while consent is loaded and valid.
 * @module @mumbo/browser-consent
 */

import { rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-browser-use'
import * as PlaywrightBrowser from '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp'
import type { McpResult } from '@deepseek-ai/dsh-mcp-client'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ToolExecution, ToolExecutionResult, PreToolDecision } from '@deepseek-ai/dsh-tools'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type {} from '@deepseek-ai/dsh-working-directory'
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
/** Upstream tool that returns the current page's accessibility snapshot. */
const SNAPSHOT = 'browser_snapshot'
/** A snapshot line whose field shows the patched snapshot's fixed mask in place of its value. */
const MASKED_FIELD = new RegExp(`: ${String.fromCharCode(0x2022).repeat(4)}$`, 'mu')
/** Characters shown of one argument key or value in an approval prompt; the rest is counted as not shown. */
const VALUE_LIMIT = 300
/** Characters of arguments listed in an approval prompt; further arguments are counted as not shown. */
const SUMMARY_LIMIT = 1200
/** Upstream tool that shows one request's headers and bodies, which carry cookies and submitted passwords; always refused. */
const REQUEST_DETAILS = 'browser_network_request'
/** Upstream tool that ends Playwright's browser connection and answers with fixed text. */
const CLOSE = 'browser_close'
/** Desktop tool of the `computer-use-x11` provider, whose `screenshot` action is its only read. */
const COMPUTER = 'computer'
/** Schemes whose URL wraps another URL that Chromium loads or shows. */
const WRAPPER_SCHEMES: ReadonlySet<string> = new Set(['view-source:', 'blob:', 'filesystem:'])
/** Line Playwright MCP writes into a result for the page the result describes. */
const PAGE_URL_LINE = /^- Page URL: (.*)$/gmu
/**
 * Lines through which Playwright MCP links a file it wrote for a result: snapshots, screenshots, console entries,
 * downloads. The link title can hold model-written text, so a link is read from the line's last `](`.
 */
const FILE_LINES = [
  /^- \[.*\]\(([^()\n]+)\)$/gmu, /^- New console entries: (.+?)(?:#L\d+)?$/gmu, /^- Downloaded file .* to "([^"\n]+)"$/gmu,
]
/** Name of the directory where Playwright MCP writes the files it links when no `outputDir` is configured. */
const OUTPUT_DIRECTORY = '.playwright-mcp'
/** {@link denial} phrase for a URL that does not parse or a tab whose URL cannot be read. */
const UNREADABLE = 'a page whose address cannot be read'

/** Upstream tools that only read the page or browser state, plus history navigation. */
const READS: ReadonlySet<string> = new Set([
  'browser_snapshot', 'browser_take_screenshot', 'browser_find', 'browser_console_messages', 'browser_network_requests',
  'browser_wait_for', 'browser_navigate_back', 'browser_navigate_forward',
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
  /**
   * Pages the browser tools never open or read: lowercase schemes with their colon (`chrome:`) and `http:` or `https:`
   * origins (`https://accounts.google.com`). Required, so each deployment states its list; `[]` denies nothing.
   */
  readonly deniedUrls: string[]
  /** Origins (`https://host[:port]`) where site writes proceed without asking. */
  readonly allowedSites: string[]
  /** Milliseconds a write waits for the person's answer before it is denied as unanswered. */
  readonly approvalTimeoutMs: number
}

/** Consent configuration as written: provider settings in their input form, the denied URLs, the other fields defaulted. */
export type ConfigInput = Partial<Omit<Config, 'browser' | 'deniedUrls'>> & Pick<Config, 'deniedUrls'>
  & { readonly browser: NonNullable<Parameters<typeof PlaywrightBrowser.Config>[0]> }

export const Config: z<ConfigInput, Config> = z.object({
  browser: PlaywrightBrowser.Config.required(),
  deniedUrls: z.array(z.string()).required(),
  allowedSites: z.array(z.string()).default([]),
  approvalTimeoutMs: z.natural().min(1).default(300_000),
})

/** A validated `deniedUrls` list. */
export interface DenyList {
  /** Denied schemes, lowercase with their colon. */
  readonly schemes: ReadonlySet<string>
  /** Denied origins as written, keyed by {@link hostKey}. */
  readonly origins: ReadonlyMap<string, string>
}

/**
 * Validate `deniedUrls` entries. A scheme entry is lowercase with its colon; an origin entry is an `http:` or `https:`
 * origin as {@link canonicalOrigin} writes it.
 * @param entries - the configured entries.
 * @returns the deny list.
 * @throws naming the first entry that is neither, and the form to use when the entry has one.
 */
export function denyList(entries: readonly string[]): DenyList {
  const schemes = new Set<string>()
  const origins = new Map<string, string>()
  for (const entry of entries) {
    if (/^[a-z][a-z\d+.-]*:$/iu.test(entry)) {
      if (entry !== entry.toLowerCase()) throw new Error(`${name}: deniedUrls entry "${entry}" is not lowercase; use "${entry.toLowerCase()}"`)
      schemes.add(entry)
      continue
    }
    const parsed = URL.parse(entry)
    const origin = parsed === null ? undefined : canonicalOrigin(parsed)
    if (parsed === null || origin !== entry) {
      throw new Error(`${name}: deniedUrls entry "${entry}" is neither a scheme nor an origin; ${origin === undefined ? 'use one such as chrome: or https://accounts.google.com' : `use "${origin}"`}`)
    }
    origins.set(hostKey(parsed), entry)
  }
  return { schemes, origins }
}

/**
 * Say what denies a URL. The URL is parsed as WHATWG URLs are, which lowercases the scheme and host, converts an IDN
 * host to punycode, decodes percent-encoded host characters, drops userinfo and the default port, and strips
 * surrounding spaces, tabs, and newlines; trailing dots of the host are then ignored. An `about:` URL other than
 * `about:blank` counts as a `chrome:` URL, because Chromium serves `about:<page>` as `chrome://<page>`. A
 * `view-source:`, `blob:`, or `filesystem:` URL is denied by its own scheme or by the URL it wraps. An origin entry
 * covers its host and port under both `http:` and `https:`.
 * @param url - the URL as Chromium reports it or a call names it, or `undefined` when it could not be read.
 * @param denied - the validated deny list.
 * @returns `a <scheme> page`, `a page on <origin>`, or {@link UNREADABLE} for a URL that is absent or does not parse;
 *   `undefined` when nothing denies the URL.
 */
export function denial(url: string | undefined, denied: DenyList): string | undefined {
  const parsed = url === undefined ? null : URL.parse(url)
  if (parsed === null) return UNREADABLE
  const scheme = parsed.protocol === 'about:' && parsed.pathname.toLowerCase() !== 'blank' ? 'chrome:' : parsed.protocol
  if (denied.schemes.has(scheme)) return `a ${scheme} page`
  if (WRAPPER_SCHEMES.has(scheme)) return denial(parsed.href.slice(scheme.length), denied)
  const origin = scheme === 'http:' || scheme === 'https:' ? denied.origins.get(hostKey(parsed)) : undefined
  return origin === undefined ? undefined : `a page on ${origin}`
}

/** The host of a parsed URL without trailing dots. */
function bareHost(url: URL): string {
  return url.hostname.replace(/\.+$/u, '')
}

/** Host and port of a parsed URL with trailing host dots removed; the port is empty when it is the scheme's default. */
function hostKey(url: URL): string {
  return `${bareHost(url)}:${url.port}`
}

/** The origin of an `http:` or `https:` URL with trailing host dots removed. */
function canonicalOrigin(url: URL): string | undefined {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  return `${url.protocol}//${bareHost(url)}${url.port === '' ? '' : `:${url.port}`}`
}

/**
 * The URL a call's `url` argument opens, read as Playwright MCP reads it: a string that does not parse as a URL gets
 * `http://` in front when it starts with `localhost` and `https://` otherwise.
 * @param args - the call's parsed arguments.
 * @returns the URL, or `undefined` when the call has no string `url` argument.
 */
export function targetUrl(args: unknown): string | undefined {
  const { url } = fieldsOf(args)
  if (typeof url !== 'string') return undefined
  return URL.canParse(url) ? url : `${url.startsWith('localhost') ? 'http' : 'https'}://${url}`
}

/**
 * Say what denies a page that a result reports through Playwright MCP's `- Page URL:` lines.
 * @param result - the call's result.
 * @param denied - the validated deny list.
 * @returns the {@link denial} of the first denied reported URL, or `undefined` when none is denied.
 */
function reportedDenial(result: ToolExecutionResult, denied: DenyList): string | undefined {
  for (const block of result.content) {
    if (block.type !== 'text') continue
    for (const [, url] of block.text.matchAll(PAGE_URL_LINE)) {
      const blocked = denial(url, denied)
      if (blocked !== undefined) return blocked
    }
  }
  return undefined
}

/** The Agent that makes a tool call. */
type Agent = NonNullable<ToolExecution['agent']>

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
 * Read the current tab's URL from a `browser_tabs` listing (`- 0: (current) [title](url)`). Page titles are not
 * escaped upstream, so a current-tab line holding `](` more than once is ambiguous and yields no URL.
 * @param text - the listing's text content.
 * @returns the URL, or `undefined` when none can be read without ambiguity.
 */
export function currentTabUrl(text: string): string | undefined {
  const [line, ...others] = text.split('\n').filter(candidate => /^- \d+: \(current\) \[/u.test(candidate))
  if (line === undefined || others.length > 0) return undefined
  const [, url, ...rest] = line.replace(/ \[crashed\]$/u, '').split('](')
  if (url === undefined || rest.length > 0 || !url.endsWith(')')) return undefined
  return url.slice(0, -1)
}

/**
 * Summarize a call's arguments for the person deciding it. Only keys the tool's input schema declares are listed, since
 * the model may add others that the tool ignores; those are counted, never shown. Each key and value is JSON with
 * invisible format characters percent-encoded and is cut at {@link VALUE_LIMIT} characters; entries that would pass
 * {@link SUMMARY_LIMIT} are counted instead of shown. `element` is returned apart because the model writes it.
 * @param args - the call's parsed arguments.
 * @param declared - the argument names the tool's input schema declares.
 * @returns the `"key": value` summary with counts of what it leaves out, and the model's element description.
 */
export function describeArguments(args: unknown, declared: ReadonlySet<string>): { summary: string; element: string | undefined } {
  if (typeof args !== 'object' || args === null) return { summary: 'not shown, because they are not a JSON object', element: undefined }
  const fields = args as Record<string, unknown>
  const keys = Object.keys(fields)
  const entries = keys.filter(key => key !== 'element' && declared.has(key)).map(key => `${shown(key)}: ${shown(fields[key])}`)
  const listed: string[] = []
  let length = 0
  for (const entry of entries) {
    if (length + entry.length > SUMMARY_LIMIT) break
    listed.push(entry)
    length += entry.length + 2
  }
  const hidden = entries.length - listed.length
  if (hidden > 0) listed.push(`… ${count(hidden, 'more argument')} not shown`)
  const undeclared = keys.filter(key => !declared.has(key)).length
  if (undeclared > 0) listed.push(`${count(undeclared, 'undeclared argument')} not shown`)
  const element = declared.has('element') && fields.element !== undefined ? shown(fields.element) : undefined
  return { summary: listed.length === 0 ? 'none' : listed.join(', '), element }
}

/** `n` followed by `noun`, pluralized with `s` unless `n` is 1. */
function count(n: number, noun: string): string {
  return `${String(n)} ${noun}${n === 1 ? '' : 's'}`
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

/**
 * Delete the files Playwright MCP wrote for a withheld result, so the model cannot read them with other tools. With an
 * `outputDir`, each link's file name is deleted from that directory, where the server writes every linked file, so a
 * Session directory change after the server started does not matter. Otherwise only links that resolve to a file
 * directly inside a directory named `.playwright-mcp` are followed. A failed deletion is logged; the result stays
 * withheld.
 * @param ctx - plugin context carrying the logger.
 * @param cwd - the Session's working directory, which is the server's and the base of its relative links.
 * @param outputDir - the configured absolute output directory, if any.
 * @param result - the withheld result.
 */
async function removeLinkedFiles(ctx: Context, cwd: string, outputDir: string | undefined, result: ToolExecutionResult): Promise<void> {
  const text = result.content.map(block => block.type === 'text' ? block.text : '').join('\n')
  const links = FILE_LINES.flatMap(pattern => Array.from(text.matchAll(pattern), match => match[1] ?? ''))
  const files = outputDir === undefined
    ? links.map(link => resolve(cwd, link)).filter(file => basename(dirname(file)) === OUTPUT_DIRECTORY)
    : links.map(link => basename(link)).filter(file => !['', '.', '..'].includes(file)).map(file => join(outputDir, file))
  await Promise.all(files.map(async (file) => {
    try {
      await rm(file, { force: true })
    } catch (error: unknown) {
      ctx.logger.error(`${name}: could not delete ${file}, which Playwright wrote for a withheld result: ${String(error)}`)
    }
  }))
}

/** The fields of a call's parsed arguments, which a malformed call may give as a non-object. */
function fieldsOf(args: unknown): Record<string, unknown> {
  return typeof args === 'object' && args !== null ? args as Record<string, unknown> : {}
}

/** MCP tool bodies neither defer context nor conclude turns. */
/* v8 ignore next */
const INERT_RUN = { deferContext() {}, concludeTurn() {} }

/**
 * Run one upstream read for this plugin's own decision through the same Session's tool, outside the tool pipeline, so
 * its result never reaches the model. Native execution runs MCP tools one at a time, so no other call of this Session's
 * browser is in flight.
 * @returns the result's text, or `undefined` when the tool is absent or fails.
 */
async function readBrowser(ctx: Context, exec: ToolExecution, tool: string, args: Record<string, unknown>): Promise<string | undefined> {
  const definition = ctx.tools.get(PREFIX + tool, exec.agent)
  if (definition === undefined) return undefined
  try {
    const result = await definition.execute(args, { ...exec, ...INERT_RUN, name: PREFIX + tool, arguments: args }) as McpResult
    return result.content.map(block => (block as { text?: unknown }).text).filter(text => typeof text === 'string').join('\n')
  } catch (error: unknown) {
    // A failed read leaves the answer unknown, which every caller treats as the stricter outcome.
    ctx.logger.debug(`${tool} for consent failed: ${String(error)}`)
    return undefined
  }
}

/**
 * Ask Playwright which tab the next action runs on, or the last one ran on, through its `browser_tabs` listing.
 * @returns the current tab's URL, or `undefined` when the listing is absent, fails, or is ambiguous.
 */
async function currentTab(ctx: Context, exec: ToolExecution): Promise<string | undefined> {
  const listing = await readBrowser(ctx, exec, TABS, { action: 'list' })
  return listing === undefined ? undefined : currentTabUrl(listing)
}

/**
 * Read the current page's snapshot for a field the patched Playwright snapshot shows masked: a password,
 * one-time-code, payment-card, or autofilled input. The mask in the snapshot is the single source of that rule.
 * @returns whether a field shows the mask, or `undefined` when the snapshot cannot be read.
 */
async function showsMaskedField(ctx: Context, exec: ToolExecution): Promise<boolean | undefined> {
  const snapshot = await readBrowser(ctx, exec, SNAPSHOT, {})
  return snapshot === undefined ? undefined : MASKED_FIELD.test(snapshot)
}

/**
 * Tool-name prefix of each browser provider whose tools can be told apart, keyed by its `browserUse` registration name.
 * MCP providers name their tools `mcp__<server>__`; the Stagehand provider names them `stagehand_<method>`.
 */
const PROVIDER_TOOL_PREFIXES: Readonly<Record<string, string>> = {
  'playwright-mcp': PREFIX,
  'chrome-devtools-mcp': 'mcp__chrome-devtools-mcp__',
  'stagehand-native': 'stagehand_',
}

/**
 * Log that a provider other than this plugin's child holds `browserUse`, saying truthfully whether its tools are refused.
 * @param ctx - plugin context carrying the logger.
 * @param holder - the registered provider's name.
 */
function reportRival(ctx: Context, holder: string): void {
  const prefix = PROVIDER_TOOL_PREFIXES[holder]
  ctx.logger.error(`browser provider "${holder}" holds browserUse without ${name}, so ${prefix === undefined ? 'its tools are not under consent' : `its tools (${prefix}*) are refused`}; remove the row that mounts it and mount the browser only through ${name}`)
}

export function apply(ctx: Context, config: Config): void {
  const denied = denyList(config.deniedUrls)
  for (const site of config.allowedSites) {
    const origin = webOrigin(site)
    if (origin !== site) {
      throw new Error(`${name}: allowedSites entry "${site}" is not an origin${origin === undefined ? '; use one such as https://mail.google.com' : `; use "${origin}"`}`)
    }
    if (denial(site, denied) !== undefined) throw new Error(`${name}: allowedSites entry "${site}" is also denied by deniedUrls`)
  }
  PlaywrightBrowser.validateConfig(config.browser)
  const holder = ctx.browserUse.providerName
  if (holder !== undefined && PROVIDER_TOOL_PREFIXES[holder] === undefined) {
    throw new Error(`${name}: browser provider "${holder}" holds browserUse and its tools have no prefix this plugin can refuse; remove the row that mounts it`)
  }
  if (holder !== undefined) reportRival(ctx, holder)
  const allowed = new Set(config.allowedSites)
  const consents = new WeakMap<ToolExecution, Consent>()
  const computerConsents = new WeakSet<ToolExecution>()
  let owned = false
  /** A refusal for a call to the tools of a provider that holds `browserUse` in place of this plugin's child. */
  const rivalRefusal = (exec: ToolExecution): string | undefined => {
    const current = ctx.browserUse.providerName
    const prefix = current === undefined || owned ? undefined : PROVIDER_TOOL_PREFIXES[current]
    return prefix !== undefined && exec.name.startsWith(prefix)
      ? `${exec.name} did not run: browser tools are disabled because this browser was set up without consent checks.`
      : undefined
  }
  const toolOf = (exec: ToolExecution): string | undefined => exec.name.startsWith(PREFIX) ? exec.name.slice(PREFIX.length) : undefined
  /**
   * A refusal for a browser call that reads request details, saves its output to a file the call names, which would
   * outlive a withheld result and could overwrite workspace files, or whose `url` argument names a denied page.
   */
  const callRefusal = (exec: ToolExecution): string | undefined => {
    const tool = toolOf(exec)
    if (tool === REQUEST_DETAILS) return `${tool} did not run: the assistant may not read request headers or bodies, which carry cookies and passwords.`
    if (tool !== undefined && fieldsOf(exec.arguments).filename !== undefined) {
      return `${tool} did not run: the assistant may not save browser output to a file; call it without filename to get the result directly.`
    }
    const target = tool === undefined ? undefined : targetUrl(exec.arguments)
    const blocked = target === undefined ? undefined : denial(target, denied)
    return blocked === undefined ? undefined : `${tool} did not run: the assistant may not open ${blocked}.`
  }
  const isScreenshot = (args: unknown): boolean => fieldsOf(args).action === 'screenshot'
  /** The arguments of a call as its tool's input schema declares them, for an approval prompt. */
  const argumentsOf = (exec: ToolExecution, agent: Agent) => {
    const properties = ctx.tools.get(exec.name, agent)?.parameters.properties
    return describeArguments(exec.arguments, new Set(typeof properties === 'object' && properties !== null ? Object.keys(properties) : []))
  }
  /**
   * Ask the person to approve one call. `subject` names the call in each denial reason, such as
   * `browser_click on https://example.com` or `computer input`.
   */
  const ask = async (exec: ToolExecution, agent: Agent, subject: string, reason: string): Promise<PreToolDecision | 'allowed'> => {
    const unavailable: PreToolDecision = { kind: 'deny', reason: `${subject} needs the user's approval, and no approval channel is available.` }
    const approval = ctx.get('approval')
    if (approval === undefined) return unavailable
    const timeout = AbortSignal.timeout(config.approvalTimeoutMs)
    const outcome: ApprovalOutcome = await approval.request({
      agent, toolName: exec.name, callId: exec.callId, reason, displayReason: { en: reason },
      signal: AbortSignal.any([exec.signal, timeout]),
    })
    switch (outcome) {
      case 'allowed-once':
        return 'allowed'
      case 'rejected':
        return (approval.overrideOf(agent.session) ?? approval.config.policy) === 'never'
          ? { kind: 'deny', reason: `Approval prompts are disabled in this session, so ${subject} did not run.` }
          : { kind: 'deny', reason: `The user declined ${subject}.` }
      case 'cancelled':
        return timeout.aborted && !exec.signal.aborted
          ? { kind: 'deny', reason: `${subject} got no answer from the user within ${String(config.approvalTimeoutMs / 1000)} seconds.` }
          : { kind: 'cancel' }
      case 'unavailable':
        return unavailable
      /* v8 ignore next -- closed-union exhaustiveness guard */
      default:
        return assertNever(outcome, 'ApprovalOutcome')
    }
  }

  ctx.tools.guard((exec) => {
    const refusal = rivalRefusal(exec) ?? callRefusal(exec)
    if (refusal !== undefined) return refusal
    if (exec.name === COMPUTER) {
      return isScreenshot(exec.arguments) || computerConsents.has(exec) ? undefined : 'computer input needs the user\'s consent, which was not given.'
    }
    const tool = toolOf(exec)
    if (tool === undefined || consents.has(exec) || classify(tool, exec.arguments) === 'read') return undefined
    return `${tool} needs the user's consent, which was not given.`
  })

  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const refusal = rivalRefusal(exec) ?? callRefusal(exec)
    if (refusal !== undefined) return { kind: 'deny', reason: refusal }
    const agent = exec.agent
    if (agent === undefined) return next()
    if (exec.name === COMPUTER) {
      if (isScreenshot(exec.arguments)) return next()
      const decision = await ask(exec, agent, 'computer input', `Computer input on the desktop. Arguments: ${argumentsOf(exec, agent).summary}.`)
      if (decision !== 'allowed') return decision
      computerConsents.add(exec)
      return next()
    }
    const tool = toolOf(exec)
    if (tool === undefined) return next()
    const kind = classify(tool, exec.arguments)
    if (kind === 'read') return next()
    const url = await currentTab(ctx, exec)
    const blocked = denial(url, denied)
    if (blocked !== undefined) return { kind: 'deny', reason: `${tool} did not run: the current tab is ${blocked}, which the assistant may not use.` }
    const site = webOrigin(url)
    const grant = (granted: BrowserWriteGrant): Promise<PreToolDecision> => {
      consents.set(exec, { session: agent.session, tool, site, grant: granted })
      return next()
    }
    // An allowance never covers a page that shows a password or payment field, nor one that cannot be checked.
    let uncovered = kind === 'always-ask' ? ' Site allowances do not cover this action.' : ''
    if (kind === 'site-write' && site !== undefined && allowed.has(site)) {
      const masked = await showsMaskedField(ctx, exec)
      if (masked === false) return grant('site')
      uncovered = masked === true
        ? ' The page shows a password or payment field, so its site allowance does not cover this action.'
        : ' The page could not be checked for password or payment fields, so its site allowance does not cover this action.'
    }
    const where = site ?? 'an unidentified page'
    const { summary, element } = argumentsOf(exec, agent)
    const reason = `Browser write: ${tool} on ${where}. Arguments: ${summary}.`
      + (element === undefined ? '' : ` Model-written target description: ${element}.`) + uncovered
    const decision = await ask(exec, agent, `${tool} on ${where}`, reason)
    return decision === 'allowed' ? grant('approval') : decision
  }, { prepend: true })

  // Around dispatch, so wrappers outside it, post-execute policy, and result observers see only the replacement.
  ctx.on('tools/execute', async (exec, next) => {
    const tool = toolOf(exec)
    const result = await next()
    // Listing tabs after `browser_close` would reconnect and open a tab; its result is fixed text.
    if (tool === undefined || tool === CLOSE) return result
    const blocked = reportedDenial(result, denied) ?? denial(await currentTab(ctx, exec), denied)
    if (blocked === undefined) return result
    const reason = `${tool} ran, but its result is withheld: the current tab is ${blocked}, which the assistant may not use. Open another page to continue.`
    const agent = exec.agent
    if (agent !== undefined) await removeLinkedFiles(ctx, ctx.workingDirectory.get(agent.session), config.browser.outputDir, result)
    return { isError: true, content: [{ type: 'text', text: `Error: ${reason}` }], error: { message: reason } }
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

  if (holder !== undefined) return
  // The provider depends on this plugin's service, so it unloads before the guard and listeners go.
  ctx.provide(GATE, {})
  const { name: providerName, Config: ProviderConfig, apply: applyProvider } = PlaywrightBrowser
  const applyOwned = (child: Context, browser: PlaywrightBrowser.Config): void => {
    // Another provider may take browserUse between this plugin's load and its child's start.
    const current = ctx.browserUse.providerName
    if (current !== undefined) {
      reportRival(ctx, current)
      throw new Error(`${name}: browser provider "${current}" took browserUse before this plugin's browser started`)
    }
    applyProvider(child, browser)
    child.effect(() => {
      owned = true
      return () => { owned = false }
    })
  }
  ctx.plugin({ name: providerName, inject: [...inject, GATE], Config: ProviderConfig, apply: applyOwned }, config.browser)
}
