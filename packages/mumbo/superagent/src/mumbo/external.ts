/**
 * In Mumbo, the external-worker Executor (`UPSTREAM.md` S13, S14, S16): a worker outside the box, such as a member's own
 * Claude Code through the door, claims an external Ticket's Assignment under a lease, reports on it, pulls its Inputs, and
 * submits the head it pushed, whose independent review the submit then requests. Each call renews the lease, and so does each
 * of its git requests, which the edge fences here first. An expired lease ends, and a Ticket whose Assignment has no live
 * lease is queued for a new worker once work waits.
 */
import { randomBytes } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { latestAssignment, liveTicket, restartNoteId, waitsForPerson, type Assignment, type EngineForExecutor, type Execution, type Ticket,
  type TicketInput, type Trigger, type WorkerReport } from '../core/index.ts'
import { batchOf, inputMessage, mandateInstructions, triggerMessage } from '../executor/dsh.ts'
import type { EffectPayloads, Effects } from '../app/effects.ts'
import { reportRelay } from '../app/notices.ts'
import type { Sessions } from '../app/sessions.ts'
import type { Store } from '../app/store.ts'
import type { Machine } from '../deployment.ts'
import { CliError } from '../infra/commands.ts'
import type { HealthEntry } from '../infra/health.ts'
import { KV, type Key } from '../kv.ts'
import { claimPull, PullSchema } from '../sources/github-pull.ts'
import type { SourceContext } from '../sources/host.ts'
import type { ExecutorPlugin } from './executors.ts'

/** The Inputs one claim or report answers, oldest first; `more` counts the rest. It bounds one door answer, so it is fixed. */
const INPUTS = 20
/** The commit SHAs one Ticket's `KV.external.pushed` keeps, newest last. It bounds one record, so it is fixed. */
const PUSHED = 100
/** Why a worker call is refused, by the code the management API answers with. */
const REFUSALS = {
  paused: 'Processing is paused or setup is not finished; try again later',
  nothing_queued: 'No external Ticket waits for a worker',
  not_claimable: 'The Ticket is not open to an external worker: it is local, ended, or its result was submitted',
  already_claimed: 'Another worker holds the lease on this Ticket',
  lease_expired: 'Your lease ended; nothing was recorded. Claim the Ticket again by its id and resend',
  lease_released: 'This lease was released when its result was submitted',
  assignment_ended: 'This Assignment no longer runs its Ticket; nothing was recorded',
  not_holder: 'Another door key holds this lease',
  wrong_ref: 'This lease pushes its Ticket\'s branch only',
  head_not_pushed: 'No holder of this Ticket\'s lease pushed that commit through the worker git route',
  head_moved: 'The Ticket\'s branch on GitHub is at another commit or does not exist; push your head to the branch again, then '
    + 'submit the commit the branch is at',
  not_found: 'Unknown Ticket or Assignment',
} as const
export type WorkerConflictCode = keyof typeof REFUSALS
/** A refused worker call: the management API answers it with 409, or 404 for `not_found`, and its `code`. */
export class WorkerConflict extends Error {
  /** @param code - Why the call was refused. */
  constructor(readonly code: WorkerConflictCode) { super(REFUSALS[code]) }
}
/** The Assignment endings that leave its worker a new claim: the lease expired, or work waited after its lease ended. */
const LEFT: readonly (string | undefined)[] = ['leaseExpired', 'workerLeft']
/** How the `external` health entry's two failures start, so each success clears only its own. */
const SWEEP_FAILED = 'Sweeping expired leases failed', REVIEW_FAILED = 'Requesting a review failed'

const WorkerSchema = z.object({ key: z.string().min(1).max(200), name: z.string().trim().min(1).max(200),
  model: z.string().trim().min(1).max(80).optional() }).strict()
/** The body of `POST workers/claim`: the Ticket to take, else the oldest queued one; the claim's idempotency key; and the worker. */
export const ClaimRequestSchema = z.object({ ticket: z.string().min(1).max(64).optional(), request: z.string().min(1).max(200),
  worker: WorkerSchema }).strict()
/** The fields of every call on a lease: its id and the door key that holds it. */
const HOLDER = { lease: z.string().regex(/^[0-9a-f]{32}$/), worker: z.object({ key: z.string().min(1).max(200) }).strict() }
const SHA = z.string().regex(/^[0-9a-f]{40}$/)
/**
 * The body of `POST workers/:assignment/report`: the lease and the door key that hold it; a state other than `ready`, which
 * only a submit records; a question for a person (`null` clears it); the person's message it `answers`; and the Inputs it
 * acknowledges (`ack`) as read from earlier answers.
 */
export const ReportRequestSchema = z.object({ ...HOLDER, state: z.enum(['progress', 'blocked', 'failed', 'dropped']), summary: z.string().trim().min(1).max(4000),
  question: z.string().trim().min(1).max(1000).nullable().optional(), answers: z.string().min(1).max(200).optional(),
  ack: z.array(z.string().min(1).max(200)).max(50).optional() }).strict()
/**
 * The body of `POST workers/:assignment/fence`, which the edge sends before it forwards one of the lease holder's git
 * requests: the lease, and for a push, its ref updates as the edge parsed them (`[]` for git's empty probe).
 */
export const FenceRequestSchema = z.object({ ...HOLDER,
  updates: z.array(z.object({ ref: z.string().min(1).max(300), old: SHA, new: SHA }).strict()).max(50).optional() }).strict()
/** The body of `POST workers/:assignment/submit`: the lease, the head the worker pushed, its summary, and its own model and cost. */
export const SubmitRequestSchema = z.object({ ...HOLDER, headSha: SHA, summary: z.string().trim().min(1).max(8000),
  model: z.string().trim().min(1).max(80).optional(), costUsd: z.number().nonnegative().optional() }).strict()
export type ClaimRequest = z.infer<typeof ClaimRequestSchema>
export type ReportRequest = z.infer<typeof ReportRequestSchema>
export type FenceRequest = z.infer<typeof FenceRequestSchema>
export type SubmitRequest = z.infer<typeof SubmitRequestSchema>

/**
 * The lease on one external Assignment, stored by Assignment id. `id`, 128 random bits, is the fencing epoch every worker call
 * names; `request` finds it again for a retried claim of the same door key. A lease is live until `expiresAt` unless released.
 */
export interface Lease {
  id: string
  ticketId: string
  worker: ClaimRequest['worker']
  request: string
  claimedAt: string
  renewedAt: string
  expiresAt: string
  /** Set when the worker's result was submitted: a released lease is not live, never renewed and never swept. */
  releasedAt?: string
  /** The submitted result, set with `releasedAt`, which a submit retried with the same head answers again. */
  result?: { pr: SubmitView['pr']; headSha: string }
}
/** A recorded submit: its Ticket and result. */
type Submitted = { ticketId: string; result: NonNullable<Lease['result']> }
/** `triggerMessage`'s fields with the full text, and without `chars`, `read` and `source_url_read`, which name in-box resources. */
export type WorkerTrigger = Omit<ReturnType<typeof triggerMessage>, 'chars' | 'read' | 'source_url_read'>
/** An Input as a worker outside the box reads it, by its id, which it acknowledges with `ack`. */
export interface WorkerInput { id: string; text: string }
/** The answer to a claim: the Ticket, its Assignment and lease, where to push, the full brief, and the first undelivered Inputs. */
export interface ClaimView {
  ticket: string
  title: string
  assignment: string
  lease: string
  /** The Assignment's place among the Ticket's Assignments, from 1. */
  attempt: number
  leaseExpiresAt: string
  /** How often to call so the lease stays live: half the lease. */
  renewWithinSeconds: number
  repository: string
  branch: string
  base: 'main'
  /** Set once two independent reviews of the Ticket's submitted heads failed: the worker starts a new session on its strongest model. */
  escalated: boolean
  brief: { request: WorkerTrigger; batch: WorkerTrigger[]; assignment: string; mandate: string }
  inputs: WorkerInput[]
  more: number
}
/** The answer to a report: the renewed expiry, the first undelivered Inputs, and the Ticket's open question for a person. */
export interface ReportView { leaseExpiresAt: string; inputs: WorkerInput[]; more: number; attention?: { question: string } }
/** The answer to a fence that passed: the edge forwards the git request on `ok`. */
export interface FenceView { ok: true; leaseExpiresAt: string }
/** The answer to a submit: the Ticket's pull request, a draft, and the released lease. */
export interface SubmitView { pr: { number: number; url: string }; lease: 'released' }

/** The last line of a CI Trigger's text (`ciSummary`), which names the in-box resource of every check. */
const CHECKS_LINE = /\nRead \S+ for every check\.$/
/**
 * A Trigger as a worker outside the box reads it: it cannot read in-box resources, so the text is whole, without a CI
 * Trigger's line that points at its checks resource, and no field names one.
 * @param trigger - The stored Trigger.
 * @param link - Its source link, as `sourceLink` resolves it.
 * @param note - The routing note it was attached with.
 * @returns `triggerMessage`'s fields with the full text.
 */
export function fullTrigger(trigger: Trigger, link: { source_url?: string; source_url_read?: string }, note?: string): WorkerTrigger {
  const { source_url_read: _resource, ...url } = link
  const { chars: _chars, read: _read, ...message }: WorkerTrigger & { chars?: number; read?: string } = triggerMessage(trigger, url, note)
  return { ...message, text: trigger.meta.ci === true ? trigger.text.replace(CHECKS_LINE, '') : trigger.text }
}
/**
 * Whether a Ticket is for a worker outside the box, which the Ticket's prepare step records as `executor: 'external'`.
 * @param store - Where its origin Triggers are stored.
 * @param ticket - The Ticket being created.
 * @returns true when a Trigger of its origin batch asks for one (`meta.worker`).
 */
export const externalRequested = (store: Pick<Store, 'triggers'>, ticket: Ticket): boolean =>
  ticket.origin.triggerIds.some(id => store.triggers.get(id)?.meta.worker === 'external')

/** An open pull request as the box reads and creates it, with what converting it to a draft needs. */
const OpenPullSchema = PullSchema.extend({ number: z.number(), node_id: z.string(), draft: z.boolean() })
const TO_DRAFT = 'mutation($id: ID!) { convertPullRequestToDraft(input: { pullRequestId: $id }) { clientMutationId } }'

const iso = (ms: number): string => new Date(ms).toISOString()
/**
 * A record the Store holds by construction, such as a Ticket a lease names or an external Ticket's Execution.
 * @throws Error naming `what` when it is missing, which breaks that construction.
 */
function held<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`${what} is missing`)
  return value
}
/** A lease is live while it is neither released nor past its expiry. */
const live = (lease: Lease | undefined): boolean => !!lease && !lease.releasedAt && Date.parse(lease.expiresAt) >= Date.now()
/** A lease expired: past its expiry and never released. */
const expired = (lease: Lease): boolean => !lease.releasedAt && Date.parse(lease.expiresAt) < Date.now()
/** A Ticket's latest Assignment; every Ticket is created with one. */
const latestOf = (ticket: Ticket): Assignment => held(latestAssignment(ticket), `The Assignment of Ticket ${ticket.id}`)
const executionOf = (ticket: Ticket): Execution => held(ticket.execution, `The Execution of Ticket ${ticket.id}`)
const branchOf = (ticket: Ticket): string => `agent/${executionOf(ticket).name}`
const LEASE_NOTE = (ticket: Ticket) => `The previous worker's lease expired. Fetch \`${branchOf(ticket)}\`, inspect what is pushed and the PR, `
  + 'and continue; do not repeat finished outside actions.'
const WORKER_LEFT_NOTE = (ticket: Ticket) => `The previous worker's lease ended, and new work waits. Fetch \`${branchOf(ticket)}\`, inspect `
  + 'what is pushed and the PR, and continue with the Inputs that follow; do not repeat finished outside actions.'
/** A `resumed` Input in the worker's own terms: the in-box text names tools a worker outside the box does not have. */
const RESUMED_NOTE = (ticket: Ticket) => 'This ticket ended earlier and the message that follows, on its thread, resumed it under the same '
  + `mandate. If it asks for more within the original scope, fetch \`${branchOf(ticket)}\`, inspect what is pushed and the PR, continue, `
  + 'and finish with task_submit; if it asks for work beyond that scope or for another ticket, report dropped with task_report without '
  + 'acknowledging the message, so it is routed again; if it needs nothing, such as thanks, report dropped. Do not repeat completed work.'

/** Host dependencies used by `ExternalExecutor`. */
export interface ExternalHost {
  readonly engine: Pick<EngineForExecutor, 'assignmentStarted' | 'assignmentLeft' | 'inputsDelivered' | 'inputsRead' | 'report' | 'requestReview'>
  readonly store: Pick<Store, 'tickets' | 'triggers' | 'get' | 'set' | 'delete' | 'keys' | 'atomic'>
  /** Durable effect queue through which a Ticket is queued for a new worker. */
  readonly effects: Pick<Effects, 'enqueue' | 'handle'>
  /** Relays a worker's report to the main Session. */
  readonly sessions: Pick<Sessions, 'relay'>
  /** The GitHub Source's context: the box's GitHub CLI, through which a submit opens the pull request, and the binding to it. */
  readonly github: SourceContext
  /** The `external` health entry, which reports whether the lease sweep, or the review request of a submit, failed. */
  readonly health: HealthEntry
  /** Logs a failed review request, which the submit's answer does not carry. */
  readonly logger: Pick<Context['logger'], 'warn'>
  readonly machine: Pick<Machine, 'workerLeaseMinutes'>
  /** Whether processing is paused or setup is pending, which refuses claims. */
  paused(): boolean
  /** The configured repository, `owner/name`; read only after setup. */
  repository(): string
  sourceLink(trigger: Trigger): Promise<{ source_url?: string; source_url_read?: string }>
}

/**
 * The Executor of external Tickets. It launches nothing: a pending Assignment waits for a claim, which leases it to one worker
 * and records the worker on it. The worker renews the lease with every call and pulls its Inputs from the answers, so a lost
 * answer loses no Input. A sweep ends expired leases: the Assignment is replaced by a new pending one, unless its worker handed
 * off to a person and no work waits, in which case it runs on without a lease until a worker claims it by its Ticket id.
 */
export class ExternalExecutor implements ExecutorPlugin {
  private timer?: ReturnType<typeof setInterval>
  /** Registers the `requeue` effect handler. */
  constructor(private readonly host: ExternalHost) {
    host.effects.handle('requeue', (payload) => { this.requeue(payload); return Promise.resolve() })
  }
  /** Nothing: a pending external Assignment waits for a claim. */
  start(): void {}
  /**
   * Nothing while the Assignment's lease is live: its worker reads the Inputs from its next answer. Otherwise, once an Input
   * that asks for work waits (see `workWaits`), arrived after the lease was released if it was, queues the Ticket for a new
   * worker through a `requeue` effect, since the Engine calls this inside its commands. An earlier Input may have reached the
   * released worker in an answer it never acknowledged.
   */
  deliver(ticket: Ticket, assignment: Assignment): void {
    const lease = this.lease(assignment.id)
    if (!live(lease) && this.workWaits(ticket, lease?.releasedAt)) {
      this.host.effects.enqueue('requeue', ticket.id, { ticketId: ticket.id, assignmentId: assignment.id })
    }
  }
  /**
   * Deletes the Assignment's lease in the caller's transaction, so every later call with it is refused, and the commits its
   * holders pushed once the Ticket ended.
   */
  stop(ticket: Ticket, assignment: Assignment): void {
    this.host.store.delete(KV.external.lease(assignment.id))
    if (ticket.ended) this.host.store.delete(KV.external.pushed(ticket.id))
  }
  /** Sweeps the leases every tenth of the lease length. */
  install(): void {
    this.timer = setInterval(() => { this.sweep() }, this.leaseMs() / 10)
    this.timer.unref()
  }
  /** A host start keeps every lease and sweeps the expired ones at once; nothing is interrupted. */
  resume(): void { this.sweep() }
  /** Nothing runs in the box for an external Ticket. */
  async shutdown(): Promise<void> {}
  dispose(): void { clearInterval(this.timer) }

  /**
   * Leases an Assignment to a worker, in one transaction: a claim retried with the same door key and `request` answers its
   * lease again, renewed, while it is live; one that expired, which a failed sweep left, is ended as the sweep ends it first.
   * Otherwise the named Ticket, or the oldest one whose latest Assignment is pending, gets a new lease, and its Assignment
   * runs with the worker recorded on it. Only a claim by Ticket id takes a handed-off Assignment, which waits for a person.
   * @param request - The validated claim.
   * @returns The Ticket, its lease and brief, and its first undelivered Inputs.
   * @throws WorkerConflict `paused` while processing is paused or setup is pending; `lease_released` for a retry of a
   * released lease; `nothing_queued`; `not_found` for an unknown named Ticket; `already_claimed` for one another live lease
   * holds; `not_claimable` for one that is local, ended, or whose lease was released.
   */
  async claim(request: ClaimRequest): Promise<ClaimView> {
    if (this.host.paused()) throw new WorkerConflict('paused')
    this.sweep()
    const { ticket, assignment, lease } = this.host.store.atomic(() => this.take(request))
    return this.view(ticket, assignment, lease)
  }
  /**
   * Records a report of the lease holder, in one transaction: renews the lease, marks the Inputs it acknowledges delivered and
   * read, records the report as a local worker's (see `Engine.report`), and relays it to the main Session as such.
   * @param assignment - The Assignment the lease is on.
   * @param request - The validated report.
   * @returns The renewed expiry, the first undelivered Inputs, and the Ticket's open question for a person.
   * @throws WorkerConflict when the caller does not hold the live lease (see `holder`); UserError as `Engine.report` refuses.
   */
  async report(assignment: string, request: ReportRequest): Promise<ReportView> {
    const { engine, store } = this.host
    const { lease: _lease, worker: _worker, ack = [], ...report } = request
    const { ticket, lease } = store.atomic(() => {
      const holding = this.holder(assignment, request)
      const renewed = this.renew(assignment, holding.lease)
      if (ack.length) { engine.inputsDelivered(holding.ticket.id, assignment, ack); engine.inputsRead(holding.ticket.id, ack) }
      return { ticket: this.record(holding.ticket.id, report), lease: renewed }
    })
    const { attention } = ticket
    return { leaseExpiresAt: lease.expiresAt, ...await this.inputs(ticket),
      ...attention ? { attention: { question: attention.question } } : {} }
  }
  /**
   * Admits one git request of the lease holder before the edge forwards it, in one transaction: renews the lease and, for a
   * push, appends each new head to the Ticket's `KV.external.pushed`, which a submit checks. Every update must be of the
   * Ticket's branch. The edge parses the updates from the push itself, so a worker never names a commit here.
   * @param assignment - The Assignment the lease is on.
   * @param request - The validated fence.
   * @returns `ok` and the renewed expiry.
   * @throws WorkerConflict when the caller does not hold the live lease (see `holder`); `wrong_ref` for an update of another
   * ref, recording nothing.
   */
  fence(assignment: string, request: FenceRequest): FenceView {
    const { store } = this.host
    return store.atomic(() => {
      const { ticket, lease } = this.holder(assignment, request)
      const updates = request.updates ?? []
      if (updates.some(update => update.ref !== `refs/heads/${branchOf(ticket)}`)) throw new WorkerConflict('wrong_ref')
      const renewed = this.renew(assignment, lease)
      if (updates.length) {
        const name = KV.external.pushed(ticket.id), heads = updates.map(update => update.new)
        store.set(name, [...(store.get(name) ?? []).filter(sha => !heads.includes(sha)), ...heads].slice(-PUSHED))
      }
      return { ok: true, leaseExpiresAt: renewed.expiresAt }
    })
  }
  /**
   * Finishes the lease holder's work with the head it pushed: checks that a holder of this Ticket's lease pushed `headSha`
   * through the worker git route and that it is still the branch head, opens a draft pull request from the branch or turns
   * the open one back into a draft, then, in one transaction, binds the pull request, records a `ready` report as a local
   * worker's, relayed to the main Session alike, with the worker's declared `model` and `costUsd` on the Assignment's
   * `worker`, and releases the lease with the result. The GitHub writes come first, so one that fails records nothing and
   * the worker submits again. A retry with the same head after the release, or while the first submit runs, answers the
   * stored result once the first one recorded it. Every answer requests the review of the head (see `answer`).
   * @param assignment - The Assignment the lease is on.
   * @param request - The validated submit.
   * @returns The pull request and the released lease.
   * @throws WorkerConflict when the caller does not hold the live lease (see `holder`); `paused` while processing is paused
   * or setup is pending; `head_not_pushed`; `head_moved`, also when the branch is not on GitHub. Error for a failed GitHub
   * call, or a pull request from the branch that the Ticket cannot claim (see `claimPull`).
   */
  async submit(assignment: string, request: SubmitRequest): Promise<SubmitView> {
    const { store, github } = this.host
    const done = this.submitted(assignment, request)
    if (done) return this.answer(done)
    const { ticket } = this.holder(assignment, request)
    if (this.host.paused()) throw new WorkerConflict('paused')
    if (!store.get(KV.external.pushed(ticket.id))?.includes(request.headSha)) throw new WorkerConflict('head_not_pushed')
    const { commands } = github, branch = branchOf(ticket)
    const head = await commands.api(z.looseObject({ commit: z.looseObject({ sha: z.string() }) }), `branches/${branch}`)
      // The fence records a push before GitHub applies it, so a pushed head may never have made the branch.
      .catch((error: unknown) => { throw error instanceof CliError && error.code === 404 ? new WorkerConflict('head_moved') : error })
    if (head.commit.sha !== request.headSha) throw new WorkerConflict('head_moved')
    const owner = this.host.repository().split('/')[0]
    const opened = async () => (await commands.api(z.array(OpenPullSchema), `pulls?head=${owner}:${branch}&state=open`))[0]
    const pull = await opened() ?? await commands.api(OpenPullSchema, 'pulls', '--method', 'POST', '-f', `title=${ticket.title}`,
      '-f', `body=This is by an automated agent, not a human.\n\n${request.summary}\n\nTicket ${ticket.id}`, '-f', `head=${branch}`,
      '-f', 'base=main', '-F', 'draft=true').catch(async (error: unknown) => {
      // GitHub answers 422 when a concurrent submit opened the pull request since the listing, and for other invalid creates.
      const made = error instanceof CliError && error.code === 422 ? await opened() : undefined
      if (!made) throw error
      return made
    })
    // An unreviewed head must not wait in the approval queue as a ready pull request.
    if (!pull.draft) await commands.gh(['api', 'graphql', '-f', `query=${TO_DRAFT}`, '-f', `id=${pull.node_id}`])
    return this.answer(store.atomic(() => {
      // A concurrent submit of the same head may have recorded it, and the lease may have ended, during the GitHub calls.
      const recorded = this.submitted(assignment, request)
      if (recorded) return recorded
      const { lease } = this.holder(assignment, request)
      const refused = claimPull(github, ticket.id, pull)
      if (refused) throw new Error(refused)
      const { lease: _lease, worker: _worker, summary, headSha, ...declared } = request
      this.record(ticket.id, { state: 'ready', summary }, { ...lease.worker, ...declared })
      const result = { pr: { number: pull.number, url: pull.html_url }, headSha }
      store.set(KV.external.lease(assignment), { ...lease, releasedAt: iso(Date.now()), result })
      return { ticketId: ticket.id, result }
    }))
  }
  /**
   * Ends every expired lease, each in one transaction: deletes it and, unless its worker handed off to a person and no work
   * waits, replaces its Assignment with a new pending one that receives `LEASE_NOTE` first. A handed-off Assignment runs on
   * without a lease, which a claim by its Ticket id takes. A failure is reported to the `external` health entry.
   */
  sweep(): void {
    const { store, health } = this.host
    try {
      for (const name of store.keys(KV.external.lease)) store.atomic(() => { this.expire(name) })
      if (health.get()?.detail.startsWith(SWEEP_FAILED)) health.set({ state: 'ready', detail: 'Expired leases are swept', at: iso(Date.now()) })
    } catch (error) {
      health.set({ state: 'error', detail: `${SWEEP_FAILED}: ${String(error)}`, at: iso(Date.now()) })
    }
  }

  private leaseMs(): number { return this.host.machine.workerLeaseMinutes * 60_000 }
  /** Records a report as a local worker's (see `Engine.report`), with `worker` when given, and relays it to the main Session alike. */
  private record(ticketId: string, report: WorkerReport, worker?: Assignment['worker']): Ticket {
    const updated = this.host.engine.report(ticketId, report, worker)
    const relay = reportRelay(updated, report)
    if (relay) this.host.sessions.relay(relay.id, relay.text)
    return updated
  }
  private lease(assignment: string): Lease | undefined { return this.host.store.get(KV.external.lease(assignment)) }
  /** The result a submit of `headSha` recorded on the caller's released lease, which a submit of the same head gets again. */
  private submitted(assignment: string, request: SubmitRequest): Submitted | undefined {
    const done = this.lease(assignment)
    return done?.id === request.lease && done.worker.key === request.worker.key && done.result?.headSha === request.headSha
      ? { ticketId: done.ticketId, result: done.result } : undefined
  }
  /**
   * The answer to a submit whose result is recorded, once it requested the review of the submitted head on its pull request
   * (`Engine.requestReview`, one review Ticket per Ticket and head, so a retried submit starts none). A refused request, such
   * as for a Ticket that ended since, leaves the recorded submit as it is: it is logged and set on the `external` health
   * entry, which the next review request that succeeds clears.
   */
  private answer({ ticketId, result: { pr, headSha } }: Submitted): SubmitView {
    const { engine, health, logger } = this.host
    try {
      engine.requestReview(ticketId, { pr: pr.number, sha: headSha })
      if (health.get()?.detail.startsWith(REVIEW_FAILED)) health.set({ state: 'ready', detail: 'Submitted heads are queued for review', at: iso(Date.now()) })
    } catch (error) {
      const detail = `${REVIEW_FAILED} for head ${headSha} of Ticket ${ticketId}: ${String(error)}`
      logger.warn('dsh-superagent: %s', detail)
      health.set({ state: 'error', detail, at: iso(Date.now()) })
    }
    return { pr, lease: 'released' }
  }
  /** Writes the lease on `assignment` with a new expiry, one lease length from now. */
  private renew(assignment: string, lease: Omit<Lease, 'renewedAt' | 'expiresAt'>): Lease {
    const now = Date.now()
    const renewed = { ...lease, renewedAt: iso(now), expiresAt: iso(now + this.leaseMs()) }
    this.host.store.set(KV.external.lease(assignment), renewed)
    return renewed
  }
  private take({ ticket: named, request, worker }: ClaimRequest): { ticket: Ticket; assignment: string; lease: Lease } {
    const { store } = this.host
    const ticketOf = (id: string): Ticket => held(store.tickets.get(id), `Ticket ${id}`)
    // Another key's identical `request` is another claim.
    const retried = store.keys(KV.external.lease)
      .map(name => [name.slice(KV.external.lease.prefix.length), held(store.get(name), name)] as const)
      .find(([, lease]) => lease.worker.key === worker.key && lease.request === request)
    if (retried) {
      const [assignment, lease] = retried
      if (lease.releasedAt) throw new WorkerConflict('lease_released')
      if (!expired(lease)) return { ticket: ticketOf(lease.ticketId), assignment, lease: this.renew(assignment, lease) }
      // A failed sweep left it: it ends as the sweep ends it, and the claim goes on as one whose lease the sweep had ended.
      this.expire(KV.external.lease(assignment))
    }
    const found = named === undefined
      ? store.tickets.open().reverse().find(item => latestOf(item).state === 'pending' && !this.refusal(item))
      : store.tickets.get(named)
    if (!found) throw new WorkerConflict(named === undefined ? 'nothing_queued' : 'not_found')
    const refusal = this.refusal(found)
    if (refusal) throw new WorkerConflict(refusal)
    const assignment = latestOf(found).id
    // The lease is written first, so the delivery `assignmentStarted` asks for finds it live and waits for the worker's call.
    const lease = this.renew(assignment, { id: randomBytes(16).toString('hex'), ticketId: found.id, worker, request, claimedAt: iso(Date.now()) })
    this.host.engine.assignmentStarted(found.id, assignment, worker)
    return { ticket: ticketOf(found.id), assignment, lease }
  }
  /**
   * Why a worker may not take `ticket`, or undefined when it may: an open external Ticket whose latest Assignment has no
   * lease, so it is pending, or runs without one because its worker handed off and the lease then expired. A claim sweeps
   * first, so a lease it finds is live or released, unless the sweep failed: an expired one then refuses `already_claimed`
   * until a sweep succeeds.
   */
  private refusal(ticket: Ticket): 'not_claimable' | 'already_claimed' | undefined {
    const lease = this.lease(latestOf(ticket).id)
    if (lease) return lease.releasedAt ? 'not_claimable' : 'already_claimed'
    return liveTicket(ticket) && ticket.executor === 'external' ? undefined : 'not_claimable'
  }
  /**
   * The Ticket of a worker call and its lease, once the caller holds it.
   * @throws WorkerConflict `not_found` for an unknown Assignment; `assignment_ended` when its Ticket ended or it ended for
   * another reason than its worker's lease ending; `lease_expired` when it has no live lease with the caller's id; `not_holder`
   * for another door key; `lease_released` for a released lease.
   */
  private holder(assignment: string, request: Pick<ReportRequest, 'lease' | 'worker'>): { ticket: Ticket; lease: Lease } {
    // ponytail: reads every Ticket to find the Assignment's; index Assignments by id if Tickets grow into the thousands.
    const found = this.host.store.tickets.list()
      .flatMap(item => item.assignments.flatMap(entry => entry.id === assignment ? [[item, entry] as const] : []))[0]
    if (!found) throw new WorkerConflict('not_found')
    const [ticket, { state, endedReason }] = found
    if (!liveTicket(ticket) || (state === 'ended' && !LEFT.includes(endedReason))) throw new WorkerConflict('assignment_ended')
    const lease = this.lease(assignment)
    if (!lease || lease.id !== request.lease || expired(lease)) throw new WorkerConflict('lease_expired')
    if (lease.worker.key !== request.worker.key) throw new WorkerConflict('not_holder')
    if (lease.releasedAt) throw new WorkerConflict('lease_released')
    return { ticket, lease }
  }
  /** Ends one lease of the sweep, re-read in its transaction (see `sweep`). */
  private expire(name: Key<Lease>): void {
    const { store, engine } = this.host
    const lease = held(store.get(name), name)
    if (!expired(lease)) return
    store.delete(name)
    const ticket = held(store.tickets.get(lease.ticketId), `Ticket ${lease.ticketId}`)
    // A worker that handed off to a person, by a blocked or failed report or a question, keeps its Assignment.
    const handedOff = waitsForPerson(ticket) || !!ticket.attention
    const assignment = name.slice(KV.external.lease.prefix.length)
    if (!handedOff || this.workWaits(ticket)) engine.assignmentLeft(ticket.id, assignment, 'leaseExpired', LEASE_NOTE(ticket))
  }
  /** Replaces an Assignment without a live lease once work waits for it as `deliver` decides, in one transaction; the lease is deleted. */
  private requeue({ ticketId, assignmentId }: EffectPayloads['requeue']): void {
    const { store, engine } = this.host
    store.atomic(() => {
      const ticket = held(store.tickets.get(ticketId), `Ticket ${ticketId}`)
      const lease = this.lease(assignmentId)
      if (live(lease) || !this.workWaits(ticket, lease?.releasedAt)) return
      store.delete(KV.external.lease(assignmentId))
      engine.assignmentLeft(ticketId, assignmentId, 'workerLeft', WORKER_LEFT_NOTE(ticket))
    })
  }
  /**
   * Whether an undelivered Input that arrived at `since` or later asks for work: a person's message, a `text` Input such as
   * review findings, or a red CI result (`meta.ciFailed`). The note a new Assignment gets first (`LEASE_NOTE`,
   * `WORKER_LEFT_NOTE`) says where to pick up, not what to do, so a worker that hands off without acknowledging it keeps its
   * Assignment. Other CI changes, notes and Policy changes wait for the next claim.
   */
  private workWaits(ticket: Ticket, since = ''): boolean {
    const notes = ticket.assignments.map(item => restartNoteId(ticket.id, item.id))
    const asks = (input: TicketInput): boolean => (input.kind === 'text' && !notes.includes(input.id))
      || (input.kind === 'trigger' && (!!input.human || this.host.store.triggers.get(input.triggerId)?.meta.ciFailed === true))
    return ticket.inputs.some(input => input.at >= since && ticket.undelivered.includes(input.id) && asks(input))
  }
  private async view(ticket: Ticket, assignment: string, lease: Lease): Promise<ClaimView> {
    const execution = executionOf(ticket)
    return { ticket: ticket.id, title: ticket.title, assignment, lease: lease.id,
      attempt: ticket.assignments.findIndex(item => item.id === assignment) + 1,
      leaseExpiresAt: lease.expiresAt, renewWithinSeconds: this.leaseMs() / 2000,
      repository: this.host.repository(), branch: branchOf(ticket), base: 'main', escalated: !!ticket.escalated,
      brief: { request: await this.full(this.triggerOf(ticket.origin.triggerId)),
        batch: await Promise.all(batchOf(this.host, ticket).map(trigger => this.full(trigger))),
        assignment: execution.assignment, mandate: mandateInstructions(ticket.mandate) },
      ...await this.inputs(ticket) }
  }
  private async full(trigger: Trigger, note?: string): Promise<WorkerTrigger> {
    return fullTrigger(trigger, await this.host.sourceLink(trigger), note)
  }
  private triggerOf(id: string): Trigger { return held(this.host.store.triggers.get(id), `Trigger ${id}`) }
  /** The Ticket's first `INPUTS` undelivered Inputs, in the order they wait, with the count of the rest. */
  private async inputs(ticket: Ticket): Promise<{ inputs: WorkerInput[]; more: number }> {
    const ids = ticket.undelivered.slice(0, INPUTS)
    const inputs = await Promise.all(ids.map(async (id) => {
      const input = held(ticket.inputs.find(item => item.id === id), `Input ${id}`)
      const trigger = input.kind === 'trigger' ? await this.full(this.triggerOf(input.triggerId), input.note) : undefined
      // Only legacy `reopen` Inputs render no text, and the schema 11 migration left none undelivered.
      return { id, text: input.kind === 'resumed' ? RESUMED_NOTE(ticket) : held(inputMessage(input, trigger), `The text of Input ${id}`) }
    }))
    return { inputs, more: ticket.undelivered.length - ids.length }
  }
}
