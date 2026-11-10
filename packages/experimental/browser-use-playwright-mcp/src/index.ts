/** Chromium browser tools from the pinned Playwright MCP server. @module */

import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { BrowserMcpConfig, mountSessionMcp, validateBrowserMcpConfig } from '@deepseek-ai/dsh-experimental-browser-use-runtime/mcp'
import Schema from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-working-directory'

/** Cordis identity for the Playwright MCP browser provider. */
export const name = 'experimental-browser-use-playwright-mcp'

/** Services required for scoped MCP startup and prompt readiness checks. */
export const inject = ['browserUse', 'agents', 'tools', 'systemPrompt', 'workingDirectory']

/** Fixed Chromium launch or existing-browser attachment settings, and where the server writes its files. */
export type Config = BrowserMcpConfig & {
  /**
   * Absolute directory for the snapshots, screenshots, and logs the server writes; omitted, the server writes them to
   * `.playwright-mcp` in the Session's working directory.
   */
  outputDir?: string
}

/** Validate the launch or attachment configuration before activation. */
export const Config: Schema<NonNullable<Parameters<typeof BrowserMcpConfig>[0]> & { outputDir?: string }, Config> = Schema.intersect([
  BrowserMcpConfig,
  Schema.object({ outputDir: Schema.string() }),
])

/**
 * Reject an invalid debugging endpoint or a relative output directory before acquiring provider or browser resources.
 * @param config - schema-validated provider settings.
 */
export function validateConfig(config: Config): void {
  validateBrowserMcpConfig(config)
  if (config.outputDir !== undefined && !isAbsolute(config.outputDir)) {
    throw new Error(`browser outputDir must be an absolute path, got "${config.outputDir}"`)
  }
}

/**
 * Expose Playwright's upstream tools in each live Session's scope.
 * The pinned npm server runs under the current Node executable; browser state is not persisted by DSH.
 * @param ctx - provider context supplying browser use, Agents, and tools.
 * @param config - validated browser choice, optional output directory, and optional tool timeout.
 */
export function apply(ctx: Context, config: Config): void {
  validateConfig(config)
  const cli = join(dirname(fileURLToPath(import.meta.resolve('@playwright/mcp/package.json'))), 'cli.js')
  // Upstream environment options can otherwise replace the configured browser
  // mode or import an unrelated profile. Empty values mean absent to its parser.
  const env = Object.fromEntries(Object.keys(process.env)
    .filter(key => key.toUpperCase().startsWith('PLAYWRIGHT_MCP_'))
    .map(key => [key, '']))
  const args = [cli, '--browser', 'chromium']
  if (config.mode === 'attach') {
    args.push('--cdp-endpoint', config.endpoint)
  } else {
    args.push('--isolated')
    if (config.headless) args.push('--headless')
    if (config.executablePath !== undefined) args.push('--executable-path', config.executablePath)
  }
  if (config.outputDir !== undefined) args.push('--output-dir', config.outputDir)
  mountSessionMcp(ctx, {
    name: 'playwright-mcp',
    exclusive: config.mode === 'attach',
    command: process.execPath,
    args,
    env,
    ...config.toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs: config.toolCallTimeoutMs },
  })
}
