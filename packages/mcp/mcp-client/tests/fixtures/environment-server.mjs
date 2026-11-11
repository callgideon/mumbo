// MCP server over stdio whose one tool reports this process's user id, working directory, and exact environment.
import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { z } from 'zod'

serveStdio(() => {
  const server = new McpServer({ name: 'environment', version: '1.0.0' }, { capabilities: { tools: {} } })
  server.registerTool('environment', { description: 'Report this server process.', inputSchema: z.object({}) }, async () => ({
    content: [{ type: 'text', text: JSON.stringify({ uid: process.getuid(), cwd: process.cwd(), env: process.env }) }],
  }))
  return server
})
