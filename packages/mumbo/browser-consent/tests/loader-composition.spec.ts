import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { BrowserUseProviderName } from '@deepseek-ai/dsh-browser-use/brand'
import { ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import type { PreToolDecision, ToolExecution, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bootComposition, consentRecords, tool, toolResults } from './harness.ts'
import type { ScriptStep } from './harness.ts'

const FIXTURE = fileURLToPath(new URL('./playwright-fixture.mjs', import.meta.url))
/** Cordis `FiberState.FAILED`. */
const FAILED = 3

// The pinned Playwright MCP server is the external boundary: the real provider and runtime spawn the fixture instead.
vi.mock('@deepseek-ai/dsh-experimental-browser-use-runtime/mcp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-experimental-browser-use-runtime/mcp')>()
  return {
    ...actual,
    mountSessionMcp: (ctx: Context, options: Parameters<typeof actual.mountSessionMcp>[1]) => {
      actual.mountSessionMcp(ctx, { ...options, args: [FIXTURE, process.env.CONSENT_FIXTURE_ROOT!, process.env.CONSENT_FIXTURE_MODE ?? ''] })
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

type LoadOptions = Omit<Parameters<typeof bootComposition>[1], 'consent'> & { consent?: Record<string, unknown>; withoutTabs?: boolean }

async function load(options: LoadOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mumbo-browser-consent-'))
  roots.push(root)
  vi.stubEnv('CONSENT_FIXTURE_ROOT', root)
  vi.stubEnv('CONSENT_FIXTURE_MODE', options.withoutTabs === true ? 'no-tabs' : '')
  const consent = { browser: { mode: 'attach', endpoint: 'http://127.0.0.1:9' }, allowedSites: ['http://allowed.test'], ...options.consent }
  const booted = await bootComposition(root, { ...options, consent })
  contexts.push(booted.ctx)
  // Every call the browser received except consent's own current-tab listings.
  const calls = async () => (await readFile(join(root, 'calls.ndjson'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean)
    .map(line => JSON.parse(line) as { name: string; args: { action?: string }; url: string })
    .filter(call => !(call.name === 'browser_tabs' && call.args.action === 'list'))
  return { ...booted, calls }
}

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
    const { asked, events, calls } = await turn({
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
        { name: 'browser_navigate', args: { url: 'http://broken.test/' } },
        { name: 'browser_click', args: { element: 'Continue', target: 'e4' } },
      ],
      answers: ['rejected', 'allowed-once', 'rejected', 'rejected', 'cancelled', 'allowed-once'],
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
      'browser_navigate http://allowed.test/compose',
      'browser_click http://broken.test/',
    ])
    expect(asked).toEqual([
      'Browser write: browser_type on http://other.test. Arguments: target="e2", text="hi\\nthere". Model-written target description: "Message".',
      'Browser write: browser_click on http://other.test. Arguments: target="e3". Model-written target description: "Send".',
      'Browser write: browser_click on http://evil.test. Arguments: target="e5".',
      'Browser write: browser_file_upload on http://allowed.test. Arguments: paths=["/root/tax.pdf"]. Site allowances do not cover this action.',
      'Browser write: browser_evaluate on http://allowed.test. Arguments: function="() => document.forms[0].submit()". Site allowances do not cover this action.',
      'Browser write: browser_click on an unidentified page. Arguments: target="e4". Model-written target description: "Continue".',
    ])
    const results = toolResults(events)
    expect(results[4]).toEqual([{ type: 'text', text: 'Error: The user declined browser_type on http://other.test.' }])
    expect(results[12]).toEqual([{ type: 'text', text: 'Error: tool call aborted before dispatch' }])
    expect(consentRecords(events)).toEqual([
      { callId: 'call-1', tool: 'browser_click', site: 'http://allowed.test', grant: 'site', outcome: 'succeeded' },
      { callId: 'call-2', tool: 'browser_click', site: 'http://allowed.test', grant: 'site', outcome: 'failed' },
      { callId: 'call-3', tool: 'browser_click', site: 'http://allowed.test', grant: 'site', outcome: 'succeeded' },
      { callId: 'call-7', tool: 'browser_click', site: 'http://other.test', grant: 'approval', outcome: 'succeeded' },
      { callId: 'call-14', tool: 'browser_click', grant: 'approval', outcome: 'succeeded' },
    ])
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
    const { ctx, agent, calls } = await load({ withoutTabs: true, withoutApproval: true })
    const run = (name: string, owner?: typeof agent) => executeModelToolFixture(ctx, {
      ...owner === undefined ? {} : { agent: owner }, name, arguments: { target: 'e1' }, callId: ToolCallId('direct'), signal: new AbortController().signal,
    })
    expect((await run(tool('browser_click'), agent)).content).toEqual([{ type: 'text', text: 'Error: browser_click on an unidentified page needs the user\'s approval, and no approval channel is available.' }])
    expect((await run(tool('browser_click'))).content).toEqual([{ type: 'text', text: 'Error: browser_click needs the user\'s consent, which was not given.' }])
    expect(await calls()).toEqual([])
    // Other tools are not this plugin's to gate.
    expect((await run('other_tool', agent)).error?.info?.code).toBe('UNKNOWN_TOOL')
  })

  it('mounts no browser when its config is invalid or another provider holds the browser', { timeout: 60_000 }, async () => {
    const invalid = await load({ consent: { allowedSites: ['https://mail.google.com/'] } })
    expect(invalid.consentFiber?.state).toBe(FAILED)
    expect(invalid.ctx.browserUse.providerName).toBeUndefined()
    expect(browserTools(invalid)).toEqual([])

    const rival = { inject: ['browserUse'], apply(ctx: Context) { ctx.effect(() => ctx.browserUse.register(BrowserUseProviderName('rival'))) } }
    const contested = await load({ before: [['rival', rival]] })
    expect(contested.consentFiber?.state).toBe(FAILED)
    expect(contested.ctx.browserUse.providerName).toBe('rival')
    expect(browserTools(contested)).toEqual([])
  })
})
