/**
 * Stdio stand-in for the Playwright MCP server: tabs whose URLs follow navigation, a `?redirect=` query, and clicks on a
 * `link:<url>` target, plus a call log. Each call is logged with the current tab's URL before the call.
 */
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const [root, mode] = process.argv.slice(2)
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
]
const tabs = [{ url: 'about:blank' }]
let current = 0
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
      reply(request.id, name === 'browser_tabs'
        ? text(`### Result\n${tabs.map((tab, index) => `- ${index}:${index === current ? ' (current)' : ''} [Fixture page](${tab.url})`).join('\n')}`)
        : text(`### Page\n- Page URL: ${tabs[current].url}`))
      break
    }
    default:
      throw new Error(`Unexpected method ${request.method}`)
  }
})
