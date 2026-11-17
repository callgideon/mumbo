/**
 * Run Wild's record in the shipped Web composition with `@mumbo/run-wild` mounted as a person's box mounts it: the
 * model asks a question, Run Wild answers it, the decision lands in the Session and the record, the "What ran without
 * asking" view lists it with its Session link, the header chip's menu opens the view, and its switch to Full access
 * removes the chip. Replays an authored Session in a real browser.
 */
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@mumbo/run-wild'
import { chromium, type Browser } from 'playwright'
import { expect, it, vi } from 'vitest'
import { captureStableAria, compareOrRefreshGolden, fixtureUserPrompts, launchWebScaffold, watchConsole, webSnapshotMode } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage } from './support.ts'

const DIR = fileURLToPath(new URL('../../../snapshots/web/run-wild-record', import.meta.url))
const FIXTURE = join(DIR, 'session.v4.jsonl')
const OVERLAY = fileURLToPath(new URL('./run-wild-record.overlay.yml', import.meta.url))
// The box installs the private package beside the profile; the scaffold profile links it the same way.
const PACKAGES = [{ dir: fileURLToPath(new URL('../../../packages/mumbo/run-wild', import.meta.url)) }]
const MODE = webSnapshotMode()
const HEADER = 'div:has(> nav[aria-label="Session hierarchy"])'
const VIEW = 'section[aria-label="What ran without asking"]'
const CHIP = 'Run Wild: Mumbo acts without asking in this session. Options'

// The fixture is authored: record mode has nothing to record.
it.skipIf(MODE === 'record')('lists the question Run Wild answered, and the chip leaves Run Wild', { timeout: 120_000 }, async () => {
  const records = await mkdtemp(join(tmpdir(), 'mumbo-run-wild-record-'))
  vi.stubEnv('MUMBO_RUN_WILD_RECORD_ROOT', records)
  const scaffold = await launchWebScaffold({
    extraOverlayPath: OVERLAY,
    profile: { hmr: false, packages: PACKAGES },
    replayFixture: FIXTURE,
    compareReplaySession: true,
  })
  let browser: Browser | undefined
  try {
    browser = await chromium.launch()
    const page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    const settled = scaffold.whenTurnSettled()
    const input = page.locator('[data-composer-input]').first()
    await input.fill(fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))[0]!)
    await input.press('Enter')
    const sessionId = await settled
    const session = scaffold.ctx.agents.get(sessionId)?.session
    if (session === undefined) throw new Error('the Run Wild turn has no Session')

    const decisions = session.snapshotEvents().filter(event => event.type === 'runwild/decision')
    expect(decisions.map(event => event.data)).toEqual([{
      kind: 'question', target: 'greeting', summary: 'Should greeting.txt say Hello or Hi?',
      reason: "Run Wild: decide from context and the person's rules, state your assumption in one line, and continue.",
    }])
    const recorded = async (): Promise<unknown[]> => {
      const days = await readdir(records)
      const text = await Promise.all(days.map(day => readFile(join(records, day), 'utf8')))
      return text.join('').split('\n').filter(line => line !== '').map((line): unknown => JSON.parse(line))
    }
    await vi.waitFor(async () => {
      const lines = decisions.map(event => ({ ...event.data, v: 1, time: event.time, session: sessionId, root: sessionId, seq: event.seq }))
      expect(await recorded()).toEqual(lines)
    })

    const goldens: [string, string][] = []
    const chip = page.getByRole('button', { name: CHIP })
    await chip.waitFor()
    goldens.push(['chip', await captureStableAria(page, HEADER, scaffold.workspaceCwd)])
    await chip.click()
    goldens.push(['chip-menu', await captureStableAria(page, '[role="menu"]', scaffold.workspaceCwd)])
    await page.getByRole('menuitem', { name: 'What ran without asking' }).click()
    const view = page.locator(VIEW)
    await view.getByText('Answered a question').waitFor()
    goldens.push(['view', await captureStableAria(page, VIEW, scaffold.workspaceCwd)])
    await view.getByRole('button', { name: 'Sends' }).click()
    await view.getByText('Nothing was sent without asking.').waitFor()
    goldens.push(['view-sends', await captureStableAria(page, VIEW, scaffold.workspaceCwd)])
    await view.getByRole('button', { name: 'All' }).click()
    await view.getByRole('button', { name: 'Open session' }).click()
    await chip.click()
    await page.getByRole('menuitem', { name: 'Switch to Full access' }).click()
    await chip.waitFor({ state: 'detached' })
    goldens.push(['full-access', await captureStableAria(page, HEADER, scaffold.workspaceCwd)])
    expect(scaffold.ctx.permissionPresets.current(session)).toBe('danger-full-access')
    for (const [name, aria] of goldens) await compareOrRefreshGolden(join(DIR, `${name}.expected.md`), aria, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  } finally {
    try {
      await browser?.close()
    } finally {
      await scaffold.close()
      vi.unstubAllEnvs()
      await rm(records, { recursive: true, force: true })
    }
  }
})
