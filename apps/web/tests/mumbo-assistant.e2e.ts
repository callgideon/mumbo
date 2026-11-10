/**
 * Mumbo in the shipped Web composition with the person-box row: the Host creates, titles, and pins the Session at
 * start; a first page load opens it, and a Session the person chose stays open across a reload; archiving Mumbo is
 * refused through the Workspace Remote with and without stopActivity, and its schedules stay. Zero model calls.
 */
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Page } from 'playwright'
import { expect, it } from 'vitest'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import {
  fixtureUserPrompts, launchWebScaffold, recordFixture, seedSession, selectedSessionFixture, watchConsole, webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage } from './support.ts'

const OVERLAY = fileURLToPath(new URL('./mumbo-assistant.overlay.yml', import.meta.url))
// The box installs the private package beside the profile; the scaffold profile links it the same way.
const PACKAGE = fileURLToPath(new URL('../../../packages/mumbo/assistant', import.meta.url))
// Any one closed conversation will do: another scenario's committed fixture, reused read-only.
const SEED = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url))
const MUMBO = SessionId('mumbo')
const REFUSAL = "cannot archive session 'mumbo': Mumbo is your always-present assistant and cannot be archived."
const INSTRUCTIONS = "You are Mumbo, this person's assistant."
const MODE = webSnapshotMode()
// TODO: record this scenario with a DeepSeek key, then commit its manifest, Session, and sidecars together: the
// corpus gate requires an owner Session fixture for every scenario directory, so the manifest cannot land first.
// Create snapshots/web/mumbo-assistant/snapshot.yml with `version: 1`, `scenario: mumbo-assistant`, `profile: web`,
// `composition: web-mumbo-assistant`, `recording: live`, and `header: { class: mumbo-assistant, pin: true }`; run this
// file once with DSH_SNAPSHOT=record and once with DSH_SNAPSHOT=refresh, then review the Session and both sidecars.
const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/mumbo-assistant', import.meta.url))
const PROMPT = 'In one sentence, what are you here for?'

/** POST one generated Remote unary through the API Gateway carrier. */
async function remote(scaffold: WebScaffold, endpoint: string, args: Readonly<Record<string, unknown>>) {
  const response = await scaffold.hostFetch(`/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: `mumbo-e2e-${randomUUID()}`, method: endpoint, payload: { args } }),
  })
  if (!response.ok) throw new Error(`${endpoint} failed over HTTP ${response.status}: ${await response.text()}`)
  return (await response.json() as { result: unknown }).result
}

/** Rendered text of the system prompt surface node, or undefined when the surface carries none. */
function systemPromptText(session: Session): string | undefined {
  const message = session.deriveMessages().find(candidate => candidate.role === 'system')
  return message?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

/** The Session the page's Workspace navigation persisted as its main view. */
async function opened(page: Page): Promise<string | undefined> {
  return page.evaluate(() => {
    const stored = localStorage.getItem('dsh.sessions.current')
    return stored === null ? undefined : (JSON.parse(stored) as { sessionId?: string }).sessionId
  })
}

it('opens a new box on Mumbo, keeps a chosen Session, and refuses to archive Mumbo or drop its schedules', async () => {
  const scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY, profile: { hmr: false, packages: [{ dir: PACKAGE }] } })
  const elsewhere = await mkdtemp(join(tmpdir(), 'mumbo-e2e-elsewhere-'))
  try {
    const { ctx } = scaffold
    const home = ctx.workspaceRegistry.list().find(workspace => workspace.sessionIds.includes(MUMBO))
    expect(home?.path).toBe(await realpath(scaffold.workspaceCwd))
    expect(ctx.workspaceRegistry.pinnedSessionIds).toEqual([MUMBO])
    expect(await remote(scaffold, 'session/list', { _request: {} })).toMatchObject({
      ok: true, value: { items: [{ sessionId: MUMBO, projections: { values: { title: 'Mumbo', agentPreset: 'standard' } } }] },
    })

    // A newer Workspace is where Workspace navigation alone would open a New Session.
    await ctx.workspaceRegistry.create(elsewhere)

    const browser = await chromium.launch()
    try {
      const page = await newEnglishPage(browser)
      const tripwire = watchConsole(page)
      await page.goto(scaffold.authenticatedUrl)
      // Until its first turn Mumbo is its Workspace's provisional New Session row.
      await expect.poll(() => opened(page), { timeout: 20_000 }).toBe(MUMBO)
      await page.getByRole('treeitem', { name: 'New Session', selected: true }).waitFor()

      // A Session the person opens stays open across a reload.
      const side = await seedSession(scaffold, await readFile(SEED, 'utf8'), 'mumbo-e2e-side')
      await page.reload()
      await page.getByText('Ungrouped', { exact: true }).click()
      await page.getByRole('treeitem').filter({ has: page.locator('button[aria-label^="Session actions for "]') }).first().click()
      await expect.poll(() => opened(page)).toBe(side)
      await page.reload()
      await page.getByRole('treeitem', { selected: true }).filter({ has: page.locator('button[aria-label^="Session actions for "]') }).waitFor()
      expect(await opened(page)).toBe(side)

      // Archiving Mumbo is refused with and without stopActivity, which would delete the schedules aimed at it.
      const schedule = await ctx.schedule.create({
        title: 'Standing check', prompt: 'Check in', timing: { kind: 'after', after_seconds: 3600 },
        target: { kind: 'session', sessionId: MUMBO },
      })
      for (const stopActivity of [false, true]) {
        expect(await remote(scaffold, 'workspace/archiveSession', { request: { sessionId: MUMBO, stopActivity } }))
          .toMatchObject({ ok: false, error: { code: 'gateway/bad-request', message: REFUSAL } })
      }
      expect(ctx.workspaceRegistry.archivedSessionIds).toEqual([])
      expect(ctx.workspaceRegistry.pinnedSessionIds).toEqual([MUMBO])
      expect((await ctx.schedule.list({ active: true })).items.map(item => item.id)).toEqual([schedule.id])
      // Other Sessions archive as before.
      expect(await remote(scaffold, 'workspace/archiveSession', { request: { sessionId: side } }))
        .toMatchObject({ ok: true, value: { archivedSessionIds: [side] } })
      expect(tripwire.pageErrors).toEqual([])
      expect(tripwire.warnings.filter(text => !/connection lost/i.test(text))).toEqual([])
    } finally {
      await browser.close()
    }
  } finally {
    await scaffold.close()
    await rm(elsewhere, { recursive: true, force: true })
  }
})

it.skipIf(!existsSync(join(SNAPSHOT_DIR, 'snapshot.yml')))('sends Mumbo\'s first turn with its instructions in the system prompt', async () => {
  const fixture = await selectedSessionFixture(join(SNAPSHOT_DIR, 'session.jsonl'), MODE === 'record')
  const scaffold = await launchWebScaffold({
    extraOverlayPath: OVERLAY, profile: { hmr: false, packages: [{ dir: PACKAGE }] }, compareReplaySession: true,
    ...(MODE === 'record' ? {} : { replayFixture: fixture, paceMs: 5 }),
  })
  try {
    if (MODE !== 'record') expect(fixtureUserPrompts(await readFile(fixture, 'utf8'))).toEqual([PROMPT])
    const browser = await chromium.launch()
    try {
      const page = await newEnglishPage(browser)
      await page.goto(scaffold.authenticatedUrl)
      await expect.poll(() => opened(page), { timeout: 20_000 }).toBe(MUMBO)
      const input = page.locator('[data-composer-input][contenteditable="true"]').first()
      await input.fill(PROMPT)
      const settled = scaffold.whenTurnSettled()
      await input.press('Enter')
      expect(await settled).toBe(MUMBO)
      const session = scaffold.ctx.agents.get(MUMBO)!.session
      expect(systemPromptText(session)).toContain(INSTRUCTIONS)
      if (MODE === 'record') await recordFixture(scaffold, MUMBO, fixture)
    } finally {
      await browser.close()
    }
  } finally {
    // Closing compares the replayed Session and the pinned system-prompt and tool-schema sidecars.
    await scaffold.close()
  }
})
