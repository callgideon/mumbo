/** Stdio stand-in for the Playwright MCP server: one tab whose URL follows navigation, and a call log. */
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
  tool('browser_tabs', { action: { type: 'string' }, url: { type: 'string' } }),
  tool('browser_click', { element: { type: 'string' }, target: { type: 'string' } }),
  tool('browser_type', { element: { type: 'string' }, target: { type: 'string' }, text: { type: 'string' } }),
  tool('browser_evaluate', { function: { type: 'string' } }),
]
let url = 'about:blank'

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
      appendFileSync(join(root, 'calls.ndjson'), JSON.stringify({ name, args, url }) + '\n')
      if (name === 'browser_navigate') url = args.url
      if ((name === 'browser_tabs' && url.includes('broken')) || args.target === 'gone') {
        reply(request.id, { ...text('### Error\nError: fixture failure'), isError: true })
      } else {
        reply(request.id, name === 'browser_tabs'
          ? text(`### Result\n- 0: (current) [Fixture page](${url})`)
          : text(`### Page\n- Page URL: ${url}`))
      }
      break
    }
    default:
      throw new Error(`Unexpected method ${request.method}`)
  }
})
