/**
 * Mutations performed as the subprocess provider's run-as identity: with a run-as provider every
 * change runs in a helper process the provider starts, the kernel judges its paths, and its output
 * is decoded strictly. The tests are not root, so the run-as identity is this process's own.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { FsError, FsVersion } from '@deepseek-ai/dsh-fs'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { decodeOutput, failureOutput, performMutation } from '../src/child-mutations.ts'
import type { HelperOutput } from '../src/child-mutations.ts'
import { runMutationHelper } from '../src/mutation-helper.ts'

const linux = process.platform === 'linux' ? describe : describe.skip

let base: string
let ctx: Context

/** This process's identity, the only one a non-root test can run children as. */
function ownIdentity() {
  const line = readFileSync('/proc/self/status', 'utf8').split('\n').find(entry => entry.startsWith('Groups:')) as string
  const groups = line.slice('Groups:'.length).trim().split(/\s+/u).filter(id => id !== '').map(Number)
  return { uid: process.getuid!(), gid: process.getgid!(), groups }
}

async function mount(
  options: { runAs: boolean; modelRoots?: string[]; subprocess?: boolean },
): Promise<{ fs: LocalFileSystem; spawns: SubprocessSpawnSpec[] }> {
  ctx = new Context()
  const spawns: SubprocessSpawnSpec[] = []
  if (options.subprocess !== false) {
    await ctx.plugin(LocalSubprocessRuntime, options.runAs
      ? { runAs: { ...ownIdentity(), inherit: ['PATH'], set: { HOME: base }, secretNames: ['DEEPSEEK_API_KEY'] } }
      : {})
    const spawn = ctx.subprocess.spawn.bind(ctx.subprocess)
    vi.spyOn(ctx.subprocess, 'spawn').mockImplementation((spec) => { spawns.push(spec); return spawn(spec) })
  }
  await ctx.plugin(LocalFileSystem, { cwd: base, ...options.modelRoots === undefined ? {} : { modelRoots: options.modelRoots } })
  return { fs: ctx.fs as LocalFileSystem, spawns }
}

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'dsh-child-mutations-')))
})

afterEach(async () => {
  await ctx.fiber.dispose()
  vi.restoreAllMocks()
  await chmod(base, 0o700).catch(() => {})
  for (const entry of await readdir(base)) await chmod(join(base, entry), 0o700).catch(() => {})
  await rm(base, { recursive: true, force: true })
})

linux('mutations under a run-as subprocess provider', () => {
  it('performs every mutation in a helper the provider starts, with in-process results', async () => {
    const { fs, spawns } = await mount({ runAs: true, modelRoots: [base] })
    const file = await fs.resolveModelPath('notes.txt')
    const created = await fs.writeText(file, 'one\ntwo\n', { kind: 'createIfAbsent' })
    expect(created).toMatchObject({ operation: 'create', before: null, after: 'one\ntwo\n' })
    const edited = await fs.editText(file, { oldString: 'one', newString: 'uno', replaceAll: false }, { version: created.version })
    expect(edited).toMatchObject({ before: 'one\ntwo\n', after: 'uno\ntwo\n' })
    const patched = await fs.patchText(file, [{ lineNumber: 1, oldLines: ['two'], newLines: ['dos'], isEndOfFile: false }], { version: edited.version })
    expect(patched.after).toBe('uno\ndos\n')
    expect((await fs.patchText(file, [{ lineNumber: 1, oldLines: ['dos'], newLines: ['dos'], isEndOfFile: false }])).after).toBe('uno\ndos\n')
    await fs.makeDirectory(await fs.resolveModelPath('nested/deeper'))
    const moved = await fs.moveFile(file, await fs.resolveModelPath('nested/deeper/moved.txt'), {})
    expect(moved).toMatchObject({ sourceDeleted: true, destination: { operation: 'create', after: 'uno\ndos\n' } })
    const removed = await fs.deleteFile(await fs.resolveModelPath('nested/deeper/moved.txt'), { version: moved.destination.version })
    expect(removed.before).toBe('uno\ndos\n')
    await fs.writeText(await fs.resolveModelPath('spare.txt'), 'spare')
    expect((await fs.deleteFile(await fs.resolveModelPath('spare.txt'))).before).toBe('spare')
    expect(await readdir(join(base, 'nested', 'deeper'))).toEqual([])
    expect(spawns).toHaveLength(9)
    for (const spec of spawns) {
      expect(spec.argv.at(-1)).toMatch(/mutation-helper\.(ts|js)$/u)
      expect(spec.cwd).toBe('/')
    }
    expect(typeof created.version).toBe('string')
  })

  it('returns the helper\'s own filesystem refusals with their codes', async () => {
    const { fs } = await mount({ runAs: true, modelRoots: [base] })
    await writeFile(join(base, 'existing.txt'), 'kept')
    const target = await fs.resolveModelPath('existing.txt')
    await expect(fs.writeText(target, 'overwrite', { kind: 'createIfAbsent' }))
      .rejects.toEqual(new FsError(`cannot overwrite existing "${join(base, 'existing.txt')}" without reading it first`, 'FS_NOT_OBSERVED'))
    await expect(fs.editText(target, { oldString: 'absent', newString: 'x', replaceAll: false }))
      .rejects.toMatchObject({ code: 'FS_EDIT_NOT_FOUND' })
    expect(await readFile(join(base, 'existing.txt'), 'utf8')).toBe('kept')
  })

  it('lets the kernel refuse a change through a directory the run-as user cannot write', async () => {
    const { fs } = await mount({ runAs: true, modelRoots: [base] })
    await mkdir(join(base, 'locked'))
    await chmod(join(base, 'locked'), 0o555)
    await expect(fs.writeText(await fs.resolveModelPath('locked/new.txt'), 'x'))
      .rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED', message: `cannot write "${join(base, 'locked/new.txt')}": permission denied` })
    await expect(fs.makeDirectory(await fs.resolveModelPath('locked/sub')))
      .rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
    expect(await readdir(join(base, 'locked'))).toEqual([])
  })

  it('checks cancellation before starting the helper', async () => {
    const { fs, spawns } = await mount({ runAs: true })
    const controller = new AbortController()
    controller.abort()
    await expect(fs.writeText(await fs.resolve('x.txt'), 'x', undefined, controller.signal))
      .rejects.toEqual(new FsError('write aborted', 'FS_ABORTED'))
    expect(spawns).toHaveLength(0)
  })

  it('reports a helper that could not start or failed without output', async () => {
    const { fs } = await mount({ runAs: true })
    vi.spyOn(ctx.subprocess, 'spawn').mockImplementation(() => ({
      stdin: undefined, stdout: undefined, stderr: undefined, control: undefined,
      collected: { stdout: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) }, stderr: { readFrom: () => ({ text: 'boom', nextOffset: 4, lossy: false }) } },
      done: Promise.resolve({ exitCode: 127, signal: null }),
      terminate() {}, waitForExit: () => Promise.resolve(true),
    }))
    await expect(fs.writeText(await fs.resolve('x.txt'), 'x')).rejects.toEqual(new FsError('the file change helper failed (127): boom', 'FS_IO_ERROR'))
    vi.spyOn(ctx.subprocess, 'spawn').mockImplementation(() => ({
      stdin: undefined, stdout: undefined, stderr: undefined, control: undefined,
      collected: { stdout: { readFrom: () => ({ text: 'x'.repeat(10), nextOffset: 10, lossy: true }) }, stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) } },
      done: Promise.resolve({ exitCode: 0, signal: null }),
      terminate() {}, waitForExit: () => Promise.resolve(true),
    }))
    await expect(fs.writeText(await fs.resolve('x.txt'), 'x')).rejects.toEqual(
      new FsError('the file change helper produced more output than its limit; the change may or may not have been applied', 'FS_IO_ERROR'))
    vi.spyOn(ctx.subprocess, 'spawn').mockImplementation(() => ({
      stdin: undefined, stdout: undefined, stderr: undefined, control: undefined, collected: {},
      done: Promise.reject(new Error('run-as: could not take uid 1')),
      terminate() {}, waitForExit: () => Promise.resolve(true),
    }))
    await expect(fs.writeText(await fs.resolve('x.txt'), 'x'))
      .rejects.toEqual(new FsError('the file change helper could not run: run-as: could not take uid 1', 'FS_IO_ERROR'))
  })
})

describe('mutation routing without a run-as provider', () => {
  it('mutates in this process when the subprocess provider runs children as this process', async () => {
    const { fs, spawns } = await mount({ runAs: false })
    await fs.writeText(await fs.resolve('local.txt'), 'local')
    expect(spawns).toHaveLength(0)
    expect(await readFile(join(base, 'local.txt'), 'utf8')).toBe('local')
  })

  it('mutates in this process when no subprocess provider is mounted and no model roots are set', async () => {
    const { fs } = await mount({ runAs: false, subprocess: false })
    await fs.makeDirectory(await fs.resolve('made'))
    expect(await readdir(base)).toEqual(['made'])
  })

  it.runIf(process.platform === 'linux')('refuses every mutation with model roots while no subprocess provider is mounted', async () => {
    const { fs } = await mount({ runAs: false, subprocess: false, modelRoots: [base] })
    const target = await fs.resolveModelPath('x.txt')
    const refusal = (verb: string) => new FsError(`cannot ${verb}: no process provider is mounted to make the change as the run-as user`, 'FS_IO_ERROR')
    await expect(fs.writeText(target, 'x')).rejects.toEqual(refusal(`write "${target.displayPath}"`))
    await expect(fs.editText(target, { oldString: 'a', newString: 'b', replaceAll: false })).rejects.toEqual(refusal(`edit "${target.displayPath}"`))
    await expect(fs.patchText(target, [])).rejects.toEqual(refusal(`patch "${target.displayPath}"`))
    await expect(fs.deleteFile(target)).rejects.toEqual(refusal(`delete "${target.displayPath}"`))
    await expect(fs.moveFile(target, await fs.resolveModelPath('y.txt'), {})).rejects.toEqual(refusal(`move "${target.displayPath}"`))
    await expect(fs.makeDirectory(await fs.resolveModelPath('d'))).rejects.toEqual(refusal(`create directory "${join(base, 'd')}"`))
    expect(await readdir(base)).toEqual([])
  })
})

/** Decode the helper's stdout. */
const output = (text: string): HelperOutput => JSON.parse(text) as HelperOutput

describe('change helper protocol', () => {
  it('runs one encoded request and encodes its outcome or failure', async () => {
    const path = join(base, 'helper.txt')
    const target = { targetKey: path, displayPath: path }
    const written = output(await runMutationHelper(JSON.stringify({ op: 'write', target, content: 'hi', diffBasisMaxBytes: 1024 })))
    expect(written).toMatchObject({ ok: true, value: { operation: 'create', after: 'hi' } })
    expect(output(await runMutationHelper(JSON.stringify({ op: 'mkdir', target: { targetKey: join(base, 'd'), displayPath: join(base, 'd') }, diffBasisMaxBytes: 1024 }))))
      .toEqual({ ok: true, value: null })
    expect(output(await runMutationHelper(JSON.stringify({ op: 'delete', target: { targetKey: join(base, 'missing'), displayPath: 'missing' }, diffBasisMaxBytes: 1024 }))))
      .toEqual({ ok: false, error: { message: 'cannot delete "missing": file changed since it was read', code: 'FS_STALE_VERSION' } })
    for (const malformed of ['not json', 'null', '{"op":"chmod","diffBasisMaxBytes":1}', '{"op":"write","diffBasisMaxBytes":0}']) {
      expect(output(await runMutationHelper(malformed)).ok).toBe(false)
    }
    expect(output(await runMutationHelper('{"op":"chmod","diffBasisMaxBytes":1}'))).toEqual({ ok: false, error: { message: 'the file change helper received a malformed request' } })
    expect(failureOutput('plain')).toEqual({ ok: false, error: { message: 'plain' } })
  })

  it('performs each request kind through the given provider', async () => {
    const calls: string[] = []
    const fake = new Proxy({}, { get: (_target, name: string) => (...args: unknown[]) => { calls.push(`${name}:${args.length}`); return Promise.resolve('done') } })
    const target = { targetKey: 'k', displayPath: 'd' } as never
    for (const request of [
      { op: 'write', target, content: 'c' }, { op: 'edit', target, edit: { oldString: 'a', newString: 'b', replaceAll: false } },
      { op: 'patch', target, hunks: [] }, { op: 'delete', target }, { op: 'move', source: target, destination: target, options: {} }, { op: 'mkdir', target },
    ] as const) await performMutation(fake as never, request)
    expect(calls).toEqual(['writeText:3', 'editText:3', 'patchText:3', 'deleteFile:2', 'moveFile:3', 'makeDirectory:1'])
  })

  it('decodes only well-formed outcomes of the requested kind', () => {
    const write = { operation: 'update', version: 'v', before: null, after: 'a' }
    expect(decodeOutput('write', JSON.stringify({ ok: true, value: write }))).toEqual({ ...write, version: FsVersion('v') })
    expect(decodeOutput('edit', JSON.stringify({ ok: true, value: { version: 'v', before: 'a', after: 'b' } }))).toMatchObject({ after: 'b' })
    expect(decodeOutput('delete', JSON.stringify({ ok: true, value: { before: null } }))).toEqual({ before: null })
    expect(decodeOutput('mkdir', JSON.stringify({ ok: true, value: null }))).toBeNull()
    const moved = { sourceBefore: 'a', destination: write, sourceDeleted: false, sourceFailure: { code: 'FS_IO_ERROR', message: 'kept' } }
    expect(decodeOutput('move', JSON.stringify({ ok: true, value: moved }))).toMatchObject({ destination: { version: FsVersion('v') }, sourceDeleted: false })
    expect(decodeOutput('move', JSON.stringify({ ok: true, value: { ...moved, sourceDeleted: true } }))).toMatchObject({ sourceDeleted: true })
    const malformed = new FsError('the file change helper returned a malformed result; the change may or may not have been applied', 'FS_IO_ERROR')
    for (const [op, text] of [
      ['write', 'not json'], ['write', '[]'], ['write', JSON.stringify({ ok: true, value: { ...write, operation: 'replace' } })],
      ['write', JSON.stringify({ ok: true, value: { version: 'v', before: 'a', after: 'b' } })],
      ['edit', JSON.stringify({ ok: true, value: write })], ['delete', JSON.stringify({ ok: true, value: {} })],
      ['mkdir', JSON.stringify({ ok: true, value: {} })], ['move', JSON.stringify({ ok: true, value: { ...moved, sourceFailure: { code: 'NOPE', message: 'x' } } })],
      ['move', JSON.stringify({ ok: true, value: { ...moved, destination: {} } })], ['write', JSON.stringify({ ok: 'yes' })],
    ] as const) expect(() => decodeOutput(op, text), text).toThrow(malformed)
    expect(() => decodeOutput('write', JSON.stringify({ ok: false, error: { message: 'stale', code: 'FS_STALE_VERSION' } })))
      .toThrow(new FsError('stale', 'FS_STALE_VERSION'))
    expect(() => decodeOutput('write', JSON.stringify({ ok: false, error: { message: 'odd', code: 'EWHATEVER' } })))
      .toThrow(new FsError('odd', 'FS_IO_ERROR'))
  })
})
