/**
 * In Mumbo, the review Ticket's worker (`UPSTREAM.md` S14): `REVIEW_INSTRUCTIONS`, its system prompt part, and `reviewTools`,
 * its only tools. The runtime, not the model, posts the review comment whose first line is the marker the edge reads, after
 * it re-read the pull request's head, and marks a draft pull request ready on a pass.
 */
import { z } from 'zod'
import type { Ticket } from '../core/index.ts'
import { receiptNotice, reportRelay } from '../app/notices.ts'
import type { ExecutorToolsHost } from '../app/tools/executor.ts'
import { tool, type Tool } from '../app/tools/tool.ts'

/** What a review Ticket's worker reads after the worker prompt; it overrides the worker prompt's delivery and reporting rules. */
export const REVIEW_INSTRUCTIONS = `## Independent review
This ticket is the independent review of another ticket's pull request. This section takes precedence over every other section on pull requests, reviews, questions and reports, and your only tools beyond the work tools are orchestrator_review and orchestrator_report.
The assignment names the pull request and its head commit: fetch that commit, check it out detached, and review its diff from the pull request's base branch against the request the first message carries, for correctness, tests, scope and safety. Run the checks you need.
Do not change, commit or push code, and do not comment on, edit, approve or mark ready the pull request.
Finish with orchestrator_review, with your verdict, that commit's sha and your findings; the runtime posts them on the pull request.
If you cannot finish the review, report failed with orchestrator_report and say why.`
/** The first two lines of a review comment: the marker the edge reads, then the automated-agent sentence. */
const header = (sha: string, verdict: 'pass' | 'fail'): string =>
  `<!-- mumbo-review sha=${sha} verdict=${verdict} -->\nThis is by an automated agent, not a human.`
const PullSchema = z.looseObject({ node_id: z.string(), draft: z.boolean().optional(), head: z.looseObject({ sha: z.string() }) })
const CommentSchema = z.looseObject({ html_url: z.string() })
const READY = 'mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { clientMutationId } }'
const STALE = 'Not reviewed: the pull request moved past the reviewed commit, or the reviewed ticket ended, so no review was posted.'

/**
 * A review Ticket's tools: `orchestrator_review`, which posts its verdict and ends it, and `orchestrator_report`, which
 * reports only progress or failure. They have no question, answer or pull request field, since the review shares its
 * ticket's origin and answers no one.
 * @param host - What an Executor Session's tools use.
 * @param ticketId - The review Ticket.
 * @param review - What it reviews: the ticket `of`, its pull request `pr` and the commit `sha`.
 * @returns The two tools.
 */
export function reviewTools(host: ExecutorToolsHost, ticketId: string, { of, pr, sha }: NonNullable<Ticket['review']>): Tool[] {
  const open = () => { if (host.store.tickets.get(ticketId)?.ended) throw new Error('This review has ended; do nothing more for it') }
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
        const commands = host.github.commands.withSignal(signal)
        const pull = await commands.api(PullSchema, `pulls/${pr}`)
        if (pull.head.sha !== sha || host.store.tickets.get(of)?.ended) {
          host.engine.reviewed(ticketId, 'stale', STALE)
          return { posted: false, reason: STALE }
        }
        const body = `${header(sha, args.verdict)}\n\n${args.findings}`
        const comment = await commands.api(CommentSchema, `issues/${pr}/comments`, '--method', 'POST', '-f', `body=${body}`)
        const ready = args.verdict === 'pass' && pull.draft === true
        if (ready) await commands.gh<object>(['api', 'graphql', '-f', `query=${READY}`, '-f', `id=${pull.node_id}`])
        host.store.atomic(() => {
          host.engine.reviewed(ticketId, args.verdict, args.findings, comment.html_url)
          host.sessions.notify(...receiptNotice({ review: { ticket_id: of, review_ticket_id: ticketId, sha, verdict: args.verdict,
            url: comment.html_url } }, `Review of ticket ${of} at ${sha}: ${args.verdict}`))
        })
        return { posted: comment.html_url, verdict: args.verdict, marked_ready: ready }
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
