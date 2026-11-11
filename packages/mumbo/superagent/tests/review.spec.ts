/**
 * In Mumbo, the review Ticket (`UPSTREAM.md` S15): one per reviewed commit, launched for a fresh local worker with the
 * request in full and only the review's tools; its verdict, which the runtime posts once with the marker the edge reads, is
 * recorded on the ticket it reviews; and the GitHub Channel never posts a comment whose first line is a marker.
 */
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { canRetry, latestReport, type Ticket } from '../src/core/index.ts'
import { ticketCard } from '../src/app/cards.ts'
import { Commands } from '../src/infra/commands.ts'
import { heldExecutor } from '../src/mumbo/executors.ts'
import { NO_VERDICT } from '../src/mumbo/review.ts'
import { sendGithub } from '../src/sources/github-channel.ts'
import { deferred, waitUntil } from './fixtures/async.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

/**
 * The edge's `MARKER` (`approvals.mjs`), which the first line of a review comment must match. Only this side reads the
 * fixture; the edge's test does not pin it yet.
 */
const MARKER = new RegExp(readFileSync(new URL('fixtures/review-marker.txt', import.meta.url), 'utf8').trim())
const SHA = 'a'.repeat(40), NEXT = 'b'.repeat(40)
const AUTOMATED = 'This is by an automated agent, not a human.'
const url = (n: number) => `https://github.com/acme/widgets/pull/12#issuecomment-${n}`

/**
 * GitHub as the agent's CLI answers it: pull request 12 with `head`, which a test may move, the comments posted to it as
 * the agent's, after `others`, and marks of it as ready; any other call answers as the host fixture's does. `failReady`
 * marks fail that many times; `gate` holds each read of the pull request; `afterPost` runs once a comment is posted.
 */
function github(head: { sha: string; draft?: boolean }, others: object[] = []) {
  const gh = { posted: [] as string[], readied: [] as string[], head, failReady: 0, gate: undefined as Promise<void> | undefined,
    afterPost: () => {} }
  vi.spyOn(Commands.prototype, 'gh').mockImplementation(async (args: string[]) => {
    const [, path = '', ...flags] = args
    if (path === 'repos/acme/widgets/pulls/12') {
      await gh.gate
      return { node_id: 'PR_12', draft: head.draft ?? true, head: { sha: head.sha } }
    }
    if (path === 'graphql') {
      if (gh.failReady-- > 0) throw new Error('GraphQL: 502 Bad Gateway')
      gh.readied.push(flags.join(' ')); return { data: {} }
    }
    if (flags.includes('--paginate')) return [[...others, ...gh.posted.map((body, i) => ({ html_url: url(i + 1), body, user: { login: 'agent-bot' } }))]]
    if (flags.includes('POST')) { gh.posted.push(flags.at(-1)!.slice('body='.length)); gh.afterPost(); return { html_url: url(gh.posted.length) } }
    return path === 'user' ? { login: 'agent-bot' } : { default_branch: 'master', permissions: { push: true } }
  })
  return gh
}

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { await h.stop() })

/** A ticket whose worker reported pull request 12 ready, as a submit leaves it: in person/review, following the pull request. */
async function submitted(id = '1', text = '@bot fix the regression') {
  const { trigger, ticket, sessionId } = await h.acceptedTicket(feishu(id, text))
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
const verdict = (session: string, value: 'pass' | 'fail', sha = SHA, findings = 'Fine.') =>
  h.runTool(session, 'orchestrator_review', { verdict: value, sha, findings })

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
    // A fresh Session: its first message is the launch, with the request the ticket started from and nothing that followed it.
    const [launch] = h.relays(session)
    expect(launch).toMatchObject({ ticket_id: id, trigger: { trigger_id: trigger.id, from: trigger.actor.id, at: trigger.at, text: '@bot fix the regression' } })
    expect(launch!.follow_ups).toBeUndefined()
    expect(stored(id).assignments.map(item => item.state)).toEqual(['running'])
    expect(ticketCard(stored(id))).toMatchObject({ review_of: parent, state: 'working' })
    expect(ticketCard(stored(parent)).state).toBe('person/review')
  })

  it('launches the review with the request and what the ticket received since in full, and no resource to read', async () => {
    const long = `@bot fix the regression. ${'Keep the behaviour existing callers see. '.repeat(20)}It must not change the public API.`
    const { trigger, parent, sessionId } = await submitted('1', long)
    const more = feishu('2', `also handle the empty list ${'and its edge cases '.repeat(40)}`, { mentions: [], root_id: 'om_1' })
    const beyond = feishu('3', 'and add an export', { mentions: [], root_id: 'om_1' })
    const requeued = feishu('4', 'also add a CSV import', { mentions: [], root_id: 'om_1' })
    h.runtime.receive(more); h.runtime.receive(beyond); h.runtime.receive(requeued)
    await h.runtime.idle()
    await h.runTool(sessionId, 'orchestrator_trigger_handback', { trigger_id: beyond.id, reason: 'It asks for an export feature.' })
    // A person sends a message that reached the ticket to Eval from the panel: no ticket decides it now.
    expect(await h.api('POST', `triggers/${requeued.id}/requeue`)).toMatchObject({ body: { queued: true } })
    expect(stored(parent).inputs.some(input => input.kind === 'trigger' && input.triggerId === requeued.id)).toBe(true)
    const first = await review(parent)
    github({ sha: SHA })
    await verdict(first.session, 'fail', SHA, 'The empty list is not handled.')
    const { session } = await review(parent, NEXT)
    const [launch] = h.relays(session)
    expect(long.length).toBeGreaterThan(600)
    expect(launch).toMatchObject({ trigger: { trigger_id: trigger.id, text: long }, follow_ups: [
      { trigger_id: more.id, from: more.actor.id, at: more.at, text: more.text },
      { at: expect.any(String), text: `The independent review of ${SHA} failed:\nThe empty list is not handled.\nFix it, push, and submit again.` }] })
    expect(launch!.follow_ups).toHaveLength(2)
    expect(launch!.batch).toBeUndefined()
    expect(JSON.stringify(launch)).not.toMatch(/"(read|chars|source_url_read|assignment_read)"/)
  })

  it('launches the review of a ticket accepted from a batch with the batch\'s other messages in full', async () => {
    // Paused, the two messages wait for one Eval, which takes both as the request.
    await h.runtime.settings.pause(true, 'panel')
    const request = feishu('1', `@bot fix the regression ${'in the parser '.repeat(15)}`)
    const keep = feishu('2', `@bot keep the old output format ${'for the existing callers '.repeat(10)}`, { root_id: 'om_1' })
    h.runtime.receive(request); h.runtime.receive(keep)
    await h.runtime.settings.pause(false, 'panel')
    await h.runtime.pump(); await h.runtime.idle()
    const accepted = await h.route({ kind: 'accept', trigger_id: request.id, title: 'Fix it', worktree_name: 'fix-it', acknowledgement: 'Got it.' })
    await h.runtime.idle()
    const parent = (accepted.ticket as { ticket_id: string }).ticket_id
    const origin = stored(parent).origin
    const [other] = [request, keep].filter(trigger => trigger.id !== origin.triggerId)
    expect([origin.triggerIds.length, other!.text.length > 160]).toEqual([2, true])
    h.runtime.engine.bindThread(parent, { source: 'github', id: '12' }, true)
    h.runtime.engine.report(parent, { state: 'ready', summary: 'PR 12 is ready.' })
    const { session } = await review(parent)
    const [launch] = h.relays(session)
    expect(launch).toMatchObject({ trigger: { trigger_id: origin.triggerId },
      batch: [{ trigger_id: other!.id, from: other!.actor.id, at: other!.at, text: other!.text }] })
    expect(launch!.batch).toHaveLength(1)
    expect(JSON.stringify(launch)).not.toMatch(/"(read|preview)"/)
  })

  it('ends the open review of an earlier commit as superseded when a new commit is submitted', async () => {
    const { parent } = await submitted()
    const first = await review(parent)
    const second = await review(parent, NEXT)
    expect(stored(first.review).ended).toMatchObject({ by: 'executor', outcome: 'dropped', reason: 'superseded' })
    expect(stored(second.review)).toMatchObject({ review: { sha: NEXT, round: 1 } })
    expect(stored(second.review).ended).toBeUndefined()
  })

  it('reviews a commit again after its review was dropped without a verdict, and not after a person stopped it', async () => {
    const { parent } = await submitted()
    const first = await review(parent)
    const second = await review(parent, NEXT)
    // The worker pushes the first commit back: its dropped review gives way to a new one, which supersedes the second.
    const again = await review(parent, SHA)
    expect(again.review).not.toBe(first.review)
    expect(stored(again.review)).toMatchObject({ review: { of: parent, sha: SHA } })
    expect(stored(again.review).ended).toBeUndefined()
    expect(stored(second.review).ended).toMatchObject({ outcome: 'dropped', reason: 'superseded' })
    expect(h.relays(again.session)[0]).toMatchObject({ ticket_id: again.review })
    // A review a person stopped stays the commit's review.
    h.runtime.engine.stopTicket(again.review)
    expect(h.runtime.engine.requestReview(parent, { pr: 12, sha: SHA }).id).toBe(again.review)
    // A review with a verdict does too.
    const next = await review(parent, NEXT)
    github({ sha: NEXT })
    await verdict(next.session, 'pass', NEXT)
    expect(h.runtime.engine.requestReview(parent, { pr: 12, sha: NEXT }).id).toBe(next.review)
  })

  it('refuses a review of an ended ticket, and ends the open review when its ticket ends', async () => {
    const { parent } = await submitted()
    const { review: id, session } = await review(parent)
    const gh = github({ sha: SHA })
    h.runtime.engine.stopTicket(parent)
    expect(stored(id).ended).toMatchObject({ by: 'executor', outcome: 'dropped', reason: 'reviewedTicketEnded' })
    expect(h.agents.get(session)!.cancel).toHaveBeenCalled()
    await expect(verdict(session, 'pass')).rejects.toThrow('This review has ended')
    expect(gh.posted).toEqual([])
    expect(() => h.runtime.engine.requestReview(parent, { pr: 12, sha: SHA })).toThrow('Ticket has ended')
  })

  it('takes no message and never resumes: a router cannot attach to a review, and an ended one stays ended', async () => {
    const { parent } = await submitted()
    const { review: id, session } = await review(parent)
    github({ sha: SHA })
    await verdict(session, 'fail', SHA, 'No test.')
    const objection = feishu('5', '@bot the reviewer was wrong')
    h.runtime.receive(objection)
    await h.runtime.idle()
    await expect(h.route({ kind: 'attach', trigger_id: objection.id, ticket_id: id, note: 'The member disputes this review.' }))
      .rejects.toThrow('A review ticket takes no messages')
    // A person's message waiting on the ended review, however it came there, does not resume it.
    const input = { id: 'input-objection', kind: 'trigger' as const, triggerId: objection.id, at: objection.at, human: true as const }
    h.runtime.store.tickets.save({ ...stored(id), inputs: [input], undelivered: [input.id] })
    h.runtime.engine.evaluateDue()
    expect([stored(id).ended?.outcome, stored(id).assignments.length]).toEqual(['completed', 1])
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
    expect(await verdict(session, 'pass', SHA, 'Correct, and the tests cover it.')).toEqual({ posted: url(1), verdict: 'pass', marked_ready: true })
    const [first, second, ...rest] = gh.posted[0]!.split('\n')
    expect(gh.posted).toHaveLength(1)
    expect(first).toBe(`<!-- mumbo-review sha=${SHA} verdict=pass -->`)
    expect(MARKER.exec(first!)?.slice(1)).toEqual([SHA, 'pass'])
    expect([second, rest.join('\n')]).toEqual([AUTOMATED, `\nCorrect, and the tests cover it.\n\n<!-- dsh-superagent:review-${id} -->`])
    expect(gh.readied).toEqual([expect.stringMatching(/^-f query=mutation.*markPullRequestReadyForReview.* -f id=PR_12$/)])
    expect(stored(parent).reviews).toEqual([{ sha: SHA, verdict: 'pass', ticket: id, url: url(1), at: expect.any(String), findings: 'Correct, and the tests cover it.' }])
    expect(stored(parent).escalated).toBeUndefined()
    expect(stored(parent).inputs.filter(input => input.kind === 'text')).toEqual([])
    expect(stored(id).ended).toMatchObject({ by: 'executor', outcome: 'completed' })
    expect(ticketCard(stored(parent)).state).toBe('person/review')
    expect(notify).toHaveBeenCalledWith(expect.any(String), { review: { ticket_id: parent, review_ticket_id: id, sha: SHA, verdict: 'pass', url: url(1) } },
      `Review of ticket ${parent} at ${SHA}: pass`)
    // The review has ended: its tools do nothing more.
    await expect(verdict(session, 'pass', SHA, 'Again.')).rejects.toThrow('This review has ended')
    await expect(h.runTool(session, 'orchestrator_report', { state: 'progress', summary: 'Again.' })).rejects.toThrow('This review has ended')
    // Nor do they once its verdict is recorded, were the review open again.
    const { ended: _ended, ...reopened } = stored(id)
    h.runtime.store.tickets.save(reopened)
    await expect(verdict(session, 'fail')).rejects.toThrow('This review has ended')
    expect(gh.posted).toHaveLength(1)
  })

  it('leaves a pull request that is not a draft as it is on a pass', async () => {
    const { parent } = await submitted()
    const { session } = await review(parent)
    const gh = github({ sha: SHA, draft: false })
    expect(await verdict(session, 'pass')).toMatchObject({ marked_ready: false })
    expect(gh.readied).toEqual([])
  })

  it('does not mark the pull request ready when its head moved while the pass was posted', async () => {
    const { parent } = await submitted()
    const { review: id, session } = await review(parent)
    const gh = github({ sha: SHA })
    gh.afterPost = () => { gh.head.sha = NEXT }
    expect(await verdict(session, 'pass')).toEqual({ posted: url(1), verdict: 'pass', marked_ready: false })
    expect(gh.readied).toEqual([])
    expect(stored(parent).reviews).toEqual([expect.objectContaining({ sha: SHA, verdict: 'pass', ticket: id })])
  })

  it('posts its marker once: a call after a failure past the comment reuses it, with its verdict, and records once', async () => {
    const { parent } = await submitted()
    const { review: id, session } = await review(parent)
    // Comments that are not this review's: another review's, a person's with this review's tag, and ones without author or body.
    const tag = `<!-- dsh-superagent:review-${id} -->`
    const gh = github({ sha: SHA }, [{ html_url: url(90), body: `<!-- mumbo-review sha=${SHA} verdict=fail -->\n\n<!-- dsh-superagent:review-other -->`,
      user: { login: 'agent-bot' } }, { html_url: url(91), body: `<!-- mumbo-review sha=${SHA} verdict=fail -->\n${tag}`, user: { login: 'mallory' } },
    { html_url: url(92), body: tag, user: null }, { html_url: url(93), body: null, user: { login: 'agent-bot' } }])
    gh.failReady = 1
    await expect(verdict(session, 'pass', SHA, 'Correct.')).rejects.toThrow('502')
    expect([gh.posted.length, stored(parent).reviews, stored(id).ended]).toEqual([1, undefined, undefined])
    // The model calls again, even with the other verdict and other findings: the posted pass and its findings are the review's.
    expect(await verdict(session, 'fail', SHA, 'No test.')).toEqual({ posted: url(1), verdict: 'pass', marked_ready: true })
    expect(gh.posted).toHaveLength(1)
    expect(gh.readied).toHaveLength(1)
    expect(stored(parent).reviews).toEqual([expect.objectContaining({ verdict: 'pass', url: url(1), ticket: id, findings: 'Correct.' })])
    expect(stored(parent).inputs.filter(input => input.kind === 'text')).toEqual([])
  })

  it('records a posted fail once, with its findings, when a later call finds it', async () => {
    const { parent } = await submitted()
    const { review: id, session } = await review(parent)
    const gh = github({ sha: SHA })
    // The comment is posted, and the record fails as the review's turn is cut.
    const reviewed = vi.spyOn(h.runtime.engine, 'reviewed').mockImplementationOnce(() => { throw new Error('The turn was cancelled') })
    await expect(verdict(session, 'fail', SHA, 'The empty list crashes.\n\nAdd a test for it.')).rejects.toThrow('cancelled')
    reviewed.mockRestore()
    expect(await verdict(session, 'pass', SHA, 'Correct and tested.')).toEqual({ posted: url(1), verdict: 'fail', marked_ready: false })
    expect([gh.posted.length, gh.readied]).toEqual([1, []])
    expect(stored(parent).reviews).toEqual([expect.objectContaining({ verdict: 'fail', ticket: id, findings: 'The empty list crashes.\n\nAdd a test for it.' })])
    expect(stored(parent).inputs.flatMap(input => input.kind === 'text' ? [input.text] : []))
      .toEqual([`The independent review of ${SHA} failed:\nThe empty list crashes.\n\nAdd a test for it.\nFix it, push, and submit again.`])
    expect(latestReport(stored(id))!.summary).toBe('The empty list crashes.\n\nAdd a test for it.')
  })

  it('runs one verdict at a time', async () => {
    const { parent } = await submitted()
    const { session } = await review(parent)
    const gh = github({ sha: SHA })
    const gate = deferred()
    gh.gate = gate.promise
    const first = verdict(session, 'pass')
    await expect(verdict(session, 'fail')).rejects.toThrow('Your verdict is being posted')
    gate.resolve()
    expect(await first).toMatchObject({ verdict: 'pass' })
    expect(gh.posted).toHaveLength(1)
  })

  it('posts a fail, wakes the local worker with the findings, and escalates the ticket on its second failed review', async () => {
    const { parent, sessionId } = await submitted()
    const first = await review(parent)
    const gh = github({ sha: SHA })
    expect(await verdict(first.session, 'fail', SHA, 'The new branch has no test.')).toMatchObject({ verdict: 'fail', marked_ready: false })
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
    await verdict(second.session, 'fail', NEXT, 'Still no test.')
    expect(stored(parent).reviews!.map(item => [item.sha, item.verdict])).toEqual([[SHA, 'fail'], [NEXT, 'fail']])
    expect(stored(parent).escalated).toBe(true)
  })

  it('asks the external Executor to deliver the findings of a failed review of an external ticket', async () => {
    const { parent } = await submitted()
    h.runtime.store.tickets.save({ ...stored(parent), executor: 'external' })
    const { session } = await review(parent)
    github({ sha: SHA })
    const deliver = vi.spyOn(heldExecutor, 'deliver')
    await verdict(session, 'fail', SHA, 'It breaks the build.')
    expect(deliver.mock.calls.map(([ticket]) => [ticket.id, ticket.undelivered.length])).toEqual([[parent, 1]])
  })

  it('posts nothing and drops the review when the pull request moved past its commit', async () => {
    const { parent } = await submitted()
    const { review: id, session } = await review(parent)
    const gh = github({ sha: NEXT })
    const result = await verdict(session, 'pass')
    expect(result).toEqual({ posted: false, reason: expect.stringMatching(/^Not reviewed: the pull request moved past the reviewed commit/) })
    expect([gh.posted, gh.readied, stored(parent).reviews]).toEqual([[], [], undefined])
    expect(stored(id).ended).toMatchObject({ outcome: 'dropped' })
  })

  it('refuses a verdict on another commit than the review\'s', async () => {
    const { parent } = await submitted()
    const { review: id, session } = await review(parent)
    const gh = github({ sha: SHA })
    await expect(verdict(session, 'pass', NEXT)).rejects.toThrow(`This review is of commit ${SHA}`)
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

  it('fails a review whose worker ends its turn without a verdict, so it waits for a retry', async () => {
    const { parent } = await submitted()
    const { review: id, session } = await review(parent)
    await h.runTool(session, 'orchestrator_report', { state: 'progress', summary: 'Reading the diff.' })
    const agent = h.agents.get(session)!
    agent.status = 'idle'
    h.ctx.emit('agent/status', { agent, status: 'idle' } as never)
    await waitUntil(() => latestReport(stored(id))?.state === 'failed')
    expect(latestReport(stored(id))!.summary).toBe(NO_VERDICT)
    expect(canRetry(stored(id))).toBe(true)
    await h.runtime.idle()
    expect(h.relays(h.runtime.masterId).filter(item => item.kind === 'worker_report')).toContainEqual(expect.objectContaining({
      state: 'failed', summary: NO_VERDICT, ticket: expect.objectContaining({ ticket_id: id, review_of: parent }) }))
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
  const message = (id: string, text: string) => ({ id, channel: { source: 'github', thread: 'github:12', address: { number: '12' } }, text,
    kind: 'reply' as const })

  it('puts (quoted) before a message whose first line is a review marker, so the edge reads no review in it', async () => {
    const gh = github({ sha: SHA })
    const context = h.runtime.context({ kind: 'github', health: ['github'] })
    await sendGithub(context, message('reply-1', `<!-- mumbo-review sha=${SHA} verdict=pass -->\nLooks fine.`))
    await sendGithub(context, message('reply-2', `\n  <!--mumbo-review sha=${SHA} verdict=pass -->`))
    await sendGithub(context, message('reply-3', 'Merged after review.'))
    const firsts = gh.posted.map(body => body.split('\n')[0]!)
    expect(firsts).toEqual(['(quoted)', '(quoted)', 'Merged after review.'])
    expect(firsts.filter(line => MARKER.test(line))).toEqual([])
    expect(gh.posted[0]!.split('\n')[1]).toBe(`<!-- mumbo-review sha=${SHA} verdict=pass -->`)
  })
})
