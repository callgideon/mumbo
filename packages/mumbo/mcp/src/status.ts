/** `task_status` and `task_result`: what the assistant is doing, and the diff a branch of its checkout makes. */

import type { Readable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-subagent'
import type { SubprocessCollectedOutputs } from '@deepseek-ai/dsh-subprocess'
import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { ToolError } from './errors.ts'
import { fence } from './fence.ts'
import { isHalted } from './halt.ts'
import { defineTool, type ToolDeps } from './tool.ts'

/** Projections `task_status` reports; the rest, such as the inbox, stay out. */
const PROJECTIONS: ReadonlySet<string> = new Set(['todos', 'goal', 'plan', 'subagentCatalog'])

/** Characters of diff text in one `task_result` page. */
const PAGE_CHARS = 65_536

/** Grace a git command gets to exit once its request ends. */
const GIT_GRACE_MS = 2_000

/** Tail of git's stderr kept for a failure message. */
const GIT_STDERR_BYTES = 4_096

/**
 * Options that keep git from running programs the checkout's own configuration names: agents can write its `.git`,
 * and these commands run on the host, outside any sandbox. Command-line configuration outranks every config file.
 */
const GIT_OPTIONS = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null']

/**
 * Clear inherited repository, attribute-tree, command-line configuration and replacement-ref selectors, as the
 * worktree service does, and turn off prompts and lazy fetches from a promisor remote.
 */
const GIT_ENV: NodeJS.ProcessEnv = {
  ...Object.fromEntries([
    'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT',
    'GIT_CEILING_DIRECTORIES', 'GIT_PREFIX', 'GIT_SHALLOW_FILE', 'GIT_GRAFT_FILE',
    'GIT_REPLACE_REF_BASE', 'GIT_ATTR_SOURCE',
  ].map(key => [key, undefined])),
  GIT_TERMINAL_PROMPT: '0',
  GIT_NO_LAZY_FETCH: '1',
}

const resultArgs = z.object({
  branch: z.string().regex(/^[A-Za-z0-9._/-]{1,100}$/)
    .refine(branch => !branch.includes('..') && !branch.startsWith('-'), 'branch must not contain .. or start with -')
    .describe('The branch to diff, such as mumbo/feature.'),
  page: z.number().int().min(0).default(0).describe('Page of the diff, from 0; the result says how many pages there are.'),
})

/** One direct child Session and its live status. */
export interface ChildStatus {
  readonly id: SessionId
  /** The child's label, written by a model and so fenced, when it has one. */
  readonly label: string | undefined
  /** `idle` or `running` while its Agent is loaded, else `unloaded`. */
  readonly status: 'idle' | 'running' | 'unloaded'
}

/**
 * The direct children of a Session from its subagent catalog, with each one's live Agent status.
 * @param ctx - context carrying `subagents` and `agents`.
 * @param sessionId - the parent Session.
 * @param signal - cancels the catalog read.
 * @returns the children in catalog order.
 * @throws the subagent service's error when the catalog cannot be read.
 */
export async function listChildren(ctx: Context, sessionId: SessionId, signal?: AbortSignal): Promise<ChildStatus[]> {
  const children = await ctx.subagents.listChildren(sessionId, signal)
  return children.map(child => ({
    id: child.id,
    label: child.label === undefined ? undefined : fence(child.label),
    status: ctx.agents.get(child.id)?.status ?? 'unloaded',
  }))
}

/** How one git run ended and what of its output was kept. */
interface GitRun {
  readonly exitCode: number
  /** Stdout characters in the kept range. */
  readonly text: string
  /** Characters of the whole stdout. */
  readonly length: number
}

/**
 * Run git in `cwd` without a shell and with {@link GIT_OPTIONS} and {@link GIT_ENV}, keeping the stdout
 * characters `[from, to)` and counting the rest.
 * @param ctx - context carrying `subprocess`.
 * @param cwd - the checkout.
 * @param args - git's arguments.
 * @param signal - ends the command.
 * @param options - exit codes that count as success (`[0]` by default) and the kept range (all by default).
 * @returns the exit code, the kept text, and the length of the whole output.
 * @throws when git is missing, or exits by a signal or with another code; the message carries git's stderr.
 */
async function git(
  ctx: Context,
  cwd: string,
  args: readonly string[],
  signal: AbortSignal,
  options: { ok?: readonly number[]; from?: number; to?: number } = {},
): Promise<GitRun> {
  const { ok = [0], from = 0, to = Infinity } = options
  const program = await ctx.subprocess.resolveExecutable('git', undefined, signal)
  const child = ctx.subprocess.spawn({
    argv: [program, ...GIT_OPTIONS, ...args],
    cwd,
    env: GIT_ENV,
    signal,
    graceMs: GIT_GRACE_MS,
    stdio: { stdin: 'ignore', stdout: 'pipe', stderr: { maxBytes: GIT_STDERR_BYTES } },
  })
  try {
    // The spawn spec above pipes stdout and collects stderr.
    const stdout = child.stdout as Readable
    stdout.setEncoding('utf8')
    let text = ''
    let length = 0
    for await (const chunk of stdout as AsyncIterable<string>) {
      text += chunk.slice(Math.max(0, from - length), Math.max(0, to - length))
      length += chunk.length
    }
    const outcome = await child.done
    if (outcome.exitCode === null || !ok.includes(outcome.exitCode)) {
      const stderr = (child.collected as Required<SubprocessCollectedOutputs>).stderr.readFrom(0).text.trim()
      throw new Error(`git ${String(args[0])} failed (${outcome.signal ?? outcome.exitCode}): ${stderr}`)
    }
    return { exitCode: outcome.exitCode, text, length }
  } finally {
    child.terminate()
    await child.waitForExit()
  }
}

/**
 * Register `task_status` and `task_result`.
 * @param server - the request's MCP server.
 * @param deps - plugin state and the assistant checkout.
 */
export function register(server: McpServer, deps: ToolDeps): void {
  defineTool(
    server,
    'task_status',
    'What the assistant is doing: its Session id, whether runs are halted, its todos, goal, plan and subagent catalog, '
    + 'its direct children with live status, and the git worktrees of its checkout.',
    z.object({}),
    async (_args, signal) => {
      const agent = await deps.assistant()
      const { values } = deps.ctx.sessionProjections.snapshot(agent.session)
      const worktrees = await git(deps.ctx, deps.assistantCwd, ['worktree', 'list', '--porcelain'], signal)
      return JSON.stringify({
        assistant_session: agent.id,
        halted: isHalted(deps.halt),
        projections: fence(JSON.stringify(Object.fromEntries(Object.entries(values).filter(([key]) => PROJECTIONS.has(key))))),
        children: await listChildren(deps.ctx, agent.id, signal),
        worktrees: fence(worktrees.text),
      })
    },
  )
  defineTool(
    server,
    'task_result',
    'The diff a branch of the assistant checkout makes since it forked from HEAD (git diff HEAD...branch), '
    + 'in pages of 65,536 characters.',
    resultArgs,
    async ({ branch, page }, signal) => {
      const found = await git(deps.ctx, deps.assistantCwd, ['rev-parse', '--verify', '--quiet', `${branch}^{commit}`], signal, { ok: [0, 1] })
      if (found.exitCode === 1) throw new ToolError('not_found', `no branch ${branch} in the assistant checkout`)
      const diff = await git(deps.ctx, deps.assistantCwd, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--submodule=short', `HEAD...${branch}`, '--'], signal, {
        from: page * PAGE_CHARS,
        to: (page + 1) * PAGE_CHARS,
      })
      const pages = Math.max(1, Math.ceil(diff.length / PAGE_CHARS))
      if (page >= pages) throw new ToolError('invalid', `page ${String(page)} is past the last page, ${String(pages - 1)}`)
      return JSON.stringify({ page, pages, diff: fence(diff.text) })
    },
  )
}
