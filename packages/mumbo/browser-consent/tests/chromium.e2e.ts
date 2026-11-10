/** Consent against the pinned Playwright MCP server attached to a disposable Chromium and two loopback origins. */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { expect, it, vi } from 'vitest'
import { bootComposition, consentRecords, toolResults } from './harness.ts'
import type { ScriptStep } from './harness.ts'

const skip = process.env.DSH_BROWSER_EXECUTABLE === undefined

/**
 * Serve two loopback origins, `127.0.0.1` and `localhost`, attach the composition to a disposable headless Chromium,
 * and run one scripted turn.
 * @param page - HTML for a request path, given the server port.
 * @param turn - consent's `deniedUrls`, `allowedSites`, the model's script, and the person's answers, given the origins.
 * @returns each tool result's text, the approval reasons asked, the Session events, the hosts that received a POST,
 *   and the names of the files Playwright MCP left in its output directory with their contents.
 */
async function runTurn(page: (port: number, path: string) => string, turn: (allowed: string, other: string) => {
  deniedUrls: string[]
  allowedSites: string[]
  script: ScriptStep[]
  answers?: Array<'rejected' | 'allowed-once'>
}) {
  const root = await mkdtemp(join(tmpdir(), 'mumbo-browser-consent-e2e-'))
  const sent: string[] = []
  const server = createServer((request, response) => {
    if (request.method === 'POST') sent.push(request.headers.host!)
    response.writeHead(200, { 'Content-Type': 'text/html' })
    response.end(page(port, request.url ?? '/'))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as { port: number }
  const profile = join(root, 'profile')
  const chromium = spawn(process.env.DSH_BROWSER_EXECUTABLE!, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' })
  const exited = once(chromium, 'exit')
  let booted: Awaited<ReturnType<typeof bootComposition>> | undefined
  try {
    let debugPort = ''
    await vi.waitFor(async () => { debugPort = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]!; expect(Number(debugPort)).toBeGreaterThan(0) }, { timeout: 20_000 })
    const { deniedUrls, allowedSites, script, answers } = turn(`http://127.0.0.1:${String(port)}`, `http://localhost:${String(port)}`)
    booted = await bootComposition(root, {
      consent: { browser: { mode: 'attach', endpoint: `http://127.0.0.1:${debugPort}` }, deniedUrls, allowedSites }, script, answers: answers ?? [],
    })
    booted.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Go.' }], source: { kind: 'user' } }))
    await booted.agent.whenIdle()
    const output = join(root, '.playwright-mcp')
    const files = await Promise.all((await readdir(output).catch(() => [])).map(async name => [name, await readFile(join(output, name), 'utf8')] as const))
    const results = toolResults(booted.events).map(content => content.map(block => block.type === 'text' ? block.text : `[${block.type}]`).join('\n'))
    return { results, asked: booted.asked, events: booted.events, sent, files, port }
  } finally {
    await booted?.ctx.fiber.dispose()
    if (chromium.exitCode === null) chromium.kill('SIGTERM')
    await exited
    server.closeAllConnections()
    server.close()
    await rm(root, { recursive: true, force: true, maxRetries: 5 })
  }
}

it.skipIf(skip)('asks before a click or code run on a site the person has not allowed', { timeout: 120_000 }, async () => {
  const page = () => '<!doctype html><title>Compose</title><form method="post" action="/send"><button id="send">Send</button></form>'
  let origins: [string, string] = ['', '']
  const { asked, events, sent, port } = await runTurn(page, (allowed, other) => {
    origins = [allowed, other]
    return {
      deniedUrls: ['chrome:'], allowedSites: [allowed], answers: ['rejected', 'rejected'],
      script: [
        { name: 'browser_navigate', args: { url: `${allowed}/` } },
        { name: 'browser_click', args: { element: 'Send', target: '#send' } },
        { name: 'browser_navigate', args: { url: `${other}/` } },
        { name: 'browser_click', args: { element: 'Send', target: '#send' } },
        { name: 'browser_evaluate', args: { function: '() => document.forms[0].requestSubmit()' } },
      ],
    }
  })
  const [allowed, other] = origins
  expect(sent).toEqual([`127.0.0.1:${String(port)}`])
  expect(asked).toEqual([
    `Browser write: browser_click on ${other}. Arguments: "target": "#send". Model-written target description: "Send".`,
    `Browser write: browser_evaluate on ${other}. Arguments: "function": "() => document.forms[0].requestSubmit()". Site allowances do not cover this action.`,
  ])
  expect(consentRecords(events)).toEqual([{ callId: 'call-1', tool: 'browser_click', site: allowed, grant: 'site', outcome: 'succeeded' }])
})

it.skipIf(skip)('withholds what a denied page shows, in the result and in the files Playwright wrote for it', { timeout: 120_000 }, async () => {
  const page = (port: number, path: string) => path === '/settings'
    ? '<!doctype html><title>Saved passwords</title><h1>Saved passwords</h1><p>bank.example: correct-horse</p>'
    : `<!doctype html><title>Home</title><a id="account" href="http://localhost:${String(port)}/settings">Account</a>`
  let denied = ''
  const { results, asked, events, files, port } = await runTurn(page, (allowed, other) => {
    denied = other
    return {
      deniedUrls: ['chrome:', other], allowedSites: [allowed],
      script: [
        { name: 'browser_navigate', args: { url: `${allowed}/` } },
        { name: 'browser_navigate', args: { url: 'chrome://settings/passwords' } },
        { name: 'browser_navigate', args: { url: `${other}/settings` } },
        { name: 'browser_click', args: { element: 'Account', target: '#account' } },
        { name: 'browser_snapshot', args: {} },
        { name: 'browser_take_screenshot', args: {} },
        { name: 'browser_evaluate', args: { function: '() => document.body.innerText' } },
        { name: 'browser_navigate', args: { url: `${allowed}/` } },
      ],
    }
  })
  const withheld = (name: string) => `Error: ${name} ran, but its result is withheld: the current tab is a page on ${denied}, which the assistant may not use. Open another page to continue.`
  expect(results.slice(1)).toEqual([
    'Error: browser_navigate did not run: the assistant may not open a chrome: page.',
    `Error: browser_navigate did not run: the assistant may not open a page on ${denied}.`,
    withheld('browser_click'), withheld('browser_snapshot'), withheld('browser_take_screenshot'),
    `Error: browser_evaluate did not run: the current tab is a page on ${denied}, which the assistant may not use.`,
    expect.stringContaining('- Page Title: Home'),
  ])
  expect(asked).toEqual([])
  expect(consentRecords(events)).toEqual([{ callId: 'call-3', tool: 'browser_click', site: `http://127.0.0.1:${String(port)}`, grant: 'site', outcome: 'failed' }])
  // Playwright wrote the allowed pages' snapshots; the denied page's snapshot is deleted.
  expect(files.length).toBeGreaterThan(0)
  expect(files.filter(([, content]) => content.includes('correct-horse') || content.includes('Saved passwords'))).toEqual([])
})

it.skipIf(skip)('shows a filled password field\'s value in a snapshot, because the pinned Playwright MCP does not mask it', { timeout: 120_000 }, async () => {
  // Chromium's password manager fills the field the same way once a click or key press on the page commits the fill.
  const page = () => '<!doctype html><title>Sign in</title><form><label>Password <input id="pw" type="password"></label></form>'
    + '<script>document.getElementById("pw").value = "hunter2-autofilled"</script>'
  const { results } = await runTurn(page, allowed => ({
    deniedUrls: [], allowedSites: [allowed],
    script: [{ name: 'browser_navigate', args: { url: `${allowed}/` } }, { name: 'browser_snapshot', args: {} }],
  }))
  expect(results[1]).toMatch(/^ *- textbox "Password" \[ref=e\d+\]: hunter2-autofilled$/mu)
})
