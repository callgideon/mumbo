/**
 * The model path walk when a name changes between being examined and being entered, as a racing shell makes it, and
 * when the kernel refuses a step for another reason. The failures are injected, so each case is deterministic.
 */
import * as promises from 'node:fs/promises'
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))

let base: string
let workspace: string
let ctx: Context

const failure = (code: string) => Object.assign(new Error(code), { code })
const { open: openFile } = promises

/** Make the walk's opens of a name within a held directory fail with `code`, `times` times. */
function failOpens(code: string, times = Infinity) {
  let left = times
  return vi.spyOn(promises, 'open').mockImplementation(async (path, ...rest) => {
    if (String(path).startsWith('/proc/self/fd/') && left-- > 0) throw failure(code)
    return openFile(path, ...rest)
  })
}

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'dsh-model-walk-')))
  workspace = join(base, 'projects')
  await mkdir(join(workspace, 'directory'), { recursive: true })
  await symlink(join(workspace, 'directory'), join(workspace, 'link'))
  ctx = new Context()
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalFileSystem, { cwd: workspace, modelRoots: [workspace] })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await ctx.fiber.dispose()
  await rm(base, { recursive: true, force: true })
})

describe.runIf(process.platform === 'linux')('the model path walk', () => {
  it('examines a link again that changed before it was read, and a directory that changed before it was entered', async () => {
    const readlink = vi.spyOn(promises, 'readlink').mockRejectedValueOnce(failure('EINVAL'))
    const open = failOpens('ENOTDIR', 1)
    const fs = ctx.fs as LocalFileSystem
    expect(String((await fs.resolveModelPath('link/x')).targetKey)).toBe(join(workspace, 'directory', 'x'))
    expect(String((await fs.resolveModelPath('directory/y')).targetKey)).toBe(join(workspace, 'directory', 'y'))
    // Each refused step was taken again, once.
    expect(readlink.mock.calls).toHaveLength(2)
    expect(open.mock.settledResults.filter(result => result.type === 'rejected')).toHaveLength(1)
  })

  it('gives up on a name that keeps changing, and reports a step the kernel refuses for another reason as it is', async () => {
    const fs = ctx.fs as LocalFileSystem
    vi.spyOn(promises, 'readlink').mockRejectedValue(failure('ENOENT'))
    await expect(fs.resolveModelPath('link/x')).rejects.toMatchObject({ code: 'FS_NOT_FOUND', message: expect.stringContaining('it kept changing while it was resolved') })
    vi.spyOn(promises, 'readlink').mockRejectedValue(failure('EIO'))
    await expect(fs.resolveModelPath('link/x')).rejects.toMatchObject({ code: 'EIO' })
    failOpens('EMFILE')
    await expect(fs.resolveModelPath('directory/y')).rejects.toMatchObject({ code: 'EMFILE' })
  })
})
