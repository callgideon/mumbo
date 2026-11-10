/**
 * Transport factory: creates the appropriate MCP transport based on the
 * plugin's resolved config. Stdio spawns a child process (with credential
 * scrubbing), through the subprocess seam when the config names an identity or
 * the mounted subprocess provider runs children as a run-as identity; such a
 * server runs as the named identity, or else as the provider's server identity,
 * in that identity's home. Streamable HTTP connects to a URL.
 *
 * @module
 */

import { setTimeout as delay } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { JSONRPCMessage, Transport } from '@modelcontextprotocol/client'
import { ReadBuffer, SdkError, SdkErrorCode, serializeMessage, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { Config, StdioConfig } from './index.ts'

/**
 * Milliseconds a closing server may take to exit after its stdin ends, and again after
 * termination starts; the SDK's own stdio transport allows the same.
 */
const CLOSE_GRACE_MS = 2000

/**
 * The subprocess seam's scrubbed parent env (credential-shaped and stale
 * `DSH_*` names dropped), plus the spec's explicit env. The MCP SDK owns the
 * actual spawn, so this transport shares the scrub definition rather than the
 * spawn path.
 */
function buildChildEnv(extra: Record<string, string>): Record<string, string> {
  return { ...scrubbedParentEnv(), ...extra }
}

/**
 * Newline-delimited JSON-RPC over the stdio of a server started through the subprocess seam as a
 * named identity, in a directory the factory chose. The child receives that identity's environment
 * plus the configured `env`, never this process's environment, and none of this process's
 * descriptors: its standard error is discarded.
 */
class SubprocessStdioTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void
  private handle: SubprocessHandle | undefined
  private started = false
  private readonly buffer = new ReadBuffer()

  constructor(
    private readonly subprocess: SubprocessRuntime,
    private readonly config: StdioConfig,
    private readonly identity: string,
    private readonly cwd: string,
  ) {}

  start(): Promise<void> {
    if (this.started) throw new Error('MCP stdio transport already started')
    this.started = true
    let handle: SubprocessHandle
    try {
      handle = this.handle = this.subprocess.spawn({
        argv: [this.config.command, ...this.config.args],
        cwd: this.cwd,
        env: this.config.env,
        identity: this.identity,
        graceMs: CLOSE_GRACE_MS,
        // A contained server never writes to this process's standard error; its diagnostics are read and dropped.
        stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 0 } },
      })
    } catch (error) {
      // Nothing started, such as when the provider refuses a secret name in `env`: report the closure once, so the
      // connection confirms it and can be retried, and fail the start with the provider's reason.
      queueMicrotask(() => { this.onclose?.() })
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- spawn throws an Error by its contract.
      return Promise.reject(error)
    }
    // Piped stdin and stdout are present by the spawn contract.
    const stdin = handle.stdin as NonNullable<SubprocessHandle['stdin']>
    const stdout = handle.stdout as NonNullable<SubprocessHandle['stdout']>
    stdin.on('error', (error: Error) => { this.onerror?.(error) })
    stdout.on('error', (error: Error) => { this.onerror?.(error) })
    stdout.on('data', (chunk: Buffer) => {
      try {
        this.buffer.append(chunk)
      } catch (error) {
        this.onerror?.(error as Error)
        void this.close()
        return
      }
      for (;;) {
        try {
          const message = this.buffer.readMessage()
          if (message === null) return
          this.onmessage?.(message)
        } catch (error) {
          this.onerror?.(error as Error)
        }
      }
    })
    void handle.done.then(
      () => undefined,
      (error: unknown) => { this.onerror?.(error instanceof Error ? error : new Error(String(error))) },
    ).finally(() => {
      this.handle = undefined
      this.onclose?.()
    })
    return Promise.resolve()
  }

  async close(): Promise<void> {
    const handle = this.handle
    if (handle !== undefined) {
      this.handle = undefined
      handle.stdin?.end()
      const exited = await Promise.race([
        handle.done.then(() => true, () => true),
        delay(CLOSE_GRACE_MS, false, { ref: false }),
      ])
      if (!exited) handle.terminate()
      await handle.waitForExit()
    }
    this.buffer.clear()
  }

  send(message: JSONRPCMessage): Promise<void> {
    const stdin = this.handle?.stdin
    if (stdin === undefined) return Promise.reject(new SdkError(SdkErrorCode.NotConnected, 'Not connected'))
    return new Promise((resolve) => {
      if (stdin.write(serializeMessage(message))) resolve()
      else stdin.once('drain', resolve)
    })
  }
}

/**
 * The home a stdio server that names an identity starts in, as the subprocess service checked it.
 * @param config - the server's stdio config.
 * @param identity - the identity the config names.
 * @param subprocess - the mounted subprocess service.
 * @returns the identity's home.
 * @throws when the service refuses the identity or its home.
 */
export function identityHome(config: StdioConfig, identity: string, subprocess: SubprocessRuntime): string {
  try {
    return subprocess.serverHome(identity)
  } catch (error) {
    throw new Error(`mcp-client(${config.serverName}): ${(error as Error).message}`, { cause: error })
  }
}

/**
 * Create an MCP transport from the resolved plugin config.
 *
 * @param config - Resolved plugin config discriminated on `transport`.
 * @param ctx - context whose subprocess service starts a stdio server that names an identity, and every stdio
 *   server when that service runs children as a run-as identity.
 * @returns an unstarted MCP transport (stdio or Streamable HTTP).
 * @throws when a stdio config names an identity and no subprocess service is mounted or it refuses that identity's
 *   home; under a provider that runs children as a run-as identity, when a stdio config names none and the provider
 *   names no server identity; or when the `cwd` of a server started through the subprocess service is not its
 *   identity's home.
 */
export function createTransport(config: Config, ctx: Context): Transport {
  switch (config.transport) {
    case 'stdio': {
      const subprocess = ctx.get('subprocess')
      const fail = (detail: string): never => { throw new Error(`mcp-client(${config.serverName}): ${detail}`) }
      // A server started through the subprocess service runs as an identity of its own in that identity's home, never in a
      // directory the model can write: the identity its config names or, under a run-as provider, the server identity.
      if (config.identity !== undefined || subprocess?.childIdentity !== undefined) {
        if (subprocess === undefined) return fail(`identity ${JSON.stringify(config.identity)} requires a subprocess service`)
        const server = config.identity !== undefined
          ? { name: config.identity, home: identityHome(config, config.identity, subprocess) }
          : subprocess.serverIdentity ?? fail('the subprocess provider runs children as a run-as identity but names no serverIdentity, which a stdio server that names no identity runs as')
        if (config.cwd !== '' && config.cwd !== server.home) {
          const runs = config.identity !== undefined ? `that names identity ${server.name} runs` : `that names no identity runs as ${server.name}`
          fail(`cwd ${JSON.stringify(config.cwd)} is not allowed: a stdio server ${runs} in its home ${JSON.stringify(server.home)}; remove cwd`)
        }
        return new SubprocessStdioTransport(subprocess, config, server.name, server.home)
      }
      return new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: buildChildEnv(config.env),
        cwd: config.cwd,
      })
    }
    case 'streamable-http':
      return new StreamableHTTPClientTransport(
        new URL(config.url),
        { requestInit: { headers: config.headers } },
      )
  }
}
