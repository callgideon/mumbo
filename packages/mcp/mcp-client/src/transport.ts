/**
 * Transport factory: creates the appropriate MCP transport based on the
 * plugin's resolved config. Stdio spawns a child process (with credential
 * scrubbing), through the subprocess seam when the config names an identity;
 * Streamable HTTP connects to a URL.
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
 * named identity. The child receives that identity's environment plus the configured `env`, never
 * this process's environment, and none of this process's descriptors: its standard error is discarded.
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
  ) {}

  start(): Promise<void> {
    if (this.started) throw new Error('MCP stdio transport already started')
    this.started = true
    const handle = this.handle = this.subprocess.spawn({
      argv: [this.config.command, ...this.config.args],
      cwd: this.config.cwd === '' ? process.cwd() : this.config.cwd,
      env: this.config.env,
      identity: this.identity,
      graceMs: CLOSE_GRACE_MS,
      // A contained server never writes to this process's standard error; its diagnostics are read and dropped.
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 0 } },
    })
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
 * Create an MCP transport from the resolved plugin config.
 *
 * @param config - Resolved plugin config discriminated on `transport`.
 * @param ctx - context whose subprocess service starts a stdio server that names an identity.
 * @returns an unstarted MCP transport (stdio or Streamable HTTP).
 * @throws when a stdio config names an identity and no subprocess service is mounted.
 */
export function createTransport(config: Config, ctx: Context): Transport {
  switch (config.transport) {
    case 'stdio': {
      if (config.identity !== undefined) {
        const subprocess = ctx.get('subprocess')
        if (subprocess === undefined) throw new Error(`mcp-client(${config.serverName}): identity ${JSON.stringify(config.identity)} requires a subprocess service`)
        return new SubprocessStdioTransport(subprocess, config, config.identity)
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
