/**
 * Stdio stand-in for the Playwright MCP server: tabs whose URLs follow navigation, a `?redirect=` query, and clicks on a
 * `link:<url>` target, plus a call log. Each call is logged with the current tab's URL before the call. The first tab
 * starts on the URL in the third argument, or `about:blank`; a click on a `report:<url>` target reports that page URL
 * without moving the tab, as when the person leaves the page between the call and the next listing.
 *
 * Output follows the pinned server. Each click writes the page it ends on to `page-<n>.yml` in the output directory,
 * the fourth argument or `.playwright-mcp` in the working directory, and links it relative to the working directory
 * under a title naming the clicked element; a `link:` click also writes a console log linked with a line range. A tab
 * listing repeats the tabs under `### Open tabs` with an earlier current tab, as upstream does when a header changes
 * between its two reads. A page whose URL holds `brackets` has a title holding `](`. A snapshot of a page whose URL
 * holds `login` shows a masked password field; a snapshot fails on a page whose URL holds `nosnap`, and a tab listing
 * on one whose URL holds `broken`. `browser_close` answers with upstream's fixed result followed by the page section,
 * and fails on a page whose URL holds `noclose`. Every other call on a page whose URL holds `stall` never answers, and
 * only `browser_tabs` on one whose URL holds `stalltabs`. An upload logs the content of each file it receives.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
  tool('browser_run_code_unsafe', { code: { type: 'string' } }),
  tool('browser_close'),
  tool('browser_console_messages', { all: { type: 'boolean' } }),
  tool('browser_network_requests'),
  tool('browser_network_request', { index: { type: 'number' } }),
]
const tabs = [{ url: start || 'about:blank' }]
let current = 0
let written = 0
/** Follow a `?redirect=` query to its target, as a server redirect would. */
const land = url => new URL(url).searchParams.get('redirect') ?? url
const title = url => url.includes('brackets') ? 'Fix [x](y)' : 'Fixture page'
const listing = currentIndex => tabs.map((tab, index) => `- ${index}:${index === currentIndex ? ' (current)' : ''} [${title(tab.url)}](${tab.url})`).join('\n')

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
      // An upload records what the browser would read from each path it receives.
      const files = name === 'browser_file_upload' ? args.paths?.map(path => readFileSync(path, 'utf8')) : undefined
      appendFileSync(join(root, 'calls.ndjson'), JSON.stringify({ name, args, url: tabs[current].url, ...files === undefined ? {} : { files } }) + '\n')
      const url = tabs[current].url
      if (url.includes('stalltabs') ? name === 'browser_tabs' : url.includes('stall') && name !== 'browser_close') break
      const failing = name === 'browser_tabs' ? 'broken' : name === 'browser_snapshot' ? 'nosnap' : name === 'browser_close' ? 'noclose' : undefined
      if ((failing !== undefined && tabs[current].url.includes(failing)) || args.target === 'gone') {
        reply(request.id, { ...text('### Error\nError: fixture failure'), isError: true })
        break
      }
      const before = current
      if (name === 'browser_navigate') tabs[current].url = land(args.url)
      if (name === 'browser_click' && args.target?.startsWith('link:')) tabs[current].url = args.target.slice('link:'.length)
      if (name === 'browser_tabs' && args.action === 'new') current = tabs.push({ url: args.url ?? 'about:blank' }) - 1
      if (name === 'browser_tabs' && args.action === 'select') current = args.index
      const reported = name === 'browser_click' && args.target?.startsWith('report:') ? args.target.slice('report:'.length) : tabs[current].url
      const page = `### Page\n- Page URL: ${reported}\n- Page Title: ${title(reported)}`
      if (name === 'browser_tabs') {
        reply(request.id, text(`### Result\n${listing(current)}\n### Open tabs\n${listing(before === current ? 0 : before)}`))
        break
      }
      if (name === 'browser_close') {
        reply(request.id, text(`### Result\nNo open tabs. Navigate to a URL to create one.\n${page}`))
        break
      }
      // A page whose URL holds `login` shows a password field, which the patched snapshot masks.
      let sections = name === 'browser_snapshot' && tabs[current].url.includes('login')
        ? `\n### Snapshot\n\`\`\`yaml\n- textbox "Password" [ref=e1]: ${String.fromCharCode(0x2022).repeat(4)}\n\`\`\``
        : ''
      if (name === 'browser_click') {
        mkdirSync(output, { recursive: true })
        const file = join(output, `page-${++written}.yml`)
        writeFileSync(file, `- text: ${reported}\n`)
        sections = `\n### Snapshot\n- [Snapshot of ${args.element ?? 'the page'}](${relative(process.cwd(), file)})`
        if (args.target?.startsWith('link:')) {
          const log = join(output, `console-${written}.log`)
          writeFileSync(log, `[LOG] one @ ${reported}\n[LOG] two @ ${reported}\n[LOG] three @ ${reported}\n`)
          sections += `\n### Events\n- New console entries: ${relative(process.cwd(), log)}#L1-L3`
        }
      }
      reply(request.id, text(`${page}${sections}`))
      break
    }
    default:
      throw new Error(`Unexpected method ${request.method}`)
  }
})
