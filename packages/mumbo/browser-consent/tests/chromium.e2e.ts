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
/** What the patched snapshot shows in place of a secret input's value. */
const MASK = '•'.repeat(4)

/**
 * Serve two loopback origins, `127.0.0.1` and `localhost`, attach the composition to a disposable headless Chromium,
 * and run one scripted turn.
 * @param page - HTML for a request path, given the server port.
 * @param turn - consent's `deniedUrls`, `allowedSites`, the model's script, and the person's answers, given the origins.
 * @returns each tool result's text, the approval reasons asked, the Session events, the hosts that received a POST,
 *   and the files Playwright MCP left in its output directory, by name.
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
    const names = await readdir(output).catch(() => [])
    const files = new Map(await Promise.all(names.map(async name => [name, await readFile(join(output, name))] as const)))
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
  expect(files.size).toBeGreaterThan(0)
  expect([...files].filter(([, content]) => content.includes('correct-horse') || content.includes('Saved passwords'))).toEqual([])
})

it.skipIf(skip)('masks password, one-time-code, and payment-card inputs in snapshots and their files; the :autofill check is best-effort', { timeout: 120_000 }, async () => {
  // Each secret field gets a distinct value; none may appear in a result or a file Playwright wrote.
  const secrets: Record<string, string> = {
    pw: 'pw-secret-1', cur: 'cur-secret-2', fresh: 'new-secret-3', otp: 'otp-secret-4', ccn: '4111111111111111', csc: '737', exp: '11/29', holder: 'Card Holder Name', code: 'otp-secret-5',
  }
  const page = () => '<!doctype html><title>Checkout</title><form>'
    + '<label>Password <input id="pw" type="password"></label><label>Empty password <input id="blank" type="password"></label>'
    + '<label>Current <input id="cur" autocomplete="current-password"></label><label>New <input id="fresh" autocomplete="new-password"></label>'
    + '<label>Code <input id="otp" autocomplete="one-time-code"></label><label>Card <input id="ccn" autocomplete="cc-number"></label>'
    + '<label>CVC <input id="csc" autocomplete="cc-csc"></label><label>Expiry <input id="exp" autocomplete="section-pay billing cc-exp"></label>'
    + '<label>Holder <input id="holder" autocomplete="CC-NAME"></label><label>Note <textarea id="code" autocomplete="one-time-code"></textarea></label>'
    + '<label>Email <input id="email" autocomplete="email"></label><label>Lookalike <input id="near" autocomplete="x-cc-number"></label></form>'
    + `<script>Object.entries(${JSON.stringify({ ...secrets, email: 'person@example.com', near: 'near-visible-6' })}).forEach(([id, value]) => { document.getElementById(id).value = value })</script>`
  const { results, files } = await runTurn(page, allowed => ({
    deniedUrls: [], allowedSites: [allowed], answers: ['allowed-once'],
    script: [
      { name: 'browser_navigate', args: { url: `${allowed}/` } },
      { name: 'browser_snapshot', args: {} },
      // :autofill is best-effort: a test cannot make Chromium autofill, so it only shows both pseudo-classes parse here.
      { name: 'browser_evaluate', args: { function: '() => [":autofill", ":-webkit-autofill"].map(pseudo => { try { document.body.matches(pseudo); return "parses" } catch { return "throws" } })' } },
    ],
  }))
  const masked = ['Password', 'Empty password', 'Current', 'New', 'Code', 'Card', 'CVC', 'Expiry', 'Holder', 'Note']
  for (const name of masked) expect(results[1]).toMatch(new RegExp(`^ *- textbox "${name}" \\[ref=e\\d+\\]: ${MASK}$`, 'mu'))
  expect(results[1]).toMatch(/^ *- textbox "Email" \[ref=e\d+\]: person@example\.com$/mu)
  expect(results[1]).toMatch(/^ *- textbox "Lookalike" \[ref=e\d+\]: near-visible-6$/mu)
  expect(results[2]).toMatch(/\[\s*"parses",\s*"parses"\s*\]/u)
  const snapshotFiles = [...files].filter(([name]) => name.endsWith('.yml')).map(([, content]) => content.toString('utf8'))
  expect(snapshotFiles.length).toBeGreaterThan(0)
  expect(snapshotFiles.join('\n')).toMatch(new RegExp(`^ *- textbox "Card" \\[ref=e\\d+\\]: ${MASK}$`, 'mu'))
  for (const secret of Object.values(secrets)) {
    expect(results.join('\n')).not.toContain(secret)
    expect(snapshotFiles.join('\n')).not.toContain(secret)
  }
})

it.skipIf(skip)('shows a password field as dots in screenshots; revealing it takes a click or hover, which asks unless the site is allowed', { timeout: 120_000 }, async () => {
  // Identical element screenshots of two equal-length passwords mean the glyphs are not drawn; text fields are the control.
  const page = () => '<!doctype html><title>Sign in</title><style>input { caret-color: transparent; outline: none; font: 16px monospace; width: 220px }</style>'
    + '<input id="pa" type="password" autocomplete="current-password"><input id="pb" type="password"><input id="pc" type="password">'
    + '<input id="ta"><input id="tb"><button id="show" onclick="pa.type = \'text\'" onmouseover="pa.type = \'text\'">Show password</button>'
    + '<script>pa.value = ta.value = "AAAAAAAA"; pb.value = tb.value = "WWWWWWWW"</script>'
  const shot = (id: string, filename: string): ScriptStep => ({ name: 'browser_take_screenshot', args: { element: id, target: `#${id}`, filename: `.playwright-mcp/${filename}` } })
  const { results, asked, files } = await runTurn(page, (allowed, other) => ({
    deniedUrls: [], allowedSites: [allowed], answers: ['allowed-once', 'rejected', 'rejected'],
    script: [
      { name: 'browser_navigate', args: { url: `${other}/` } },
      shot('pa', 'pa.png'), shot('pb', 'pb.png'), shot('ta', 'ta.png'), shot('tb', 'tb.png'),
      { name: 'browser_type', args: { element: 'third password', target: '#pc', text: 'WWWWWWWW' } },
      shot('pc', 'pc.png'),
      { name: 'browser_snapshot', args: {} },
      { name: 'browser_hover', args: { element: 'Show password', target: '#show' } },
      { name: 'browser_click', args: { element: 'Show password', target: '#show' } },
      shot('pa', 'pa-after-reads.png'),
      // On an allowed site the same click runs without asking.
      { name: 'browser_navigate', args: { url: `${allowed}/` } },
      { name: 'browser_click', args: { element: 'Show password', target: '#show' } },
      shot('pa', 'pa-revealed.png'),
      { name: 'browser_snapshot', args: {} },
    ],
  }))
  const png = (name: string) => files.get(name)!
  expect(png('pa.png').equals(png('pb.png'))).toBe(true)
  expect(png('pa.png').equals(png('pc.png'))).toBe(true)
  expect(png('ta.png').equals(png('tb.png'))).toBe(false)
  expect(png('pa-after-reads.png').equals(png('pa.png'))).toBe(true)
  expect(png('pa-revealed.png').equals(png('pa.png'))).toBe(false)
  expect(png('pa-revealed.png').equals(png('ta.png'))).toBe(true)
  expect(asked.map(reason => reason.split('. Arguments')[0])).toEqual([
    expect.stringMatching(/^Browser write: browser_type on http:\/\/localhost:\d+$/u),
    expect.stringMatching(/^Browser write: browser_hover on http:\/\/localhost:\d+$/u),
    expect.stringMatching(/^Browser write: browser_click on http:\/\/localhost:\d+$/u),
  ])
  // The snapshot is a read and masks all three password fields; the declined hover and click leave the field a password field.
  const maskedFields = (text: string | undefined) => text?.match(new RegExp(`^ *- textbox (\\[active\\] )?\\[ref=(f\\d+)?e\\d+\\]: ${MASK}$`, 'gmu'))
  expect(maskedFields(results[7])).toHaveLength(3)
  // Revealed by an allowed click, the field is text: the screenshot shows the password, and the snapshot still masks it
  // by its autocomplete token.
  expect(maskedFields(results[14])).toHaveLength(3)
  expect(results[14]).toMatch(/^ *- textbox \[ref=(f\d+)?e\d+\]: AAAAAAAA$/mu)
})
