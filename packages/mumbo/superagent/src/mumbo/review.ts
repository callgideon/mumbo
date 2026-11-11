/**
 * In Mumbo, the review Ticket's worker (`UPSTREAM.md` S15): `REVIEW_INSTRUCTIONS`, its system prompt part; `reviewLaunch`, what
 * its launch message carries; `NO_VERDICT`, the failure of a turn that ends without a verdict; and `reviewTools`, its only
 * tools. The runtime, not the model, posts the review comment whose first line is the marker the edge reads, after it re-read
 * the pull request's head, and marks a draft pull request ready on a pass.
 */
import { z } from 'zod'
import type { Ticket, Trigger } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'
import { sameName } from '../infra/text.ts'
import { receiptNotice, reportRelay } from '../app/notices.ts'
import type { Store } from '../app/store.ts'
import type { ExecutorToolsHost } from '../app/tools/executor.ts'
import { tool, type Tool } from '../app/tools/tool.ts'

/** What a review Ticket's worker reads after the worker prompt; it overrides every other section. */
export const REVIEW_INSTRUCTIONS = `## Independent review
This ticket is the independent review of another ticket's pull request. This section takes precedence over every other section, and your only tools beyond the work tools are orchestrator_review and orchestrator_report.
The other ticket's worker acknowledged the request already: do not acknowledge, answer or message anyone on any thread.
The assignment names the pull request and its head commit: fetch that commit, check it out detached, and review its diff from the pull request's base branch against the request the first message carries in full, and the person's messages among its follow_ups, for correctness, tests, scope and safety. Its other follow_ups are notes the other ticket's worker received, for context only. Run the checks you need.
Do not change, commit or push code, and do not comment on, edit, approve or mark ready the pull request.
Finish with orchestrator_review, with your verdict, that commit's sha and your findings; the runtime posts them on the pull request. A turn that ends without orchestrator_review fails the review.
If you cannot finish the review, report failed with orchestrator_report and say why.`
/** The failed report of a review whose worker's turn ended without a verdict; it waits for a person's Retry. */
export const NO_VERDICT = 'The review\'s worker ended its turn without orchestrator_review, so no verdict was posted.'
/** The first two lines of a review comment: the marker the edge reads, then the automated-agent sentence. */
const header = (sha: string, verdict: 'pass' | 'fail'): string =>
  `<!-- mumbo-review sha=${sha} verdict=${verdict} -->\nThis is by an automated agent, not a human.`
const PullSchema = z.looseObject({ node_id: z.string(), draft: z.boolean().optional(), head: z.looseObject({ sha: z.string() }) })
const CommentSchema = z.looseObject({ html_url: z.string(), body: z.string().nullish(), user: z.looseObject({ login: z.string() }).nullish() })
const READY = 'mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { clientMutationId } }'
const STALE = 'Not reviewed: the pull request moved past the reviewed commit, so no review was posted.'

/** A Trigger as a review's worker reads it: in full, since it reads no resource. */
const full = (trigger: Trigger) => ({ trigger_id: trigger.id, from: trigger.actor.id, at: trigger.at, text: trigger.text })
/**
 * What a review's launch message carries beside its assignment, in full, since its worker reads no resource: the request the
 * reviewed ticket started from, and, oldest first, what that ticket received since: the person's messages it decides, not
 * those it read for context or handed back, and its text notes, such as an earlier review's findings.
 * @param store - The tickets and Triggers.
 * @param of - The reviewed ticket.
 * @param request - Its origin Trigger.
 * @returns The launch message's `trigger` and, when there are any, its `follow_ups`.
 */
export function reviewLaunch(store: Pick<Store, 'tickets' | 'triggers'>, of: string, request: Trigger) {
  const handedBack = (triggerId: string) => !!store.triggers.disposition(triggerId)?.handbacks?.some(item => item.ticketId === of)
  const follow_ups = store.tickets.get(of)!.inputs.flatMap(input => input.kind === 'text' ? [{ at: input.at, text: input.text }]
    : input.kind === 'trigger' && input.human && !input.context && !handedBack(input.triggerId) ? [full(store.triggers.get(input.triggerId)!)] : [])
  return { trigger: full(request), ...(follow_ups.length ? { follow_ups } : {}) }
}

/**
 * A review Ticket's tools: `orchestrator_review`, which posts its verdict and ends it, and `orchestrator_report`, which
 * reports only progress or failure. They have no question, answer or pull request field, since the review shares its
 * ticket's origin and answers no one. A call of `orchestrator_review` that failed after posting the review comment leaves
 * it on the pull request, tagged with the review's id; the next call finds it and posts no other, so the recorded verdict is
 * the posted one. One call runs at a time.
 * @param host - What an Executor Session's tools use.
 * @param ticketId - The review Ticket.
 * @param review - What it reviews: the ticket `of`, its pull request `pr` and the commit `sha`.
 * @returns The two tools.
 */
export function reviewTools(host: ExecutorToolsHost, ticketId: string, { of, pr, sha }: NonNullable<Ticket['review']>): Tool[] {
  // A review may act while it has not ended and its verdict is not recorded on the ticket it reviews.
  const open = () => {
    if (host.store.tickets.get(ticketId)?.ended || host.store.tickets.get(of)?.reviews?.some(item => item.ticket === ticketId)) {
      throw new Error('This review has ended; do nothing more for it')
    }
  }
  const tag = `<!-- dsh-superagent:review-${ticketId} -->`
  let posting = false
  const post = async (commands: Commands, wanted: 'pass' | 'fail', findings: string) => {
    if ((await commands.api(PullSchema, `pulls/${pr}`)).head.sha !== sha) {
      host.engine.reviewed(ticketId, 'stale', STALE)
      return { posted: false, reason: STALE }
    }
    const login = commands.deployment.github.login
    const earlier = (await commands.pages(CommentSchema, `issues/${pr}/comments`))
      .find(comment => sameName(comment.user?.login ?? '', login) && (comment.body ?? '').includes(tag))
    const verdict = earlier ? earlier.body!.startsWith(header(sha, 'pass')) ? 'pass' : 'fail' : wanted
    open()
    const url = earlier?.html_url ?? (await commands.api(CommentSchema, `issues/${pr}/comments`, '--method', 'POST', '-f',
      `body=${header(sha, verdict)}\n\n${findings}\n\n${tag}`)).html_url
    // A draft becomes ready only while its head is still the reviewed commit and the review has not ended.
    const pull = verdict === 'pass' ? await commands.api(PullSchema, `pulls/${pr}`) : undefined
    const ready = pull?.head.sha === sha && pull.draft === true
    if (ready) {
      open()
      await commands.gh<object>(['api', 'graphql', '-f', `query=${READY}`, '-f', `id=${pull.node_id}`])
    }
    host.store.atomic(() => {
      host.engine.reviewed(ticketId, verdict, findings, url)
      host.sessions.notify(...receiptNotice({ review: { ticket_id: of, review_ticket_id: ticketId, sha, verdict, url } },
        `Review of ticket ${of} at ${sha}: ${verdict}`))
    })
    return { posted: url, verdict, marked_ready: ready }
  }
  return [
    tool({
      name: 'orchestrator_review',
      description: 'Finish the review with your verdict on the commit you reviewed. The runtime posts it on the pull request if its head is still that commit, marks a draft pull request ready on a pass, and ends this review.',
      schema: z.object({
        verdict: z.enum(['pass', 'fail']),
        sha: z.string().describe('The commit you reviewed, as the assignment names it.'),
        findings: z.string().trim().min(1).max(6000).describe('What you checked and found, with the reasons for a fail; Markdown.'),
      }).strict(),
      execute: async (args, signal) => {
        open()
        if (args.sha !== sha) throw new Error(`This review is of commit ${sha}: review that commit and pass it as sha`)
        if (posting) throw new Error('Your verdict is being posted: wait for that call\'s result')
        posting = true
        try { return await post(host.github.commands.withSignal(signal), args.verdict, args.findings) } finally { posting = false }
      },
    }),
    tool({
      name: 'orchestrator_report',
      description: 'Report progress, or failed when you cannot finish the review; a verdict goes through orchestrator_review.',
      schema: z.object({ state: z.enum(['progress', 'failed']), summary: z.string().min(1) }).strict(),
      execute: (args) => {
        open()
        return Promise.resolve(host.store.atomic(() => {
          const relay = reportRelay(host.engine.report(ticketId, args), args)
          if (relay) host.sessions.relay(relay.id, relay.text)
          return { reported: true, notification: relay ? 'orchestrator' : 'internal_only' }
        }))
      },
    }),
  ]
}
