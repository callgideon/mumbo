// MCP server over stdio, in raw JSON-RPC, whose one tool `roots` reports the capabilities the client declared and,
// when they include `roots`, the client's answer to `roots/list`.
import { createInterface } from 'node:readline'

const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
const waiting = new Map()
let capabilities

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === undefined) {
    waiting.get(message.id)?.(message)
    waiting.delete(message.id)
    return
  }
  if (message.id === undefined) return
  switch (message.method) {
    case 'server/discover':
      send({ id: message.id, error: { code: -32601, message: 'Legacy fixture' } })
      break
    case 'initialize':
      capabilities = message.params.capabilities
      send({ id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'roots', version: '1' } } })
      break
    case 'tools/list':
      send({ id: message.id, result: { tools: [{ name: 'roots', description: 'Report the client roots.', inputSchema: { type: 'object', properties: {} } }] } })
      break
    case 'tools/call': {
      const report = answer => send({ id: message.id, result: { content: [{ type: 'text', text: JSON.stringify({ capabilities, answer }) }] } })
      if (capabilities.roots === undefined) {
        report(null)
        break
      }
      waiting.set('roots', report)
      send({ id: 'roots', method: 'roots/list' })
      break
    }
    default:
      send({ id: message.id, error: { code: -32601, message: `Unexpected ${message.method}` } })
  }
})
