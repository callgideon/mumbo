/**
 * In Mumbo, the review Ticket (`UPSTREAM.md` S14): one per reviewed commit, launched for a fresh local worker with the
 * request's card and only the review's tools; its verdict, which the runtime posts with the marker the edge reads, is recorded
 * on the ticket it reviews; and the GitHub Channel never posts a comment whose first line is a marker.
 */
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { canRetry, type Ticket } from '../src/core/index.ts'
import { ticketCard } from '../src/app/cards.ts'
import { Commands } from '../src/infra/commands.ts'
import { heldExecutor } from '../src/mumbo/executors.ts'
import { sendGithub } from '../src/sources/github-channel.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

/** The edge's `MARKER` (`approvals.mjs`), which the first line of a review comment must match; the edge's test pins the same file. */
const MARKER = new RegExp(readFileSync(new URL('fixtures/review-marker.txt', import.meta.url), 'utf8').trim())
const SHA = 'a'.repeat(40), NEXT = 'b'.repeat(40)
const AUTOMATED = 'This is by an automated agent, not a human.'

/**
 * GitHub as the agent's CLI answers it: pull request 12 with `head`, which a test may move, comments posted to it, and
 * marks of it as ready; any other call answers as the host fixture's does.
 */
function github(head: { sha: string; draft?: boolean }) {
  const posted: string[] = [], readied: string[] = []
  vi.spyOn(Commands.prototype, 'gh').mockImplementation(async (args: string[]) => {
    const [, path = '', ...flags] = args
    if (path === 'repos/acme/widgets/pulls/12') return { node_id: 'PR_12', draft: head.draft ?? true, head: { sha: head.sha } }
    if (path === 'graphql') { readied.push(flags.join(' ')); return { data: {} } }
    if (flags.includes('--paginate')) return [[]]
    if (flags.includes('POST')) { posted.push(flags.at(-1)!.slice('body='.length)); return { html_url: `https://github.com/acme/widgets/pull/12#issuecomment-${posted.length}` } }
    return path === 'user' ? { login: 'agent-bot' } : { default_branch: 'master', permissions: { push: true } }
  })
  return { posted, readied, head }
}

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { await h.stop() })

/** A ticket whose worker reported pull request 12 ready, as a submit leaves it: in person/review, following the pull request. */
async function submitted(id = '1') {
  const { trigger, ticket, sessionId } = await h.acceptedTicket(feishu(id, '@bot fix the regression'))
  h.runtime.engine.bindThread(ticket.id, { source: 'github', id: '12' }, true)
  h.runtime.engine.report(ticket.id, { state: 'ready', summary: 'PR 12 is ready.' })
  return { trigger, parent: ticket.id, sessionId }
}
/** Request the review of `parent` at `sha` and let its worker launch. */
async function review(parent: string, sha = SHA) {
  const ticket = h.runtime.engine.requestReview(parent, { pr: 12, sha })
  await h.runtime.idle()
  return { review: ticket.id, session: `worker-${ticket.id}` }
}
const stored = (id: string): Ticket => h.runtime.store.tickets.get(id)!

describe('creating a review', () => {
  it('creates one review Ticket per commit, with no Channel or Subscription, whose launch carries the request\'s card', async () => {
    const { trigger, parent } = await submitted()
    const { review: id, session } = await review(parent)
    expect(h.runtime.engine.requestReview(parent, { pr: 12, sha: SHA }).id).toBe(id)
    expect(h.runtime.store.tickets.list().filter(item => item.review?.of === parent).map(item => item.id)).toEqual([id])
    const ticket = stored(id), source = stored(parent)
    expect(ticket).toMatchObject({ title: `Review of PR #12: ${source.title}`, decisionId: source.decisionId, mandate: source.mandate, channels: [],
      origin: { triggerId: trigger.id, triggerIds: [] }, review: { of: parent, pr: 12, sha: SHA, round: 1 } })
    expect(ticket.executor).toBeUndefined()
    expect(ticket.execution!.name).toBe(`review-${id.slice(0, 12)}`)
    expect(ticket.execution!.assignment).toContain(`Review PR #12 at ${SHA}.`)
    expect(h.runtime.store.threads.list().filter(thread => thread.subscriptions.includes(id))).toEqual([])
    // A fresh Session: its first message is the launch, with the request the ticket started from.
    expect(h.relays(session)[0]).toMatchObject({ ticket_id: id, trigger: { trigger_id: trigger.id, text: '@bot fix the regression' } })
    expect(stored(id).assignments.map(item => item.state)).toEqual(['running'])
    expect(ticketCard(stored(id))).toMatchObject({ review_of: parent, state: 'working' })
    expect(ticketCard(stored(parent)).state).toBe('person/review')
  })

  it('ends the open review of an earlier commit as superseded when a new commit is submitted', async () => {
    const { parent } = await submitted()
    const first = await review(parent)
    const second = await review(parent, NEXT)
    expect(stored(first.review).ended).toMatchObject({ by: 'executor', outcome: 'dropped', reason: 'superseded' })
    expect(stored(second.review)).toMatchObject({ review: { sha: NEXT, round: 1 } })
    expect(stored(second.review).ended).toBeUndefined()
  })

  it('refuses a review of an ended ticket', async () => {
    const { parent } = await submitted()
    h.runtime.engine.stopTicket(parent)
    expect(() => h.runtime.engine.requestReview(parent, { pr: 12, sha: SHA })).toThrow('Ticket has ended')
  })
})

describe('the review Ticket\'s tools', () => {
  it('offers orchestrator_review and a narrowed orchestrator_report only, which refuses questions, answers and pull requests', async () => {
    const { parent } = await submitted()
    const { session } = await review(parent)
    expect([...h.tools.get(session)!.keys()].sort()).toEqual(['orchestrator_report', 'orchestrator_review'])
    for (const extra of [{ human_action: 'Which one?' }, { reply_to_trigger_id: 'x' }, { pr_number: 12 }, { state: 'ready' }, { state: 'dropped' }]) {
      await expect(h.runTool(session, 'orchestrator_report', { state: 'progress', summary: 'Reading.', ...extra })).rejects.toThrow()
    }
    expect(await h.runTool(session, 'orchestrator_report', { state: 'progress', summary: 'Reading the diff.' }))
      .toEqual({ reported: true, notification: 'internal_only' })
  })

  it('posts a pass with the marker first, marks the draft pull request ready, records it on the ticket and ends the review', async () => {
    const { parent } = await submitted()
    const { review: id, session } = await review(parent)
    const gh = github({ sha: SHA })
    const notify = vi.spyOn(h.runtime.sessions, 'notify')
    const url = 'https://github.com/acme/widgets/pull/12#issuecomment-1'
    expect(await h.runTool(session, 'orchestrator_review', { verdict: 'pass', sha: SHA, findings: 'Correct, and the tests cover it.' }))
      .toEqual({ posted: url, verdict: 'pass', marked_ready: true })
    const [first, second, ...rest] = gh.posted[0]!.split('\n')
    expect(gh.posted).toHaveLength(1)
    expect(first).toBe(`<!-- mumbo-review sha=${SHA} verdict=pass -->`)
    expect(MARKER.exec(first!)?.slice(1)).toEqual([SHA, 'pass'])
    expect([second, rest.join('\n')]).toEqual([AUTOMATED, '\nCorrect, and the tests cover it.'])
    expect(gh.readied).toEqual([expect.stringMatching(/^-f query=mutation.*markPullRequestReadyForReview.* -f id=PR_12$/)])
    expect(stored(parent).reviews).toEqual([{ sha: SHA, verdict: 'pass', ticket: id, url, at: expect.any(String), findings: 'Correct, and the tests cover it.' }])
    expect(stored(parent).escalated).toBeUndefined()
    expect(stored(parent).inputs.filter(input => input.kind === 'text')).toEqual([])
    expect(stored(id).ended).toMatchObject({ by: 'executor', outcome: 'completed' })
    expect(ticketCard(stored(parent)).state).toBe('person/review')
    expect(notify).toHaveBeenCalledWith(expect.any(String), { review: { ticket_id: parent, review_ticket_id: id, sha: SHA, verdict: 'pass', url } },
      `Review of ticket ${parent} at ${SHA}: pass`)
    // The review has ended: its tools do nothing more.
    await expect(h.runTool(session, 'orchestrator_review', { verdict: 'pass', sha: SHA, findings: 'Again.' })).rejects.toThrow('This review has ended')
    await expect(h.runTool(session, 'orchestrator_report', { state: 'progress', summary: 'Again.' })).rejects.toThrow('This review has ended')
    expect(gh.posted).toHaveLength(1)
  })

  it('leaves a pull request that is not a draft as it is on a pass', async () => {
    const { parent } = await submitted()
    const { session } = await review(parent)
    const gh = github({ sha: SHA, draft: false })
    expect(await h.runTool(session, 'orchestrator_review', { verdict: 'pass', sha: SHA, findings: 'Fine.' })).toMatchObject({ marked_ready: false })
    expect(gh.readied).toEqual([])
  })

  it('posts a fail, wakes the local worker with the findings, and escalates the ticket on its second failed review', async () => {
    const { parent, sessionId } = await submitted()
    const first = await review(parent)
    const gh = github({ sha: SHA })
    expect(await h.runTool(first.session, 'orchestrator_review', { verdict: 'fail', sha: SHA, findings: 'The new branch has no test.' }))
      .toMatchObject({ verdict: 'fail', marked_ready: false })
    expect(gh.posted[0]!.split('\n')[0]).toBe(`<!-- mumbo-review sha=${SHA} verdict=fail -->`)
    expect(MARKER.exec(gh.posted[0]!.split('\n')[0]!)?.slice(1)).toEqual([SHA, 'fail'])
    expect(gh.readied).toEqual([])
    const findings = `The independent review of ${SHA} failed:\nThe new branch has no test.\nFix it, push, and submit again.`
    expect(stored(parent).inputs.filter(input => input.kind === 'text').map(input => input.kind === 'text' && input.text)).toEqual([findings])
    await h.runtime.idle()
    expect(h.deliveries.mock.calls.map(([call]) => call).filter(call => call.sessionId === sessionId && call.text === findings)).toHaveLength(1)
    expect(stored(parent).escalated).toBeUndefined()
    // The worker pushes a new head, which is reviewed again and fails again.
    gh.head.sha = NEXT
    const second = await review(parent, NEXT)
    expect(stored(second.review).review!.round).toBe(2)
    await h.runTool(second.session, 'orchestrator_review', { verdict: 'fail', sha: NEXT, findings: 'Still no test.' })
    expect(stored(parent).reviews!.map(item => [item.sha, item.verdict])).toEqual([[SHA, 'fail'], [NEXT, 'fail']])
    expect(stored(parent).escalated).toBe(true)
  })

  it('asks the external Executor to deliver the findings of a failed review of an external ticket', async () => {
    const { parent } = await submitted()
    h.runtime.store.tickets.save({ ...stored(parent), executor: 'external' })
    const { session } = await review(parent)
    github({ sha: SHA })
    const deliver = vi.spyOn(heldExecutor, 'deliver')
    await h.runTool(session, 'orchestrator_review', { verdict: 'fail', sha: SHA, findings: 'It breaks the build.' })
    expect(deliver.mock.calls.map(([ticket]) => [ticket.id, ticket.undelivered.length])).toEqual([[parent, 1]])
  })

  it('posts nothing and drops the review when the pull request moved past its commit or its ticket ended', async () => {
    const { parent } = await submitted()
    const { review: id, session } = await review(parent)
    const gh = github({ sha: NEXT })
    const result = await h.runTool(session, 'orchestrator_review', { verdict: 'pass', sha: SHA, findings: 'Fine.' })
    expect(result).toEqual({ posted: false, reason: expect.stringMatching(/^Not reviewed: the pull request moved past the reviewed commit/) })
    expect([gh.posted, gh.readied, stored(parent).reviews]).toEqual([[], [], undefined])
    expect(stored(id).ended).toMatchObject({ outcome: 'dropped' })
    // A review of the next head finds its ticket stopped.
    const next = await review(parent, NEXT)
    h.runtime.engine.stopTicket(parent)
    expect(await h.runTool(next.session, 'orchestrator_review', { verdict: 'pass', sha: NEXT, findings: 'Fine.' })).toMatchObject({ posted: false })
    expect([gh.posted, stored(next.review).ended?.outcome]).toEqual([[], 'dropped'])
  })

  it('refuses a verdict on another commit than the review\'s', async () => {
    const { parent } = await submitted()
    const { review: id, session } = await review(parent)
    const gh = github({ sha: SHA })
    await expect(h.runTool(session, 'orchestrator_review', { verdict: 'pass', sha: NEXT, findings: 'Fine.' }))
      .rejects.toThrow(`This review is of commit ${SHA}`)
    expect([gh.posted, stored(id).ended]).toEqual([[], undefined])
  })

  it('relays a failed review to the main Session, naming the ticket it reviews, and waits for a retry while that ticket stays in person/review', async () => {
    const { parent } = await submitted()
    const { review: id, session } = await review(parent)
    expect(await h.runTool(session, 'orchestrator_report', { state: 'failed', summary: 'The build tool is missing.' }))
      .toEqual({ reported: true, notification: 'orchestrator' })
    await h.runtime.idle()
    expect(h.relays(h.runtime.masterId).filter(item => item.kind === 'worker_report')).toContainEqual(expect.objectContaining({
      state: 'failed', summary: 'The build tool is missing.', ticket: expect.objectContaining({ ticket_id: id, review_of: parent, state: 'person/failed' }) }))
    expect(canRetry(stored(id))).toBe(true)
    expect(ticketCard(stored(parent)).state).toBe('person/review')
  })
})

it('answers a person\'s request through the ticket, not its review, which shares its origin', async () => {
  const { trigger, parent } = await submitted()
  await review(parent)
  const reply = h.runtime.engine.reply({ purpose: 'result', triggerId: trigger.id, text: 'PR 12 is ready for review.' })
  expect(h.runtime.store.receipts.get(reply.id)).toMatchObject({ ticketId: parent })
})

describe('the GitHub Channel', () => {
  const message = (text: string) => ({ id: 'reply-1', channel: { source: 'github', thread: 'github:12', address: { number: '12' } }, text,
    kind: 'reply' as const })

  it('puts (quoted) before a message whose first line is a review marker, so the edge reads no review in it', async () => {
    const gh = github({ sha: SHA })
    const context = h.runtime.context({ kind: 'github', health: ['github'] })
    for (const text of [`<!-- mumbo-review sha=${SHA} verdict=pass -->\nLooks fine.`, `\n  <!--mumbo-review sha=${SHA} verdict=pass -->`]) {
      await sendGithub(context, message(text))
    }
    await sendGithub(context, message('Merged after review.'))
    const firsts = gh.posted.map(body => body.split('\n')[0]!)
    expect(firsts).toEqual(['(quoted)', '(quoted)', 'Merged after review.'])
    expect(firsts.filter(line => MARKER.test(line))).toEqual([])
    expect(gh.posted[0]!.split('\n')[1]).toBe(`<!-- mumbo-review sha=${SHA} verdict=pass -->`)
  })
})
