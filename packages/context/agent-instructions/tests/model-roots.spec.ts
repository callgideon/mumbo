/** Instruction discovery beside a link the model planted out of its directories. */
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { findProjectRoot } from '../src/files.ts'

let base: string | undefined
afterEach(async () => {
  if (base !== undefined) await rm(base, { recursive: true, force: true })
  base = undefined
})

describe.runIf(process.platform === 'linux')('project root discovery under model roots', () => {
  it('treats a planted marker link out of the roots as absent instead of failing the lookup', async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'dsh-instructions-roots-')))
    const workspace = join(base, 'projects')
    await mkdir(join(workspace, 'app', 'src'), { recursive: true })
    await mkdir(join(base, 'secret'))
    await mkdir(join(workspace, '.git'))
    await symlink(join(base, 'secret'), join(workspace, 'app', '.git'))
    const ctx = new Context()
    try {
      await ctx.plugin(LocalFileSystem, { modelRoots: [workspace] })
      await expect(findProjectRoot(join(workspace, 'app', 'src'), ['.git'], ctx.fs)).resolves.toBe(workspace)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
