import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { expect, it, onTestFinished } from 'vitest'
import { bootBrowserProvider, verifyMcpBrowser } from '../../browser-use-runtime/tests/mcp-upstream.ts'
import * as Provider from '../src/index.ts'

const executable = process.env.DSH_BROWSER_EXECUTABLE

it.skipIf(executable === undefined).each(['launch', 'attach'] as const)(
  'uses the pinned Playwright MCP server to %s Chromium and visit a loopback page',
  async mode => verifyMcpBrowser(Provider, 'playwright-mcp', { name: 'browser_navigate', arguments: url => ({ url }) }, mode),
)

it.skipIf(executable === undefined)('sends a file from the file root to the page, and refuses one from anywhere else', { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-playwright-file-root-'))
  const ctx = new Context()
  // The page shows the content of the file it receives in its title.
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' })
    response.end('<!doctype html><title>waiting</title><input type="file" onchange="this.files[0].text().then(text => { document.title = text })">')
  })
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    server.closeAllConnections()
    server.close()
    await rm(root, { recursive: true, force: true })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as { port: number }
  const [staging, elsewhere, output] = ['staging', 'elsewhere', 'output'].map(name => join(root, name))
  for (const directory of [staging!, elsewhere!, output!]) await mkdir(directory)
  await writeFile(join(staging!, 'staged.txt'), 'staged content')
  await writeFile(join(elsewhere!, 'other.txt'), 'other content')
  const owner = await bootBrowserProvider(ctx, Provider, { mode: 'launch', headless: true, executablePath: executable!, outputDir: output!, fileRoot: staging! }, root)
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await executeToolFixture(ctx, { agent: owner.agent, name: `mcp__playwright-mcp__${name}`, arguments: args, callId: ToolCallId(name), signal: new AbortController().signal })
    return { isError: result.isError, text: result.content.map(block => (block as { text?: string }).text ?? '').join('\n') }
  }
  await call('browser_navigate', { url: `http://127.0.0.1:${String(port)}/` })
  const snapshot = (await call('browser_snapshot', {})).text
  const target = /\[ref=(e\d+)\]/u.exec(snapshot)?.[1]
  expect(target, snapshot).toBeDefined()
  // A click on the file input opens the file chooser, which an upload then answers.
  const choose = () => call('browser_click', { element: 'file input', target })
  expect((await choose()).text).toContain('File chooser')
  const refused = await call('browser_file_upload', { paths: [join(elsewhere!, 'other.txt')] })
  expect(refused).toMatchObject({ isError: true })
  expect(refused.text).toContain(`File access denied: ${join(elsewhere!, 'other.txt')} is outside allowed roots`)
  expect((await choose()).text).toContain('File chooser')
  const sent = await call('browser_file_upload', { paths: [join(staging!, 'staged.txt')] })
  expect(sent.isError, sent.text).toBe(false)
  await expect.poll(async () => (await call('browser_snapshot', {})).text, { timeout: 20_000 }).toContain('Page Title: staged content')
})
