/**
 * Reads free, writes ask, denied pages never: consent for the assistant's actions in a person's own signed-in Chromium
 * and on their desktop. The plugin mounts the Playwright MCP browser provider itself, so the browser tools exist only
 * while consent is loaded and valid. While the person has taken the browser over, it refuses every browser and desktop
 * call and keeps no browser connection open.
 * @module @mumbo/browser-consent
 */

import { createHash, randomBytes } from 'node:crypto'
import { constants, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { chmod, mkdir, open, rm } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type {} from '@deepseek-ai/dsh-browser-use'
import * as PlaywrightBrowser from '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { McpResult } from '@deepseek-ai/dsh-mcp-client'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SubprocessChildIdentity } from '@deepseek-ai/dsh-subprocess'
import type { ToolExecution, ToolExecutionResult, ToolExecutionToken, PreToolDecision } from '@deepseek-ai/dsh-tools'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type {} from '@deepseek-ai/dsh-working-directory'
import z from '@deepseek-ai/schemastery'
import type { BrowserHold, BrowserTakeover, BrowserWriteGrant } from './types.ts'

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
/**
 * A queue of asynchronous steps.
 * @returns a function that runs a step once every step queued before it settles, and returns the step's result.
 */
function sequence(): <T>(step: () => Promise<T>) => Promise<T> {
  let tail = Promise.resolve()
  return <T>(step: () => Promise<T>): Promise<T> => {
    const result = tail.then(step)
    tail = result.then(() => {}, () => {})
    return result
  }
}

/** Upstream tools whose output keeps entries from every page a tab has shown since Playwright last cleared it. */
const TAB_LOGS: ReadonlySet<string> = new Set(['browser_console_messages', 'browser_network_requests'])
/** Upstream tool that runs model-written code in the Playwright server process rather than the page; always refused. */
const SERVER_CODE = 'browser_run_code_unsafe'
/** Upstream tool that shows one request's headers and bodies, which carry cookies and submitted passwords; always refused. */
const REQUEST_DETAILS = 'browser_network_request'
/** Upstream tools that send the local files their `paths` argument names to the page. */
const FILE_SENDERS: ReadonlySet<string> = new Set(['browser_file_upload', 'browser_drop'])
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
  /^- \[.*\]\(([^()\n]+)\)$/gmu, /^- New console entries: (.+?)(?:#L\d+(?:-L\d+)?)?$/gmu, /^- Downloaded file .* to "([^"\n]+)"$/gmu,
]
/** How long a staged upload copy is kept at most, in milliseconds: copies older than a day go before the next one is staged. */
const STAGED_LIFETIME_MS = 24 * 60 * 60 * 1000
/** The staged copies kept together, and the files of one call, stay within this many times `uploadMaxBytes`. */
const STAGED_TOTAL_FACTOR = 4
/** Name of a staged copy's directory: 16 random bytes in lowercase hex. */
const NONCE_NAME = /^[0-9a-f]{32}$/u
/** Bytes read from an upload at a time while it is copied. */
const COPY_CHUNK_BYTES = 1 << 20
/** {@link denial} phrase for a URL that does not parse or a tab whose URL cannot be read. */
const UNREADABLE = 'a page whose address cannot be read'
/** Why a browser or desktop call does not run, and the failure of a consent read that a takeover stopped. */
const TAKEN_OVER = 'the person has taken over the browser'
/** How long a takeover lasts, as the model is told with each refusal. */
const UNTIL_HANDED_BACK = 'Browser and desktop tools stay unavailable until they hand it back.'

/** The refusal of a browser or desktop call, named `tool`, that the person's takeover kept from running. */
function takenOverRefusal(tool: string): string {
  return `${tool} did not run: ${TAKEN_OVER}. ${UNTIL_HANDED_BACK}`
}

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
  /**
   * Absolute existing directory, such as the shared Downloads, whose files `browser_file_upload` and `browser_drop` may
   * send, each named directly in it. Required, so each deployment states it, and named by its real path below
   * directories that only root and dsh's own user can change (see {@link uploadDirectory}).
   */
  readonly uploadDirectory: string
  /**
   * Absolute existing directory, such as `/var/lib/mumbo/uploads`, where consent stages the copy of each file it sends
   * and which the browser server receives as its only file root. Required, named by its real path, owned by root or
   * dsh's own user and writable by no other user, below directories that only those users can change (see
   * {@link uploadStaging}), and neither inside nor containing `uploadDirectory` or `browser.outputDir`. At load consent
   * deletes the entries named like its copies' directories, 32 lowercase hex characters, and leaves every other entry.
   */
  readonly uploadStaging: string
  /** Largest file, in bytes, that one upload or drop may send; 536870912 (512 MiB) by default. */
  readonly uploadMaxBytes: number
}

/** Consent configuration as written: provider settings in their input form, the required fields, the others defaulted. */
export type ConfigInput = Partial<Omit<Config, 'browser' | 'deniedUrls' | 'uploadDirectory' | 'uploadStaging'>>
  & Pick<Config, 'deniedUrls' | 'uploadDirectory' | 'uploadStaging'>
  & { readonly browser: NonNullable<Parameters<typeof PlaywrightBrowser.Config>[0]> }

export const Config: z<ConfigInput, Config> = z.object({
  browser: PlaywrightBrowser.Config.required(),
  deniedUrls: z.array(z.string()).required(),
  allowedSites: z.array(z.string()).default([]),
  approvalTimeoutMs: z.natural().min(1).default(300_000),
  uploadDirectory: z.string().required(),
  uploadStaging: z.string().required(),
  uploadMaxBytes: z.natural().min(1).default(536_870_912),
})

/** Whether a uid is root's or this process's. */
function trusted(uid: number): boolean {
  return uid === 0 || uid === process.getuid?.()
}

/** Whether the normalized absolute path `inner` is `outer` or lies inside it. */
function within(inner: string, outer: string): boolean {
  // `join` keeps one trailing separator, so `/a/bc` is not inside `/a/b`, and every path is inside `/`.
  return join(inner, sep).startsWith(join(outer, sep))
}

/**
 * Validate a directory setting as {@link uploadDirectory} describes.
 * @param key - the setting's name, for errors.
 * @param path - the configured directory.
 * @param example - a directory of the form the setting takes, for errors.
 * @returns the directory, normalized.
 */
function settledDirectory(key: 'uploadDirectory' | 'uploadStaging', path: string, example: string): string {
  let real: string | undefined
  try {
    real = isAbsolute(path) ? realpathSync.native(path) : undefined
  } catch (_missing) {
    // Reported below as not an existing directory.
  }
  if (real === undefined || !statSync(real).isDirectory()) throw new Error(`${name}: ${key} "${path}" must be an absolute path to an existing directory, such as ${example}`)
  if (real !== resolve(path)) throw new Error(`${name}: ${key} "${path}" must be its own real path; use "${real}"`)
  for (let entry = real; dirname(entry) !== entry; entry = dirname(entry)) {
    const parent = statSync(dirname(entry))
    if (!trusted(parent.uid) || ((parent.mode & 0o022) !== 0 && ((parent.mode & 0o1000) === 0 || !trusted(statSync(entry).uid)))) {
      throw new Error(`${name}: ${key} "${path}" must lie below directories that only root and dsh's own user can change, but another user can change ${dirname(entry)}`)
    }
  }
  return real
}

/**
 * Validate `uploadDirectory`. Consent opens an upload by its name in this directory, so the directory must be named by
 * its real path below directories that no user other than root and this process's user can change; no one else can
 * then make that path name another directory after load. A sticky directory counts as unchangeable for an entry that
 * root or this process's user owns.
 * @param path - the configured directory.
 * @returns the directory, normalized.
 * @throws when it is not an absolute path to an existing directory, is not its own real path, or lies below a directory
 *   another user can change.
 */
export function uploadDirectory(path: string): string {
  return settledDirectory('uploadDirectory', path, '/home/shared/Downloads')
}

/**
 * Validate `uploadStaging`: a directory as {@link uploadDirectory} requires, which is also owned by root or this
 * process's user and writable by no other user, because consent writes the copies it sends there.
 * @param path - the configured directory.
 * @returns the directory, normalized.
 * @throws as {@link uploadDirectory} does, or when another user owns or can change the directory.
 */
export function uploadStaging(path: string): string {
  const real = settledDirectory('uploadStaging', path, '/var/lib/mumbo/uploads')
  const own = statSync(real)
  if (!trusted(own.uid) || (own.mode & 0o022) !== 0) {
    throw new Error(`${name}: uploadStaging "${path}" must be owned by root or dsh's own user and writable by no other user, because consent writes the copies it sends there`)
  }
  return real
}

/** Whether `path` is a string naming an entry directly in `directory`, exactly as `<directory>/<name>`. */
function directlyIn(directory: string, path: unknown): path is string {
  return typeof path === 'string' && isAbsolute(path) && resolve(path) === path && dirname(path) === directory && basename(path) !== ''
}

/**
 * Say why a call may not send the files its `paths` argument names. Each must name an entry directly in the upload
 * directory, exactly as `<directory>/<name>`, where `<name>` is one component other than `.` and `..`. No file is opened
 * here, so a refusal says nothing about what exists outside the directory.
 * @param paths - the call's `paths` argument.
 * @param directory - the validated upload directory.
 * @returns why the first refused path is refused, or `undefined` when every path may be staged.
 */
export function uploadRefusal(paths: unknown, directory: string): string | undefined {
  if (paths === undefined) return undefined
  if (!Array.isArray(paths)) return 'paths is not a list of file paths'
  const outside = (paths as unknown[]).findIndex(path => !directlyIn(directory, path))
  if (outside === -1) return undefined
  return `${JSON.stringify(paths[outside])} is not directly in ${directory}; put the file directly in ${directory} and retry`
}

/** One file consent staged: its copy's path, its name in the upload directory, its size, and its SHA-256 in hex. */
export interface StagedFile {
  readonly path: string
  readonly name: string
  readonly bytes: number
  readonly sha256: string
}

/**
 * Whether a user may read a file by its mode bits, checked as the kernel checks them: the owner bits for its owner, else
 * the group bits for a member of its group, else the other bits. ACL entries are not read.
 * @param reader - the user's uid, primary gid, and supplementary groups.
 * @param info - the file's `fstat`.
 */
function readableBy(reader: SubprocessChildIdentity, info: Stats): boolean {
  const member = reader.gid === info.gid || reader.groups.includes(info.gid)
  return (info.mode & (reader.uid === info.uid ? 0o400 : member ? 0o040 : 0o004)) !== 0
}

/**
 * Copy one upload into a new directory, named by a random nonce, in the staging directory. The source is opened once,
 * without following a link at its name and without blocking, as a FIFO or device would on open or read; `fstat` on that
 * descriptor must show a regular file of at most `maxBytes` that `reader` may read, and the copy reads only through it,
 * refusing a file that grows past that `fstat` size while it is copied. The SHA-256 is computed while copying; a write
 * that stores fewer bytes than were read fails the copy. The nonce directory ends with mode `0750` and the copy with
 * `0440`, both in the group that a set-group-ID staging directory gives them.
 * @param source - a path directly in the upload directory.
 * @param staging - the validated staging directory.
 * @param maxBytes - the largest file it copies.
 * @param reader - the identity the model's processes run as, which must be able to read the file itself; `undefined`
 *   when they run as this process, which opened it.
 * @param makeRoom - called with the file's `fstat` size before it is copied, which the copy never passes; returns why
 *   there is no room for it, if so.
 * @returns the staged file, or why it was refused; a refused or failed copy leaves nothing in the staging directory.
 */
export async function stageUpload(
  source: string, staging: string, maxBytes: number, reader: SubprocessChildIdentity | undefined,
  makeRoom: (bytes: number) => Promise<string | undefined>,
): Promise<StagedFile | { readonly refusal: string }> {
  const shown = JSON.stringify(source)
  let input: FileHandle
  try {
    input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error: unknown) {
    // Node's file system calls reject with its errors, which carry a code.
    const { code } = error as NodeJS.ErrnoException
    return { refusal: `${shown} ${code === 'ENOENT' ? 'does not exist' : code === 'ELOOP' ? 'is a symbolic link, not a regular file' : 'could not be opened'}` }
  }
  try {
    const info = await input.stat()
    if (!info.isFile()) return { refusal: `${shown} is not a regular file` }
    // Consent reads as root: a file the model could not read itself is never sent for it.
    if (reader !== undefined && !readableBy(reader, info)) return { refusal: `${shown} is a file the assistant cannot read itself` }
    if (info.size > maxBytes) return { refusal: `${shown} is larger than the upload limit of ${String(maxBytes)} bytes` }
    const crowded = await makeRoom(info.size)
    if (crowded !== undefined) return { refusal: crowded }
    const directory = join(staging, randomBytes(16).toString('hex'))
    const path = join(directory, basename(source))
    try {
      await mkdir(directory, { mode: 0o700 })
      const hash = createHash('sha256')
      let bytes = 0
      const output = await open(path, 'wx', 0o600)
      try {
        const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES)
        for (;;) {
          const { bytesRead } = await input.read(buffer, 0, buffer.length, null)
          bytes += bytesRead
          if (bytesRead === 0 || bytes > info.size) break
          hash.update(buffer.subarray(0, bytesRead))
          // One write(2), which a full disk can cut short without an error.
          const { bytesWritten } = await output.write(buffer, 0, bytesRead)
          if (bytesWritten !== bytesRead) throw new Error(`wrote ${String(bytesWritten)} of ${String(bytesRead)} bytes`)
        }
        await output.chmod(0o440)
      } finally {
        await output.close()
      }
      // Room was made for the fstat size, so a file that grew is not kept.
      if (bytes > info.size) {
        await rm(directory, { recursive: true, force: true })
        return { refusal: `${shown} changed while it was copied` }
      }
      await chmod(directory, 0o750)
      return { path, name: basename(source), bytes, sha256: hash.digest('hex') }
    } catch (error: unknown) {
      await rm(directory, { recursive: true, force: true })
      return { refusal: `${shown} could not be copied: ${String(error)}` }
    }
  } finally {
    await input.close()
  }
}

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
      // Every `about:` URL but `about:blank` is matched as `chrome:`, and `about:blank` is never denied.
      if (entry === 'about:') throw new Error(`${name}: deniedUrls entry "about:" would deny only about:blank; use "chrome:"`)
      schemes.add(entry)
      continue
    }
    const parsed = URL.parse(entry)
    const origin = parsed === null ? undefined : canonicalOrigin(parsed)
    if (parsed === null || origin !== entry) {
      throw new Error(`${name}: deniedUrls entry "${entry}" is neither a scheme nor an origin; ${origin === undefined ? 'use one such as chrome: or https://accounts.google.com' : `use "${origin}"`}`)
    }
    if (parsed.hostname.includes('*')) {
      throw new Error(`${name}: deniedUrls entry "${entry}" names a wildcard host, which matches no page; list each origin, such as https://accounts.google.com`)
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
  /** The arguments the browser receives in place of the model's: its `paths` name the staged copies. */
  readonly sent?: Record<string, unknown>
}

/** A staged copy consent keeps until it unloads or makes room: its nonce directory, its size, and when it was made. */
interface StagedCopy {
  readonly directory: string
  readonly bytes: number
  readonly at: number
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
 * The tab lines (`- 0: (current) [title](url)`) of a `browser_tabs` listing's `### Result` section, or of the whole text
 * when it has none. Upstream may repeat the tabs under `### Open tabs` after the result, rendered at a later moment.
 */
function tabLines(text: string): string[] {
  const section = /(?:^|\n)### Result\n([\s\S]*?)(?:\n### |$)/u.exec(text)?.[1] ?? text
  return section.split('\n').filter(line => /^- \d+: (\(current\) )?\[/u.test(line))
}

/**
 * The URL of one tab line. Page titles are not escaped upstream, so a line holding `](` more than once is ambiguous;
 * it yields `hint` only when the line ends with `](hint)`, since the URL is always the line's last part.
 */
function lineUrl(line: string, hint: string | undefined): string | undefined {
  const trimmed = line.replace(/ \[crashed\]$/u, '')
  const [, url, ...rest] = trimmed.split('](')
  if (url === undefined || !trimmed.endsWith(')')) return undefined
  if (rest.length === 0) return url.slice(0, -1)
  return hint !== undefined && trimmed.endsWith(`](${hint})`) ? hint : undefined
}

/**
 * Read the current tab's URL from a `browser_tabs` listing. A current-tab line holding `](` more than once is ambiguous
 * and yields the URL only when the line ends with `hint`, such as the URL a call's own result reports.
 * @param text - the listing's text content.
 * @param hint - a URL the current tab is believed to show.
 * @returns the URL, or `undefined` when none can be read without ambiguity.
 */
export function currentTabUrl(text: string, hint?: string): string | undefined {
  const current = [...new Set(tabLines(text).filter(line => /^- \d+: \(current\) /u.test(line)))]
  const [line, ...others] = current
  return line !== undefined && others.length === 0 ? lineUrl(line, hint) : undefined
}

/**
 * Read one tab's URL from a `browser_tabs` listing.
 * @param text - the listing's text content.
 * @param index - the tab's index in the listing.
 * @returns the URL, or `undefined` when the tab is not listed or its line is ambiguous.
 */
export function tabUrl(text: string, index: number): string | undefined {
  const lines = [...new Set(tabLines(text).filter(line => line.startsWith(`- ${String(index)}: `)))]
  const [line, ...others] = lines
  return line !== undefined && others.length === 0 ? lineUrl(line, undefined) : undefined
}

/**
 * Every URL a listing could name for any tab: each text after a `](` on a tab line, up to the line's end and up to
 * the first `)`. A page title can add candidates, never hide the real URL, so a check over them errs toward denial.
 */
function listedUrls(text: string): string[] {
  return text.split('\n').filter(line => /^- \d+: /u.test(line)).flatMap(line => line.replace(/ \[crashed\]$/u, '').split('](').slice(1)
    .flatMap(part => [part.replace(/\)$/u, ''), part.replace(/\).*$/u, '')]))
}

/** The URL in the `- Page URL:` line that opens a result's `### Page` section, which upstream renders from the current tab. */
function pageUrlOf(text: string): string | undefined {
  return /(?:^|\n)### Page\n- Page URL: (.*)$/mu.exec(text)?.[1]
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
 * Delete the files Playwright MCP wrote for a withheld result, so the model cannot read them with other tools. Each
 * link's file name is deleted from the output directory, where the server writes every linked file. A failed deletion
 * is logged; the result stays withheld.
 * @param ctx - plugin context carrying the logger.
 * @param outputDir - the configured absolute output directory.
 * @param result - the withheld result.
 */
async function removeLinkedFiles(ctx: Context, outputDir: string, result: ToolExecutionResult): Promise<void> {
  const text = result.content.map(block => block.type === 'text' ? block.text : '').join('\n')
  const links = FILE_LINES.flatMap(pattern => Array.from(text.matchAll(pattern), ([, link]) => link))
    .filter((link): link is string => link !== undefined)
  const files = links.map(link => basename(link)).filter(file => !['', '.', '..'].includes(file)).map(file => join(outputDir, file))
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

/** The text of one upstream read, or why it could not be made, as a phrase for the model. */
type BrowserRead = { readonly text: string } | { readonly failure: string }

/**
 * Run one upstream read for this plugin's own decision through the same Session's tool, outside the tool pipeline, so
 * its result never reaches the model. Native execution runs MCP tools one at a time, so no other call of this Session's
 * browser is in flight.
 * @returns the result's text, or the first line of the tool's error, or that the tool is absent.
 */
async function readBrowser(ctx: Context, exec: ToolExecution, tool: string, args: Record<string, unknown>): Promise<BrowserRead> {
  const definition = ctx.tools.get(PREFIX + tool, exec.agent)
  if (definition === undefined) return { failure: `the browser has no ${tool} tool` }
  try {
    // A read whose call was stopped before it began, such as by a takeover, never reaches the browser.
    exec.signal.throwIfAborted()
    const result = await definition.execute(args, { ...exec, ...INERT_RUN, name: PREFIX + tool, arguments: args }) as McpResult
    return { text: result.content.map(block => (block as { text?: unknown }).text).filter(text => typeof text === 'string').join('\n') }
  } catch (error: unknown) {
    // MCP errors arrive as `### Error` text; the first error line names the cause, such as a refused connection.
    /* v8 ignore next -- MCP client tool bodies throw Error instances only */
    const reason = error instanceof Error ? error.message : String(error)
    const message = reason.replace(/^### Error\n/u, '').replace(/^Error: /u, '')
    ctx.logger.warn(`${name}: ${tool} for consent failed: ${message}`)
    return { failure: `${tool} failed: ${message.replace(/\n[\s\S]*$/u, '').slice(0, 300)}` }
  }
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

/**
 * Whether a takeover record exists. A record that cannot be checked counts as present, so the browser stays taken over
 * until the person hands it back.
 * @param ctx - plugin context carrying the logger.
 * @param file - the takeover record.
 */
function recordedTakeover(ctx: Context, file: string): boolean {
  try {
    statSync(file)
    return true
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
    ctx.logger.error(`${name}: could not check ${file}, so the browser stays taken over until the person hands it back: ${String(error)}`)
    return true
  }
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
  const upload = uploadDirectory(config.uploadDirectory)
  const staging = uploadStaging(config.uploadStaging)
  // The server's workspace is the staging directory, which it cannot write; the files a withheld result links are
  // deleted only from a configured output directory.
  const { outputDir } = config.browser
  if (outputDir === undefined) {
    throw new Error(`${name}: browser.outputDir must be set, because the browser server's workspace is uploadStaging; name a directory the server's user owns in a root-owned parent, such as /var/lib/mumbo/playwright-output`)
  }
  if (config.browser.fileRoot !== undefined) {
    throw new Error(`${name}: browser.fileRoot must not be set; consent gives the browser server uploadStaging as its only file root`)
  }
  // Load deletes copy directories in the staging directory, so it shares no directory with the person's or the server's files.
  for (const [key, other] of [['uploadDirectory', upload], ['browser.outputDir', resolve(outputDir)]] as const) {
    if (within(staging, other) || within(other, staging)) {
      throw new Error(`${name}: uploadStaging "${staging}" must not be, contain, or lie inside ${key} "${other}"; use a directory of its own, such as /var/lib/mumbo/uploads`)
    }
  }
  const holder = ctx.browserUse.providerName
  if (holder !== undefined && PROVIDER_TOOL_PREFIXES[holder] === undefined) {
    throw new Error(`${name}: browser provider "${holder}" holds browserUse and its tools have no prefix this plugin can refuse; remove the row that mounts it`)
  }
  if (holder !== undefined) reportRival(ctx, holder)
  const allowed = new Set(config.allowedSites)
  const consents = new WeakMap<ToolExecution, Consent>()
  const computerConsents = new WeakSet<ToolExecution>()
  /** `browser_tabs` selects whose target tab this plugin listed and found allowed. */
  const checkedSelects = new WeakSet<ToolExecution>()
  /** Sessions whose browser has listed or shown a denied page in some tab; their tabs' logs may keep its entries. */
  const shownDenied = new WeakSet<Session>()
  /** What denies the page the browser's current tab showed when this plugin last read it; `undefined` when allowed. */
  let showing: string | undefined
  let owned = false
  // Copies a crash or an earlier load left behind go before any new one is staged; nothing else in the directory is touched.
  for (const entry of readdirSync(staging)) if (NONCE_NAME.test(entry)) rmSync(join(staging, entry), { recursive: true, force: true })
  /** The staged copies kept, oldest first; Chromium can read a copy after its call returns, so each stays until room is made. */
  const copies: StagedCopy[] = []
  /** The total `copies` and one call's files may reach. */
  const stagedLimit = STAGED_TOTAL_FACTOR * config.uploadMaxBytes
  /** Run one staging step after those before it, so each sees every copy kept. */
  const stagingStep = sequence()
  /** Delete staged copies and forget them; a failed deletion is logged, and the start script empties the directory. */
  const discard = async (doomed: readonly StagedCopy[]): Promise<void> => {
    // A call's own copies can already be gone, deleted to make room while its question waited.
    copies.splice(0, copies.length, ...copies.filter(copy => !doomed.includes(copy)))
    await Promise.all(doomed.map(async (copy) => {
      try {
        await rm(copy.directory, { recursive: true, force: true })
      } catch (error: unknown) {
        ctx.logger.error(`${name}: could not delete the staged upload copy ${copy.directory}: ${String(error)}`)
      }
    }))
  }
  /**
   * Stage a copy of each file a call sends, one call at a time. Once a file's size is known and before it is copied, a
   * file that with the call's earlier copies would pass the limit is refused, deleting no other copy; otherwise copies
   * older than a day go, then the oldest others while the copies kept and the new one would pass the limit. A refusal
   * deletes the call's copies.
   */
  type Staged = { readonly files: StagedFile[]; readonly made: StagedCopy[] } | { readonly refusal: string }
  const stageCall = (paths: readonly string[], reader: SubprocessChildIdentity | undefined): Promise<Staged> =>
    stagingStep(async () => {
      const made: StagedCopy[] = []
      const files: StagedFile[] = []
      const makeRoom = async (bytes: number): Promise<string | undefined> => {
        if (made.reduce((sum, copy) => sum + copy.bytes, bytes) > stagedLimit) return `the files of one call may not pass ${String(stagedLimit)} bytes in total`
        const now = Date.now()
        const doomed = copies.filter(copy => now - copy.at > STAGED_LIFETIME_MS)
        const kept = copies.filter(copy => !doomed.includes(copy))
        let total = kept.reduce((sum, copy) => sum + copy.bytes, bytes)
        // The call's own copies come last and fit, so the oldest others are enough.
        for (const copy of kept) {
          if (total <= stagedLimit) break
          doomed.push(copy)
          total -= copy.bytes
        }
        await discard(doomed)
        return undefined
      }
      for (const path of paths) {
        const staged = await stageUpload(path, staging, config.uploadMaxBytes, reader, makeRoom)
        if ('refusal' in staged) {
          await discard(made)
          return staged
        }
        const copy = { directory: dirname(staged.path), bytes: staged.bytes, at: Date.now() }
        copies.push(copy)
        made.push(copy)
        files.push(staged)
      }
      return { files, made }
    })
  ctx.effect(() => () => stagingStep(() => discard([...copies])), `${name}: staged uploads`)
  /** A refusal for a call to the tools of a provider that holds `browserUse` in place of this plugin's child. */
  const rivalRefusal = (exec: ToolExecution): string | undefined => {
    const current = ctx.browserUse.providerName
    const prefix = current === undefined || owned ? undefined : PROVIDER_TOOL_PREFIXES[current]
    return prefix !== undefined && exec.name.startsWith(prefix)
      ? `${exec.name} did not run: browser tools are disabled because this browser was set up without consent checks.`
      : undefined
  }
  const toolOf = (exec: ToolExecution): string | undefined => exec.name.startsWith(PREFIX) ? exec.name.slice(PREFIX.length) : undefined
  /** Present while the person has taken over the browser, so a Host restart keeps the takeover. */
  const takeoverFile = join(resolveDshHome(), 'mumbo', 'browser-takeover')
  /** Aborted while the person has the browser, which stops every browser and desktop call and consent read started before. */
  let release = new AbortController()
  if (recordedTakeover(ctx, takeoverFile)) release.abort()
  /** Browser and desktop calls and consent reads that may still be running; a takeover waits for them to settle. */
  const running = new Set<Promise<void>>()
  /** Agents whose Playwright server received a call since this plugin last closed its browser connection. */
  const connected = new WeakSet<Agent>()
  /** Take-over and hand-back requests so far; a hand back yields to any request made after it. */
  let requests = 0
  /** Take-over steps queued or running. */
  let taking = 0
  /** Why the last take-over step failed; a later step that succeeds, or a hand back, clears it. */
  let unfinished: string | undefined
  /** Run one take-over or hand-back step after those requested before it. */
  const serialize = sequence()
  /** The name a takeover refusal gives a browser or desktop call; `undefined` for every other tool. */
  const takeoverTool = (exec: ToolExecution): string | undefined => toolOf(exec) ?? (exec.name === COMPUTER ? COMPUTER : undefined)
  /** The refusal of a browser or desktop call while the person has the browser. */
  const takeoverRefusal = (exec: ToolExecution): string | undefined => {
    const tool = takeoverTool(exec)
    return tool === undefined || !release.signal.aborted ? undefined : takenOverRefusal(tool)
  }
  /** Keep an operation among the running ones until it settles. */
  const track = <T>(operation: Promise<T>): Promise<T> => {
    const settled = operation.then(() => {}, () => {})
    running.add(settled)
    void settled.then(() => running.delete(settled))
    return operation
  }
  /** One upstream read for a consent decision: refused while the person has the browser, and stopped when they take it. */
  const readForConsent = async (exec: ToolExecution, agent: Agent, tool: string, args: Record<string, unknown>): Promise<BrowserRead> => {
    const stop = release.signal
    connected.add(agent)
    const result = await track(readBrowser(ctx, { ...exec, signal: AbortSignal.any([exec.signal, stop]) }, tool, args))
    return stop.aborted ? { failure: TAKEN_OVER } : result
  }
  /** A run context for one of this plugin's own browser calls for `agent`, outside any model call. */
  const ownCall = (agent: Agent): ToolExecution => {
    const callId = ToolCallId(name)
    const token = Symbol(name) as ToolExecutionToken
    return { callId, rootCallId: callId, token, name, arguments: {}, agent, signal: new AbortController().signal }
  }
  /**
   * A refusal for a browser call that reads request details, saves its output to a file the call names, which would
   * outlive a withheld result and could overwrite workspace files, or whose `url` argument names a denied page.
   */
  const callRefusal = (exec: ToolExecution): string | undefined => {
    const tool = toolOf(exec)
    if (tool === REQUEST_DETAILS) return `${tool} did not run: the assistant may not read request headers or bodies, which carry cookies and passwords.`
    if (tool === SERVER_CODE) return `${tool} did not run: code may not run in the browser automation process; browser_evaluate runs a function in the page and asks the user first.`
    if (tool !== undefined && TAB_LOGS.has(tool) && exec.agent !== undefined && shownDenied.has(exec.agent.session)) {
      return `${tool} did not run: a tab in this browser has shown a page the assistant may not use, and console and request logs keep that page's entries.`
    }
    if (tool !== undefined && fieldsOf(exec.arguments).filename !== undefined) {
      return `${tool} did not run: the assistant may not save browser output to a file; call it without filename to get the result directly.`
    }
    // Only files named directly in the upload directory are staged; a staged copy's own path is refused like any other.
    const unsent = tool !== undefined && FILE_SENDERS.has(tool) ? uploadRefusal(fieldsOf(exec.arguments).paths, upload) : undefined
    if (unsent !== undefined) return `${tool} did not run: ${unsent}.`
    const target = tool === undefined ? undefined : targetUrl(exec.arguments)
    const blocked = target === undefined ? undefined : denial(target, denied)
    return blocked === undefined ? undefined : `${tool} did not run: the assistant may not open ${blocked}.`
  }
  const isScreenshot = (args: unknown): boolean => fieldsOf(args).action === 'screenshot'
  /** Whether a URL names a denied page; a URL that does not parse is not evidence of one. */
  const isDenied = (url: string): boolean => ![undefined, UNREADABLE].includes(denial(url, denied))
  /** The current tab's URL, or why it could not be checked. */
  type TabRead = { readonly url: string } | { readonly failure: string }
  /**
   * List the Session's tabs, record a denied page in any of them, and read the current tab's URL; an ambiguous
   * current-tab line is resolved by the URL `hint` gives, when the line ends with it.
   */
  const readTabs = async (exec: ToolExecution, agent: Agent, hint: () => Promise<string | undefined>): Promise<TabRead> => {
    const listing = await readForConsent(exec, agent, TABS, { action: 'list' })
    if ('failure' in listing) return listing
    if (listedUrls(listing.text).some(isDenied)) shownDenied.add(agent.session)
    const url = currentTabUrl(listing.text) ?? currentTabUrl(listing.text, await hint())
    if (url === undefined) return { failure: 'its tab listing is ambiguous' }
    showing = denial(url, denied)
    return { url }
  }
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
    // A takeover withdraws the question; the call is then refused like any call made while the person has the browser.
    const outcome: ApprovalOutcome = await approval.request({
      agent, toolName: exec.name, callId: exec.callId, reason, displayReason: { en: reason },
      signal: AbortSignal.any([exec.signal, timeout, release.signal]),
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
    const refusal = takeoverRefusal(exec) ?? rivalRefusal(exec) ?? callRefusal(exec)
    if (refusal !== undefined) return refusal
    if (exec.name === COMPUTER) {
      const free = isScreenshot(exec.arguments) && showing === undefined
      return free || computerConsents.has(exec) ? undefined : 'computer input needs the user\'s consent, which was not given.'
    }
    const tool = toolOf(exec)
    if (tool === TABS && fieldsOf(exec.arguments).action === 'select' && !checkedSelects.has(exec)) {
      return `${tool} did not run: the tab it selects was not checked.`
    }
    if (tool === undefined || consents.has(exec) || classify(tool, exec.arguments) === 'read') return undefined
    return `${tool} needs the user's consent, which was not given.`
  })

  /** Refuse a call, ask the person about it, or pass it to the listeners after this one. */
  const decide = async (exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> => {
    const refusal = takeoverRefusal(exec) ?? rivalRefusal(exec) ?? callRefusal(exec)
    if (refusal !== undefined) return { kind: 'deny', reason: refusal }
    const agent = exec.agent
    if (agent === undefined) return next()
    if (exec.name === COMPUTER) {
      const screenshot = isScreenshot(exec.arguments)
      // Free browser reads can bring a denied page to the screen, so a screenshot then asks.
      if (screenshot && showing === undefined) return next()
      const { summary } = argumentsOf(exec, agent)
      const decision = screenshot
        ? await ask(exec, agent, 'the desktop screenshot', `Desktop screenshot while the browser's current tab is ${String(showing)}, which the assistant may not use. Arguments: ${summary}.`)
        : await ask(exec, agent, 'computer input', `Computer input on the desktop. Arguments: ${summary}.`)
      const consented = (): Promise<PreToolDecision> => {
        computerConsents.add(exec)
        return next()
      }
      return decision === 'allowed' ? consented() : decision
    }
    const tool = toolOf(exec)
    if (tool === undefined) return next()
    const { action, index } = fieldsOf(exec.arguments)
    if (tool === TABS && action === 'select') {
      const listing = await readForConsent(exec, agent, TABS, { action: 'list' })
      if ('failure' in listing) return { kind: 'deny', reason: `${tool} did not run: the tab it selects could not be checked (${listing.failure}).` }
      if (listedUrls(listing.text).some(isDenied)) shownDenied.add(agent.session)
      const selected = typeof index === 'number' ? tabUrl(listing.text, index) : undefined
      if (selected === undefined) return { kind: 'deny', reason: `${tool} did not run: the tab it selects could not be checked (the tab listing does not show it unambiguously).` }
      const blocked = denial(selected, denied)
      if (blocked !== undefined) return { kind: 'deny', reason: `${tool} did not run: that tab is ${blocked}, which the assistant may not use.` }
      checkedSelects.add(exec)
      return next()
    }
    const kind = classify(tool, exec.arguments)
    if (kind === 'read') return next()
    let snapshot: BrowserRead | undefined
    const readSnapshot = async (): Promise<BrowserRead> => (snapshot ??= await readForConsent(exec, agent, SNAPSHOT, {}))
    const tab = await readTabs(exec, agent, async () => {
      const read = await readSnapshot()
      return 'text' in read ? pageUrlOf(read.text) : undefined
    })
    if ('failure' in tab) return { kind: 'deny', reason: `${tool} did not run: the browser's current tab could not be checked (${tab.failure}).` }
    const blocked = denial(tab.url, denied)
    if (blocked !== undefined) {
      shownDenied.add(agent.session)
      return { kind: 'deny', reason: `${tool} did not run: the current tab is ${blocked}, which the assistant may not use.` }
    }
    const site = webOrigin(tab.url)
    // The browser reads what it sends after the call returns: it gets copies consent made, never the model's files.
    const { paths } = fieldsOf(exec.arguments)
    const staged = FILE_SENDERS.has(tool) && Array.isArray(paths) && paths.length > 0 ? await stageCall(paths as string[], ctx.get('subprocess')?.childIdentity) : undefined
    if (staged !== undefined && 'refusal' in staged) return { kind: 'deny', reason: `${tool} did not run: ${staged.refusal}.` }
    const sent = staged === undefined ? undefined : { ...fieldsOf(exec.arguments), paths: staged.files.map(file => file.path) }
    const grant = (granted: BrowserWriteGrant): Promise<PreToolDecision> => {
      consents.set(exec, { session: agent.session, tool, site, grant: granted, ...sent === undefined ? {} : { sent } })
      return next()
    }
    const files = staged === undefined ? '' : ` Files sent: ${staged.files.map(file =>
      `${shown(file.name)} (${count(file.bytes, 'byte')}, SHA-256 ${file.sha256.slice(0, 12)})`).join(', ')}.`
    // An allowance never covers a page that shows a password or payment field, nor one that cannot be checked.
    let uncovered = kind === 'always-ask' ? `${files} Site allowances do not cover this action.` : ''
    if (kind === 'site-write' && site !== undefined && allowed.has(site)) {
      // The patched snapshot's mask is the single source of the secret-input rule.
      const read = await readSnapshot()
      const masked = 'text' in read ? MASKED_FIELD.test(read.text) : undefined
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
    if (decision === 'allowed') return grant('approval')
    if (staged !== undefined) await discard(staged.made)
    return decision
  }
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const decision = await decide(exec, next)
    // A takeover during the decision stops its reads and withdraws its question; the call is refused like a later one.
    const refusal = takeoverRefusal(exec)
    return refusal === undefined ? decision : { kind: 'deny', reason: refusal }
  }, { prepend: true })

  /** The error that replaces a result, after deleting the files Playwright linked from a browser result. */
  const withhold = async (exec: ToolExecution, result: ToolExecutionResult | undefined, reason: string): Promise<ToolExecutionResult> => {
    if (result !== undefined && toolOf(exec) !== undefined) await removeLinkedFiles(ctx, outputDir, result)
    return { isError: true, content: [{ type: 'text', text: `Error: ${reason}` }], error: { message: reason } }
  }

  // Around dispatch, so wrappers outside it, post-execute policy, and result observers see only the replacement.
  ctx.on('tools/execute', async (exec, next) => {
    const called = takeoverTool(exec)
    if (called === undefined) return next()
    const stop = release.signal
    // The guard let it through before the person took over; neither the browser nor the desktop receives it.
    if (stop.aborted) return withhold(exec, undefined, takenOverRefusal(called))
    // A function, so each check reads the signal again after an await rather than a narrowed earlier value.
    const interrupted = (): boolean => stop.aborted
    const stopped = `${called} was stopped because the person took over the browser, so it may or may not have taken effect. ${UNTIL_HANDED_BACK}`
    const tool = toolOf(exec)
    const agent = exec.agent
    if (tool !== undefined && agent !== undefined) connected.add(agent)
    const original = exec.signal
    exec.signal = AbortSignal.any([original, stop])
    // An upload or drop sends the staged copies: the browser receives their paths for this dispatch only, so the
    // Session log and result observers keep the model's own arguments.
    const dispatched: { arguments: unknown } = exec
    const asked = exec.arguments
    const sent = consents.get(exec)?.sent
    if (sent !== undefined) dispatched.arguments = sent
    let result: ToolExecutionResult
    try {
      result = await track(next())
    } catch (error: unknown) {
      // The browser runtime rejects a call that a takeover stopped while it waited for or ran in the browser.
      if (interrupted()) return await withhold(exec, undefined, stopped)
      throw error
    } finally {
      exec.signal = original
      dispatched.arguments = asked
    }
    if (interrupted()) return withhold(exec, result, stopped)
    // A listing after `browser_close` would reconnect and open a new tab; the close itself was refused before the call
    // when its tab was on a denied page. An Agent-less call never reaches the browser.
    if (tool === undefined || tool === CLOSE || agent === undefined) return result
    const text = result.content.map(block => block.type === 'text' ? block.text : '').join('\n')
    let reason: string | undefined
    const reported = reportedDenial(result, denied)
    if (reported === undefined) {
      const tab = await readTabs(exec, agent, () => Promise.resolve(pageUrlOf(text)))
      const blocked = 'failure' in tab ? undefined : denial(tab.url, denied)
      if ('failure' in tab) reason = `${tool}: the browser's current tab could not be checked after the call (${tab.failure}), so its result is withheld.`
      else if (blocked !== undefined) {
        shownDenied.add(agent.session)
        reason = `${tool} ran, but its result is withheld: the current tab is ${blocked}, which the assistant may not use. Open another page to continue.`
      }
    } else {
      shownDenied.add(agent.session)
      showing = reported
      reason = `${tool} ran, but its result is withheld: the current tab is ${reported}, which the assistant may not use. Open another page to continue.`
    }
    // A takeover during the check stops its read; the result is withheld like that of any call it stopped.
    if (interrupted()) reason = stopped
    return reason === undefined ? result : withhold(exec, result, reason)
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

  /** Close the browser connection of each live Session whose Playwright server may hold one, once its calls settle. */
  const disconnect = async (): Promise<string[]> => {
    await Promise.all(running)
    const agents = ctx.agents.list().filter(agent => connected.has(agent) && ctx.tools.get(PREFIX + CLOSE, agent) !== undefined)
    // In attach mode upstream's `browser_close` closes the CDP connection and leaves the browser and its tabs open.
    const closed = await Promise.all(agents.map(async (agent) => {
      const result = await readBrowser(ctx, ownCall(agent), CLOSE, {})
      if ('text' in result) connected.delete(agent)
      return result
    }))
    return closed.flatMap(result => 'failure' in result ? [`a browser connection did not close: ${result.failure}`] : [])
  }
  const takeover: BrowserTakeover = {
    get hold(): BrowserHold {
      if (!release.signal.aborted) return { kind: 'free' }
      if (taking > 0) return { kind: 'taking' }
      return unfinished === undefined ? { kind: 'held' } : { kind: 'unfinished', failure: unfinished }
    },
    takeOver() {
      requests += 1
      release.abort()
      taking += 1
      return serialize(async () => {
        const failures: string[] = []
        try {
          await writeFileAtomic(takeoverFile, `${new Date().toISOString()}\n`, { mode: 0o600 })
        } catch (error: unknown) {
          failures.push(`the takeover could not be saved, so a restart would hand the browser back: ${String(error)}`)
        }
        failures.push(...await disconnect())
        taking -= 1
        unfinished = failures.length === 0 ? undefined : failures.join('; ')
        if (unfinished !== undefined) throw new Error(unfinished)
      })
    },
    handBack() {
      const request = ++requests
      return serialize(async () => {
        await rm(takeoverFile, { force: true })
        // A take over requested after this hand back writes the record again in its own step and keeps the browser.
        if (request !== requests || !release.signal.aborted) return
        release = new AbortController()
        unfinished = undefined
        // The person may have left a denied page on screen; until a read shows the tab, a desktop screenshot asks.
        showing = UNREADABLE
        await Promise.all(ctx.agents.list().filter(agent => ctx.tools.get(PREFIX + TABS, agent) !== undefined)
          .map(agent => readTabs(ownCall(agent), agent, () => Promise.resolve(undefined))))
      })
    },
  }
  ctx.effect(() => () => serialize(() => Promise.resolve()), `${name}: takeover`)

  if (holder !== undefined) return
  // The provider depends on this plugin's service, so it unloads before the guard and listeners go.
  ctx.provide(GATE, takeover)
  const { name: providerName, Config: ProviderConfig, apply: applyProvider } = PlaywrightBrowser
  const applyOwned = (child: Context, browser: PlaywrightBrowser.Config): void => {
    // Another provider may take browserUse between this plugin's load and its child's start.
    const current = ctx.browserUse.providerName
    if (current !== undefined) {
      reportRival(ctx, current)
      throw new Error(`${name}: browser provider "${current}" took browserUse before this plugin's browser started`)
    }
    // Checked here, where a refused identity fails only the browser; each Session's server start would fail the Session.
    if (browser.identity !== undefined) child.subprocess.serverHome(browser.identity)
    applyProvider(child, { ...browser, fileRoot: staging })
    child.effect(() => {
      owned = true
      return () => { owned = false }
    })
  }
  // With an identity, the browser mounts only once a subprocess service is mounted.
  const providerInject = [...inject, GATE, ...config.browser.identity === undefined ? [] : ['subprocess']]
  ctx.plugin({ name: providerName, inject: providerInject, Config: ProviderConfig, apply: applyOwned }, config.browser)
}
