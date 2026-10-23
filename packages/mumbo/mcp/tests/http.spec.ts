import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterEach, describe, expect, it } from 'vitest'
import * as McpDoor from '../src/index.ts'

const KEY = 'fixture-key-0123456789'
const TOOLS_LIST = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** A real WebServer on an OS port plus the plugin config for a temp key file. */
async function host(keyText = `${KEY}\n`, allowlist = ['ann']): Promise<{ ctx: Context; config: McpDoor.Config; url: string }> {
  root = await mkdtemp(join(tmpdir(), 'mumbo-mcp-http-'))
  const keyFile = join(root, 'key')
  await writeFile(keyFile, keyText)
  context = new Context()
  await context.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  const config = { keyFile, allowlist, assistantTitle: 'assistant', assistantCwd: root, irreversibleTools: [] } satisfies McpDoor.Config
  return { ctx: context, config, url: `${context.webServer.getOrigin()}/mcp` }
}

/** Start the plugin and return the route URL. */
async function serve(): Promise<string> {
  const { ctx, config, url } = await host()
  await ctx.plugin(McpDoor, config)
  return url
}

/** Send one MCP-style request; `null` omits a header. */
async function post(url: string, options: {
  authorization?: string | null
  principal?: string | null
  body?: string
  method?: string
} = {}): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  }
  const authorization = options.authorization === undefined ? `Bearer ${KEY}` : options.authorization
  const principal = options.principal === undefined ? 'ann' : options.principal
  if (authorization !== null) headers.authorization = authorization
  if (principal !== null) headers['x-mcp-principal'] = principal
  const method = options.method ?? 'POST'
  return await fetch(url, { method, headers, ...(method === 'POST' ? { body: options.body ?? TOOLS_LIST } : {}) })
}

describe('authenticated /mcp route', () => {
  it('answers an allowlisted principal with the trimmed key with JSON', async () => {
    const response = await post(await serve())
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toMatch(/^application\/json/)
    expect(await response.json()).toEqual({ jsonrpc: '2.0', id: 1, result: { tools: [] } })
  })

  it.each([
    ['no authorization header', null],
    ['a wrong key of equal length', `Bearer ${'x'.repeat(KEY.length)}`],
    ['a wrong key of other length', 'Bearer short'],
    ['the key without its scheme', KEY],
  ])('refuses %s with 401', async (_label, authorization) => {
    const response = await post(await serve(), { authorization })
    expect(response.status).toBe(401)
  })

  it.each([
    ['a principal outside the allowlist', 'eve'],
    ['a malformed principal', 'Bad Name'],
    ['no principal header', null],
  ])('refuses %s with 403', async (_label, principal) => {
    const response = await post(await serve(), { principal })
    expect(response.status).toBe(403)
  })

  it('accepts a notification with an empty 202', async () => {
    const response = await post(await serve(), { body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) })
    expect(response.status).toBe(202)
    expect(await response.text()).toBe('')
  })

  it.each([
    ['406 without text/event-stream in accept', { accept: 'application/json' }, 406],
    ['415 for a non-JSON media type', { 'content-type': 'text/plain' }, 415],
    ['400 for a body that is not JSON-RPC', { body: 'not json' }, 400],
  ])('answers %s', async (_label, override, status) => {
    const { body, ...headers } = { body: TOOLS_LIST, ...override }
    const response = await fetch(await serve(), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${KEY}`,
        'x-mcp-principal': 'ann',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...headers,
      },
      body,
    })
    expect(response.status).toBe(status)
  })

  it('refuses a body over 1 MiB with 413', async () => {
    const response = await post(await serve(), { body: 'x'.repeat(1024 * 1024 + 1) })
    expect(response.status).toBe(413)
  })

  it('refuses GET with 405', async () => {
    const response = await post(await serve(), { method: 'GET' })
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('POST')
  })

  it('serves the SDK client', async () => {
    const client = new Client({ name: 'fixture', version: '0.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(await serve()), {
      requestInit: { headers: { authorization: `Bearer ${KEY}`, 'x-mcp-principal': 'ann' } },
    }))
    try {
      expect((await client.listTools()).tools).toEqual([])
    } finally {
      await client.close()
    }
  })
})

describe('plugin lifecycle', () => {
  it('fails load on an empty key file and registers no route', async () => {
    const { ctx, config, url } = await host(' \n')
    await expect(ctx.plugin(McpDoor, config)).rejects.toThrow(/keyFile .* is empty/)
    expect((await post(url)).status).toBe(404)
  })

  it('fails load on a malformed allowlist entry', async () => {
    const { ctx, config, url } = await host(`${KEY}\n`, ['Bad Name'])
    await expect(ctx.plugin(McpDoor, config)).rejects.toThrow(/allowlist\[0\]/)
    expect((await post(url)).status).toBe(404)
  })

  it('frees /mcp on unload so a later load registers it again', async () => {
    const { ctx, config, url } = await host()
    const fiber = ctx.plugin(McpDoor, config)
    await fiber
    await fiber.dispose()
    expect((await post(url)).status).toBe(404)
    await ctx.plugin(McpDoor, config)
    expect((await post(url)).status).toBe(200)
  })
})
