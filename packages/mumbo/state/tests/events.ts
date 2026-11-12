/** Session event builders for the fold tests: one log with contiguous seqs and, by default, one second between events. */

import { CompactionId } from '@deepseek-ai/dsh-compaction'
import type { GoalOperation } from '@deepseek-ai/dsh-goal'
import { GoalId } from '@deepseek-ai/dsh-goal'
import { JobId } from '@deepseek-ai/dsh-jobs'
import type { JobSettleCause } from '@deepseek-ai/dsh-jobs'
import { createAssistantMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { MessageSource } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionEventMap, SessionEventType } from '@deepseek-ai/dsh-session'
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo'
import { WorkflowRunId } from '@deepseek-ai/dsh-workflow'
import type {} from '../src/resume.ts'

/** A log under construction. */
export class Log {
  readonly events: SessionEvent[] = []

  /**
   * @param base - the time before the first event, in epoch milliseconds.
   * @param spacing - the milliseconds between events; 0 logs every event at `base`.
   */
  constructor(private readonly base = 0, private readonly spacing = 1000) {}

  /** Append one event; message events take the `append` surface operation. */
  add<T extends SessionEventType>(type: T, data: SessionEventMap[T]): this {
    const seq = this.events.length
    const surface = ['user/message', 'assistant/message', 'tool/result'].includes(type) ? { surfaceOp: 'append' } : {}
    this.events.push({ type, seq: SessionSeq(seq), time: this.base + (seq + 1) * this.spacing, data, ...surface } as SessionEvent)
    return this
  }

  user(text: string, source: MessageSource = { kind: 'user' }): this {
    return this.add('user/message', createUserMessage({ content: [{ type: 'text', text }], source }))
  }

  assistant(text: string): this {
    return this.add('assistant/message', {
      turn: 1, step: 1, stream: [], message: createAssistantMessage({ content: [{ type: 'text', text }], source: { provider: 'mock', model: 'mock' } }),
    })
  }

  call(id: string, name: string, args: string, turn = 1): this {
    return this.add('tool/call', { turn, step: 1, callId: ToolCallId(id), name, arguments: args })
  }

  result(id: string, isError = false): this {
    return this.add('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: ToolCallId(id), content: [], isError }) })
  }

  /** `exit_plan_mode` presenting `plan`, and its review result. */
  plan(id: string, plan: string, isError = false, turn = 1): this {
    return this.call(id, 'exit_plan_mode', JSON.stringify({ plan }), turn).result(id, isError)
  }

  todos(items: TodoItem[]): this {
    return this.add('todo/write', { todos: items })
  }

  goal(operation: GoalOperation): this {
    if (operation === 'clear') {
      return this.add('goal/change', { kind: 'goal/change', version: 1, operation, cleared: { id: GoalId('g'), revision: 1 }, clearedAt: 0 })
    }
    const goal = { id: GoalId('g'), revision: 1, objective: 'Ship it', phase: 'active' as const, maxGoalRounds: 8 }
    return this.add('goal/change', { kind: 'goal/change', version: 1, operation, goal, roundsStarted: 0, createdAt: 0, updatedAt: 0 })
  }

  compaction(error?: string): this {
    return this.add('compaction/end', { compactionId: CompactionId('c'), turn: null, ...error === undefined ? {} : { error } })
  }

  job(id: string, kind = 'bash', label = 'node slow.js'): this {
    return this.add('job/registered', { jobId: JobId(id), owner: SessionId('s'), kind, label, startedAt: 0 })
  }

  settle(id: string, cause: JobSettleCause, status: 'completed' | 'killed' | 'failed' = 'completed', detail?: string): this {
    return this.add('job/settled', {
      jobId: JobId(id), owner: SessionId('s'), kind: 'bash', label: 'node slow.js', startedAt: 0, finishedAt: 0, status, cause,
      producerReported: true, ...detail === undefined ? {} : { detail },
    })
  }

  run(id: string, name = 'review'): this {
    return this.add('tool-workflow/run-start', { runId: WorkflowRunId(id), name })
  }

  runAgent(id: string, end = false): this {
    const runId = WorkflowRunId(id)
    return end
      ? this.add('tool-workflow/agent-end', { runId, seq: 1, outcome: 'completed' })
      : this.add('tool-workflow/agent-start', { runId, seq: 1, label: 'reader', childId: SessionId('child') })
  }

  runEnd(id: string): this {
    return this.add('tool-workflow/run-end', { runId: WorkflowRunId(id), stopReason: 'completed' })
  }

  /** A step's start; only a series start or a changed header also logs a `request/header`. */
  step(header = false): this {
    this.add('step/start', { turn: 1, step: 1 })
    return header ? this.add('request/header', { header: { config: { provider: 'mock', model: 'mock' } }, reason: 'initial' }) : this
  }
}
