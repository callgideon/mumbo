/**
 * The model-facing file tools under configured model roots, through the tool executor and the
 * real local provider: inside the roots the tools work, outside them each tool returns the
 * pinned refusal and the file on disk is untouched.
 */
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'

let base: string
let workspace: string
let outside: string
let ctx: Context
let fiber: Awaited<ReturnType<Context['plugin']>>
const session = { header: { get cwd() { return workspace } } }

let callCounter = 0
function call(name: string, args: unknown) {
  return executeToolFixture(ctx, {
    signal: new AbortController().signal,
    callId: ToolCallId(`roots-${++callCounter}`),
    name,
    arguments: args,
    agent: { session } as never,
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

/** The exact refusal the model reads for a path outside its roots. */
function refusal(path: string): string {
  return `Error: cannot access "${path}": its real path is outside the directories you can access (${workspace})`
}

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'dsh-tool-fs-roots-')))
  workspace = join(base, 'projects')
  outside = join(base, 'secret')
  await mkdir(workspace)
  await mkdir(outside)
  await writeFile(join(outside, 'key'), 'secret')
  await writeFile(join(workspace, 'notes.txt'), 'inside\n')
  ctx = new Context()
  provideWorkingDirectoryFixture(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(LocalFileSystem, { cwd: workspace, modelRoots: [workspace] })
  // read_image resolves through the same shared read-target step as read.
  fiber = await ctx.plugin(ToolFs, { applyPatch: true })
})

afterEach(async () => {
  await fiber.dispose()
  await rm(base, { recursive: true, force: true })
})

describe('model file tools under model roots', () => {
  it('read, write, edit, and apply_patch work inside the roots', async () => {
    expect(text(await call('read', { file_path: 'notes.txt' }))).toContain('inside')
    expect((await call('write', { file_path: 'made.txt', content: 'one\n' })).isError).toBe(false)
    expect((await call('edit', { file_path: 'made.txt', old_string: 'one', new_string: 'two' })).isError).toBe(false)
    expect((await call('apply_patch', { input: '*** Begin Patch\n*** Add File: patched.txt\n+three\n*** End Patch' })).isError).toBe(false)
    expect(await readFile(join(workspace, 'made.txt'), 'utf8')).toBe('two\n')
    expect(await readFile(join(workspace, 'patched.txt'), 'utf8')).toBe('three\n')
  })

  it.each([
    ['an absolute path', () => join(outside, 'key'), () => join(outside, 'key')],
    ['a dot-dot path', () => '../secret/key', () => `${workspace}/../secret/key`],
    ['the harness environment', () => '/proc/self/environ', () => '/proc/self/environ'],
    ['the init environment', () => '/proc/1/environ', () => '/proc/1/environ'],
  ])('read refuses %s', async (_case, path, shown) => {
    const result = await call('read', { file_path: path() })
    expect(result).toMatchObject({ isError: true, error: { info: { code: 'FS_OUTSIDE_ROOTS' } } })
    expect(text(result)).toBe(refusal(shown()))
  })

  it('every tool refuses a symbolic link out of the roots and leaves its target untouched', async () => {
    await symlink(join(outside, 'key'), join(workspace, 'file-link'))
    await symlink(outside, join(workspace, 'dir-link'))
    const shown = (path: string): string => refusal(join(workspace, path))
    expect(text(await call('read', { file_path: 'file-link' }))).toBe(shown('file-link'))
    expect(text(await call('read', { file_path: 'dir-link/key' }))).toBe(shown('dir-link/key'))
    expect(text(await call('write', { file_path: 'dir-link/key', content: 'overwritten' }))).toBe(shown('dir-link/key'))
    expect(text(await call('write', { file_path: 'dir-link/new/planted.txt', content: 'planted' }))).toBe(shown('dir-link/new/planted.txt'))
    expect(text(await call('edit', { file_path: 'file-link', old_string: 'secret', new_string: 'edited' }))).toBe(shown('file-link'))
    const patched = text(await call('apply_patch', { input: '*** Begin Patch\n*** Update File: dir-link/key\n@@\n-secret\n+patched\n*** End Patch' }))
    expect(patched).toContain(shown('dir-link/key').replace(/^Error: /u, ''))
    expect(await readFile(join(outside, 'key'), 'utf8')).toBe('secret')
    await expect(readFile(join(outside, 'new', 'planted.txt'))).rejects.toThrow()
  })

  it('every mutating tool refuses an absolute path outside the roots and leaves it untouched', async () => {
    const key = join(outside, 'key')
    expect(text(await call('write', { file_path: key, content: 'overwritten' }))).toBe(refusal(key))
    expect(text(await call('write', { file_path: join(outside, 'planted.txt'), content: 'planted' }))).toBe(refusal(join(outside, 'planted.txt')))
    expect(text(await call('edit', { file_path: key, old_string: 'secret', new_string: 'edited' }))).toBe(refusal(key))
    const patched = text(await call('apply_patch', { input: `*** Begin Patch\n*** Update File: ${key}\n@@\n-secret\n+patched\n*** End Patch` }))
    expect(patched).toContain(refusal(key).replace(/^Error: /u, ''))
    expect(await readFile(key, 'utf8')).toBe('secret')
    await expect(readFile(join(outside, 'planted.txt'))).rejects.toThrow()
  })
})
