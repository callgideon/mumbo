/**
 * In Mumbo, the Executor port (`UPSTREAM.md` S11): `ExecutorPlugin`, an Executor with its lifecycle, and `Executors`, the
 * Executor the Engine sees, which sends each call to the Executor of its Ticket's kind.
 */
import type { Assignment, Executor, Ticket } from '../core/index.ts'

/** Which Executor runs a Ticket; a Ticket without `executor` is local. */
export type ExecutorKind = 'local' | 'external'
/** An Executor the Runtime composes: the core port plus its lifecycle. */
export interface ExecutorPlugin extends Executor {
  /** Subscribe to host events and start timers; once, after setup. */
  install(): void
  /** Reconcile `tickets`, its own open Tickets, after a host start. */
  resume(tickets: Ticket[]): void
  /** Bounded stop of background work on host stop. */
  shutdown(): Promise<void>
  /** Undo `install`. */
  dispose(): void
}
/**
 * The kind of Executor that runs `ticket`.
 * @param ticket - The Ticket, or only its `executor`.
 * @returns `external` for an external Ticket, otherwise `local`.
 */
export const executorOf = (ticket: Pick<Ticket, 'executor'>): ExecutorKind => ticket.executor ?? 'local'

/** The `external` kind until an external-worker Executor takes its place: it does nothing, so external Tickets stay as they are. */
export const heldExecutor: ExecutorPlugin = {
  start() {}, deliver() {}, stop() {}, install() {}, resume() {}, async shutdown() {}, dispose() {},
}

/** The Executor the Engine sees: each call goes to the Ticket's kind; lifecycle calls reach every kind. */
export class Executors implements ExecutorPlugin {
  /** @param kinds - The Executor of each kind. */
  constructor(private readonly kinds: Record<ExecutorKind, ExecutorPlugin>) {}
  start(ticket: Ticket, assignment: Assignment): void { this.kinds[executorOf(ticket)].start(ticket, assignment) }
  deliver(ticket: Ticket, assignment: Assignment): void { this.kinds[executorOf(ticket)].deliver(ticket, assignment) }
  stop(ticket: Ticket, assignment: Assignment, reason: string): void { this.kinds[executorOf(ticket)].stop(ticket, assignment, reason) }
  install(): void { for (const executor of Object.values(this.kinds)) executor.install() }
  /** Gives each kind only its own Tickets of `tickets`. */
  resume(tickets: Ticket[]): void {
    for (const [kind, executor] of Object.entries(this.kinds)) executor.resume(tickets.filter(ticket => executorOf(ticket) === kind))
  }
  /**
   * Shuts every kind down, each whatever the others do.
   * @throws The first kind's failure, once every kind has finished.
   */
  async shutdown(): Promise<void> {
    const results = await Promise.allSettled(Object.values(this.kinds).map(executor => executor.shutdown()))
    const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failed) throw failed.reason
  }
  dispose(): void { for (const executor of Object.values(this.kinds)) executor.dispose() }
}
