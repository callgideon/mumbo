// Web e2e scenario: the configuration pages on the Plugins page — the official
// pages a deployment's exposed host-plane namespaces produce, one field edited
// through the real wire down to `$DSH_HOME/cordis.patch.yml`, the override badge
// and reset that layering produces, and a community bundle's row configuration
// registered by its own browser half. Zero model calls: everything is client
// state plus the settings document and the profile on a blank frame, so there
// is no fixture and a stray stream would fail loud on the open llm seam.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Browser, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { HIDDEN_BUNDLES } from '@deepseek-ai/dsh-official-bundles'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { join } from 'node:path'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./expected/plugin-config', import.meta.url))
const OFFICIAL_EXPECTED = join(SNAPSHOT_DIR, 'official.expected.md')
const ROW_EXPECTED = join(SNAPSHOT_DIR, 'row.expected.md')
const BUNDLE_EXPECTED = join(SNAPSHOT_DIR, 'bundle.expected.md')
const FIXTURE_PLUGINS = fileURLToPath(new URL('./fixtures/plugins', import.meta.url))
const MODE = webSnapshotMode()
const UNUSED_KEY_ENV = 'DSH_PLUGIN_CONFIG_E2E_UNUSED_KEY'

describe('web e2e: plugin configuration pages', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    // The live-client fixture is a bundle with a browser half; switched on
    // below, that half registers its row's configuration into the page.
    // Legacy Messages search names an unset credential so the goldens show the
    // unconfigured key whatever keys the host environment carries.
    scaffold = await launchWebScaffold({
      extraOverlayPath: fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)),
      deepSeekSearch: { apiKeyEnv: UNUSED_KEY_ENV },
      profile: { packages: [{ dir: join(FIXTURE_PLUGINS, 'fixture-live-client') }] },
    })
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: 'en-US' })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  /**
   * Show the Plugins page's cards. The scenarios share one page so the
   * settings document accumulates across them, so this closes any settings
   * dialog a previous scenario left open and leaves whatever page it opened.
   */
  async function openPlugins(): Promise<Locator> {
    if (await page.getByRole('dialog', { name: 'Settings' }).count() > 0) {
      await page.keyboard.press('Escape')
      await expect.poll(() => page.getByRole('dialog', { name: 'Settings' }).count(), { timeout: 5_000 }).toBe(0)
    }
    await page.getByRole('navigation', { name: 'Global panels' }).getByRole('button', { name: 'Plugins', exact: true }).click()
    const panel = page.locator('[data-plugin-panel]')
    await panel.waitFor({ timeout: 10_000 })
    while (await panel.getByRole('button', { name: /^Back/ }).count() > 0) {
      await panel.getByRole('button', { name: /^Back/ }).first().click()
    }
    await panel.getByRole('heading', { name: 'Built-in plugin settings', exact: true }).waitFor({ timeout: 20_000 })
    return panel
  }

  /** Open one official plugin's page from its card and wait for its form. */
  async function openPage(panel: Locator, title: string): Promise<void> {
    await panel.getByRole('button', { name: `View ${title}`, exact: true }).click()
    await panel.locator('[data-plugin-config]').waitFor({ timeout: 10_000 })
  }

  /** The settings document as the Host has written it so far. */
  async function settingsDocument(): Promise<string> {
    return readFile(join(scaffold.harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml'), 'utf8').catch(() => '')
  }

  it('keeps configuration pages first and opens the full experimental plugin list separately', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-plugin-config-cards'))
    const panel = await openPlugins()

    // Every page the shipped web composition exposes: the shell executor, the
    // agent loop, subagent selection, and the DeepSeek search provider.
    await panel.getByRole('button', { name: 'View Web search and fetch', exact: true }).waitFor({ timeout: 20_000 })
    const basic = panel.locator('[data-plugin-group="basic"]')
    expect(await basic.locator('[data-plugin-item]').count()).toBe(4)
    expect(await basic.locator(':scope > ul > li').evaluateAll(cards => cards.map(card => card.getAttribute('data-plugin-item'))))
      .toEqual(['subagent', 'web-search', 'agent-loop', 'shell'])
    for (const title of ['Subagent', 'Web search and fetch', 'Agent loop', 'Shell']) {
      expect(await basic.getByRole('button', { name: `View ${title}`, exact: true }).count()).toBe(1)
    }
    // A card carries the one-liner; the fields wait for the page.
    expect(await basic.getByText('Limit how long each command may run and how much it may output.', { exact: true }).count()).toBe(1)
    expect(await panel.getByLabel('Command timeout (ms)').count()).toBe(0)

    const extensions = panel.locator('[data-plugin-group="extensions"]')
    const more = panel.getByRole('button', { name: 'More', exact: true })
    expect(await extensions.getByRole('heading', { name: 'Experimental plugins', exact: true }).count()).toBe(1)
    expect(await extensions.getByRole('button', { name: 'More', exact: true }).textContent()).toBe('More')
    expect(await extensions.getByRole('list').isVisible()).toBe(true)
    expect(await panel.locator('[data-plugin-group="more"]').count()).toBe(0)
    await more.focus()
    await page.keyboard.press('Enter')
    await panel.getByRole('heading', { name: 'Experimental plugins', exact: true, level: 1 }).waitFor()
    // The More list omits the shipped bundles whose own rows do not run (the visibility rule lives in
    // ui-plugin-manager), so it holds fewer cards than the installed optional-bundle list.
    const bundles = await scaffold.ctx.pluginManager.listBundles()
    expect(await panel.locator('[data-plugin-group="more"] [data-plugin-package]').count())
      .toBe(bundles.filter(bundle => !HIDDEN_BUNDLES.has(bundle.name)
        && bundle.name !== '@deepseek-ai/dsh-experimental-liveshare'
        && bundle.official && (bundle.listedByDefault !== false || bundle.enabled || bundle.installed)).length)
    expect(await basic.count()).toBe(0)
    expect(await extensions.count()).toBe(0)
    expect(await panel.locator('[data-plugin-group="bundles"]').count()).toBe(0)
    await panel.getByRole('button', { name: 'View Developer tools', exact: true }).click()
    await panel.locator('[data-plugin-detail]').waitFor()
    await panel.getByRole('button', { name: 'Back to Experimental plugins', exact: true }).click()
    await panel.getByRole('heading', { name: 'Experimental plugins', exact: true, level: 1 }).waitFor()
    await panel.getByRole('button', { name: 'Back to plugins', exact: true }).focus()
    await page.keyboard.press('Space')
    expect(await extensions.getByRole('list').isVisible()).toBe(true)
    expect(await panel.locator('[data-plugin-group="more"]').count()).toBe(0)
    await more.click()
    await page.reload({ waitUntil: 'load' })
    await openPlugins()
    expect(await extensions.getByRole('list').isVisible()).toBe(true)
    expect(await panel.locator('[data-plugin-group="more"]').count()).toBe(0)

    const snapshot = await captureStableAria(page, '[data-plugin-panel]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(OFFICIAL_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('selects search and fetch providers independently and keeps each provider’s settings', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-search-api-settings'))
    const panel = await openPlugins()
    await openPage(panel, 'Web search and fetch')
    // A menu's accessible name is its label followed by the selected entry, so the menus are found by id.
    const searchMenu = panel.locator('#plugin-config-web-search-provider')
    const fetchMenu = panel.locator('#plugin-config-web-fetch-provider')
    const searchSection = panel.getByRole('region', { name: 'Web search provider', exact: true })
    const fetchSection = panel.getByRole('region', { name: 'Web fetch provider', exact: true })
    const count = panel.getByLabel('Results per search', { exact: true })
    const save = panel.getByRole('button', { name: 'Save', exact: true })
    /** Pick one entry from a menu. */
    async function choose(menu: Locator, label: string): Promise<void> {
      await menu.click()
      await page.getByRole('menuitem', { name: label, exact: true }).click()
    }
    /** Open a menu and read its entries in order, then close it. */
    async function entries(menu: Locator): Promise<string[]> {
      await menu.click()
      const items = await page.getByRole('menuitem').allTextContents()
      await page.keyboard.press('Escape')
      await expect.poll(() => page.getByRole('menuitem').count()).toBe(0)
      return items
    }
    // The shipped composition selects the DeepSeek Search API and local fetch, and the page writes nothing on mount.
    expect(await searchMenu.textContent()).toBe('DeepSeek Search API')
    expect(await fetchMenu.textContent()).toBe('Direct fetch')
    expect(await panel.getByRole('button', { name: 'Web search provider DeepSeek Search API', exact: true }).count()).toBe(1)
    expect(await panel.getByRole('button', { name: 'Web fetch provider Direct fetch', exact: true }).count()).toBe(1)
    expect(await entries(searchMenu)).toEqual(['DeepSeek Search API', 'DeepSeek (legacy)'])
    expect(await entries(fetchMenu)).toEqual(['Direct fetch', 'DeepSeek Fetch API'])
    expect(await settingsDocument()).not.toContain('searchProvider:')
    // The page fixes the menu order itself; the Loader imports plugins concurrently, so the
    // Host's registration order is not the YAML row order and only its membership is checked here.
    const hostWeb = scaffold.ctx.get('web') as { listProviders(): Record<'search' | 'fetch', { id: string }[]> } | undefined
    expect(hostWeb?.listProviders().search.map(provider => provider.id).sort()).toEqual(['deepseek-official', 'deepseek-search-api'])
    expect(await panel.getByRole('link', { name: 'Search & Fetch guide', exact: true }).getAttribute('href'))
      .toBe('https://api-docs.deepseek.com/guides/search')
    // Each section shows the description its selected provider registered with the Host, in the active language.
    expect(await searchSection.getByText('Queries the search endpoint directly for titles, URLs, and snippets without an extra model call. Uses the DeepSeek account of the current conversation, or a DeepSeek API key, and may incur API charges.', { exact: true }).count()).toBe(1)
    expect(await fetchSection.getByText('Fetches URLs directly from this machine with no API key or charges, including intranet and loopback addresses. Decodes text, HTML, JSON, and XML only; no JavaScript, cookies, or PDFs. You can also try DeepSeek Fetch API.', { exact: true }).count()).toBe(1)
    // The Fetch API suggestion is text, not an action.
    expect(await fetchSection.getByRole('button').count()).toBe(1)
    expect(await save.isDisabled()).toBe(true)

    // The Search panel holds only the result count.
    expect(await searchSection.getByRole('textbox').count()).toBe(1)
    expect(await count.inputValue()).toBe('10')
    await count.fill('51')
    await panel.getByText('Enter an integer from 1 to 50, or leave blank to use the default.', { exact: true }).waitFor()
    expect(await save.isDisabled()).toBe(true)
    for (const menu of [searchMenu, fetchMenu]) expect(await menu.isDisabled()).toBe(true)
    await count.fill('10')
    expect(await save.isDisabled()).toBe(true)

    // The Fetch API takes no settings here, so its section shows no panel.
    await choose(fetchMenu, 'DeepSeek Fetch API')
    expect(await fetchSection.getByText('Fetches public URLs on DeepSeek servers and returns Markdown. Uses the DeepSeek account of the current conversation, or a DeepSeek API key, may incur API charges, and cannot reach intranet or loopback addresses.', { exact: true }).count()).toBe(1)
    expect(await fetchSection.getByRole('textbox').count()).toBe(0)
    expect(await fetchSection.getByRole('button').count()).toBe(1)
    await save.click()
    await expect.poll(() => save.isDisabled()).toBe(true)
    await expect.poll(settingsDocument).toContain('fetchProvider: deepseek-fetch-api')

    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await openPlugins()
    await openPage(panel, 'Web search and fetch')
    expect(await searchMenu.textContent()).toBe('DeepSeek Search API')
    expect(await fetchMenu.textContent()).toBe('DeepSeek Fetch API')
    const snapshot = await captureStableAria(page, '[data-plugin-panel]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'web-search.expected.md'), snapshot, MODE)

    await choose(fetchMenu, 'Direct fetch')
    await save.click()
    await expect.poll(() => save.isDisabled()).toBe(true)
    await expect.poll(settingsDocument).not.toContain('fetchProvider: deepseek-fetch-api')

    await choose(searchMenu, 'DeepSeek (legacy)')
    const messagesEndpoint = panel.locator('#plugin-config-web-search-endpoint')
    expect(await panel.getByLabel('Maximum searches per request', { exact: true }).inputValue()).toBe('5')
    await messagesEndpoint.fill('https://messages.test/anthropic/v1')
    await save.click()
    await expect.poll(() => save.isDisabled()).toBe(true)
    await expect.poll(settingsDocument).toContain('searchProvider: deepseek-official')
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await openPlugins()
    await openPage(panel, 'Web search and fetch')
    expect(await searchMenu.textContent()).toBe('DeepSeek (legacy)')
    expect(await messagesEndpoint.inputValue()).toBe('https://messages.test/anthropic/v1')
    expect(await entries(searchMenu)).toEqual(['DeepSeek Search API', 'DeepSeek (legacy)'])
    expect(await save.isDisabled()).toBe(true)
    expect(await settingsDocument()).toContain('searchProvider: deepseek-official')
    await choose(searchMenu, 'DeepSeek Search API')
    await count.fill('20')
    await save.click()
    await expect.poll(() => save.isDisabled()).toBe(true)
    await expect.poll(settingsDocument).not.toContain('searchProvider:')
    expect(await settingsDocument()).toContain('count: 20')
    expect(await settingsDocument()).not.toMatch(/ApiKeyEnv:|searchBaseURL:|fetchBaseURL:/)
    expect(tripwire.pageErrors).toEqual([])
  })

  it('saves subagent limits and resets them to the deployment defaults', async () => {
    const panel = await openPlugins()
    await openPage(panel, 'Subagent')
    const depth = panel.getByLabel('Maximum recursion depth', { exact: true })
    const capacity = panel.getByLabel('Subagent parallelism limit', { exact: true })
    expect(await depth.inputValue()).toBe('1')
    expect(await capacity.inputValue()).toBe('8')
    await depth.fill('2')
    await capacity.fill('12')
    await panel.getByRole('button', { name: 'Save', exact: true }).click()
    await expect.poll(() => panel.getByRole('button', { name: 'Save', exact: true }).isDisabled()).toBe(true)
    await expect.poll(settingsDocument).toContain('maxActiveSubagents: 12')
    await expect.poll(settingsDocument).toContain('maxDepth: 2')
    await openPlugins()
    await openPage(panel, 'Subagent')
    const snapshot = await captureStableAria(page, '[data-plugin-panel]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'subagent.expected.md'), snapshot, MODE)
    const controlHeight = await depth.evaluate(element => element.getBoundingClientRect().height)
    await depth.fill('1.5')
    expect(await depth.evaluate(element => element.getBoundingClientRect().height)).toBe(controlHeight)
    expect(await panel.getByRole('button', { name: 'Save', exact: true }).isDisabled()).toBe(true)
    await depth.fill('2')
    await panel.getByRole('button', { name: 'Reset to default', exact: true }).first().click()
    await panel.getByRole('button', { name: 'Reset to default', exact: true }).first().click()
    await panel.getByRole('button', { name: 'Save', exact: true }).click()
    await expect.poll(() => panel.getByRole('button', { name: 'Save', exact: true }).isDisabled()).toBe(true)
    await openPlugins()
    await openPage(panel, 'Subagent')
    expect(await depth.inputValue()).toBe('1')
    expect(await capacity.inputValue()).toBe('8')
    await panel.getByRole('button', { name: 'Back to plugins', exact: true }).click()
  })

  it('opens field explanations with the keyboard and retains unsaved edits', async () => {
    const panel = await openPlugins()
    await openPage(panel, 'Subagent')
    const depth = panel.getByLabel('Maximum recursion depth', { exact: true })
    await depth.fill('2')
    const depthHelp = panel.getByRole('button', { name: 'About maximum recursion depth', exact: true })
    expect(await panel.getByRole('region', { name: 'About maximum recursion depth', exact: true }).count()).toBe(0)
    await depthHelp.press('Enter')
    const depthRules = panel.getByRole('region', { name: 'About maximum recursion depth', exact: true })
    await depthRules.waitFor()
    expect(await depthRules.getByText('Limits how many levels of Subagents an Agent can create.', { exact: true }).count()).toBe(1)
    const depthTable = depthRules.getByRole('table', { name: 'About maximum recursion depth', exact: true })
    expect(await depthTable.getByRole('row', { name: '0 Disable Subagents', exact: true }).count()).toBe(1)
    expect(await depthTable.getByRole('row', { name: '1 Only the main Agent can create Subagents', exact: true }).count()).toBe(1)
    expect(await depthRules.getByText('If a tool defines its own maximum recursion depth, that setting takes precedence.', { exact: true }).count()).toBe(1)
    await depthHelp.press('Enter')
    expect(await depthRules.count()).toBe(0)
    expect(await depth.inputValue()).toBe('2')
    await panel.getByRole('button', { name: 'About the Subagent parallelism limit', exact: true }).click()
    const capacityRules = panel.getByRole('region', { name: 'About the Subagent parallelism limit', exact: true })
    expect(await capacityRules.getByText('Total live Subagents under the same main Agent, across all recursion levels. The main Agent is excluded. New start requests are rejected when the limit is reached.', { exact: true }).count()).toBe(1)
    await panel.getByRole('button', { name: 'Back to plugins', exact: true }).click()
    await openPage(panel, 'Subagent')
    expect(await depth.inputValue()).toBe('1')
  })

  it('saves limits and the model allowlist together from the shared card', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-plugin-config-subagent-model-selection'))
    const panel = await openPlugins()
    await openPage(panel, 'Subagent')
    const toggle = panel.getByRole('switch', { name: 'Allow agents to choose models for Subagents' })

    await panel.getByLabel('Maximum recursion depth', { exact: true }).fill('2')
    await toggle.click()
    const models = panel.getByRole('group', { name: 'Models agents may choose' })
    await models.waitFor({ timeout: 10_000 })
    const firstModel = models.getByRole('checkbox').first()
    await firstModel.check()
    const save = panel.getByRole('button', { name: 'Save', exact: true })
    await save.click()

    // The Save label returns only after both namespace controllers settle.
    await expect.poll(() => save.isDisabled(), { timeout: 10_000 }).toBe(true)
    const saved = await settingsDocument()
    expect(saved).toContain('id: subagent-model-selection-settings')
    expect(saved).toContain('maxDepth: 2')
    expect(saved).toContain('enabled: true')
    expect(saved).toContain('allowedModels:')
    expect(saved).toContain('provider:')
    expect(saved).toContain('model:')
    await expect.poll(() => toggle.getAttribute('aria-checked'), { timeout: 5_000 }).toBe('true')

    await toggle.click()
    await save.click()
    await expect.poll(async () => (await settingsDocument()).includes('enabled: false'), { timeout: 10_000 })
      .toBe(true)
    await expect.poll(() => toggle.getAttribute('aria-checked'), { timeout: 5_000 }).toBe('false')
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('stages an edit and writes it only when saved', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-plugin-config-write'))
    const panel = await openPlugins()
    await openPage(panel, 'Shell')
    const entry = [...scaffold.ctx.loader.entries()].find(row => row.options.id === 'bash-sandbox')!
    const fiber = entry.fiber

    const timeout = panel.getByLabel('Command timeout (ms)')
    await timeout.waitFor({ timeout: 10_000 })
    // The composed default this deployment ships, before any user layer.
    expect(await timeout.inputValue()).toBe('60000')
    await timeout.fill('12000')
    await timeout.blur()

    // Nothing crosses the wire until the user saves: leaving the control is
    // not a decision to store the value.
    expect(await settingsDocument()).not.toContain('timeoutMs')
    const save = panel.getByRole('button', { name: 'Save', exact: true })
    await expect.poll(() => save.isEnabled(), { timeout: 5_000 }).toBe(true)
    await save.click()

    await expect.poll(async () => (await settingsDocument()).includes('timeoutMs: 12000'), { timeout: 10_000 })
      .toBe(true)
    expect(scaffold.ctx.shell.resolve({ command: 'true' }).timeoutMs).toBe(12000)
    expect(entry.fiber === fiber).toBe(true)
    // Presence in the user layer is what the badge reports, and the reset is
    // offered only for a field that has one.
    await expect.poll(() => panel.getByText('Overridden').count(), { timeout: 5_000 }).toBe(1)
    expect(await panel.getByRole('button', { name: 'Reset to default' }).count()).toBe(1)
    // A settled form offers no save to repeat.
    await expect.poll(() => save.isDisabled(), { timeout: 5_000 }).toBe(true)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('drops a staged edit when the page is left, without touching the document', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-plugin-config-leave'))
    const panel = await openPlugins()
    await openPage(panel, 'Shell')
    const timeout = panel.getByLabel('Command timeout (ms)')
    await timeout.waitFor({ timeout: 10_000 })

    await timeout.fill('7000')
    await panel.getByRole('button', { name: 'Back to plugins' }).click()
    await panel.getByRole('heading', { name: 'Built-in plugin settings', exact: true }).waitFor({ timeout: 10_000 })
    await openPage(panel, 'Shell')

    await expect.poll(() => panel.getByLabel('Command timeout (ms)').inputValue(), { timeout: 5_000 }).toBe('12000')
    expect(await settingsDocument()).toContain('timeoutMs: 12000')
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('refuses to save a draft that is not a number', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-plugin-config-invalid'))
    const panel = await openPlugins()
    await openPage(panel, 'Shell')
    const timeout = panel.getByLabel('Command timeout (ms)')
    await timeout.waitFor({ timeout: 10_000 })

    await timeout.fill('soon')

    const save = panel.getByRole('button', { name: 'Save', exact: true })
    await expect.poll(() => save.isDisabled(), { timeout: 5_000 }).toBe(true)
    expect(await panel.getByText('Enter a number, or leave blank to use the default.').count()).toBe(1)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('clears the field back to the composed default on reset', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-plugin-config-reset'))
    const panel = await openPlugins()
    await openPage(panel, 'Shell')
    const timeout = panel.getByLabel('Command timeout (ms)')
    await timeout.waitFor({ timeout: 10_000 })
    expect(await timeout.inputValue()).toBe('12000')

    // The reset stages the composed default; the document still carries the
    // override until the save lands.
    await panel.getByRole('button', { name: 'Reset to default' }).click()
    await expect.poll(() => timeout.inputValue(), { timeout: 5_000 }).toBe('60000')
    expect(await settingsDocument()).toContain('timeoutMs: 12000')

    await panel.getByRole('button', { name: 'Save', exact: true }).click()

    await expect.poll(async () => (await settingsDocument()).includes('timeoutMs'), { timeout: 10_000 })
      .toBe(false)
    expect(await timeout.inputValue()).toBe('60000')
    expect(await panel.getByText('Overridden').count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('renders a community bundle\'s row configuration, registered by its browser half, on the row\'s page', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-plugin-config-row'))
    const panel = await openPlugins()

    // Off, the bundle's browser half is not loaded and the row has no configuration to open.
    await panel.getByRole('button', { name: 'View @fixture/live-client', exact: true }).click()
    const row = panel.locator('[data-plugin-row]', { hasText: 'fixture-live-client' })
    await row.waitFor({ timeout: 10_000 })
    expect(await panel.getByRole('button', { name: 'Configure @fixture/live-client' }).count()).toBe(0)

    // Off, the bundle's page carries no contribution either: the browser half
    // that would make them is not loaded.
    const bundlePage = panel.locator('[data-plugin-detail="@fixture/live-client"]')
    expect(await bundlePage.locator('[data-live-action]').count()).toBe(0)

    // Switched on, the Host recomposes and the browser half mounts without a
    // reload; its registration puts the configure control on the row, and
    // its detail contributions on the bundle's page: the action before the
    // page's own switch, the badge beside the title, the section after the rows.
    await panel.getByRole('switch', { name: 'Enable @fixture/live-client' }).click()
    const configure = panel.getByRole('button', { name: 'Configure @fixture/live-client' })
    await configure.waitFor({ timeout: 30_000 })
    await bundlePage.locator('[data-live-section="bundle"]').waitFor({ timeout: 10_000 })
    // The page's own view of the row follows the Host's change event, which
    // can land after the browser half mounted; the golden holds the settled page.
    await row.getByText('Running', { exact: true }).waitFor({ timeout: 10_000 })
    expect(await bundlePage.getByRole('button', { name: 'Fixture action' }).count()).toBe(1)
    expect(await bundlePage.locator('[data-live-badge="bundle"]').textContent()).toBe('Fixture badge')
    expect(await bundlePage.getByRole('region', { name: 'Fixture section' }).getByText('Section content from the fixture').count()).toBe(1)
    const bundleSnapshot = await captureStableAria(page, '[data-plugin-panel]', scaffold.workspaceCwd, {
      replacements: [[FIXTURE_PLUGINS, '{{fixtures}}']],
    })
    await compareOrRefreshGolden(BUNDLE_EXPECTED, bundleSnapshot, MODE)
    await configure.click()

    const rowPage = panel.locator('[data-plugin-row-detail="@fixture/live-client#fixture-live-client"]')
    await rowPage.waitFor({ timeout: 10_000 })
    expect(await rowPage.getByRole('heading', { level: 3 }).textContent()).toBe('@fixture/live-client')
    expect(await rowPage.getByText('An example setting', { exact: true }).count()).toBe(1)
    // The same entries render for the row's page, told it is about the row.
    expect(await rowPage.locator('[data-live-action="row"]').count()).toBe(1)
    expect(await rowPage.locator('[data-live-badge="row"]').count()).toBe(1)
    expect(await rowPage.locator('[data-live-section="row"]').count()).toBe(1)
    const form = rowPage.getByRole('form', { name: 'Live plugin configuration' })
    await form.getByLabel('Greeting').fill('hello')
    await form.getByRole('button', { name: 'Save' }).click()
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.liveSaves), { timeout: 5_000 }).toBe('1')

    const snapshot = await captureStableAria(page, '[data-plugin-panel]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(ROW_EXPECTED, snapshot, MODE)
    await rowPage.getByRole('button', { name: 'Back to @fixture/live-client' }).click()
    await bundlePage.waitFor({ timeout: 10_000 })

    // An official plugin's page is another subject; the fixture's entries render nothing for it.
    await panel.getByRole('button', { name: 'Back to plugins' }).click()
    await openPage(panel, 'Shell')
    const itemPage = panel.locator('[data-plugin-item-detail]')
    expect(await itemPage.locator('[data-live-action], [data-live-badge], [data-live-section]').count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)

  it.skipIf(MODE === 'record')('keeps the fixture inventory closed', async () => {
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['bundle.expected.md', 'official.expected.md', 'row.expected.md', 'subagent.expected.md', 'web-search.expected.md'])
  })


})
