import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { BrowserUseProviderName } from '@deepseek-ai/dsh-browser-use/brand'
import * as PlaywrightBrowser from '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp'
import { mountSessionMcp } from '@deepseek-ai/dsh-experimental-browser-use-runtime/mcp'
import { ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineContentToolFixture, executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import type { PreToolDecision, ToolExecution, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
      actual.mountSessionMcp(ctx, { ...options, args: [FIXTURE, process.env.CONSENT_FIXTURE_ROOT!, process.env.CONSENT_FIXTURE_MODE ?? '', process.env.CONSENT_FIXTURE_START ?? ''] })
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

type LoadOptions = Omit<Parameters<typeof bootComposition>[1], 'consent'> & { consent?: Record<string, unknown>; withoutTabs?: boolean; start?: string }

async function load(options: LoadOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mumbo-browser-consent-'))
  roots.push(root)
  vi.stubEnv('CONSENT_FIXTURE_ROOT', root)
  vi.stubEnv('CONSENT_FIXTURE_MODE', options.withoutTabs === true ? 'no-tabs' : '')
  vi.stubEnv('CONSENT_FIXTURE_START', options.start ?? '')
  const consent = { browser: { mode: 'attach', endpoint: 'http://127.0.0.1:9' }, deniedUrls: DENIED_URLS, allowedSites: ['http://allowed.test'], ...options.consent }
  const booted = await bootComposition(root, { ...options, consent })
  contexts.push(booted.ctx)
  // Every call the browser received, in order, with the current tab's URL before the call.
  const allCalls = async () => (await readFile(join(root, 'calls.ndjson'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean)
    .map(line => JSON.parse(line) as { name: string; args: { action?: string }; url: string })
  // Every call except consent's own current-tab listings.
  const calls = async () => (await allCalls()).filter(call => !(call.name === 'browser_tabs' && call.args.action === 'list'))
  return { ...booted, calls, allCalls, root }
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

const browserTools = (loaded: Awaited<ReturnType<typeof load>>) => loaded.ctx.tools.schemas(loaded.agent).filter(schema => schema.name.startsWith(tool('')))

describe('browser write consent in the person-box composition', () => {
  it('decides each write on the tab it runs on, asks for the rest with its arguments, and logs every allowed write', { timeout: 60_000 }, async () => {
    const { asked, events, calls, root } = await turn({
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
        { name: 'browser_file_upload', args: { paths: ['/root/tax.pdf'] } },
        { name: 'browser_evaluate', args: { function: '() => document.forms[0].submit()' } },
      ],
      answers: ['rejected', 'allowed-once', 'rejected', 'rejected', 'cancelled'],
    })

    // Each call is listed with the URL of the tab it ran on; the denied writes never reached the browser.
    expect((await calls()).map(call => `${call.name} ${call.url}`)).toEqual([
      'browser_navigate about:blank',
      'browser_click http://allowed.test/inbox',
      'browser_click http://allowed.test/inbox',
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
      'Browser write: browser_file_upload on http://allowed.test. Arguments: "paths": ["/root/tax.pdf"]. Site allowances do not cover this action.',
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
    expect((await readdir(join(root, '.playwright-mcp'))).sort()).toEqual(['page-1.yml', 'page-2.yml', 'page-3.yml'])
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
    ]) {
      const invalid = await load({ consent })
      expect(invalid.consentFiber?.state).toBe(FAILED)
      expect(invalid.ctx.browserUse.providerName).toBeUndefined()
      expect(browserTools(invalid)).toEqual([])
    }
  })

  it('refuses every tool of a provider row that loaded ahead of consent', { timeout: 60_000 }, async () => {
    const rival = { inject: PlaywrightBrowser.inject, async apply(ctx: Context) {
      await ctx.plugin(PlaywrightBrowser, { mode: 'attach', endpoint: 'http://127.0.0.1:9' })
      ctx.provide('rivalReady', {})
    } }
    const { consentFiber, ctx, agent, events, calls, asked } = await turn({
      before: [['rival', rival]], consentInject: ['rivalReady'],
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
    const stagehand = await load({ before: [['stagehand', holder('stagehand-native')]], consentInject: ['rivalReady'] })
    expect(stagehand.consentFiber?.state).toBe(ACTIVE)
    expect(stagehand.errors).toContainEqual(expect.stringContaining('"stagehand-native" holds browserUse without mumbo-browser-consent, so its tools (stagehand_*) are refused'))
    const act = await executeModelToolFixture(stagehand.ctx, { agent: stagehand.agent, name: 'stagehand_act', arguments: {}, callId: ToolCallId('act'), signal: new AbortController().signal })
    expect(act.content).toEqual([{ type: 'text', text: 'Error: stagehand_act did not run: browser tools are disabled because this browser was set up without consent checks.' }])
    expect(acted).toBe(false)

    const unknownFirst = await load({ before: [['mystery', holder('mystery')]], consentInject: ['rivalReady'] })
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
    expect(await loaded.calls()).toEqual([])
    // Other origins open, and so does a blank new tab.
    for (const url of ['http://allowed.test/', 'https://mail.google.com/', 'https://accounts.google.com.evil.test/']) {
      expect(textOf(await direct(loaded, tool('browser_navigate'), { url }))).toBe(`### Page\n- Page URL: ${url}`)
    }
    expect((await direct(loaded, tool('browser_tabs'), { action: 'new' })).isError).toBe(false)
    expect((await loaded.calls()).map(call => call.args)).toEqual([
      ...['http://allowed.test/', 'https://mail.google.com/', 'https://accounts.google.com.evil.test/'].map(url => ({ url })), { action: 'new' },
    ])
    // The guard refuses the same call when a listener ahead of consent allows it, and when no Agent makes it.
    loaded.ctx.on('tools/pre-execute', (): Promise<PreToolDecision> => Promise.resolve({ kind: 'allow' }), { prepend: true })
    expect(textOf(await direct(loaded, tool('browser_navigate'), { url: 'chrome://settings/passwords' }))).toBe('Error: browser_navigate did not run: the assistant may not open a chrome: page.')
    expect(textOf(await direct(loaded, tool('browser_navigate'), { url: 'chrome://settings/passwords' }, false))).toBe('Error: browser_navigate did not run: the assistant may not open a chrome: page.')
    expect(loaded.asked).toEqual([])
    expect(await loaded.calls()).toHaveLength(4)
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
        { name: 'browser_click', args: { element: 'Sign in', target: 'link:https://accounts.google.com/signin' } },
        { name: 'browser_navigate', args: { url: 'http://allowed.test/' } },
        { name: 'browser_click', args: { element: 'Settings', target: 'report:chrome://settings/passwords' } },
      ],
    })
    const withheld = (name: string, page: string) => [{ type: 'text', text: `Error: ${name} ran, but its result is withheld: the current tab is ${page}, which the assistant may not use. Open another page to continue.` }]
    expect(toolResults(events)).toEqual([
      withheld('browser_snapshot', 'a page on https://passwords.google.com'),
      withheld('browser_tabs', 'a page on https://passwords.google.com'),
      [{ type: 'text', text: 'Error: browser_click did not run: the current tab is a page on https://passwords.google.com, which the assistant may not use.' }],
      [{ type: 'text', text: 'Error: browser_evaluate did not run: the current tab is a page on https://passwords.google.com, which the assistant may not use.' }],
      [{ type: 'text', text: '### Page\n- Page URL: http://allowed.test/' }],
      withheld('browser_click', 'a page on https://accounts.google.com'),
      [{ type: 'text', text: '### Page\n- Page URL: http://allowed.test/' }],
      withheld('browser_click', 'a chrome: page'),
    ])
    expect(asked).toEqual([])
    expect((await calls()).map(call => `${call.name} ${call.url}`)).toEqual([
      'browser_snapshot https://passwords.google.com/',
      'browser_tabs https://passwords.google.com/',
      'browser_navigate https://passwords.google.com/',
      'browser_click http://allowed.test/',
      'browser_navigate https://accounts.google.com/signin',
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
    const unreadable = (name: string) => [{ type: 'text', text: `Error: ${name} ran, but its result is withheld: the current tab is a page whose address cannot be read, which the assistant may not use. Open another page to continue.` }]
    const withoutTabs = await turn({ withoutTabs: true, script: [{ name: 'browser_navigate', args: { url: 'http://allowed.test/' } }, { name: 'browser_click', args: { target: 'e1' } }] })
    expect(toolResults(withoutTabs.events)).toEqual([
      unreadable('browser_navigate'),
      [{ type: 'text', text: 'Error: browser_click did not run: the current tab is a page whose address cannot be read, which the assistant may not use.' }],
    ])
    expect(withoutTabs.asked).toEqual([])
    expect((await withoutTabs.calls()).map(call => call.name)).toEqual(['browser_navigate'])
    // A listing that fails, here on the fixture's broken page, withholds the result too.
    const broken = await turn({ script: [{ name: 'browser_navigate', args: { url: 'http://broken.test/' } }] })
    expect(toolResults(broken.events)).toEqual([unreadable('browser_navigate')])
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
    expect(toolResults(loaded.events)).toEqual([[{ type: 'text', text: '### Page\n- Page URL: about:blank' }]])
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
