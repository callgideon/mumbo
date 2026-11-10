/**
 * Stdio stand-in for the Playwright MCP server: tabs whose URLs follow navigation, a `?redirect=` query, and clicks on a
 * `link:<url>` target, plus a call log. Each call is logged with the current tab's URL before the call. The first tab
 * starts on the URL in the third argument, or `about:blank`; a click on a `report:<url>` target reports that page URL
 * without moving the tab, as when the person leaves the page between the call and the next listing. Each click writes
 * the page it ends on to `page-<n>.yml` in the output directory, the fourth argument or `.playwright-mcp` in the working
 * directory, and links it relative to the working directory under a title naming the clicked element, as Playwright
 * MCP links an element screenshot.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { createInterface } from 'node:readline'

const [root, mode, start, outputDir] = process.argv.slice(2)
const output = outputDir || '.playwright-mcp'
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
const text = value => ({ content: [{ type: 'text', text: value }] })
const tool = (name, properties = {}) => ({ name, description: `Fixture ${name}.`, inputSchema: { type: 'object', properties } })
const TOOLS = [
  tool('browser_navigate', { url: { type: 'string' } }),
  tool('browser_snapshot'),
  tool('browser_tabs', { action: { type: 'string' }, index: { type: 'number' }, url: { type: 'string' } }),
  tool('browser_click', { element: { type: 'string' }, target: { type: 'string' } }),
  tool('browser_type', { element: { type: 'string' }, target: { type: 'string' }, text: { type: 'string' } }),
  tool('browser_file_upload', { paths: { type: 'array', items: { type: 'string' } } }),
  tool('browser_evaluate', { function: { type: 'string' } }),
  tool('browser_close'),
  tool('browser_network_requests'),
  tool('browser_network_request', { index: { type: 'number' } }),
]
const tabs = [{ url: start || 'about:blank' }]
let current = 0
let written = 0
/** Follow a `?redirect=` query to its target, as a server redirect would. */
const land = url => new URL(url).searchParams.get('redirect') ?? url

createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line)
  if (request.id === undefined) return
  switch (request.method) {
    case 'server/discover':
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Legacy fixture' } }) + '\n')
      break
    case 'initialize':
      reply(request.id, { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'playwright-fixture', version: '1' } })
      break
    case 'tools/list':
      reply(request.id, { tools: mode === 'no-tabs' ? TOOLS.filter(entry => entry.name !== 'browser_tabs') : TOOLS })
      break
    case 'tools/call': {
      const { name, arguments: args } = request.params
      appendFileSync(join(root, 'calls.ndjson'), JSON.stringify({ name, args, url: tabs[current].url }) + '\n')
      if ((name === 'browser_tabs' && tabs[current].url.includes('broken')) || args.target === 'gone') {
        reply(request.id, { ...text('### Error\nError: fixture failure'), isError: true })
        break
      }
      if (name === 'browser_navigate') tabs[current].url = land(args.url)
      if (name === 'browser_click' && args.target?.startsWith('link:')) tabs[current].url = args.target.slice('link:'.length)
      if (name === 'browser_tabs' && args.action === 'new') current = tabs.push({ url: args.url ?? 'about:blank' }) - 1
      if (name === 'browser_tabs' && args.action === 'select') current = args.index
      const reported = name === 'browser_click' && args.target?.startsWith('report:') ? args.target.slice('report:'.length) : tabs[current].url
      let snapshot = ''
      if (name === 'browser_click') {
        const file = join(output, `page-${++written}.yml`)
        mkdirSync(output, { recursive: true })
        writeFileSync(file, `- text: ${reported}\n`)
        snapshot = `\n### Snapshot\n- [Snapshot of ${args.element ?? 'the page'}](${relative(process.cwd(), file)})`
      }
      reply(request.id, name === 'browser_tabs'
        ? text(`### Result\n${tabs.map((tab, index) => `- ${index}:${index === current ? ' (current)' : ''} [Fixture page](${tab.url})`).join('\n')}`)
        : text(`### Page\n- Page URL: ${reported}${snapshot}`))
      break
    }
    default:
      throw new Error(`Unexpected method ${request.method}`)
  }
})
