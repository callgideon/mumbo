/**
 * The state block's text: fixed sections, each present only when it has content, filled greedily within a character
 * cap, with pointers to the tools that hold what does not fit.
 * @module @mumbo/state/render
 */

/** The facts one state block shows, read at a boundary. Each absent or empty part renders no section. */
export interface StateView {
  readonly goal?: {
    readonly phase: 'active' | 'paused' | 'blocked' | 'complete'
    /** Whether this process continues an active goal on its own. */
    readonly armed: boolean
    readonly roundsStarted: number
    readonly maxGoalRounds: number
    readonly objective: string
    /** Why the goal is blocked; present exactly while it is. */
    readonly blockedReason?: string
  }
  readonly plan?: { readonly title: string | undefined; readonly steps: readonly string[]; readonly turn: number }
  readonly todos?: {
    readonly items: readonly { readonly content: string; readonly status: 'pending' | 'in_progress' | 'completed' }[]
    readonly turn: number
  }
  readonly team?: readonly { readonly id: string; readonly status: string; readonly owner: string | undefined; readonly subject: string }[]
  /** Running direct children: the name the parent knows them by, and their task label. */
  readonly subagents?: readonly { readonly name: string; readonly label: string | undefined }[]
  readonly jobs?: readonly { readonly id: string; readonly status: string; readonly label: string }[]
}

/** First line of every non-empty block. */
export const BLOCK_HEADER = 'Mumbo state at the last compaction, restart or goal change. Changes after that point are in the conversation that follows.'

/** Characters kept free for a `… N more` line and the `Not shown:` line. */
const TAIL_RESERVE = 160
/** Longest item line. */
const ITEM_CHARS = 140
/** Longest goal objective. */
const OBJECTIVE_CHARS = 300

/** One rendered section: its heading line, its item lines, and where the model reads what does not fit. */
interface Section {
  readonly name: string
  readonly heading: string
  readonly items: readonly string[]
  readonly pointer: string
}

/**
 * Cut text to a length.
 * @param text - the text.
 * @param max - the longest result.
 * @returns `text`, or its first `max - 1` characters and `…` when it is longer.
 */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/** An item line: indented, on one line, clipped. */
function item(text: string): string {
  return clip(`  ${text.replace(/\s+/gu, ' ')}`, ITEM_CHARS)
}

/** The goal's state, as the heading's parenthesis starts. */
function goalState(goal: NonNullable<StateView['goal']>): string {
  if (goal.blockedReason !== undefined) return `blocked: ${goal.blockedReason}`
  return goal.phase === 'active' && !goal.armed ? 'active, stopped by a restart: a person must resume it with /goal resume' : goal.phase
}

/** The sections of a view, in their fixed order, without the empty ones. */
function sections(view: StateView): Section[] {
  const out: Section[] = []
  const { goal, plan, todos, team = [], subagents = [], jobs = [] } = view
  if (goal !== undefined) {
    const objective = clip(goal.objective.replace(/\s+/gu, ' '), OBJECTIVE_CHARS)
    const rounds = `round ${String(goal.roundsStarted)} of ${String(goal.maxGoalRounds)}`
    out.push({ name: 'goal', heading: `Goal (${goalState(goal)}; ${rounds}): ${objective}`, items: [], pointer: 'get_goal' })
  }
  if (plan !== undefined) {
    const title = plan.title === undefined ? 'Plan' : `Plan "${plan.title}"`
    out.push({
      name: 'plan',
      heading: `${title} (approved in turn ${String(plan.turn)}; full text: plan_read):`,
      items: plan.steps.map((step, index) => item(`${String(index + 1)}. ${step}`)),
      pointer: 'plan_read',
    })
  }
  const open = todos?.items.filter(entry => entry.status !== 'completed') ?? []
  if (todos !== undefined && open.length > 0) {
    out.push({
      name: 'todo',
      heading: `Todo (${String(open.length)} of ${String(todos.items.length)} open, written in turn ${String(todos.turn)}):`,
      items: open.map(entry => item(`[${entry.status}] ${entry.content}`)),
      pointer: 'your last todo_write',
    })
  }
  if (team.length > 0) {
    out.push({
      name: 'team tasks',
      heading: `Team tasks (${String(team.length)} open; team_task_list):`,
      items: team.map(task => item(`#${task.id} [${task.status}${task.owner === undefined ? '' : `, ${task.owner}`}] ${task.subject}`)),
      pointer: 'team_task_list',
    })
  }
  if (subagents.length > 0) {
    out.push({
      name: 'subagents',
      heading: 'Subagents running (list_agents):',
      items: subagents.map(child => item(child.label === undefined || child.label === child.name ? child.name : `${child.name}: ${child.label}`)),
      pointer: 'list_agents',
    })
  }
  if (jobs.length > 0) {
    out.push({
      name: 'background jobs',
      heading: 'Background jobs (job_list):',
      items: jobs.map(job => item(`${job.id} [${job.status}] ${job.label}`)),
      pointer: 'job_list',
    })
  }
  return out
}

/**
 * Render a state view. Sections keep their order; a section's lines are added while the text and a tail reserve stay
 * within `maxChars`, the first item that does not fit becomes `… N more (<pointer>)`, and a section whose heading does
 * not fit is named in a final `Not shown:` line. The result never exceeds `maxChars`.
 * @param view - the facts to show.
 * @param maxChars - the cap on the whole text.
 * @returns the block, or `''` when the view has nothing to show.
 */
export function render(view: StateView, maxChars: number): string {
  const all = sections(view)
  if (all.length === 0) return ''
  const lines = [BLOCK_HEADER]
  let used = BLOCK_HEADER.length
  const fits = (line: string): boolean => used + 1 + line.length + TAIL_RESERVE <= maxChars
  const add = (line: string): void => {
    lines.push(line)
    used += 1 + line.length
  }
  const hidden: string[] = []
  for (const section of all) {
    if (!fits(section.heading)) {
      hidden.push(`${section.name} (${section.pointer})`)
      continue
    }
    add(section.heading)
    let shown = 0
    for (const line of section.items) {
      if (!fits(line)) break
      add(line)
      shown += 1
    }
    if (shown < section.items.length) add(`  … ${String(section.items.length - shown)} more (${section.pointer})`)
  }
  if (hidden.length > 0) lines.push(`Not shown: ${hidden.join(', ')}.`)
  return clip(lines.join('\n'), maxChars)
}
