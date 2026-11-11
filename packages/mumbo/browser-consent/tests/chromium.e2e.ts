/** Consent against the pinned Playwright MCP server attached to a disposable Chromium and two loopback origins. */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { connect, createServer as createTcpServer } from 'node:net'
import type { AddressInfo, Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { expect, it, vi } from 'vitest'
import { bootComposition, consentRecords, tool, toolResults } from './harness.ts'
import type { ScriptStep } from './harness.ts'

const skip = process.env.DSH_BROWSER_EXECUTABLE === undefined
/** A home page on `127.0.0.1` linking to a saved-passwords page on `localhost`. */
/**
 * A home page on `127.0.0.1` linking to a saved-passwords page on `localhost`, which logs to its console and posts a
 * password; `/redir` redirects there.
 */
const accountPages = (port: number, path: string) => path === '/settings'
  ? '<!doctype html><title>Saved passwords</title><h1>Saved passwords</h1><p>bank.example: correct-horse</p>'
    + '<script>console.log("vault: correct-horse"); console.log("vault loaded"); fetch("/login", { method: "POST", body: "pw=correct-horse" })</script>'
  : path === '/redir' ? `REDIRECT http://localhost:${String(port)}/settings`
    : `<!doctype html><title>Home</title><a id="account" href="http://localhost:${String(port)}/settings">Account</a>`
/** What the patched snapshot shows in place of a secret input's value. */
const MASK = '•'.repeat(4)

/**
 * Upload settings for a composition in `root`: an upload directory and a staging directory, each of its own, in it.
 * @param root - scratch directory.
 * @returns the consent row's `uploadDirectory` and `uploadStaging`.
 */
async function uploads(root: string) {
  const [uploadDirectory, uploadStaging] = [join(root, 'Downloads'), join(root, 'staging')]
  for (const directory of [uploadDirectory, uploadStaging]) await mkdir(directory, { mode: 0o700 })
  return { uploadDirectory, uploadStaging }
}

/**
 * Start a disposable headless Chromium with its profile in `root`.
 * @param root - scratch directory for the profile.
 * @returns the debugging port once Chromium reports it, and a stop that waits for Chromium to exit.
 */
function launchChromium(root: string) {
  const profile = join(root, 'profile')
  const chromium = spawn(process.env.DSH_BROWSER_EXECUTABLE!, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' })
  const exited = once(chromium, 'exit')
  return {
    async debugPort(): Promise<string> {
      let port = ''
      await vi.waitFor(async () => { port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]!; expect(Number(port)).toBeGreaterThan(0) }, { timeout: 20_000 })
      return port
    },
    async stop(): Promise<void> {
      if (chromium.exitCode === null) chromium.kill('SIGTERM')
      await exited
    },
  }
}

/**
 * Serve two loopback origins, `127.0.0.1` and `localhost`, attach the composition to a disposable headless Chromium,
 * and run one scripted turn.
 * @param page - HTML for a request path, given the server port, or `REDIRECT <url>` for a redirect.
 * @param turn - consent's `deniedUrls`, `allowedSites`, the model's script, the person's answers, and whether the
 *   server writes to an `outputDir` outside the working directory, given the origins and the upload directory.
 * @returns each tool result's text, the approval reasons asked, the Session events, the hosts that received a POST,
 *   the files Playwright MCP left in its output directory, by name, and the names in the working directory.
 */
async function runTurn(page: (port: number, path: string) => string, turn: (allowed: string, other: string, downloads: string) => {
  deniedUrls: string[]
  allowedSites: string[]
  script: ScriptStep[]
  answers?: Array<'rejected' | 'allowed-once'>
  outputDir?: boolean
}) {
  const root = await mkdtemp(join(tmpdir(), 'mumbo-browser-consent-e2e-'))
  const cleanup: string[] = []
  const sent: string[] = []
  const server = createServer((request, response) => {
    if (request.method === 'POST') sent.push(request.headers.host!)
    const body = page(port, request.url ?? '/')
    if (body.startsWith('REDIRECT ')) {
      response.writeHead(302, { Location: body.slice('REDIRECT '.length) })
      response.end()
      return
    }
    response.writeHead(200, { 'Content-Type': 'text/html' })
    response.end(body)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as { port: number }
  // The takeover record lives under the DSH home.
  vi.stubEnv('DSH_HOME', root)
  const chromium = launchChromium(root)
  let booted: Awaited<ReturnType<typeof bootComposition>> | undefined
  try {
    const debugPort = await chromium.debugPort()
    const upload = await uploads(root)
    const { deniedUrls, allowedSites, script, answers, outputDir } = turn(`http://127.0.0.1:${String(port)}`, `http://localhost:${String(port)}`, upload.uploadDirectory)
    const output = outputDir === true ? join(tmpdir(), `${basename(root)}-output`) : join(root, '.playwright-mcp')
    cleanup.push(output)
    const browser = { mode: 'attach', endpoint: `http://127.0.0.1:${debugPort}`, outputDir: output }
    const consent = { browser, deniedUrls, allowedSites, ...upload }
    booted = await bootComposition(root, { consent, script, answers: answers ?? [] })
    booted.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Go.' }], source: { kind: 'user' } }))
    await booted.agent.whenIdle()
    const names = await readdir(output).catch(() => [])
    const files = new Map(await Promise.all(names.map(async name => [name, await readFile(join(output, name))] as const)))
    const results = toolResults(booted.events).map(content => content.map(block => block.type === 'text' ? block.text : `[${block.type}]`).join('\n'))
    return { results, asked: booted.asked, events: booted.events, sent, files, port, workspace: await readdir(root) }
  } finally {
    await booted?.ctx.fiber.dispose()
    await chromium.stop()
    vi.unstubAllEnvs()
    server.closeAllConnections()
    server.close()
    await Promise.all([root, ...cleanup].map(path => rm(path, { recursive: true, force: true, maxRetries: 5 })))
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
  let denied = ''
  const { results, asked, events, files, port } = await runTurn(accountPages, (allowed, other) => {
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

it.skipIf(skip)('shows a password field as dots in screenshots; revealing it takes a click or hover, which asks even on an allowed site', { timeout: 120_000 }, async () => {
  // Identical element screenshots of two equal-length passwords mean the glyphs are not drawn; text fields are the control.
  const page = () => '<!doctype html><title>Sign in</title><style>input { caret-color: transparent; outline: none; font: 16px monospace; width: 220px }</style>'
    + '<input id="pa" type="password" autocomplete="current-password"><input id="pb" type="password"><input id="pc" type="password">'
    + '<input id="ta"><input id="tb"><button id="show" onclick="pa.type = \'text\'" onmouseover="pa.type = \'text\'">Show password</button>'
    + '<script>pa.value = ta.value = "AAAAAAAA"; pb.value = tb.value = "WWWWWWWW"</script>'
  const shot = (id: string): ScriptStep => ({ name: 'browser_take_screenshot', args: { element: id, target: `#${id}` } })
  const { results, asked, files } = await runTurn(page, (allowed, other) => ({
    deniedUrls: [], allowedSites: [allowed], answers: ['allowed-once', 'rejected', 'rejected', 'allowed-once'],
    script: [
      { name: 'browser_navigate', args: { url: `${other}/` } },
      shot('pa'), shot('pb'), shot('ta'), shot('tb'),
      { name: 'browser_type', args: { element: 'third password', target: '#pc', text: 'WWWWWWWW' } },
      shot('pc'),
      { name: 'browser_snapshot', args: {} },
      { name: 'browser_hover', args: { element: 'Show password', target: '#show' } },
      { name: 'browser_click', args: { element: 'Show password', target: '#show' } },
      shot('pa'),
      // On an allowed site the same click asks too, because the page shows a masked field; the person approves it.
      { name: 'browser_navigate', args: { url: `${allowed}/` } },
      { name: 'browser_click', args: { element: 'Show password', target: '#show' } },
      shot('pa'),
      { name: 'browser_snapshot', args: {} },
    ],
  }))
  // Each screenshot is the file its result links.
  const png = (step: number) => files.get(/\]\(\.\.\/\.playwright-mcp\/([^)]+\.png)\)$/mu.exec(results[step] ?? '')?.[1] ?? '')!
  const [pa, pb, ta, tb, pc, afterReads, revealed] = [1, 2, 3, 4, 6, 10, 13].map(png)
  expect(pa!.equals(pb!)).toBe(true)
  expect(pa!.equals(pc!)).toBe(true)
  expect(ta!.equals(tb!)).toBe(false)
  expect(afterReads!.equals(pa!)).toBe(true)
  expect(revealed!.equals(pa!)).toBe(false)
  expect(revealed!.equals(ta!)).toBe(true)
  expect(asked.map(reason => reason.split('. Arguments')[0])).toEqual([
    expect.stringMatching(/^Browser write: browser_type on http:\/\/localhost:\d+$/u),
    expect.stringMatching(/^Browser write: browser_hover on http:\/\/localhost:\d+$/u),
    expect.stringMatching(/^Browser write: browser_click on http:\/\/localhost:\d+$/u),
    expect.stringMatching(/^Browser write: browser_click on http:\/\/127\.0\.0\.1:\d+$/u),
  ])
  expect(asked[3]).toContain('The page shows a password or payment field, so its site allowance does not cover this action.')
  // The snapshot is a read and masks all three password fields; the declined hover and click leave the field a password field.
  const maskedFields = (text: string | undefined) => text?.match(new RegExp(`^ *- textbox (\\[active\\] )?\\[ref=(f\\d+)?e\\d+\\]: ${MASK}$`, 'gmu'))
  expect(maskedFields(results[7])).toHaveLength(3)
  // Revealed by an approved click, the field is text: the screenshot shows the password, and the snapshot still masks it
  // by its autocomplete token.
  expect(maskedFields(results[14])).toHaveLength(3)
  expect(results[14]).toMatch(/^ *- textbox \[ref=(f\d+)?e\d+\]: AAAAAAAA$/mu)
})

it.skipIf(skip)('lists requests without their headers or bodies, and refuses the request details that carry them', { timeout: 120_000 }, async () => {
  const page = (_port: number, path: string) => path === '/login' ? 'ok'
    : '<!doctype html><title>Sign in</title><script>document.cookie = "session=cookie-secret-6"; fetch("/login", { method: "POST", '
      + 'headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Auth": "header-secret-8" }, body: "password=body-secret-7" })'
      + '.then(() => document.body.append("sent"))</script>'
  const { results, asked, sent } = await runTurn(page, allowed => ({
    deniedUrls: [], allowedSites: [allowed],
    script: [
      { name: 'browser_navigate', args: { url: `${allowed}/` } },
      { name: 'browser_wait_for', args: { text: 'sent' } },
      { name: 'browser_network_requests', args: {} },
      { name: 'browser_network_request', args: { index: 2 } },
    ],
  }))
  expect(sent).toHaveLength(1)
  expect(results[2]).toMatch(/^\d+\. \[POST\] http:\/\/127\.0\.0\.1:\d+\/login => \[200\] OK$/mu)
  for (const secret of ['cookie-secret-6', 'body-secret-7', 'header-secret-8']) expect(results.join('\n')).not.toContain(secret)
  expect(results[3]).toBe('Error: browser_network_request did not run: the assistant may not read request headers or bodies, which carry cookies and passwords.')
  expect(asked).toEqual([])
})

it.skipIf(skip)('refuses saving browser output to a chosen file, and deletes a withheld screenshot whatever its element is called', { timeout: 120_000 }, async () => {
  let denied = ''
  const { results, files, workspace } = await runTurn(accountPages, (allowed, other) => {
    denied = other
    return {
      deniedUrls: [other], allowedSites: [allowed],
      script: [
        { name: 'browser_navigate', args: { url: `${allowed}/` } },
        { name: 'browser_click', args: { element: 'Account', target: '#account' } },
        { name: 'browser_snapshot', args: { filename: 'snap.yml' } },
        { name: 'browser_take_screenshot', args: { element: 'heading](elsewhere.png)', target: 'h1' } },
      ],
    }
  })
  expect(results[2]).toBe('Error: browser_snapshot did not run: the assistant may not save browser output to a file; call it without filename to get the result directly.')
  expect(results[3]).toBe(`Error: browser_take_screenshot ran, but its result is withheld: the current tab is a page on ${denied}, which the assistant may not use. Open another page to continue.`)
  expect(workspace).not.toContain('snap.yml')
  expect([...files.keys()].filter(name => name.endsWith('.png'))).toEqual([])
  expect([...files.values()].filter(content => content.includes('correct-horse'))).toEqual([])
})

it.skipIf(skip)('writes to a configured outputDir outside the working directory, and deletes a withheld result\'s files there', { timeout: 120_000 }, async () => {
  const { results, files, workspace } = await runTurn(accountPages, (allowed, other) => ({
    deniedUrls: [other], allowedSites: [allowed], outputDir: true,
    script: [
      { name: 'browser_navigate', args: { url: `${allowed}/` } },
      { name: 'browser_click', args: { element: 'Account', target: '#account' } },
      { name: 'browser_navigate', args: { url: `${allowed}/` } },
    ],
  }))
  expect(results[0]).toMatch(/^- \[Snapshot\]\(\.\.\/[^)]+-output\/page-[^)]+\.yml\)$/mu)
  expect(results[1]).toMatch(/^Error: browser_click ran, but its result is withheld/u)
  expect([...files.keys()].filter(name => name.endsWith('.yml'))).toHaveLength(2)
  expect([...files.values()].filter(content => content.includes('correct-horse'))).toEqual([])
  expect(workspace).not.toContain('.playwright-mcp')
})

it.skipIf(skip)('uploads the copy it staged and asked about, which the real server accepts from its file root', { timeout: 120_000 }, async () => {
  // The page shows the content of the file it receives in its title.
  const page = () => '<!doctype html><title>waiting</title><input id="f" type="file" onchange="this.files[0].text().then(text => { document.title = text })">'
  const { results, asked } = await runTurn(page, (allowed, _other, downloads) => {
    writeFileSync(join(downloads, 'tax.txt'), 'staged content')
    return {
      deniedUrls: [], allowedSites: [allowed], answers: ['allowed-once'],
      script: [
        { name: 'browser_navigate', args: { url: `${allowed}/` } },
        { name: 'browser_click', args: { element: 'file input', target: '#f' } },
        { name: 'browser_file_upload', args: { paths: [join(downloads, 'tax.txt')] } },
        { name: 'browser_wait_for', args: { time: 1 } },
        { name: 'browser_snapshot', args: {} },
      ],
    }
  })
  expect(asked).toEqual([expect.stringContaining(`Files sent: "tax.txt" (14 bytes, SHA-256 ${createHash('sha256').update('staged content').digest('hex').slice(0, 12)}).`)])
  expect(results[2]).not.toMatch(/^Error/u)
  expect(results[4]).toContain('- Page Title: staged content')
})

it.skipIf(skip)('asks before a click or typing on an allowed page with a masked field, or one whose snapshot fails, and not on a plain page', { timeout: 120_000 }, async () => {
  const page = (_port: number, path: string) => path === '/login'
    ? '<!doctype html><title>Sign in</title><input id="pw" type="password"><button id="go" type="button">Sign in</button>'
    : path === '/modal'
      ? '<!doctype html><title>Notice</title><script>setTimeout(() => alert("Notice"), 0)</script>'
      : '<!doctype html><title>Inbox</title><button id="go" type="button">Next</button>'
  const { asked, events, port } = await runTurn(page, allowed => ({
    deniedUrls: [], allowedSites: [allowed], answers: ['rejected', 'rejected', 'rejected'],
    script: [
      { name: 'browser_navigate', args: { url: `${allowed}/login` } },
      { name: 'browser_click', args: { element: 'Sign in', target: '#go' } },
      { name: 'browser_type', args: { element: 'Password', target: '#pw', text: 'x' } },
      { name: 'browser_navigate', args: { url: `${allowed}/inbox` } },
      { name: 'browser_click', args: { element: 'Next', target: '#go' } },
      { name: 'browser_navigate', args: { url: `${allowed}/modal` } },
      { name: 'browser_handle_dialog', args: { accept: true } },
    ],
  }))
  expect(asked.map(reason => reason.replace(/^Browser write: (\w+) on .*?\.( The page.*)$/u, '$1$2'))).toEqual([
    'browser_click The page shows a password or payment field, so its site allowance does not cover this action.',
    'browser_type The page shows a password or payment field, so its site allowance does not cover this action.',
    'browser_handle_dialog The page could not be checked for password or payment fields, so its site allowance does not cover this action.',
  ])
  expect(consentRecords(events)).toEqual([{ callId: 'call-4', tool: 'browser_click', site: `http://127.0.0.1:${String(port)}`, grant: 'site', outcome: 'succeeded' }])
})

it.skipIf(skip)('keeps a denied page out of reach after the tab leaves it: logs refused, its tab not selectable', { timeout: 120_000 }, async () => {
  let denied = ''
  const { results, asked } = await runTurn(accountPages, (allowed, other) => {
    denied = other
    return {
      deniedUrls: [other], allowedSites: [allowed],
      script: [
        { name: 'browser_navigate', args: { url: `${allowed}/` } },
        { name: 'browser_navigate', args: { url: `${allowed}/redir` } },
        { name: 'browser_tabs', args: { action: 'new', url: `${allowed}/` } },
        { name: 'browser_tabs', args: { action: 'select', index: 0 } },
        { name: 'browser_navigate_back', args: {} },
        { name: 'browser_console_messages', args: { all: true } },
        { name: 'browser_network_requests', args: {} },
      ],
    }
  })
  expect(results[1]).toMatch(/^Error: browser_navigate ran, but its result is withheld/u)
  expect(results[3]).toBe(`Error: browser_tabs did not run: that tab is a page on ${denied}, which the assistant may not use.`)
  const logs = (name: string) => `Error: ${name} did not run: a tab in this browser has shown a page the assistant may not use, and console and request logs keep that page's entries.`
  expect(results.slice(5)).toEqual([logs('browser_console_messages'), logs('browser_network_requests')])
  expect(results.join('\n')).not.toContain('correct-horse')
  expect(asked).toEqual([])
})

it.skipIf(skip)('reads an allowed page whose title holds brackets, and clicks there without asking', { timeout: 120_000 }, async () => {
  const page = () => '<!doctype html><title>Fix [x](y) - Review</title><button id="go" type="button">Approve</button>'
  const { results, asked, events } = await runTurn(page, allowed => ({
    deniedUrls: [], allowedSites: [allowed],
    script: [
      { name: 'browser_navigate', args: { url: `${allowed}/` } },
      { name: 'browser_tabs', args: { action: 'new', url: `${allowed}/two` } },
      { name: 'browser_snapshot', args: {} },
      { name: 'browser_click', args: { element: 'Approve', target: '#go' } },
    ],
  }))
  expect(results.filter(result => result.startsWith('Error:'))).toEqual([])
  expect(asked).toEqual([])
  expect(consentRecords(events)).toEqual([expect.objectContaining({ tool: 'browser_click', grant: 'site', outcome: 'succeeded' })])
})

it('reports why a browser call failed when the browser is down', { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'mumbo-browser-consent-down-'))
  vi.stubEnv('DSH_HOME', root)
  const booted = await bootComposition(root, {
    consent: { browser: { mode: 'attach', endpoint: 'http://127.0.0.1:1', outputDir: join(root, '.playwright-mcp') }, deniedUrls: [], ...await uploads(root) },
    script: [{ name: 'browser_navigate', args: { url: 'https://example.com/' } }],
  })
  try {
    booted.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Go.' }], source: { kind: 'user' } }))
    await booted.agent.whenIdle()
    const [result] = toolResults(booted.events).map(content => content.map(block => block.type === 'text' ? block.text : '').join('\n'))
    expect(result).toMatch(/^Error: browser_navigate: the browser's current tab could not be checked after the call \(browser_tabs/u)
    expect(result).toMatch(/ECONNREFUSED 127\.0\.0\.1:1.*\), so its result is withheld\.$/u)
  } finally {
    await booted.ctx.fiber.dispose()
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true, maxRetries: 5 })
  }
})

it.skipIf(skip)('holds no connection to the browser while the person has it, and reconnects when they hand it back', { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'mumbo-browser-consent-takeover-'))
  vi.stubEnv('DSH_HOME', root)
  const chromium = launchChromium(root)
  // Every connection to the debugging port, the HTTP version request and the CDP WebSocket alike, passes through here.
  const open = new Set<Socket>()
  const proxy = createTcpServer((client) => {
    open.add(client)
    const upstream = connect(Number(debugPort), '127.0.0.1')
    const close = () => {
      open.delete(client)
      client.destroy()
      upstream.destroy()
    }
    for (const socket of [client, upstream]) socket.on('close', close).on('error', close)
    client.pipe(upstream).pipe(client)
  })
  let debugPort = ''
  let booted: Awaited<ReturnType<typeof bootComposition>> | undefined
  try {
    debugPort = await chromium.debugPort()
    proxy.listen(0, '127.0.0.1')
    await once(proxy, 'listening')
    const endpoint = `http://127.0.0.1:${String((proxy.address() as AddressInfo).port)}`
    booted = await bootComposition(root, { consent: { browser: { mode: 'attach', endpoint, outputDir: join(root, '.playwright-mcp') }, deniedUrls: ['chrome:'], ...await uploads(root) } })
    const { ctx, agent } = booted
    const snapshot = async () => (await executeModelToolFixture(ctx, {
      agent, name: tool('browser_snapshot'), arguments: {}, callId: ToolCallId('snapshot'), signal: new AbortController().signal,
    })).content.map(block => block.type === 'text' ? block.text : '').join('\n')
    expect(await snapshot()).toContain('- Page URL: about:blank')
    expect(open.size).toBeGreaterThan(0)
    // Chromium's own list of its tabs, read past the proxy.
    const tabs = async () => (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json() as Array<{ id: string; type: string }>)
      .filter(target => target.type === 'page').map(target => target.id)
    const before = await tabs()

    const takeover = ctx.get('mumbo-browser-consent')!
    await takeover.takeOver()
    await expect.poll(() => open.size, { timeout: 15_000 }).toBe(0)
    // Closing the connection leaves the person's tabs open.
    expect(await tabs()).toEqual(before)
    expect(await snapshot()).toBe('Error: browser_snapshot did not run: the person has taken over the browser. Browser and desktop tools stay unavailable until they hand it back.')
    expect(open.size).toBe(0)

    await takeover.handBack()
    expect(open.size).toBeGreaterThan(0)
    expect(await snapshot()).toContain('- Page URL: about:blank')
  } finally {
    await booted?.ctx.fiber.dispose()
    for (const socket of open) socket.destroy()
    proxy.close()
    await chromium.stop()
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true, maxRetries: 5 })
  }
})
