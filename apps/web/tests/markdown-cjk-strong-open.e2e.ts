/** Asterisk strong emphasis in a settled CJK reply opens after CJK text when the span starts with punctuation. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory, compareOrRefreshGolden,
  launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/markdown-cjk-strong-open', import.meta.url))
const MODE = webSnapshotMode()
const STRONG_TEXTS = [
  '“흓뗦쌴헲쬫낓쥥멍쎽썼（흻횕눉낖）뉒신늅낖냗횦”',
  '“Wi-Fi 옋높옍쨰뀄낹”',
  '（즅펹）',
  '「멍쎽썼」',
  '“눅폹릝왧”',
]

describe('web e2e: strong emphasis opening after CJK text', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    await seedSession(scaffold, await readFile(join(SNAPSHOT_DIR, 'session.v4.jsonl'), 'utf8'), 'markdown-cjk-strong-open')
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('[role="treeitem"]').first().click()
    await page.locator('[role="treeitem"]').nth(1).click()
    await page.locator('[class*="markdown"] p', { hasText: '뎈꽣。' }).first().waitFor()
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('renders each punctuation-led span after CJK text as strong and leaves no bare markers', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-markdown-cjk-strong-open'))
    const reply = page.locator('[class*="markdown"]', { has: page.locator('p', { hasText: '뎈꽣。' }) }).first()
    expect(await reply.locator('strong').allTextContents()).toEqual(STRONG_TEXTS)
    expect(await reply.textContent()).not.toContain('**')
    const prose = await reply.ariaSnapshot()
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'reply.expected.md'), prose, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['session.v4.jsonl', 'reply.expected.md'])
  })
})
