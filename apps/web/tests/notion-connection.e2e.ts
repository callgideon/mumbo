// Web e2e scenario: connecting the Notion plugin from its page on the Plugins
// page. The section reads the MCP manager's real entry, the browser opens the
// loopback authorization server's page, the Host callback answers with its
// completion page, the connection reaches the manager, and sign-out returns the
// section to disconnected. Zero model calls.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, BrowserContext, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { startNotionOAuthFixture, type NotionOAuthFixture } from './notion-oauth-fixture.ts'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { saveFailureShot } from './support.ts'

const NOTION_DIR = fileURLToPath(new URL('../../../packages/connector/notion', import.meta.url))

describe('web e2e: Notion plugin connection', () => {
  let fixture: NotionOAuthFixture
  let overlayDir: string
  let scaffold: WebScaffold
  let browser: Browser
  let context: BrowserContext
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    fixture = await startNotionOAuthFixture()
    overlayDir = await mkdtemp(join(tmpdir(), 'dsh-notion-e2e-'))
    const overlay = join(overlayDir, 'notion.overlay.yml')
    await writeFile(overlay, `- id: notion\n  config:\n    url: ${fixture.origin}/mcp\n`)
    scaffold = await launchWebScaffold({
      extraOverlayPath: [fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)), overlay],
      profile: { packages: [{ dir: NOTION_DIR, enabled: true }] },
    })
    browser = await chromium.launch()
    context = await browser.newContext({ viewport: { width: 1680, height: 1000 }, locale: 'en-US' })
    page = await context.newPage()
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    await fixture?.close()
    if (overlayDir !== undefined) await rm(overlayDir, { recursive: true, force: true })
  })

  it('connects the account from the plugin page and signs out after confirmation', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-notion-connection'))
    await page.getByRole('navigation', { name: 'Global panels' }).getByRole('button', { name: 'Plugins', exact: true }).click()
    const panel = page.locator('[data-plugin-panel]')
    await panel.getByRole('button', { name: 'View Notion plugin', exact: true }).click({ timeout: 20_000 })
    const section = panel.locator('[data-connector-account]')
    await expect.poll(() => section.getAttribute('data-connector-account'), { timeout: 20_000 }).toBe('disconnected')
    expect(await panel.locator('[data-plugin-detail]').getByText('Not connected', { exact: true }).count()).toBe(2)

    const opened = context.waitForEvent('page')
    await section.getByRole('button', { name: 'Connect Notion', exact: true }).click()
    const authorization = await opened
    await expect.poll(async () => await authorization.locator('body').textContent(), { timeout: 20_000 })
      .toContain('Authorization received. You can close this page and check the connection in DSH.')
    await expect.poll(() => section.getAttribute('data-connector-account'), { timeout: 20_000 }).toBe('connected')
    await page.getByText('Notion connected', { exact: true }).waitFor({ timeout: 10_000 })
    expect(fixture.authorizations()).toBe(1)
    await authorization.close()

    await section.getByRole('button', { name: 'Sign out', exact: true }).click()
    await page.getByRole('dialog', { name: 'Sign out of Notion?' }).getByRole('button', { name: 'Sign out', exact: true }).click()
    await expect.poll(() => section.getAttribute('data-connector-account'), { timeout: 20_000 }).toBe('disconnected')
    expect(tripwire.pageErrors).toEqual([])
  })
})
