import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as McpDoor from '../src/index.ts'
import { call, type Host, startHost, stopHosts, unfence } from './door-fixture.ts'

// Git in the tests and in the plugin reads no user or system configuration.
beforeEach(() => {
  vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null')
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
})
afterEach(async () => {
  await stopHosts()
  vi.unstubAllEnvs()
})

/** Run git in `cwd` as a fixed author and return its stdout. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'ann', GIT_AUTHOR_EMAIL: 'ann@example.com', GIT_COMMITTER_NAME: 'ann', GIT_COMMITTER_EMAIL: 'ann@example.com' },
  })
}

/** A host with the plugin loaded on a git checkout of `main` whose `feature` branch adds a file of about 70 KiB. */
async function door(): Promise<{ host: Host; repo: string }> {
  const host = await startHost()
  const repo = join(host.root, 'repo')
  await mkdir(repo)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'base')
  git(repo, 'switch', '-q', '-c', 'feature')
  await writeFile(join(repo, 'big.txt'), 'line of text\n'.repeat(5_200))
  git(repo, 'add', 'big.txt')
  git(repo, 'commit', '-q', '-m', 'big')
  git(repo, 'switch', '-q', 'main')
  await host.ctx.plugin(McpDoor, { ...host.config, assistantCwd: repo })
  return { host, repo }
}

describe('task_status', () => {
  it('reports the assistant Session, the halt flag, its projections and worktrees fenced, and its children with live status', async () => {
    const { host, repo } = await door()
    await call(host.url, 'task_status', {})
    host.children.set('s1', [
      { id: 'c1', createdAt: 1, mode: 'continuable', label: 'build' },
      { id: 'c2', createdAt: 2, mode: 'one-shot' },
      { id: 'c3', createdAt: 3, mode: 'one-shot', label: 'lint' },
    ])
    host.addAgent('c1').status = 'running'
    host.addAgent('c3')
    Object.assign(host.projections, { todos: [{ text: 'ship' }], goal: null, plan: { active: false }, subagentCatalog: [], inbox: ['private'] })

    const reply = await call(host.url, 'task_status', {})
    expect(reply.isError).toBe(false)
    const value = reply.value as { projections: string; worktrees: string }
    expect(value).toEqual({
      assistant_session: 's1',
      halted: false,
      projections: expect.any(String) as string,
      children: [
        { id: 'c1', label: 'build', status: 'running' },
        { id: 'c2', status: 'unloaded' },
        { id: 'c3', label: 'lint', status: 'idle' },
      ],
      worktrees: expect.any(String) as string,
    })
    expect(JSON.parse(unfence(value.projections))).toEqual({ todos: [{ text: 'ship' }], goal: null, plan: { active: false }, subagentCatalog: [] })
    expect(unfence(value.worktrees)).toBe(git(repo, 'worktree', 'list', '--porcelain'))
  })

  it('reports a git failure as a tool error', async () => {
    const host = await startHost()
    // The temp root is no git checkout.
    await host.ctx.plugin(McpDoor, host.config)
    const reply = await call(host.url, 'task_status', {})
    expect(reply.isError).toBe(true)
    expect(reply.value).toEqual(expect.stringMatching(/^git worktree failed \(128\): fatal: not a git repository/))
  })
})

describe('task_result', () => {
  it('pages the diff a branch makes since it forked from HEAD in fenced 64 KiB pages', async () => {
    const { host, repo } = await door()
    const first = await call(host.url, 'task_result', { branch: 'feature' })
    const second = await call(host.url, 'task_result', { branch: 'feature', page: 1 })
    const pages = [first.value, second.value] as { page: number; pages: number; diff: string }[]
    expect(pages.map(({ page, pages: count }) => ({ page, pages: count }))).toEqual([{ page: 0, pages: 2 }, { page: 1, pages: 2 }])
    const [head, tail] = pages.map(({ diff }) => unfence(diff))
    expect(head).toHaveLength(65_536)
    expect(`${head ?? ''}${tail ?? ''}`).toBe(git(repo, 'diff', 'HEAD...feature'))
  })

  it('returns one empty page for a branch with no changes since it forked', async () => {
    const { host } = await door()
    const reply = await call(host.url, 'task_result', { branch: 'main' })
    expect(reply.value).toEqual({ page: 0, pages: 1, diff: expect.any(String) as string })
    expect(unfence((reply.value as { diff: string }).diff)).toBe('')
  })

  it('answers an unknown branch with code not_found', async () => {
    const { host } = await door()
    expect(await call(host.url, 'task_result', { branch: 'missing' })).toMatchObject({ isError: true, value: { code: 'not_found' } })
  })

  it.each([
    ['a branch climbing out with ..', { branch: '../x' }],
    ['a branch holding ..', { branch: 'a..b' }],
    ['a branch read as an option', { branch: '-p' }],
    ['a branch with a space', { branch: 'a b' }],
    ['a branch over 100 characters', { branch: 'b'.repeat(101) }],
    ['a negative page', { branch: 'feature', page: -1 }],
    ['a fractional page', { branch: 'feature', page: 0.5 }],
    ['a page past the last', { branch: 'feature', page: 2 }],
  ])('answers %s with code invalid', async (_label, args) => {
    const { host } = await door()
    expect(await call(host.url, 'task_result', args)).toMatchObject({ isError: true, value: { code: 'invalid' } })
  })
})
