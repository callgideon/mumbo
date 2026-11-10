/**
 * Model roots through the `ctx.fs` operations that enforce them: `resolveModelPath` confines
 * model-supplied paths to the roots by real path, and every resolution refuses a path under a
 * root that leaves the roots through a symbolic link.
 */

import { execFileSync, spawn } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { FsError } from '@deepseek-ai/dsh-fs'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'

let base: string
let workspace: string
let scratch: string
let outside: string
let ctx: Context
let fiber: Awaited<ReturnType<Context['plugin']>> | undefined

function refusal(path: string): FsError {
  return new FsError(
    `cannot access "${path}": its real path is outside the directories you can access (${workspace}, ${scratch})`,
    'FS_OUTSIDE_ROOTS',
  )
}

async function rejection(promise: Promise<unknown>): Promise<FsError> {
  const error = await promise.then(() => undefined, (failure: unknown) => failure)
  expect(error).toBeInstanceOf(FsError)
  return error as FsError
}

async function mount(config: Record<string, unknown>): Promise<LocalFileSystem> {
  await fiber?.dispose()
  // With model roots, mutations need a subprocess provider; this one runs children as this process.
  if (ctx.get('subprocess') === undefined) await ctx.plugin(LocalSubprocessRuntime)
  fiber = await ctx.plugin(LocalFileSystem, config)
  return ctx.fs as LocalFileSystem
}

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'dsh-model-roots-')))
  workspace = join(base, 'projects')
  scratch = join(base, 'scratch')
  outside = join(base, 'secret')
  for (const directory of [workspace, scratch, outside]) await mkdir(directory)
  await writeFile(join(outside, 'key'), 'secret')
  await writeFile(join(workspace, 'notes.txt'), 'inside')
  ctx = new Context()
})

afterEach(async () => {
  await fiber?.dispose()
  fiber = undefined
  await rm(base, { recursive: true, force: true })
})

describe.runIf(process.platform === 'linux')('model roots configuration', () => {
  it.each([
    [[], 'fs-local: modelRoots must list at least one directory; omit it to leave model paths unrestricted'],
    [['relative/root'], 'fs-local: modelRoots entry "relative/root" must be an absolute path'],
  ])('fails the provider at load for %j', async (modelRoots, message) => {
    await expect(ctx.plugin(LocalFileSystem, { modelRoots })).rejects.toThrow(message)
    expect(ctx.get('fs')).toBeUndefined()
  })

  it('fails the provider at load for a missing or non-directory root', async () => {
    await expect(ctx.plugin(LocalFileSystem, { modelRoots: [join(base, 'missing')] }))
      .rejects.toThrow(`fs-local: modelRoots entry ${JSON.stringify(join(base, 'missing'))} must be an existing directory: `)
    await expect(ctx.plugin(LocalFileSystem, { modelRoots: [join(outside, 'key')] }))
      .rejects.toThrow(`fs-local: modelRoots entry ${JSON.stringify(join(outside, 'key'))} must be an existing directory`)
  })

  it('leaves every path unrestricted when no roots are configured', async () => {
    const fs = await mount({ cwd: workspace })
    await symlink(outside, join(workspace, 'escape'))
    expect((await fs.resolveModelPath('/proc/self/environ')).displayPath).toBe('/proc/self/environ')
    expect(await fs.readText(await fs.resolveModelPath('escape/key'))).toBe('secret')
  })
})

describe.runIf(process.platform === 'linux')('model paths under roots', () => {
  let fs: LocalFileSystem
  beforeEach(async () => {
    fs = await mount({ cwd: workspace, modelRoots: [workspace, scratch] })
  })

  it('reads, writes, edits, and lists inside the roots by relative and absolute path', async () => {
    expect(await fs.readText(await fs.resolveModelPath('notes.txt'))).toBe('inside')
    await fs.writeText(await fs.resolveModelPath(join(scratch, 'new', 'file.txt')), 'created')
    await fs.makeDirectory(await fs.resolveModelPath(join(scratch, 'new')))
    await fs.writeText(await fs.resolveModelPath(join(scratch, 'new', 'file.txt')), 'created')
    await fs.editText(await fs.resolveModelPath(join(scratch, 'new', 'file.txt')), { oldString: 'created', newString: 'edited', replaceAll: false })
    expect(await fs.readText(await fs.resolveModelPath(join(scratch, 'new', 'file.txt')))).toBe('edited')
    expect((await fs.listDir(await fs.resolveModelPath(workspace))).map(entry => entry.name)).toEqual(['notes.txt'])
    expect((await fs.resolveModelPath(scratch)).displayPath).toBe(scratch)
  })

  it('follows a symbolic link that stays inside the roots', async () => {
    await symlink(join(workspace, 'notes.txt'), join(scratch, 'alias'))
    expect(await fs.readText(await fs.resolveModelPath(join(scratch, 'alias')))).toBe('inside')
  })

  it.each([
    ['an absolute path outside', () => join(outside, 'key')],
    ['a dot-dot path', () => '../secret/key'],
    ['the process environment', () => '/proc/self/environ'],
    ['another process environment', () => '/proc/1/environ'],
    ['the filesystem root', () => '/'],
  ])('refuses %s', async (_case, path) => {
    const requested = path()
    const error = await rejection(fs.resolveModelPath(requested))
    // The refusal names the path as the model wrote it, resolved against the cwd but not normalized.
    expect(error).toEqual(refusal(requested.startsWith('/') ? requested : `${workspace}/${requested}`))
    expect(error.code).toBe('FS_OUTSIDE_ROOTS')
  })

  it('refuses a file symbolic link and a directory symbolic link that lead out, for every caller', async () => {
    await symlink(join(outside, 'key'), join(workspace, 'file-link'))
    await symlink(outside, join(workspace, 'dir-link'))
    for (const requested of ['file-link', 'dir-link', 'dir-link/key']) {
      expect(await rejection(fs.resolveModelPath(requested))).toEqual(refusal(join(workspace, requested)))
      // A harness reader of a model-writable directory, such as instruction or skill discovery, is refused too.
      expect(await rejection(fs.resolve(join(workspace, requested)))).toEqual(refusal(join(workspace, requested)))
    }
  })

  it('refuses a write target that does not exist yet under a symbolically linked parent', async () => {
    await symlink(outside, join(scratch, 'parent'))
    const requested = join(scratch, 'parent', 'missing', 'new.txt')
    expect(await rejection(fs.resolveModelPath(requested))).toEqual(refusal(requested))
  })

  it('refuses a link planted after an earlier resolution once the path is resolved again', async () => {
    await mkdir(join(workspace, 'swapped'))
    await writeFile(join(workspace, 'swapped', 'key'), 'harmless')
    expect(await fs.readText(await fs.resolveModelPath('swapped/key'))).toBe('harmless')
    await rm(join(workspace, 'swapped'), { recursive: true })
    await symlink(outside, join(workspace, 'swapped'))
    expect(await rejection(fs.resolveModelPath('swapped/key'))).toEqual(refusal(join(workspace, 'swapped/key')))
  })

  it('still lets harness callers resolve paths outside the roots that no root contains', async () => {
    expect(await fs.readText(await fs.resolve(join(outside, 'key')))).toBe('secret')
  })

  it('accepts a root configured through a symbolic link by both its spellings', async () => {
    await symlink(workspace, join(base, 'projects-link'))
    const linked = await mount({ cwd: workspace, modelRoots: [join(base, 'projects-link')] })
    expect(await linked.readText(await linked.resolveModelPath(join(base, 'projects-link', 'notes.txt')))).toBe('inside')
    expect(await linked.readText(await linked.resolveModelPath(join(workspace, 'notes.txt')))).toBe('inside')
    await expect(linked.resolveModelPath(join(outside, 'key'))).rejects.toThrow(
      `its real path is outside the directories you can access (${join(base, 'projects-link')})`,
    )
  })
})

/**
 * Start a process that keeps flipping `<workspace>/swapped` between a real directory holding a
 * harmless `key` and a symbolic link to the secret directory.
 * @returns a stopper that ends the flipping and waits for the process to exit.
 */
function flipper(directory: string, secretDirectory: string): () => Promise<void> {
  const script = [
    "const fs = require('node:fs'); const path = require('node:path')",
    'const [dir, secret] = process.argv.slice(1)',
    "const target = path.join(dir, 'swapped'), real = path.join(dir, 'real'), link = path.join(dir, 'link')",
    "fs.mkdirSync(real); fs.writeFileSync(path.join(real, 'key'), 'harmless'); fs.symlinkSync(secret, link)",
    'for (;;) { try { fs.renameSync(real, target); fs.renameSync(target, real); fs.renameSync(link, target); fs.renameSync(target, link) } catch {} }',
  ].join('\n')
  const child = spawn(process.execPath, ['-e', script, directory, secretDirectory], { stdio: 'ignore' })
  return () => new Promise((resolve) => { child.once('exit', () => { resolve() }); child.kill('SIGKILL') })
}

describe.runIf(process.platform === 'linux')('reads through an accepted descriptor', () => {
  it('reports a target that vanished, a non-file, a FIFO, and a non-directory listing without blocking', async () => {
    const fs = await mount({ cwd: workspace, modelRoots: [workspace, scratch] })
    const gone = await fs.resolveModelPath('notes.txt')
    await rm(join(workspace, 'notes.txt'))
    await expect(fs.readText(gone)).rejects.toEqual(new FsError(`cannot read "${join(workspace, 'notes.txt')}": not found`, 'FS_NOT_FOUND'))
    await expect(fs.readText(await fs.resolveModelPath(scratch))).rejects.toEqual(new FsError(`cannot read "${scratch}": not a regular file`, 'FS_NOT_REGULAR_FILE'))
    execFileSync('mkfifo', [join(workspace, 'pipe')])
    await expect(fs.readText(await fs.resolveModelPath('pipe'))).rejects.toMatchObject({ code: 'FS_NOT_REGULAR_FILE' })
    await writeFile(join(workspace, 'plain'), 'x')
    await expect(fs.listDir(await fs.resolveModelPath('plain'))).rejects.toEqual(new FsError(`cannot list "${join(workspace, 'plain')}": not a directory`, 'FS_NOT_DIRECTORY'))
    await expect(fs.readByteRange(await fs.resolveModelPath('plain'), { offset: 0, length: 0 })).resolves.toEqual(new Uint8Array(0))
    await expect(fs.readBytes(await fs.resolveModelPath('plain'), undefined, 0)).rejects.toMatchObject({ code: 'FS_TOO_LARGE' })
    await chmod(join(workspace, 'plain'), 0o000)
    await expect(fs.readText(await fs.resolveModelPath('plain'))).rejects.toMatchObject({ code: 'EACCES' })
  })

  it('refuses a descriptor that names a different file inside the roots', async () => {
    const fs = await mount({ cwd: workspace, modelRoots: [workspace, scratch] })
    await mkdir(join(workspace, 'a'))
    await writeFile(join(workspace, 'a', 'f'), 'first')
    await mkdir(join(scratch, 'b'))
    await writeFile(join(scratch, 'b', 'f'), 'second')
    const target = await fs.resolveModelPath('a/f')
    await rm(join(workspace, 'a'), { recursive: true })
    await symlink(join(scratch, 'b'), join(workspace, 'a'))
    await expect(fs.readText(target)).rejects.toEqual(new FsError(`cannot read "${join(workspace, 'a/f')}": the path changed while it was being opened`, 'FS_STALE_VERSION'))
  })

  it('refuses model roots on a host without descriptor paths', async () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    try {
      await expect(ctx.plugin(LocalFileSystem, { modelRoots: [workspace] })).rejects.toThrow('fs-local: modelRoots requires Linux; this host is darwin')
    } finally {
      platform.mockRestore()
    }
  })
})

describe.runIf(process.platform === 'linux')('model roots against a racing link swap', () => {
  it('never reads or lists the secret through a link swapped in after resolution', async () => {
    const fs = await mount({ cwd: workspace, modelRoots: [workspace, scratch] })
    await writeFile(join(outside, 'key'), 'secret')
    const stop = flipper(workspace, outside)
    let reads = 0
    try {
      const deadline = Date.now() + 4_000
      while (Date.now() < deadline) {
        let target
        try {
          target = await fs.resolveModelPath('swapped/key')
        } catch (_refusedOrMissing) {
          // The link was in place or the name was absent at resolution; nothing was read.
          continue
        }
        for (const read of [
          () => fs.readText(target),
          async () => Buffer.from(await fs.readBytes(target, undefined, 100)).toString('utf8'),
          async () => Buffer.from(await fs.readByteRange(target, { offset: 0, length: 100 })).toString('utf8'),
          async () => { let text = ''; for await (const chunk of await fs.streamText(target)) text += chunk; return text },
          async () => (await fs.listDir(await fs.resolveModelPath('swapped'))).map(entry => entry.name).join(','),
        ]) {
          const text = await read().catch(() => '')
          expect(text).not.toContain('secret')
          reads += 1
        }
      }
    } finally {
      await stop()
    }
    expect(reads).toBeGreaterThan(50)
  })
})
