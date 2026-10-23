import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Group from '@deepseek-ai/cordis-plugin-group'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as McpDoor from '../src/index.ts'

const EXAMPLE = fileURLToPath(new URL('../examples/loopback/cordis.yml', import.meta.url))

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  vi.unstubAllEnvs()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('real Loader composition', () => {
  it('mounts the loopback example on its own listener and serves /mcp', { timeout: 60_000 }, async () => {
    root = await mkdtemp(join(tmpdir(), 'mumbo-mcp-loader-'))
    await writeFile(join(root, 'key'), 'loader-key\n')
    vi.stubEnv('MUMBO_MCP_PORT', '0')
    vi.stubEnv('MUMBO_MCP_KEY_FILE', join(root, 'key'))
    vi.stubEnv('MUMBO_MCP_ASSISTANT_CWD', root)

    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    // Host services the Web profile provides; the Session services stay unused by tools/list.
    await context.plugin(Storage)
    await context.plugin(StorageJson, { root: join(root, 'storage') })
    await context.plugin(StorageDomain, { backend: 'json' })
    for (const service of ['sessionController', 'workspaceRegistry', 'agents', 'subagents', 'jobs', 'sessionProjections', 'subprocess']) {
      context.provide(service, {} as never)
    }
    await context.plugin(Loader)
    const modules = new Map<string, object>([
      ['@deepseek-ai/dsh-host-webserver', WebServer],
      ['@mumbo/mcp', McpDoor],
    ])
    const loader = context.loader
    loader.builtins.group = Group
    loader.builtins.include = class FixtureInclude extends Include {
      override import(specifier: string, getOuterStack?: () => string[]): unknown {
        if (specifier.startsWith('cordis:')) return super.import(specifier, getOuterStack)
        const module = modules.get(specifier)
        if (module === undefined) throw new Error(`unexpected Loader import: ${specifier}`)
        return module
      }
    }
    await loader.create({ name: 'cordis:include', config: { path: pathToFileURL(EXAMPLE).href } })
    await loader.await()
    const entries = [...loader.entries()]
    expect(entries.filter(entry => entry.fiber === undefined && !entry.disabled).map(entry => entry.options.id)).toEqual([])

    const door = entries.find(entry => entry.options.id === 'mumbo-mcp')
    const port = door?.fiber?.ctx.webServer.port
    expect(port).toBeTypeOf('number')
    expect(context.get('webServer')).toBeUndefined()
    const response = await fetch(`http://127.0.0.1:${String(port)}/mcp`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer loader-key',
        'x-mcp-principal': 'ann',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    })
    expect(response.status).toBe(200)
    const body = await response.json() as { result: { tools: { name: string }[] } }
    expect(body.result.tools.map(tool => tool.name)).toEqual(['agent_send', 'agent_read', 'needs_you', 'task_reply', 'task_status', 'task_result', 'runs_halt', 'runs_resume'])
  })
})
