/** Consent against the pinned Playwright MCP server attached to a disposable Chromium and two loopback origins. */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { expect, it, vi } from 'vitest'
import { bootComposition, consentRecords } from './harness.ts'

it.skipIf(process.env.DSH_BROWSER_EXECUTABLE === undefined)('asks before a click or code run on a site the person has not allowed', { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'mumbo-browser-consent-e2e-'))
  const sent: string[] = []
  const server = createServer((request, response) => {
    if (request.method === 'POST') sent.push(request.headers.host!)
    response.writeHead(200, { 'Content-Type': 'text/html' })
    response.end('<!doctype html><title>Compose</title><form method="post" action="/send"><button id="send">Send</button></form>')
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
    const allowed = `http://127.0.0.1:${String(port)}`
    const other = `http://localhost:${String(port)}`
    booted = await bootComposition(root, {
      browser: { mode: 'attach', endpoint: `http://127.0.0.1:${debugPort}` },
      allowedSites: [allowed],
      script: [
        { name: 'browser_navigate', args: { url: `${allowed}/` } },
        { name: 'browser_click', args: { element: 'Send', target: '#send' } },
        { name: 'browser_navigate', args: { url: `${other}/` } },
        { name: 'browser_click', args: { element: 'Send', target: '#send' } },
        { name: 'browser_evaluate', args: { function: '() => document.forms[0].requestSubmit()' } },
      ],
      answers: ['rejected', 'rejected'],
    })
    booted.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Send both drafts.' }], source: { kind: 'user' } }))
    await booted.agent.whenIdle()

    expect(sent).toEqual([`127.0.0.1:${String(port)}`])
    expect(booted.asked).toEqual([
      `Browser write: browser_click on ${other} (the assistant describes the target as "Send")`,
      `Browser write: browser_evaluate on ${other}; this action can reach beyond the current site, so site allowances do not cover it`,
    ])
    expect(consentRecords(booted.events)).toEqual([{ callId: 'call-1', tool: 'browser_click', site: allowed, grant: 'site', outcome: 'succeeded' }])
  } finally {
    await booted?.ctx.fiber.dispose()
    if (chromium.exitCode === null) chromium.kill('SIGTERM')
    await exited
    server.closeAllConnections()
    server.close()
    await rm(root, { recursive: true, force: true })
  }
})
