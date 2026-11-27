import { execFileSync } from 'node:child_process'
import { request as httpRequest } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Group from '@deepseek-ai/cordis-plugin-group'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as McpDoor from '../src/index.ts'
import { unfence } from './door-fixture.ts'

const DOOR_TOOLS = ['agent_send', 'agent_read', 'needs_you', 'task_reply', 'task_status', 'task_result']

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  vi.unstubAllEnvs()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/**
 * Where a test boots the composition: the loopback entry list; the person-box overlay applied as `dsh --patch` does;
 * that overlay over a Web listener and Connection, as a box composes it; or the door on that Web listener itself.
 */
type Composition = 'loopback' | 'person' | 'person-beside-web' | 'on-web-listener'

/** The public host a box's Connection trusts, as `dsh web --trusted-host` configures it. */
const SITE_HOST = 'app.mumbo.si'

/** The Web profile's own listener and Connection, trusting the site host. */
const WEB_ROWS = [
  { id: 'webserver', name: '@deepseek-ai/dsh-host-webserver', config: { host: '127.0.0.1', port: 0 } },
  { id: 'client-connection', name: '@deepseek-ai/dsh-client-connection', config: { trustedHosts: [SITE_HOST] } },
]

/** The door row of the person-box overlay, placed on the listener its scope already has. */
const DOOR_ROW = {
  id: 'mumbo-mcp', name: '@mumbo/mcp',
  config: { keyFile: { __jsExpr: 'process.env.MUMBO_MCP_KEY_FILE' }, allowlist: ['ann'], session: 'mumbo', profile: 'door', assistantCwd: { __jsExpr: 'process.env.MUMBO_MCP_ASSISTANT_CWD' } },
}

/** A booted composition: its temp root, the door's `/mcp` URL, and the Session ids the fake session controller resolved. */
interface Booted {
  readonly root: string
  readonly url: string
  readonly resolved: string[]
}

/**
 * Boot the host services the Web profile provides, with fake Session services, and let the real Loader mount the
 * composition with the key, principal `ann` and assistant directory under a fresh temp root.
 * @param composition - which shipped file to mount.
 * @returns the temp root, which is also the assistant directory, the door's URL, and the resolved Session ids.
 */
async function boot(composition: Composition): Promise<Booted> {
  const dir = root = await mkdtemp(join(tmpdir(), 'mumbo-mcp-loader-'))
  await writeFile(join(root, 'key'), 'loader-key\n')
  vi.stubEnv('MUMBO_MCP_PORT', '0')
  vi.stubEnv('MUMBO_MCP_KEY_FILE', join(root, 'key'))
  vi.stubEnv('MUMBO_MCP_ASSISTANT_CWD', root)
  vi.stubEnv('MUMBO_MCP_PRINCIPAL', 'ann')

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Storage)
  await context.plugin(StorageJson, { root: join(root, 'storage') })
  await context.plugin(StorageDomain, { backend: 'json' })
  await context.plugin(LocalSubprocessRuntime)
  const resolved: string[] = []
  context.provide('sessionController', {
    resolveAgent: async (sessionId: string) => {
      resolved.push(sessionId)
      return { agent: { id: sessionId, session: { id: sessionId } } }
    },
  } as never)
  context.provide('sessionProjections', {
    snapshot: () => ({ asOfSeq: 0, values: {} }),
    register: () => Promise.resolve({ stateOf: () => false, dispose: () => Promise.resolve() }),
  } as never)
  for (const service of ['workspaceRegistry', 'agents', 'subagents', 'jobs', 'permissionPresets']) context.provide(service, {} as never)
  await context.plugin(Loader)
  const modules = new Map<string, object>([
    ['@deepseek-ai/dsh-host-webserver', WebServer],
    ['@deepseek-ai/dsh-client-connection', Connection],
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
  if (composition === 'loopback') {
    const path = fileURLToPath(new URL('../examples/loopback/cordis.yml', import.meta.url))
    await loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
  } else {
    const base = join(root, 'cordis.yml')
    const rows = composition === 'person' ? [] : composition === 'person-beside-web' ? WEB_ROWS : [...WEB_ROWS, DOOR_ROW]
    await writeFile(base, JSON.stringify(rows))
    const overlay = fileURLToPath(new URL('../examples/person.overlay.yml', import.meta.url))
    const patches = composition === 'on-web-listener' ? [] : loadOverlayPatches('mumbo-mcp-test', overlay)
    await loader.create({ name: 'cordis:include', config: { path: pathToFileURL(base).href, patches } })
  }
  await loader.await()
  const entries = [...loader.entries()]
  expect(entries.filter(entry => entry.fiber === undefined && !entry.disabled).map(entry => entry.options.id)).toEqual([])

  const door = entries.find(entry => entry.options.id === 'mumbo-mcp')
  const port = door?.fiber?.ctx.webServer.port
  expect(port).toBeTypeOf('number')
  // Except when the door sits on the Web listener itself, its listener is its group's own.
  if (composition === 'on-web-listener') expect(context.get('webServer')?.port).toBe(port)
  else if (composition === 'person-beside-web') expect(context.get('webServer')?.port).not.toBe(port)
  else expect(context.get('webServer')).toBeUndefined()
  return { root: dir, url: `http://127.0.0.1:${String(port)}/mcp`, resolved }
}

/**
 * Send one JSON-RPC request to the door as principal `ann`.
 * @param url - the door's `/mcp` URL.
 * @param method - the JSON-RPC method.
 * @param params - its parameters.
 * @returns the JSON-RPC result.
 */
async function rpc(url: string, method: string, params: object): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: 'Bearer loader-key',
      'x-mcp-principal': 'ann',
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  expect(response.status).toBe(200)
  return ((await response.json()) as { result: unknown }).result
}

describe('real Loader composition', () => {
  it.each([
    ['loopback' as const, [...DOOR_TOOLS, 'runs_halt', 'runs_resume']],
    ['person' as const, DOOR_TOOLS],
  ])('mounts the %s composition on its own listener, serves its tools on /mcp, and provides the report-turn gate to every plugin', { timeout: 60_000 }, async (composition, tools) => {
    const { url } = await boot(composition)
    const result = await rpc(url, 'tools/list', {}) as { tools: { name: string }[] }
    expect(result.tools.map(tool => tool.name)).toEqual(tools)
    // The group isolates only webServer, so the service reaches plugins outside it, such as browser consent.
    expect(Object.keys(context?.get('mumbo-report-turns') ?? {})).toEqual(['reportStarted'])
  })

  it('answers task_status in the person-box overlay from the Session mumbo and the checkout it names', { timeout: 60_000 }, async () => {
    // Git in the test and in the plugin reads no user or system configuration.
    vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null')
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
    const { root: checkout, url, resolved } = await boot('person')
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: checkout })
    const result = await rpc(url, 'tools/call', { name: 'task_status', arguments: {} }) as { isError?: boolean; content: { text: string }[] }
    expect(result.isError).toBeUndefined()
    const status = JSON.parse(result.content[0]?.text ?? '') as { assistant_session: string; worktrees: string }
    expect(status.assistant_session).toBe('mumbo')
    expect(resolved).toEqual(['mumbo'])
    expect(unfence(status.worktrees)).toContain(`worktree ${checkout}\n`)
  })
})

/**
 * POST `tools/list` to the door as principal `ann` with exactly this Host and bearer key.
 * @param url - the door's `/mcp` URL.
 * @param host - the Host header the box receives.
 * @param key - the bearer key, or undefined to send none.
 * @returns the response status and body text.
 */
function doorRequest(url: string, host: string, key: string | undefined): Promise<{ status: number; body: string }> {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(url, {
      method: 'POST',
      headers: {
        host, 'x-mcp-principal': 'ann', 'content-type': 'application/json', accept: 'application/json, text/event-stream',
        'content-length': Buffer.byteLength(body), ...key === undefined ? {} : { authorization: `Bearer ${key}` },
      },
    }, (response) => {
      let text = ''
      response.setEncoding('utf8').on('data', (chunk: string) => { text += chunk })
      response.on('end', () => { resolve({ status: response.statusCode ?? 0, body: text }) })
    })
    outgoing.on('error', reject)
    outgoing.end(body)
  })
}

describe('door admission in a box composition', () => {
  const SITE_HOSTS = [SITE_HOST, `${SITE_HOST}:882`, `${SITE_HOST}:443`]

  it.each(['person-beside-web', 'on-web-listener'] as const)('refuses a missing and a wrong key in the %s composition, whichever site Host the edge sends', { timeout: 60_000 }, async (composition) => {
    const { url } = await boot(composition)
    for (const host of SITE_HOSTS) {
      expect(await doorRequest(url, host, undefined), host).toEqual({ status: 401, body: 'invalid key' })
      expect(await doorRequest(url, host, 'wrong-key'), host).toEqual({ status: 401, body: 'invalid key' })
      const served = await doorRequest(url, host, 'loader-key')
      expect(served.status, host).toBe(200)
      expect(served.body, host).toContain('"agent_send"')
    }
  })

  it('refuses an untrusted Host with 403 before the key check when the door shares the Web listener', { timeout: 60_000 }, async () => {
    const { url } = await boot('on-web-listener')
    for (const key of ['loader-key', 'wrong-key', undefined]) {
      expect(await doorRequest(url, 'evil.example', key), String(key)).toEqual({ status: 403, body: 'forbidden' })
    }
  })

  it('admits a request on the door\'s own listener by the key and the principal alone, whatever its Host', { timeout: 60_000 }, async () => {
    const { url } = await boot('person-beside-web')
    // Connection's source policy follows the Web listener's isolation and never sees this listener's requests.
    expect((await doorRequest(url, 'evil.example', 'loader-key')).status).toBe(200)
    expect(await doorRequest(url, 'evil.example', 'wrong-key')).toEqual({ status: 401, body: 'invalid key' })
    expect(await doorRequest(url, 'evil.example', undefined)).toEqual({ status: 401, body: 'invalid key' })
  })
})
