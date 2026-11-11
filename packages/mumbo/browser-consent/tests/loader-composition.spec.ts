import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { BrowserUseProviderName } from '@deepseek-ai/dsh-browser-use/brand'
import * as PlaywrightBrowser from '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp'
import { mountSessionMcp } from '@deepseek-ai/dsh-experimental-browser-use-runtime/mcp'
import { ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineContentToolFixture, executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import type { PreToolDecision, ToolExecution, ToolExecutionResult, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { bootComposition, consentRecords, tool, toolResults } from './harness.ts'
import type { ScriptStep } from './harness.ts'

const FIXTURE = fileURLToPath(new URL('./playwright-fixture.mjs', import.meta.url))
/** Cordis `FiberState.ACTIVE`. */
const ACTIVE = 2
/** Cordis `FiberState.FAILED`. */
const FAILED = 3

// The pinned Playwright MCP server is the external boundary: the real provider and runtime spawn the fixture instead.
vi.mock('@deepseek-ai/dsh-experimental-browser-use-runtime/mcp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-experimental-browser-use-runtime/mcp')>()
  return {
    ...actual,
    mountSessionMcp: (ctx: Context, options: Parameters<typeof actual.mountSessionMcp>[1]) => {
      // The fixture writes its files where the real server's `--output-dir` points.
      const outputDir = options.args.includes('--output-dir') ? options.args[options.args.indexOf('--output-dir') + 1]! : ''
      actual.mountSessionMcp(ctx, { ...options, args: [FIXTURE, process.env.CONSENT_FIXTURE_ROOT!, process.env.CONSENT_FIXTURE_MODE ?? '', process.env.CONSENT_FIXTURE_START ?? '', outputDir] })
    },
  }
})

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  vi.unstubAllEnvs()
})

/** The list the box edge writes: every non-web scheme and the Google pages that hold passwords, payments, and sign-in. */
const DENIED_URLS = [
  'chrome:', 'chrome-untrusted:', 'chrome-extension:', 'devtools:', 'view-source:', 'file:', 'https://passwords.google.com',
  'https://pay.google.com', 'https://payments.google.com', 'https://myaccount.google.com', 'https://accounts.google.com',
]

type LoadOptions = Omit<Parameters<typeof bootComposition>[1], 'consent'> & { consent?: Record<string, unknown>; withoutTabs?: boolean; start?: string; root?: string }

async function load(options: LoadOptions = {}) {
  const root = options.root ?? await mkdtemp(join(tmpdir(), 'mumbo-browser-consent-'))
  if (options.root === undefined) roots.push(root)
  // The takeover record lives under the DSH home.
  vi.stubEnv('DSH_HOME', root)
  vi.stubEnv('CONSENT_FIXTURE_ROOT', root)
  vi.stubEnv('CONSENT_FIXTURE_MODE', options.withoutTabs === true ? 'no-tabs' : '')
  vi.stubEnv('CONSENT_FIXTURE_START', options.start ?? '')
  const staging = join(root, 'staging')
  await mkdir(staging, { recursive: true, mode: 0o700 })
  const consent = {
    browser: { mode: 'attach', endpoint: 'http://127.0.0.1:9', outputDir: join(root, '.playwright-mcp') }, deniedUrls: DENIED_URLS,
    allowedSites: ['http://allowed.test'], uploadDirectory: root, uploadStaging: staging, ...options.consent,
  }
  const booted = await bootComposition(root, { ...options, consent })
  contexts.push(booted.ctx)
  // Every call the browser received, in order, with the current tab's URL before the call.
  const allCalls = async () => (await readFile(join(root, 'calls.ndjson'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean)
    .map(line => JSON.parse(line) as { name: string; args: { action?: string }; url: string })
  // Every call except consent's own current-tab listings.
  const calls = async () => (await allCalls()).filter(call => !(call.name === 'browser_tabs' && call.args.action === 'list'))
  return { ...booted, calls, allCalls, root, staging }
}

/** Run one call through the executor as the booted Session's Agent, or without an Agent. */
const direct = (loaded: Awaited<ReturnType<typeof load>>, name: string, args: Record<string, unknown>, agent: boolean = true) =>
  executeModelToolFixture(loaded.ctx, {
    ...agent ? { agent: loaded.agent } : {}, name, arguments: args, callId: ToolCallId(`direct-${name}`), signal: new AbortController().signal,
  })

/** Model-visible text of one result. */
const textOf = (result: { content: ReadonlyArray<{ type: string; text?: string }> }) => result.content.map(block => block.text ?? `[${block.type}]`).join('\n')

/** Run one scripted turn and return what it produced. */
async function turn(options: LoadOptions & { script: readonly ScriptStep[] }) {
  const loaded = await load(options)
  loaded.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Go.' }], source: { kind: 'user' } }))
  await loaded.agent.whenIdle()
  return loaded
}

/** SHA-256 of the text `pdf`, the upload fixtures' content. */
const PDF_SHA256 = 'c35b21d6ca39aa7cc3b79a705d989f1a6e88b99ab43988d74048799e3db926a3'

const browserTools = (loaded: Awaited<ReturnType<typeof load>>) => loaded.ctx.tools.schemas(loaded.agent).filter(schema => schema.name.startsWith(tool('')))

describe('browser write consent in the person-box composition', () => {
  it('decides each write on the tab it runs on, asks for the rest with its arguments, and logs every allowed write', { timeout: 60_000 }, async () => {
    const downloads = await mkdtemp(join(tmpdir(), 'mumbo-browser-consent-downloads-'))
    roots.push(downloads)
    const upload = join(downloads, 'tax.pdf')
    await writeFile(upload, 'pdf')
    const { asked, events, calls, root, staging } = await turn({
      consent: { uploadDirectory: downloads },
      script: [
        { name: 'browser_navigate', args: { url: 'http://allowed.test/inbox' } },
        { name: 'browser_click', args: { element: 'Archive', target: 'e1' } },
        { name: 'browser_click', args: { element: 'Undo', target: 'gone' } },
        { name: 'browser_click', args: { element: 'Next', target: 'link:http://other.test/next' } },
        { name: 'browser_type', args: { element: 'Message', target: 'e2', text: 'hi\nthere' } },
        { name: 'browser_tabs', args: { action: 'new', url: 'http://allowed.test/compose' } },
        { name: 'browser_tabs', args: { action: 'select', index: 0 } },
        { name: 'browser_click', args: { element: 'Send', target: 'e3' } },
        { name: 'browser_navigate', args: { url: 'http://allowed.test/?redirect=http%3A%2F%2Fevil.test%2F' } },
        { name: 'browser_click', args: { target: 'e5' } },
        { name: 'browser_tabs', args: { action: 'select', index: 1 } },
        { name: 'browser_file_upload', args: { paths: [upload] } },
        { name: 'browser_evaluate', args: { function: '() => document.forms[0].submit()' } },
      ],
      answers: ['rejected', 'allowed-once', 'rejected', 'rejected', 'cancelled'],
    })

    // Each call is listed with the URL of the tab it ran on; the denied writes never reached the browser. Each write on
    // the allowed site first reads the page's snapshot for a masked field.
    expect((await calls()).map(call => `${call.name} ${call.url}`)).toEqual([
      'browser_navigate about:blank',
      'browser_snapshot http://allowed.test/inbox',
      'browser_click http://allowed.test/inbox',
      'browser_snapshot http://allowed.test/inbox',
      'browser_click http://allowed.test/inbox',
      'browser_snapshot http://allowed.test/inbox',
      'browser_click http://allowed.test/inbox',
      'browser_tabs http://other.test/next',
      'browser_tabs http://allowed.test/compose',
      'browser_click http://other.test/next',
      'browser_navigate http://other.test/next',
      'browser_tabs http://evil.test/',
    ])
    expect(asked).toEqual([
      'Browser write: browser_type on http://other.test. Arguments: "target": "e2", "text": "hi\\nthere". Model-written target description: "Message".',
      'Browser write: browser_click on http://other.test. Arguments: "target": "e3". Model-written target description: "Send".',
      'Browser write: browser_click on http://evil.test. Arguments: "target": "e5".',
      `Browser write: browser_file_upload on http://allowed.test. Arguments: "paths": [${JSON.stringify(upload)}]. Files sent: "tax.pdf" (3 bytes, SHA-256 ${PDF_SHA256.slice(0, 12)}). Site allowances do not cover this action.`,
      'Browser write: browser_evaluate on http://allowed.test. Arguments: "function": "() => document.forms[0].submit()". Site allowances do not cover this action.',
    ])
    const results = toolResults(events)
    expect(results[4]).toEqual([{ type: 'text', text: 'Error: The user declined browser_type on http://other.test.' }])
    expect(results[12]).toEqual([{ type: 'text', text: 'Error: tool call aborted before dispatch' }])
    expect(consentRecords(events)).toEqual([
      { callId: 'call-1', tool: 'browser_click', site: 'http://allowed.test', grant: 'site', outcome: 'succeeded' },
      { callId: 'call-2', tool: 'browser_click', site: 'http://allowed.test', grant: 'site', outcome: 'failed' },
      { callId: 'call-3', tool: 'browser_click', site: 'http://allowed.test', grant: 'site', outcome: 'succeeded' },
      { callId: 'call-7', tool: 'browser_click', site: 'http://other.test', grant: 'approval', outcome: 'succeeded' },
    ])
    expect((await readdir(join(root, '.playwright-mcp'))).sort()).toEqual(['console-2.log', 'page-1.yml', 'page-2.yml', 'page-3.yml'])
    // The declined upload's copy is gone.
    expect(await readdir(staging)).toEqual([])
  })

  it('denies a write that a listener ahead of consent allowed, and loses its browser when consent unloads', { timeout: 60_000 }, async () => {
    const { ctx, agent, asked, calls, consentFiber } = await load()
    // Registered after consent with `prepend`, so it runs first and never delegates.
    ctx.on('tools/pre-execute', (): Promise<PreToolDecision> => Promise.resolve({ kind: 'allow' }), { prepend: true })
    const click = () => executeModelToolFixture(ctx, {
      agent, name: tool('browser_click'), arguments: { element: 'Buy', target: 'e9' }, callId: ToolCallId('direct'), signal: new AbortController().signal,
    })
    expect((await click()).content).toEqual([{ type: 'text', text: 'Error: browser_click needs the user\'s consent, which was not given.' }])
    expect(asked).toEqual([])
    expect(await calls()).toEqual([])

    // At each tool change during unload, record whether browser tools remain and whether the guard still denies a write.
    const probe: ToolExecution = { callId: ToolCallId('probe'), rootCallId: ToolCallId('probe'), token: Symbol('probe') as ToolExecutionToken, name: tool('browser_click'), arguments: {}, agent, signal: new AbortController().signal }
    const changes: string[] = []
    ctx.on('tools/change', () => { changes.push(`${String(ctx.tools.schemas(agent).some(schema => schema.name.startsWith(tool(''))))}/${String(ctx.tools.checkGuards(probe) !== undefined)}`) })
    await consentFiber!.dispose()
    expect(changes.find(change => change.startsWith('false/'))).toBe('false/true')
    expect(ctx.browserUse.providerName).toBeUndefined()
    expect((await click()).error?.info?.code).toBe('UNKNOWN_TOOL')
    expect(await calls()).toEqual([])
  })

  it('denies a write whose approval a listener ahead of consent asked for', { timeout: 60_000 }, async () => {
    const loaded = await load({ script: [{ name: 'browser_click', args: { target: 'e1' } }], answers: ['allowed-once'] })
    loaded.ctx.on('tools/pre-execute', (): Promise<PreToolDecision> => Promise.resolve({ kind: 'ask', reason: 'Another policy asks.' }), { prepend: true })
    loaded.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Go.' }], source: { kind: 'user' } }))
    await loaded.agent.whenIdle()
    const { asked, events, calls } = loaded
    expect(asked).toEqual(['Another policy asks.'])
    expect(toolResults(events)[0]).toEqual([{ type: 'text', text: 'Error: browser_click needs the user\'s consent, which was not given.' }])
    expect((await calls()).map(call => call.name)).toEqual([])
  })

  it('denies writes under the never policy, when the person does not answer in time, and when no answerer can', { timeout: 60_000 }, async () => {
    const never = await turn({ approvalPolicy: 'never', script: [{ name: 'browser_click', args: { target: 'e1' } }] })
    expect(toolResults(never.events)[0]).toEqual([{ type: 'text', text: 'Error: Approval prompts are disabled in this session, so browser_click on an unidentified page did not run.' }])
    const unanswered = await turn({ consent: { approvalTimeoutMs: 50 }, script: [{ name: 'browser_click', args: { target: 'e1' } }], answers: ['hang'] })
    expect(toolResults(unanswered.events)[0]).toEqual([{ type: 'text', text: 'Error: browser_click on an unidentified page got no answer from the user within 0.05 seconds.' }])
    expect(await unanswered.calls()).toEqual([])
    const unavailable = await turn({ script: [{ name: 'browser_click', args: { target: 'e1' } }], answers: ['unavailable'] })
    expect(toolResults(unavailable.events)[0]).toEqual([{ type: 'text', text: 'Error: browser_click on an unidentified page needs the user\'s approval, and no approval channel is available.' }])
  })

  it('denies writes when no one can be asked, and Agent-less writes outright', { timeout: 60_000 }, async () => {
    const { ctx, agent, calls } = await load({ withoutApproval: true })
    const run = (name: string, owner?: typeof agent) => executeModelToolFixture(ctx, {
      ...owner === undefined ? {} : { agent: owner }, name, arguments: { target: 'e1' }, callId: ToolCallId('direct'), signal: new AbortController().signal,
    })
    expect((await run(tool('browser_click'), agent)).content).toEqual([{ type: 'text', text: 'Error: browser_click on an unidentified page needs the user\'s approval, and no approval channel is available.' }])
    expect((await run(tool('browser_unknown'), agent)).content).toEqual([{ type: 'text', text: 'Error: browser_unknown on an unidentified page needs the user\'s approval, and no approval channel is available.' }])
    expect((await run(tool('browser_click'))).content).toEqual([{ type: 'text', text: 'Error: browser_click needs the user\'s consent, which was not given.' }])
    expect(await calls()).toEqual([])
    // Other tools are not this plugin's to gate.
    expect((await run('other_tool', agent)).error?.info?.code).toBe('UNKNOWN_TOOL')
  })

  it('mounts no browser when its config is invalid', { timeout: 60_000 }, async () => {
    for (const consent of [
      { allowedSites: ['https://mail.google.com/'] }, { browser: { mode: 'attach', endpoint: 'http://localhost:bad/path' } },
      { deniedUrls: undefined }, { deniedUrls: ['https://accounts.google.com/'] }, { allowedSites: ['https://accounts.google.com'] },
      { browser: { mode: 'attach', endpoint: 'http://127.0.0.1:9', outputDir: 'playwright-output' } },
      { browser: { mode: 'attach', endpoint: 'http://127.0.0.1:9' } }, { uploadStaging: undefined }, { uploadStaging: tmpdir() },
    ]) {
      const invalid = await load({ consent })
      expect(invalid.consentFiber?.state).toBe(FAILED)
      expect(invalid.ctx.browserUse.providerName).toBeUndefined()
      expect(browserTools(invalid)).toEqual([])
    }
  })

  it('mounts no browser when the subprocess service refuses the server\'s identity, and Sessions still start', { timeout: 60_000 }, async () => {
    const checked: string[] = []
    const subprocess = { apply(ctx: Context) {
      ctx.provide('subprocess', { serverHome(identity: string): never {
        checked.push(identity)
        throw new Error(`subprocess-local: identities.${identity} set.HOME "/home/${identity}" must be writable by no other user`)
      } })
    } }
    const browser = { mode: 'attach', endpoint: 'http://127.0.0.1:9', identity: 'browsermcp', outputDir: '/var/lib/mumbo/playwright-output' }
    // The composition creates its Session after load, which rejects when a Session's creation fails.
    const refused = await load({ before: [['subprocess', subprocess]], consent: { browser } })
    expect(checked).toEqual(['browsermcp'])
    expect(refused.consentFiber?.state).toBe(ACTIVE)
    expect(refused.errors).toContainEqual(expect.stringContaining('subprocess-local: identities.browsermcp set.HOME "/home/browsermcp" must be writable by no other user'))
    expect(refused.ctx.browserUse.providerName).toBeUndefined()
    expect(browserTools(refused)).toEqual([])
  })

  it('mounts the browser of a server identity only once a subprocess service is mounted', { timeout: 60_000 }, async () => {
    const browser = { mode: 'attach', endpoint: 'http://127.0.0.1:9', identity: 'browsermcp', outputDir: '/var/lib/mumbo/playwright-output' }
    const waiting = await load({ consent: { browser } })
    expect(waiting.consentFiber?.state).toBe(ACTIVE)
    expect(waiting.errors).toEqual([])
    expect(waiting.ctx.browserUse.providerName).toBeUndefined()
    expect(browserTools(waiting)).toEqual([])
  })

  it('refuses every tool of a provider row that loaded ahead of consent', { timeout: 60_000 }, async () => {
    const rival = { inject: PlaywrightBrowser.inject, async apply(ctx: Context) {
      await ctx.plugin(PlaywrightBrowser, { mode: 'attach', endpoint: 'http://127.0.0.1:9' })
      ctx.provide('rivalReady', {})
    } }
    const { consentFiber, ctx, agent, events, calls, asked } = await turn({
      before: [['rival', rival]], inject: { consent: ['rivalReady'] },
      script: [{ name: 'browser_snapshot', args: {} }, { name: 'browser_click', args: { target: 'e1' } }], answers: ['allowed-once'],
    })
    expect(consentFiber?.state).toBe(ACTIVE)
    expect(ctx.browserUse.providerName).toBe('playwright-mcp')
    expect(toolResults(events)).toEqual(['browser_snapshot', 'browser_click'].map(name => [{
      type: 'text', text: `Error: ${tool(name)} did not run: browser tools are disabled because this browser was set up without consent checks.`,
    }]))
    expect(asked).toEqual([])
    expect(await calls()).toEqual([])
    const other = await executeModelToolFixture(ctx, { agent, name: 'other_tool', arguments: {}, callId: ToolCallId('other'), signal: new AbortController().signal })
    expect(other.error?.info?.code).toBe('UNKNOWN_TOOL')
  })

  it('refuses the tools of a differently named provider row that takes the browser right after consent loads', { timeout: 60_000 }, async () => {
    const devtools = { inject: PlaywrightBrowser.inject, apply(ctx: Context) {
      mountSessionMcp(ctx, { name: 'chrome-devtools-mcp', exclusive: true, command: process.execPath, args: [] })
    } }
    const { consentFiber, ctx, agent, errors, calls } = await load({ after: [['devtools', devtools]] })
    expect(consentFiber?.state).toBe(ACTIVE)
    expect(ctx.browserUse.providerName).toBe('chrome-devtools-mcp')
    expect(errors).toContainEqual(expect.stringContaining('browser provider "chrome-devtools-mcp" holds browserUse without mumbo-browser-consent, so its tools (mcp__chrome-devtools-mcp__*) are refused'))
    for (const name of ['browser_click', 'browser_snapshot']) {
      const result = await executeModelToolFixture(ctx, { agent, name: `mcp__chrome-devtools-mcp__${name}`, arguments: {}, callId: ToolCallId(name), signal: new AbortController().signal })
      expect(result.content).toEqual([{ type: 'text', text: `Error: mcp__chrome-devtools-mcp__${name} did not run: browser tools are disabled because this browser was set up without consent checks.` }])
    }
    expect(await calls()).toEqual([])
  })

  it('refuses a known non-MCP provider by its tool prefix, and fails or reports truthfully for an unknown one', { timeout: 60_000 }, async () => {
    let acted = false
    const holder = (providerName: string) => ({ inject: ['browserUse', 'tools'], apply(ctx: Context) {
      ctx.effect(() => ctx.browserUse.register(BrowserUseProviderName(providerName)))
      ctx.tools.register(defineContentToolFixture({ name: 'stagehand_act', description: 'Act.', parameters: {}, execute: () => {
        acted = true
        return Promise.resolve([{ type: 'text', text: 'acted' }])
      } }))
      ctx.provide('rivalReady', {})
    } })
    const stagehand = await load({ before: [['stagehand', holder('stagehand-native')]], inject: { consent: ['rivalReady'] } })
    expect(stagehand.consentFiber?.state).toBe(ACTIVE)
    expect(stagehand.errors).toContainEqual(expect.stringContaining('"stagehand-native" holds browserUse without mumbo-browser-consent, so its tools (stagehand_*) are refused'))
    const act = await executeModelToolFixture(stagehand.ctx, { agent: stagehand.agent, name: 'stagehand_act', arguments: {}, callId: ToolCallId('act'), signal: new AbortController().signal })
    expect(act.content).toEqual([{ type: 'text', text: 'Error: stagehand_act did not run: browser tools are disabled because this browser was set up without consent checks.' }])
    expect(acted).toBe(false)

    const unknownFirst = await load({ before: [['mystery', holder('mystery')]], inject: { consent: ['rivalReady'] } })
    expect(unknownFirst.consentFiber?.state).toBe(FAILED)
    expect(unknownFirst.errors).toContainEqual(expect.stringContaining('browser provider "mystery" holds browserUse and its tools have no prefix this plugin can refuse'))

    const late = { inject: PlaywrightBrowser.inject, apply(ctx: Context) { ctx.effect(() => ctx.browserUse.register(BrowserUseProviderName('mystery'))) } }
    const unknownLate = await load({ after: [['mystery', late]] })
    expect(unknownLate.consentFiber?.state).toBe(ACTIVE)
    expect(unknownLate.ctx.browserUse.providerName).toBe('mystery')
    const report = unknownLate.errors.find(error => error.includes('"mystery" holds browserUse'))
    expect(report).toContain('its tools are not under consent')
    expect(report).not.toContain('refused')
  })
  it('refuses a call that names a denied page before the browser sees it, without asking', { timeout: 60_000 }, async () => {
    const loaded = await load({ answers: [] })
    const bypasses = [
      'chrome://password-manager/passwords', 'CHROME://settings/passwords', 'about:settings', 'chrome-untrusted://print/',
      'chrome-extension://abcdefghijklmnop/popup.html', 'devtools://devtools/bundled/inspector.html', 'view-source:http://allowed.test/',
      'file:///home/browser/.config/google-chrome/Default/Login%20Data', 'https://passwords.google.com/', 'https://pay.google.com/',
      'https://payments.google.com/', 'https://myaccount.google.com/security', 'HTTPS://Accounts.Google.com./', 'https://accounts.google.com:443/',
      'https://x@accounts.google.com/', 'http://accounts.google.com/Logout', 'accounts.google.com', 'https://accounts%2Egoogle.com/',
      'https://ａｃｃｏｕｎｔｓ.google.com/', 'blob:https://accounts.google.com/0f8c',
    ]
    for (const url of bypasses) {
      for (const [name, args] of [['browser_navigate', { url }], ['browser_tabs', { action: 'new', url }]] as const) {
        expect(textOf(await direct(loaded, tool(name), args))).toMatch(new RegExp(`^Error: ${name} did not run: the assistant may not open (a [a-z-]+: page|a page on https://[a-z.]+\\.google\\.com|a page whose address cannot be read)\\.$`, 'u'))
      }
    }
    expect(textOf(await direct(loaded, tool('browser_navigate'), { url: 'https://accounts.google.com/' })))
      .toBe('Error: browser_navigate did not run: the assistant may not open a page on https://accounts.google.com.')
    expect(textOf(await direct(loaded, tool('browser_navigate'), { url: 'about:settings' }))).toBe('Error: browser_navigate did not run: the assistant may not open a chrome: page.')
    const details = 'Error: browser_network_request did not run: the assistant may not read request headers or bodies, which carry cookies and passwords.'
    expect(textOf(await direct(loaded, tool('browser_network_request'), { index: 1 }))).toBe(details)
    const saved = 'Error: browser_snapshot did not run: the assistant may not save browser output to a file; call it without filename to get the result directly.'
    expect(textOf(await direct(loaded, tool('browser_snapshot'), { filename: 'notes/page.yml' }))).toBe(saved)
    const serverCode = 'Error: browser_run_code_unsafe did not run: code may not run in the browser automation process; browser_evaluate runs a function in the page and asks the user first.'
    expect(textOf(await direct(loaded, tool('browser_run_code_unsafe'), { code: 'async (page) => page.title()' }))).toBe(serverCode)
    expect(await loaded.calls()).toEqual([])
    // Other origins open, and so does a blank new tab.
    for (const url of ['http://allowed.test/', 'https://mail.google.com/', 'https://accounts.google.com.evil.test/']) {
      expect(textOf(await direct(loaded, tool('browser_navigate'), { url }))).toBe(`### Page\n- Page URL: ${url}\n- Page Title: Fixture page`)
    }
    expect((await direct(loaded, tool('browser_tabs'), { action: 'new' })).isError).toBe(false)
    expect((await loaded.calls()).map(call => call.args)).toEqual([
      ...['http://allowed.test/', 'https://mail.google.com/', 'https://accounts.google.com.evil.test/'].map(url => ({ url })), { action: 'new' },
    ])
    // The guard refuses the same call when a listener ahead of consent allows it, and when no Agent makes it.
    loaded.ctx.on('tools/pre-execute', (): Promise<PreToolDecision> => Promise.resolve({ kind: 'allow' }), { prepend: true })
    expect(textOf(await direct(loaded, tool('browser_navigate'), { url: 'chrome://settings/passwords' }))).toBe('Error: browser_navigate did not run: the assistant may not open a chrome: page.')
    expect(textOf(await direct(loaded, tool('browser_navigate'), { url: 'chrome://settings/passwords' }, false))).toBe('Error: browser_navigate did not run: the assistant may not open a chrome: page.')
    expect(textOf(await direct(loaded, tool('browser_network_request'), { index: 1 }))).toBe(details)
    expect(textOf(await direct(loaded, tool('browser_snapshot'), { filename: 'notes/page.yml' }))).toBe(saved)
    expect(textOf(await direct(loaded, tool('browser_run_code_unsafe'), { code: 'async (page) => page.title()' }))).toBe(serverCode)
    expect((await direct(loaded, tool('browser_network_requests'), {})).isError).toBe(false)
    expect(loaded.asked).toEqual([])
    expect((await loaded.calls()).map(call => call.name)).toEqual(['browser_navigate', 'browser_navigate', 'browser_navigate', 'browser_tabs', 'browser_network_requests'])
  })

  it('sends files only from directly in the upload directory, refusing every other path before asking anyone', { timeout: 60_000 }, async () => {
    const downloads = await mkdtemp(join(tmpdir(), 'mumbo-browser-consent-downloads-'))
    roots.push(downloads)
    const loaded = await load({ consent: { uploadDirectory: downloads } })
    const secret = join(loaded.root, 'Login Data')
    await writeFile(secret, 'passwords')
    await mkdir(join(downloads, 'folder'))
    await writeFile(join(downloads, 'folder', 'scan.pdf'), 'pdf')
    await symlink(secret, join(downloads, 'tax.pdf'))
    const outside = (path: string) => `${JSON.stringify(path)} is not directly in ${downloads}; put the file directly in ${downloads} and retry`
    for (const [name, args, why] of [
      ['browser_file_upload', { paths: [secret] }, outside(secret)],
      ['browser_drop', { target: 'e1', paths: [`${downloads}/../${relative(dirname(downloads), secret)}`] }, outside(`${downloads}/../${relative(dirname(downloads), secret)}`)],
      ['browser_file_upload', { paths: [join(downloads, 'folder', 'scan.pdf')] }, outside(join(downloads, 'folder', 'scan.pdf'))],
      ['browser_file_upload', { paths: [join(downloads, 'tax.pdf')] }, `${JSON.stringify(join(downloads, 'tax.pdf'))} is a symbolic link, not a regular file`],
      ['browser_file_upload', { paths: [join(downloads, 'missing.pdf')] }, `${JSON.stringify(join(downloads, 'missing.pdf'))} does not exist`],
    ] as const) {
      const refusal = `Error: ${name} did not run: ${why}.`
      expect(textOf(await direct(loaded, tool(name), args))).toBe(refusal)
    }
    // The guard refuses a path not directly in the directory when a listener ahead of consent would allow it.
    const allow = loaded.ctx.on('tools/pre-execute', (): Promise<PreToolDecision> => Promise.resolve({ kind: 'allow' }), { prepend: true })
    expect(textOf(await direct(loaded, tool('browser_file_upload'), { paths: [secret] }))).toBe(`Error: browser_file_upload did not run: ${outside(secret)}.`)
    allow()
    expect(loaded.asked).toEqual([])
    expect(await loaded.calls()).toEqual([])
    expect(await readdir(loaded.staging)).toEqual([])
  })

  it('sends the copy it staged and asked about, whatever replaces the original during the ask, and refuses that copy as an input', { timeout: 60_000 }, async () => {
    const downloads = await mkdtemp(join(tmpdir(), 'mumbo-browser-consent-downloads-'))
    roots.push(downloads)
    const upload = join(downloads, 'tax.pdf')
    await writeFile(upload, 'pdf')
    // The model's shell swaps the file while the person reads the question.
    const swap = async (): Promise<'allowed-once'> => {
      await writeFile(upload, 'swapped')
      return 'allowed-once'
    }
    const loaded = await turn({
      consent: { uploadDirectory: downloads }, start: 'http://allowed.test/', answers: [swap],
      script: [{ name: 'browser_file_upload', args: { paths: [upload] } }],
    })
    expect(loaded.asked).toEqual([
      `Browser write: browser_file_upload on http://allowed.test. Arguments: "paths": [${JSON.stringify(upload)}]. Files sent: "tax.pdf" (3 bytes, SHA-256 ${PDF_SHA256.slice(0, 12)}). Site allowances do not cover this action.`,
    ])
    const [sent] = (await loaded.calls()) as Array<{ name: string; args: { paths: string[] }; files: string[] }>
    expect(sent!.name).toBe('browser_file_upload')
    const [copy] = sent!.args.paths
    expect(copy).toMatch(new RegExp(`^${loaded.staging}/[0-9a-f]{32}/tax\\.pdf$`, 'u'))
    expect(sent!.files).toEqual(['pdf'])
    expect(consentRecords(loaded.events)).toEqual([{ callId: 'call-0', tool: 'browser_file_upload', site: 'http://allowed.test', grant: 'approval', outcome: 'succeeded' }])
    // The Session log keeps the model's own arguments.
    expect(JSON.stringify(loaded.events)).not.toContain(loaded.staging)
    // The copy stays for the browser to read after the call; naming it is refused before any question.
    expect(await readFile(copy!, 'utf8')).toBe('pdf')
    expect(textOf(await direct(loaded, tool('browser_file_upload'), { paths: [copy] })))
      .toBe(`Error: browser_file_upload did not run: ${JSON.stringify(copy)} is not directly in ${downloads}; put the file directly in ${downloads} and retry.`)
    expect(loaded.asked).toHaveLength(1)
    // Unloading consent deletes its copies; loading it again clears what a crash left.
    await loaded.consentFiber!.dispose()
    expect(await readdir(loaded.staging)).toEqual([])
    await mkdir(join(loaded.staging, 'left-over'))
    const again = await load({ root: loaded.root, consent: { uploadDirectory: downloads } })
    expect(again.consentFiber?.state).toBe(ACTIVE)
    expect(await readdir(loaded.staging)).toEqual([])
  })

  it('logs a staged copy it cannot delete when it unloads', { timeout: 60_000 }, async () => {
    const downloads = await mkdtemp(join(tmpdir(), 'mumbo-browser-consent-downloads-'))
    roots.push(downloads)
    await writeFile(join(downloads, 'tax.pdf'), 'pdf')
    const loaded = await turn({
      consent: { uploadDirectory: downloads }, start: 'http://allowed.test/', answers: ['allowed-once'],
      script: [{ name: 'browser_file_upload', args: { paths: [join(downloads, 'tax.pdf')] } }],
    })
    const [nonce] = await readdir(loaded.staging)
    // The staging path names a file by the time consent unloads, so the copy's directory cannot be reached.
    await rename(loaded.staging, `${loaded.staging}-moved`)
    await writeFile(loaded.staging, '')
    await loaded.consentFiber!.dispose()
    expect(loaded.errors).toContainEqual(expect.stringContaining(`could not delete the staged upload copy ${join(loaded.staging, nonce!)}: Error: ENOTDIR`))
  })

  it('keeps copies within four times the upload limit, deletes them after a day, and refuses a call whose files alone pass it', { timeout: 60_000 }, async () => {
    const downloads = await mkdtemp(join(tmpdir(), 'mumbo-browser-consent-downloads-'))
    roots.push(downloads)
    for (const name of ['a', 'b', 'c', 'd', 'e']) await writeFile(join(downloads, name), 'four')
    const staging = join(downloads, '..', `${basename(downloads)}-staging`)
    await mkdir(staging, { mode: 0o700 })
    roots.push(staging)
    /** The names of the staged copies at each question. */
    const seen: string[][] = []
    const kept = async () => (await Promise.all((await readdir(staging)).map(nonce => readdir(join(staging, nonce))))).flat().sort()
    const allow = async (): Promise<'allowed-once'> => {
      seen.push(await kept())
      return 'allowed-once'
    }
    // At the third question a day and an hour pass, so every earlier copy goes before the next one is staged.
    const now = Date.now()
    const later = async (): Promise<'allowed-once'> => {
      vi.spyOn(Date, 'now').mockReturnValue(now + 25 * 60 * 60 * 1000)
      return allow()
    }
    onTestFinished(() => { vi.restoreAllMocks() })
    const send = (...names: string[]) => ({ name: 'browser_file_upload', args: { paths: names.map(name => join(downloads, name)) } })
    const { events, asked } = await turn({
      consent: { uploadDirectory: downloads, uploadStaging: staging, uploadMaxBytes: 4 }, start: 'http://allowed.test/', answers: [allow, allow, later, allow],
      script: [send('a', 'b'), send('c', 'd'), send('e'), send('a'), send('a', 'b', 'c', 'd', 'e')],
    })
    // Four copies of four bytes fill the sixteen; the fifth makes room by deleting the oldest.
    expect(seen).toEqual([['a', 'b'], ['a', 'b', 'c', 'd'], ['b', 'c', 'd', 'e'], ['a']])
    expect(asked).toHaveLength(4)
    // One call's own files are never deleted for each other: five of them pass the sixteen, so the call is refused.
    expect(toolResults(events)[4]).toEqual([{ type: 'text', text: 'Error: browser_file_upload did not run: the files of one call may not pass 16 bytes in total.' }])
    expect(await kept()).toEqual([])
  })

  it('withholds the result of every call that leaves or finds the tab on a denied page, and refuses writes there', { timeout: 60_000 }, async () => {
    const { asked, events, calls, root } = await turn({
      start: 'https://passwords.google.com/',
      script: [
        { name: 'browser_snapshot', args: {} },
        { name: 'browser_tabs', args: { action: 'select', index: 0 } },
        { name: 'browser_click', args: { element: 'Show password', target: 'e1' } },
        { name: 'browser_evaluate', args: { function: '() => document.querySelector("input").value' } },
        { name: 'browser_navigate', args: { url: 'http://allowed.test/' } },
        { name: 'browser_click', args: { element: 'Sign in](elsewhere.yml)', target: 'link:https://accounts.google.com/signin' } },
        { name: 'browser_navigate', args: { url: 'http://allowed.test/' } },
        { name: 'browser_click', args: { element: 'Settings', target: 'report:chrome://settings/passwords' } },
      ],
    })
    const withheld = (name: string, page: string) => [{ type: 'text', text: `Error: ${name} ran, but its result is withheld: the current tab is ${page}, which the assistant may not use. Open another page to continue.` }]
    expect(toolResults(events)).toEqual([
      withheld('browser_snapshot', 'a page on https://passwords.google.com'),
      [{ type: 'text', text: 'Error: browser_tabs did not run: that tab is a page on https://passwords.google.com, which the assistant may not use.' }],
      [{ type: 'text', text: 'Error: browser_click did not run: the current tab is a page on https://passwords.google.com, which the assistant may not use.' }],
      [{ type: 'text', text: 'Error: browser_evaluate did not run: the current tab is a page on https://passwords.google.com, which the assistant may not use.' }],
      [{ type: 'text', text: '### Page\n- Page URL: http://allowed.test/\n- Page Title: Fixture page' }],
      withheld('browser_click', 'a page on https://accounts.google.com'),
      [{ type: 'text', text: '### Page\n- Page URL: http://allowed.test/\n- Page Title: Fixture page' }],
      withheld('browser_click', 'a chrome: page'),
    ])
    expect(asked).toEqual([])
    expect((await calls()).map(call => `${call.name} ${call.url}`)).toEqual([
      'browser_snapshot https://passwords.google.com/',
      'browser_navigate https://passwords.google.com/',
      'browser_snapshot http://allowed.test/',
      'browser_click http://allowed.test/',
      'browser_navigate https://accounts.google.com/signin',
      'browser_snapshot http://allowed.test/',
      'browser_click http://allowed.test/',
    ])
    expect(consentRecords(events)).toEqual([
      { callId: 'call-5', tool: 'browser_click', site: 'http://allowed.test', grant: 'site', outcome: 'failed' },
      { callId: 'call-7', tool: 'browser_click', site: 'http://allowed.test', grant: 'site', outcome: 'failed' },
    ])
    // The snapshot files Playwright wrote for the withheld clicks are gone, so no other tool can read them.
    expect(await readdir(join(root, '.playwright-mcp'))).toEqual([])
  })

  it('withholds a result and refuses writes when the current tab cannot be read', { timeout: 60_000 }, async () => {
    const unchecked = (name: string, why: string) => [{ type: 'text', text: `Error: ${name}: the browser's current tab could not be checked after the call (${why}), so its result is withheld.` }]
    const withoutTabs = await turn({ withoutTabs: true, script: [{ name: 'browser_navigate', args: { url: 'http://allowed.test/' } }, { name: 'browser_click', args: { target: 'e1' } }] })
    expect(toolResults(withoutTabs.events)).toEqual([
      unchecked('browser_navigate', 'the browser has no browser_tabs tool'),
      [{ type: 'text', text: 'Error: browser_click did not run: the browser\'s current tab could not be checked (the browser has no browser_tabs tool).' }],
    ])
    expect(withoutTabs.asked).toEqual([])
    expect((await withoutTabs.calls()).map(call => call.name)).toEqual(['browser_navigate'])
    // A listing that fails, here on the fixture's broken page, withholds the result too.
    const broken = await turn({ script: [{ name: 'browser_navigate', args: { url: 'http://broken.test/' } }] })
    expect(toolResults(broken.events)).toEqual([unchecked('browser_navigate', 'browser_tabs failed: fixture failure')])
  })

  it('asks before a write on an allowed site whose page shows a masked field or cannot be checked', { timeout: 60_000 }, async () => {
    const { asked, events, calls } = await turn({
      script: [
        { name: 'browser_navigate', args: { url: 'http://allowed.test/login' } },
        { name: 'browser_click', args: { element: 'Sign in', target: 'e1' } },
        { name: 'browser_type', args: { element: 'Password', target: 'e2', text: 'x' } },
        { name: 'browser_navigate', args: { url: 'http://allowed.test/nosnap' } },
        { name: 'browser_click', args: { element: 'Next', target: 'e3' } },
        { name: 'browser_navigate', args: { url: 'http://allowed.test/inbox' } },
        { name: 'browser_click', args: { element: 'Archive', target: 'e4' } },
      ],
      answers: ['allowed-once', 'rejected', 'rejected'],
    })
    const masked = ' The page shows a password or payment field, so its site allowance does not cover this action.'
    expect(asked).toEqual([
      `Browser write: browser_click on http://allowed.test. Arguments: "target": "e1". Model-written target description: "Sign in".${masked}`,
      `Browser write: browser_type on http://allowed.test. Arguments: "target": "e2", "text": "x". Model-written target description: "Password".${masked}`,
      'Browser write: browser_click on http://allowed.test. Arguments: "target": "e3". Model-written target description: "Next".'
        + ' The page could not be checked for password or payment fields, so its site allowance does not cover this action.',
    ])
    expect(toolResults(events)[2]).toEqual([{ type: 'text', text: 'Error: The user declined browser_type on http://allowed.test.' }])
    expect((await calls()).filter(call => call.name !== 'browser_snapshot' && call.name !== 'browser_navigate').map(call => `${call.name} ${call.url}`))
      .toEqual(['browser_click http://allowed.test/login', 'browser_click http://allowed.test/inbox'])
    expect(consentRecords(events)).toEqual([
      { callId: 'call-1', tool: 'browser_click', site: 'http://allowed.test', grant: 'approval', outcome: 'succeeded' },
      { callId: 'call-6', tool: 'browser_click', site: 'http://allowed.test', grant: 'site', outcome: 'succeeded' },
    ])
  })

  it('refuses console and request logs once any tab has shown a denied page', { timeout: 60_000 }, async () => {
    const logs = (name: string) => [{ type: 'text', text: `Error: ${name} did not run: a tab in this browser has shown a page the assistant may not use, and console and request logs keep that page's entries.` }]
    // A click lands on a denied page; after the tab moves on, its logs may still hold that page's entries.
    const landed = await turn({
      script: [
        { name: 'browser_navigate', args: { url: 'http://allowed.test/' } },
        { name: 'browser_network_requests', args: {} },
        { name: 'browser_click', args: { element: 'Sign in', target: 'link:https://accounts.google.com/' } },
        { name: 'browser_navigate', args: { url: 'http://allowed.test/' } },
        { name: 'browser_console_messages', args: { all: true } },
        { name: 'browser_network_requests', args: {} },
      ],
    })
    const results = toolResults(landed.events)
    expect(results[1]).toEqual([{ type: 'text', text: '### Page\n- Page URL: http://allowed.test/\n- Page Title: Fixture page' }])
    expect(results.slice(4)).toEqual([logs('browser_console_messages'), logs('browser_network_requests')])
    // The person's own tab on a denied page, seen only in a listing, does the same.
    const listed = await turn({
      start: 'https://passwords.google.com/',
      script: [{ name: 'browser_tabs', args: { action: 'new', url: 'http://allowed.test/' } }, { name: 'browser_network_requests', args: {} }],
    })
    expect(toolResults(listed.events)[1]).toEqual(logs('browser_network_requests'))
    expect((await listed.calls()).map(call => call.name)).toEqual(['browser_tabs'])
  })

  it('asks before a desktop screenshot while the browser shows a denied page, and refuses selecting a tab it cannot check', { timeout: 60_000 }, async () => {
    const desktop = { inject: ['tools'], apply(ctx: Context) {
      ctx.tools.register(defineContentToolFixture({
        name: 'computer', description: 'Desktop.', parameters: { action: { type: 'string', required: true } },
        execute: args => Promise.resolve([{ type: 'text', text: `${args.action} done` }]),
      }))
    } }
    const loaded = await turn({
      before: [['desktop', desktop]], start: 'https://passwords.google.com/', answers: ['rejected', 'allowed-once'],
      script: [
        { name: 'browser_snapshot', args: {} },
        { name: 'computer', args: { action: 'screenshot' } },
        { name: 'computer', args: { action: 'screenshot' } },
        { name: 'browser_tabs', args: { action: 'select', index: 7 } },
        { name: 'browser_navigate', args: { url: 'http://allowed.test/' } },
        { name: 'computer', args: { action: 'screenshot' } },
      ],
    })
    expect(loaded.asked).toEqual(Array.from({ length: 2 }, () => 'Desktop screenshot while the browser\'s current tab is a page on https://passwords.google.com, which the assistant may not use. Arguments: "action": "screenshot".'))
    const results = toolResults(loaded.events)
    expect(results.slice(1, 3)).toEqual([[{ type: 'text', text: 'Error: The user declined the desktop screenshot.' }], [{ type: 'text', text: 'screenshot done' }]])
    expect(results[3]).toEqual([{ type: 'text', text: 'Error: browser_tabs did not run: the tab it selects could not be checked (the tab listing does not show it unambiguously).' }])
    expect(results[5]).toEqual([{ type: 'text', text: 'screenshot done' }])
    // A click on the allowed page lands on a denied one. The guard then denies a screenshot that a listener ahead of
    // consent allowed, and a select that skipped the check.
    expect(textOf(await direct(loaded, tool('browser_click'), { target: 'link:https://pay.google.com/' }))).toMatch(/^Error: browser_click ran, but its result is withheld/u)
    loaded.ctx.on('tools/pre-execute', (): Promise<PreToolDecision> => Promise.resolve({ kind: 'allow' }), { prepend: true })
    expect(textOf(await direct(loaded, 'computer', { action: 'screenshot' }))).toBe('Error: computer input needs the user\'s consent, which was not given.')
    expect(textOf(await direct(loaded, tool('browser_tabs'), { action: 'select', index: 0 }))).toBe('Error: browser_tabs did not run: the tab it selects was not checked.')
  })

  it('refuses a select or write it cannot check, and withholds a listing of a denied tab', { timeout: 60_000 }, async () => {
    const broken = await turn({ start: 'http://allowed.test/broken', script: [{ name: 'browser_tabs', args: { action: 'select', index: 0 } }] })
    expect(toolResults(broken.events)[0]).toEqual([{ type: 'text', text: 'Error: browser_tabs did not run: the tab it selects could not be checked (browser_tabs failed: fixture failure).' }])
    const unchecked = await turn({
      start: 'http://allowed.test/brackets-nosnap',
      script: [{ name: 'browser_tabs', args: { action: 'select' } }, { name: 'browser_click', args: { target: 'e1' } }],
    })
    expect(toolResults(unchecked.events)).toEqual([
      [{ type: 'text', text: 'Error: browser_tabs did not run: the tab it selects could not be checked (the tab listing does not show it unambiguously).' }],
      [{ type: 'text', text: 'Error: browser_click did not run: the browser\'s current tab could not be checked (its tab listing is ambiguous).' }],
    ])
    const listed = await turn({ start: 'https://myaccount.google.com/', script: [{ name: 'browser_tabs', args: { action: 'list' } }] })
    expect(JSON.stringify(toolResults(listed.events)[0])).toContain('ran, but its result is withheld: the current tab is a page on https://myaccount.google.com')
  })

  it('withholds a result holding other blocks, and logs a linked file it cannot delete', { timeout: 60_000 }, async () => {
    const loaded = await load({ start: 'https://pay.google.com/', script: [{ name: 'browser_snapshot', args: {} }] })
    await mkdir(join(loaded.root, '.playwright-mcp', 'folder'), { recursive: true })
    // Registered after consent, so it wraps the browser inside consent's wrapper and adds an image and a link.
    loaded.ctx.on('tools/execute', async (_exec, next) => {
      const result = await next()
      return { ...result, content: [{ type: 'image', attachment: { attachmentId: 'a', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } }, ...result.content, { type: 'text', text: '- [Snapshot](.playwright-mcp/folder)' }] } as ToolExecutionResult
    })
    loaded.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Go.' }], source: { kind: 'user' } }))
    await loaded.agent.whenIdle()
    expect(JSON.stringify(toolResults(loaded.events)[0])).toContain('ran, but its result is withheld: the current tab is a page on https://pay.google.com')
    expect(loaded.errors).toContainEqual(expect.stringContaining(`could not delete ${join(loaded.root, '.playwright-mcp', 'folder')}, which Playwright wrote for a withheld result`))
  })

  it('reads an ambiguous tab line through the page URL a result or snapshot reports', { timeout: 60_000 }, async () => {
    const { asked, events, calls } = await turn({
      script: [
        { name: 'browser_navigate', args: { url: 'http://allowed.test/brackets' } },
        { name: 'browser_click', args: { element: 'Merge', target: 'e1' } },
      ],
    })
    expect(toolResults(events)[0]).toEqual([{ type: 'text', text: '### Page\n- Page URL: http://allowed.test/brackets\n- Page Title: Fix [x](y)' }])
    expect(asked).toEqual([])
    expect((await calls()).map(call => call.name)).toEqual(['browser_navigate', 'browser_snapshot', 'browser_click'])
    expect(consentRecords(events)).toEqual([{ callId: 'call-1', tool: 'browser_click', site: 'http://allowed.test', grant: 'site', outcome: 'succeeded' }])
  })

  it('starts a desktop row that injects consent\'s service only when consent loads', { timeout: 60_000 }, async () => {
    const desktop = { inject: ['tools'], apply(ctx: Context) {
      ctx.tools.register(defineContentToolFixture({ name: 'computer', description: 'Desktop.', parameters: {}, execute: () => Promise.resolve([]) }))
    } }
    const hasComputer = (loaded: Awaited<ReturnType<typeof load>>) => loaded.ctx.tools.schemas(loaded.agent).some(schema => schema.name === 'computer')
    expect(hasComputer(await load({ after: [['desktop', desktop]], inject: { desktop: ['mumbo-browser-consent'] } }))).toBe(true)
    const invalid = await load({ consent: { deniedUrls: undefined }, after: [['desktop', desktop]], inject: { desktop: ['mumbo-browser-consent'] } })
    expect(invalid.consentFiber?.state).toBe(FAILED)
    expect(hasComputer(invalid)).toBe(false)
  })

  it('passes outputDir to the server and deletes a withheld result\'s files there', { timeout: 60_000 }, async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'mumbo-browser-consent-output-'))
    roots.push(outputDir)
    const { events, root } = await turn({
      consent: { browser: { mode: 'attach', endpoint: 'http://127.0.0.1:9', outputDir } },
      script: [
        { name: 'browser_navigate', args: { url: 'http://allowed.test/' } },
        { name: 'browser_click', args: { element: 'Next', target: 'e1' } },
        { name: 'browser_click', args: { element: 'Sign in', target: 'link:https://accounts.google.com/' } },
      ],
    })
    expect(toolResults(events)[1]).toEqual([{ type: 'text', text: `### Page\n- Page URL: http://allowed.test/\n- Page Title: Fixture page\n### Snapshot\n- [Snapshot of Next](${relative(root, join(outputDir, 'page-1.yml'))})` }])
    expect(JSON.stringify(toolResults(events)[2])).toContain('Error: browser_click ran, but its result is withheld')
    expect(await readdir(outputDir)).toEqual(['page-1.yml'])
    expect(await readdir(root)).not.toContain('.playwright-mcp')
  })

  it('replaces the result before later wrappers and post-execute policy see it', { timeout: 60_000 }, async () => {
    const loaded = await load({ start: 'https://accounts.google.com/' })
    const seen: string[] = []
    loaded.ctx.on('tools/execute', async (_exec, next) => {
      const result = await next()
      seen.push(textOf(result))
      return result
    }, { prepend: true })
    loaded.ctx.on('tools/post-execute', (_exec, result) => {
      seen.push(textOf(result))
      return Promise.resolve({ kind: 'accept' })
    }, { prepend: true })
    const result = await direct(loaded, tool('browser_snapshot'), {})
    const text = 'Error: browser_snapshot ran, but its result is withheld: the current tab is a page on https://accounts.google.com, which the assistant may not use. Open another page to continue.'
    expect(textOf(result)).toBe(text)
    expect(seen).toEqual([text, text])
  })

  it('does not list tabs after closing the browser, which would open a new tab', { timeout: 60_000 }, async () => {
    const loaded = await turn({ script: [{ name: 'browser_close', args: {} }], answers: ['allowed-once'] })
    expect(toolResults(loaded.events)).toEqual([[{ type: 'text', text: '### Result\nNo open tabs. Navigate to a URL to create one.\n### Page\n- Page URL: about:blank\n- Page Title: Fixture page' }]])
    expect((await loaded.allCalls()).map(call => `${call.name}${call.args.action === undefined ? '' : ` ${call.args.action}`}`)).toEqual(['browser_tabs list', 'browser_close'])
  })

  it('lets desktop screenshots pass and asks before every other computer input, which the guard enforces', { timeout: 60_000 }, async () => {
    const inputs: string[] = []
    const desktop = { inject: ['tools'], apply(ctx: Context) {
      ctx.tools.register(defineContentToolFixture({
        name: 'computer', description: 'Desktop.',
        parameters: { action: { type: 'string', required: true }, x: { type: 'integer' }, y: { type: 'integer' }, text: { type: 'string' } },
        execute: (args) => {
          inputs.push(args.action)
          return Promise.resolve([{ type: 'text', text: `${args.action} done` }])
        },
      }))
    } }
    const loaded = await turn({
      before: [['desktop', desktop]], answers: ['allowed-once', 'rejected'],
      script: [{ name: 'computer', args: { action: 'screenshot' } }, { name: 'computer', args: { action: 'click', x: 1, y: 2 } }, { name: 'computer', args: { action: 'type', text: 'hunter2' } }],
    })
    expect(toolResults(loaded.events)).toEqual(['screenshot done', 'click done', 'Error: The user declined computer input.'].map(text => [{ type: 'text', text }]))
    expect(loaded.asked).toEqual([
      'Computer input on the desktop. Arguments: "action": "click", "x": 1, "y": 2.',
      'Computer input on the desktop. Arguments: "action": "type", "text": "hunter2".',
    ])
    expect(loaded.events.flatMap(event => event.type === 'approval/asked' ? [event.data.toolName] : event.type === 'approval/decided' ? [event.data.outcome] : []))
      .toEqual(['computer', 'allowed-once', 'computer', 'rejected'])
    // Without this plugin's recorded consent, the guard denies input that a listener ahead of consent allowed.
    loaded.ctx.on('tools/pre-execute', (): Promise<PreToolDecision> => Promise.resolve({ kind: 'allow' }), { prepend: true })
    for (const action of ['key', 'scroll', 'drag', 'move']) {
      expect(textOf(await direct(loaded, 'computer', { action }))).toBe('Error: computer input needs the user\'s consent, which was not given.')
    }
    expect(textOf(await direct(loaded, 'computer', { action: 'click' }, false))).toBe('Error: computer input needs the user\'s consent, which was not given.')
    expect(textOf(await direct(loaded, 'computer', { action: 'screenshot' }))).toBe('screenshot done')
    expect(inputs).toEqual(['screenshot', 'click', 'screenshot'])
    expect(loaded.asked).toHaveLength(2)
  })
})

describe('take over', () => {
  const TAKEN_OVER = 'Browser and desktop tools stay unavailable until they hand it back.'
  const refused = (name: string) => `Error: ${name} did not run: the person has taken over the browser. ${TAKEN_OVER}`
  const stopped = (name: string) => `Error: ${name} was stopped because the person took over the browser, so it may or may not have taken effect. ${TAKEN_OVER}`
  const takeoverOf = (loaded: Awaited<ReturnType<typeof load>>) => loaded.ctx.get('mumbo-browser-consent')!
  const record = (root: string) => join(root, 'mumbo', 'browser-takeover')
  /** Each call the browser received, by name and action. */
  const received = async (loaded: Awaited<ReturnType<typeof load>>) => (await loaded.allCalls()).map(call => `${call.name}${call.args.action === undefined ? '' : ` ${call.args.action}`}`)
  /**
   * A `computer` tool that records each action, finishes each only once `gate` settles, whether or not its call was
   * stopped, and, with `stall`, runs until its call is stopped.
   */
  const desktop = (inputs: string[] = [], gate?: Promise<void>) => ({ inject: ['tools'], apply(ctx: Context) {
    ctx.tools.register(defineContentToolFixture({
      name: 'computer', description: 'Desktop.', parameters: { action: { type: 'string', required: true }, stall: { type: 'boolean' } },
      execute: async (args, exec) => {
        inputs.push(args.action)
        if (gate !== undefined) await gate
        if (args.stall !== true) return [{ type: 'text', text: `${args.action} done` }]
        return new Promise((_resolve, reject) => { exec.signal.addEventListener('abort', () => { reject(new Error('stopped')) }) })
      },
    }))
  } })
  /** Run one call through the executor as the booted Session's Agent under its own call id. */
  type Loaded = Awaited<ReturnType<typeof load>>
  const run = (loaded: Loaded, name: string, args: Record<string, unknown>, id: string) => executeModelToolFixture(loaded.ctx, {
    agent: loaded.agent, name, arguments: args, callId: ToolCallId(id), signal: new AbortController().signal,
  })

  it('refuses every browser tool and computer action, closes the browser connection, and reconnects on hand back', { timeout: 60_000 }, async () => {
    const inputs: string[] = []
    const loaded = await load({
      before: [['desktop', desktop(inputs)]], start: 'http://allowed.test/',
      script: [{ name: 'browser_navigate', args: { url: 'http://allowed.test/next' } }, { name: 'computer', args: { action: 'screenshot' } }],
    })
    const takeover = takeoverOf(loaded)
    expect(takeover.hold).toEqual({ kind: 'free' })
    // An Agent-less read reaches no browser whether or not the person has it.
    expect(textOf(await direct(loaded, tool('browser_snapshot'), {}, false))).toMatch(/browser tool belongs to another Session/u)
    // Handing back a browser the person does not have changes nothing, and a Session that never called the browser has
    // no connection to close.
    await takeover.handBack()
    await takeover.takeOver()
    expect(takeover.hold).toEqual({ kind: 'held' })
    expect(await received(loaded)).toEqual([])

    for (const schema of browserTools(loaded)) {
      expect(textOf(await direct(loaded, schema.name, { url: 'http://allowed.test/', filename: 'x' }))).toBe(refused(schema.name.slice(tool('').length)))
    }
    for (const action of ['screenshot', 'click', 'move', 'drag', 'scroll', 'type', 'key', 'other']) {
      expect(textOf(await direct(loaded, 'computer', { action }))).toBe(refused('computer'))
    }
    // The model sees the refusals as its tool results; nothing is asked, and neither the browser nor the desktop gets a call.
    loaded.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Go.' }], source: { kind: 'user' } }))
    await loaded.agent.whenIdle()
    expect(toolResults(loaded.events)).toEqual([refused('browser_navigate'), refused('computer')].map(text => [{ type: 'text', text }]))
    expect(loaded.asked).toEqual([])
    expect(inputs).toEqual([])
    expect(await received(loaded)).toEqual([])

    // Handing back reconnects by reading the tabs; the next take over closes that connection.
    await takeover.handBack()
    expect(takeover.hold).toEqual({ kind: 'free' })
    expect(await received(loaded)).toEqual(['browser_tabs list'])
    expect(textOf(await direct(loaded, tool('browser_snapshot'), {}))).toContain('- Page URL: http://allowed.test/')
    expect(textOf(await direct(loaded, 'computer', { action: 'screenshot' }))).toBe('screenshot done')
    await takeover.takeOver()
    await takeover.takeOver()
    expect(await received(loaded)).toEqual(['browser_tabs list', 'browser_snapshot', 'browser_tabs list', 'browser_close'])
  })

  it('stops the calls in flight when the person takes over and returns none of their results', { timeout: 60_000 }, async () => {
    const inputs: string[] = []
    const loaded = await load({
      before: [['desktop', desktop(inputs)]], start: 'http://allowed.test/stall', answers: ['hang'], script: [{ name: 'computer', args: { action: 'click' } }],
    })
    // A read waiting in the browser, a write whose tab consent is reading, a screenshot running on the desktop, and the
    // model's input waiting for the person's answer.
    const snapshot = run(loaded, tool('browser_snapshot'), {}, 'snapshot')
    await expect.poll(() => received(loaded)).toEqual(['browser_snapshot'])
    const click = run(loaded, tool('browser_click'), { target: 'e1' }, 'click')
    await expect.poll(() => received(loaded)).toEqual(['browser_snapshot', 'browser_tabs list'])
    const screenshot = run(loaded, 'computer', { action: 'screenshot', stall: true }, 'screenshot')
    loaded.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Go.' }], source: { kind: 'user' } }))
    await expect.poll(() => [inputs, loaded.asked.length]).toEqual([['screenshot'], 1])

    await takeoverOf(loaded).takeOver()
    expect((await Promise.all([snapshot, click, screenshot])).map(textOf)).toEqual([stopped('browser_snapshot'), refused('browser_click'), stopped('computer')])
    await loaded.agent.whenIdle()
    expect(toolResults(loaded.events)).toEqual([[{ type: 'text', text: refused('computer') }]])
    // No listing follows the stopped calls; the close comes after they settled.
    expect(await received(loaded)).toEqual(['browser_snapshot', 'browser_tabs list', 'browser_close'])
    expect(inputs).toEqual(['screenshot'])
    expect(loaded.events.flatMap(event => event.type === 'approval/decided' ? [event.data.outcome] : [])).toEqual(['cancelled'])

    // A call that finished in the browser while consent was still reading the tab after it.
    const checking = await load({ start: 'http://allowed.test/stalltabs' })
    const read = run(checking, tool('browser_snapshot'), {}, 'read')
    await expect.poll(() => received(checking)).toEqual(['browser_snapshot', 'browser_tabs list'])
    await takeoverOf(checking).takeOver()
    expect(textOf(await read)).toBe(stopped('browser_snapshot'))
    expect(await received(checking)).toEqual(['browser_snapshot', 'browser_tabs list', 'browser_close'])
  })

  it('refuses a call that reached dispatch after the person took over, and one that a listener ahead of consent allowed', { timeout: 60_000 }, async () => {
    const inputs: string[] = []
    const loaded = await load({ before: [['desktop', desktop(inputs)]] })
    const takeover = takeoverOf(loaded)
    // Outside consent's wrapper, so the person takes over after the guard let each call through.
    const late = loaded.ctx.on('tools/execute', async (_exec, next) => {
      await takeover.takeOver()
      return next()
    }, { prepend: true })
    expect(textOf(await direct(loaded, tool('browser_snapshot'), {}))).toBe(refused('browser_snapshot'))
    expect(textOf(await direct(loaded, 'computer', { action: 'screenshot' }))).toBe(refused('computer'))
    late()
    loaded.ctx.on('tools/pre-execute', (): Promise<PreToolDecision> => Promise.resolve({ kind: 'allow' }), { prepend: true })
    expect(textOf(await direct(loaded, tool('browser_snapshot'), {}))).toBe(refused('browser_snapshot'))
    expect(textOf(await direct(loaded, 'computer', { action: 'screenshot' }))).toBe(refused('computer'))
    expect(await received(loaded)).toEqual([])
    expect(inputs).toEqual([])
  })

  it('reports the takeover as taking until the calls in flight settle and the browser connection closes', { timeout: 60_000 }, async () => {
    const inputs: string[] = []
    const gate = Promise.withResolvers<undefined>()
    const loaded = await load({ before: [['desktop', desktop(inputs, gate.promise)]], start: 'http://allowed.test/' })
    const takeover = takeoverOf(loaded)
    await direct(loaded, tool('browser_snapshot'), {})
    // A desktop call that keeps running past its stop until the test lets it finish.
    const screenshot = run(loaded, 'computer', { action: 'screenshot' }, 'screenshot')
    await expect.poll(() => inputs).toEqual(['screenshot'])
    const taken = takeover.takeOver()
    expect(takeover.hold).toEqual({ kind: 'taking' })
    // The take over waits for that call before it closes the browser connection.
    expect(await received(loaded)).toEqual(['browser_snapshot', 'browser_tabs list'])
    expect(takeover.hold).toEqual({ kind: 'taking' })
    gate.resolve(undefined)
    await taken
    expect(takeover.hold).toEqual({ kind: 'held' })
    expect(await received(loaded)).toEqual(['browser_snapshot', 'browser_tabs list', 'browser_close'])
    expect(textOf(await screenshot)).toBe(stopped('computer'))
  })

  it('keeps the browser taken over across a restart until the person hands it back', { timeout: 60_000 }, async () => {
    const first = await load({ start: 'http://allowed.test/' })
    await takeoverOf(first).takeOver()
    expect((await stat(record(first.root))).mode & 0o777).toBe(0o600)
    contexts.splice(contexts.indexOf(first.ctx), 1)
    await first.ctx.fiber.dispose()

    const second = await load({ root: first.root, start: 'http://allowed.test/' })
    expect(takeoverOf(second).hold).toEqual({ kind: 'held' })
    expect(textOf(await direct(second, tool('browser_snapshot'), {}))).toBe(refused('browser_snapshot'))
    expect(await received(second)).toEqual([])
    await takeoverOf(second).handBack()
    await expect(stat(record(first.root))).rejects.toThrow(/ENOENT/u)
    expect(await received(second)).toEqual(['browser_tabs list'])
  })

  it('lets the latest request win when a take over arrives during a hand back', { timeout: 60_000 }, async () => {
    const loaded = await load()
    const takeover = takeoverOf(loaded)
    await takeover.takeOver()
    await Promise.all([takeover.handBack(), takeover.takeOver()])
    expect(takeover.hold).toEqual({ kind: 'held' })
    expect((await stat(record(loaded.root))).isFile()).toBe(true)
    await Promise.all([takeover.takeOver(), takeover.handBack()])
    expect(takeover.hold).toEqual({ kind: 'free' })
    await expect(stat(record(loaded.root))).rejects.toThrow(/ENOENT/u)
  })

  it('reports a takeover it could not save or whose connection stayed open, and a record it cannot check or remove', { timeout: 60_000 }, async () => {
    // A record that cannot be checked counts as a takeover, and one that cannot be written is reported.
    const unchecked = await mkdtemp(join(tmpdir(), 'mumbo-browser-consent-'))
    roots.push(unchecked)
    await writeFile(join(unchecked, 'mumbo'), '')
    const blocked = await load({ root: unchecked })
    expect(takeoverOf(blocked).hold).toEqual({ kind: 'held' })
    const unreadable = `could not check ${record(unchecked)}, so the browser stays taken over until the person hands it back`
    expect(blocked.errors).toContainEqual(expect.stringContaining(unreadable))
    const unsaved = /^the takeover could not be saved, so a restart would hand the browser back: Error: /u
    await expect(takeoverOf(blocked).takeOver()).rejects.toThrow(unsaved)
    const notSaved = { kind: 'unfinished', failure: expect.stringMatching(unsaved) as string }
    expect(takeoverOf(blocked).hold).toEqual(notSaved)
    // A hand back that fails leaves the take over reported unfinished.
    await expect(takeoverOf(blocked).handBack()).rejects.toThrow(/ENOTDIR/u)
    expect(takeoverOf(blocked).hold).toEqual(notSaved)

    // A record that cannot be removed keeps the browser taken over.
    const stuck = await mkdtemp(join(tmpdir(), 'mumbo-browser-consent-'))
    roots.push(stuck)
    await mkdir(join(record(stuck), 'entry'), { recursive: true })
    const kept = await load({ root: stuck })
    await expect(takeoverOf(kept).handBack()).rejects.toThrow()
    expect(takeoverOf(kept).hold).toEqual({ kind: 'held' })

    // A connection that does not close is reported on each attempt, and the browser stays taken over.
    const open = await load({ start: 'http://allowed.test/noclose' })
    await direct(open, tool('browser_snapshot'), {})
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(takeoverOf(open).takeOver()).rejects.toThrow('a browser connection did not close: browser_close failed: fixture failure')
    }
    expect(takeoverOf(open).hold).toEqual({ kind: 'unfinished', failure: 'a browser connection did not close: browser_close failed: fixture failure' })
    expect(await received(open)).toEqual(['browser_snapshot', 'browser_tabs list', 'browser_close', 'browser_close'])
  })

  it('reads the tab the person left when they hand back, so a screenshot of a denied or unread page asks', { timeout: 60_000 }, async () => {
    const screenshot = 'Error: The user declined the desktop screenshot.'
    const question = (what: string) => `Desktop screenshot while the browser's current tab is ${what}, which the assistant may not use. Arguments: "action": "screenshot".`
    const unread = 'a page whose address cannot be read'
    // A listing that fails, or whose current-tab line a page title makes ambiguous, leaves the tab unread.
    for (const [start, what] of [
      ['https://accounts.google.com/', 'a page on https://accounts.google.com'], ['http://allowed.test/broken', unread], ['http://allowed.test/brackets', unread],
    ] as const) {
      const loaded = await load({ before: [['desktop', desktop()]], start, script: [{ name: 'computer', args: { action: 'screenshot' } }] })
      await takeoverOf(loaded).takeOver()
      await takeoverOf(loaded).handBack()
      loaded.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Go.' }], source: { kind: 'user' } }))
      await loaded.agent.whenIdle()
      expect(toolResults(loaded.events)).toEqual([[{ type: 'text', text: screenshot }]])
      expect(loaded.asked).toEqual([question(what)])
    }
    // The listing showed a denied page, so console and request logs stay refused.
    const denied = await load({ start: 'https://accounts.google.com/' })
    await takeoverOf(denied).takeOver()
    await takeoverOf(denied).handBack()
    expect(textOf(await direct(denied, tool('browser_console_messages'), {}))).toMatch(/console and request logs keep that page's entries\.$/u)
  })
})
