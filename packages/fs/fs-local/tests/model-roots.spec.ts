/**
 * Model roots through the `ctx.fs` operations that enforce them: `resolveModelPath` confines
 * model-supplied paths to the roots by real path, and every resolution refuses a path under a
 * root that leaves the roots through a symbolic link.
 */

import { execFileSync, spawn } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmod, link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
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

  it('gives one refusal for names behind a link out of the roots, whether they exist, are missing, or are files', async () => {
    await mkdir(join(outside, 'directory'))
    await symlink(outside, join(workspace, 'link'))
    for (const requested of ['link/key/x', 'link/missing/x', 'link/directory/x', 'link/key/..', 'link/directory/..', 'link/missing/..']) {
      expect(await rejection(fs.resolveModelPath(requested))).toEqual(refusal(`${workspace}/${requested}`))
    }
    // Inside the roots the real failure stays.
    await mkdir(join(workspace, 'real'))
    expect((await rejection(fs.resolveModelPath('notes.txt/x'))).code).toBe('FS_NOT_FOUND')
    expect((await rejection(fs.resolveModelPath('real/missing/..'))).code).toBe('FS_NOT_FOUND')
  })

  it('gives the same refusal to a path that leaves the roots and returns with "..", whether the outside name exists or not', async () => {
    await mkdir(join(outside, 'directory', 'deep'), { recursive: true })
    await symlink(outside, join(workspace, 'link'))
    for (const requested of [
      'link/directory/../../projects/notes.txt', 'link/missing/../../projects/notes.txt', 'link/key/../../projects/notes.txt',
      'link/directory/deep/../../../projects/notes.txt', 'link/directory/nodeep/../../../projects/notes.txt',
      `${outside}/directory/../../projects/notes.txt`, `${outside}/missing/../../projects/notes.txt`,
    ]) {
      const written = requested.startsWith('/') ? requested : `${workspace}/${requested}`
      expect(await rejection(fs.resolveModelPath(requested)), requested).toEqual(refusal(written))
    }
    // ".." inside the roots keeps its physical meaning, through a link that stays inside too.
    await mkdir(join(workspace, 'real', 'inner'), { recursive: true })
    await writeFile(join(workspace, 'real', 'beside.txt'), 'beside')
    await symlink(join(workspace, 'real', 'inner'), join(workspace, 'inner-link'))
    expect(await fs.readText(await fs.resolveModelPath('real/inner/../../notes.txt'))).toBe('inside')
    expect(await fs.readText(await fs.resolveModelPath('inner-link/../beside.txt'))).toBe('beside')
    // So does ".." from a directory on the way to a root, which tells nothing about what lies outside.
    expect(await fs.readText(await fs.resolveModelPath(`/..${workspace}/notes.txt`))).toBe('inside')
  })

  it('gives a final link out of the roots the same refusal whether its target exists or not, and follows one inside', async () => {
    await symlink(join(outside, 'key'), join(workspace, 'present'))
    await symlink(join(outside, 'nokey'), join(workspace, 'dangling'))
    for (const name of ['present', 'dangling']) expect(await rejection(fs.resolveModelPath(name)), name).toEqual(refusal(join(workspace, name)))
    // A dangling link inside the roots leads to the file a write through it creates.
    await symlink(join(workspace, 'later.txt'), join(workspace, 'pending'))
    expect(await fs.resolveModelPath('pending')).toEqual({ targetKey: join(workspace, 'later.txt'), displayPath: join(workspace, 'pending') })
    // A relative link resolves from its own directory; a loop and a directory the process cannot search fail as the kernel's lookup would.
    await mkdir(join(workspace, 'sub'))
    await symlink('../notes.txt', join(workspace, 'sub', 'relative'))
    expect(await fs.readText(await fs.resolveModelPath('sub/relative'))).toBe('inside')
    expect(await rejection(fs.resolveModelPath(' '))).toEqual(new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND'))
    await symlink('loop', join(workspace, 'loop'))
    expect(await rejection(fs.resolveModelPath('loop'))).toEqual(new FsError(`cannot resolve "${join(workspace, 'loop')}": too many levels of symbolic links`, 'FS_NOT_FOUND'))
    await chmod(join(workspace, 'sub'), 0o000)
    try {
      await expect(fs.resolveModelPath('sub/relative')).rejects.toMatchObject({ code: 'EACCES' })
    } finally {
      await chmod(join(workspace, 'sub'), 0o755)
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
  it('reports a target that vanished, a non-file, a FIFO, a non-directory listing, and a refused open without blocking', async () => {
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
    await expect(fs.readText(await fs.resolveModelPath('plain'))).rejects.toEqual(new FsError(`cannot read "${join(workspace, 'plain')}": permission denied`, 'FS_PERMISSION_DENIED'))
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

  it('refuses a root that contains this process\'s temporary directory', async () => {
    const previous = process.env.TMPDIR
    process.env.TMPDIR = join(workspace, 'tmp')
    await mkdir(join(workspace, 'tmp'))
    try {
      await expect(ctx.plugin(LocalFileSystem, { modelRoots: [workspace] })).rejects.toThrow(
        `fs-local: modelRoots and readOnlyRoots must not contain this process's temporary directory ${JSON.stringify(join(workspace, 'tmp'))}; start dsh with TMPDIR set to a root-only directory such as /root/.dsh/tmp`,
      )
    } finally {
      if (previous === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = previous
    }
  })

  it('lists a link out of the roots as an opaque entry that no read accepts', async () => {
    const fs = await mount({ cwd: workspace, modelRoots: [workspace, scratch] })
    await mkdir(join(workspace, 'v'))
    await symlink(outside, join(workspace, 'v', 'out'))
    await symlink(join(scratch), join(workspace, 'v', 'in'))
    const entries = await fs.listDir(await fs.resolveModelPath('v'))
    expect(entries.map(({ name, type, size, version }) => ({ name, type, size, version }))).toEqual([
      { name: 'in', type: 'directory', size: undefined, version: expect.any(String) as string },
      { name: 'out', type: 'other', size: undefined, version: undefined },
    ])
    const out = entries.find(entry => entry.name === 'out')!
    expect(out.target.targetKey).toBe(join(workspace, 'v', 'out'))
    await expect(fs.listDir(out.target)).rejects.toMatchObject({ code: 'FS_OUTSIDE_ROOTS' })
    await expect(fs.readText(await fs.resolve(join(outside, 'key')))).resolves.toBe('secret')
  })

  it('refuses a hard-linked file the run-as user does not own', async () => {
    const fs = await mount({ cwd: workspace, modelRoots: [workspace, scratch] })
    await writeFile(join(scratch, 'original'), 'linked')
    await link(join(scratch, 'original'), join(workspace, 'hard'))
    const subprocess = ctx.subprocess
    const identity = vi.spyOn(subprocess, 'childIdentity', 'get').mockReturnValue({ uid: process.getuid!() + 1, gid: 1, groups: [] })
    try {
      await expect(fs.readText(await fs.resolveModelPath('hard'))).rejects.toMatchObject({ code: 'FS_OUTSIDE_ROOTS' })
      await expect(fs.readText(await fs.resolveModelPath('notes.txt'))).resolves.toBe('inside')
      identity.mockReturnValue({ uid: process.getuid!(), gid: 1, groups: [] })
      await expect(fs.readText(await fs.resolveModelPath('hard'))).resolves.toBe('linked')
    } finally {
      identity.mockRestore()
    }
  })

  it('refuses any path outside the roots with one fixed refusal, whether or not it exists', async () => {
    const fs = await mount({ cwd: workspace, modelRoots: [workspace, scratch] })
    for (const requested of [join(outside, 'key', 'below'), join(outside, 'missing', 'below'), join(outside, 'key')]) {
      expect(await rejection(fs.resolveModelPath(requested))).toEqual(refusal(requested))
    }
    await writeFile(join(workspace, 'file'), 'x')
    await expect(fs.resolveModelPath('file/below')).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
    const aborted = new AbortController()
    aborted.abort()
    await expect(fs.resolveModelPath(join(outside, 'key'), { signal: aborted.signal })).rejects.toMatchObject({ code: 'FS_ABORTED' })
  })

  it('resolves through an outward link for a person-facing reader', async () => {
    const fs = await mount({ cwd: workspace, modelRoots: [workspace, scratch] })
    await symlink(outside, join(workspace, 'escape'))
    expect(await fs.readText(await fs.resolve('escape/key', { unconfined: true }))).toBe('secret')
    await expect(fs.resolve('escape/key')).rejects.toMatchObject({ code: 'FS_OUTSIDE_ROOTS' })
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

describe.runIf(process.platform === 'linux')('read-only roots', () => {
  let home: string
  let dshHome: string
  let attachments: string
  let skills: string
  beforeEach(async () => {
    home = join(base, 'home')
    dshHome = join(base, 'dsh')
    attachments = join(dshHome, 'attachments', 'v1')
    skills = join(dshHome, 'skills')
    for (const directory of [home, attachments, join(attachments, 'files'), skills]) await mkdir(directory, { recursive: true })
    await writeFile(join(attachments, 'files', 'upload.csv'), 'a,b')
    await writeFile(join(skills, 'SKILL.md'), 'skill')
    vi.stubEnv('HOME', home)
    vi.stubEnv('DSH_HOME', dshHome)
  })
  afterEach(() => { vi.unstubAllEnvs() })

  const readOnlyRefusal = (verb: string) => new FsError(
    `cannot ${verb}: it is in a directory you can only read (${attachments}, ${skills})`, 'FS_OUTSIDE_ROOTS',
  )

  it('fails the provider at load for a list that would expose the harness home or a credential store', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ readOnlyRoots: [attachments] }, 'fs-local: readOnlyRoots requires modelRoots; without them model paths are unrestricted'],
      [{ modelRoots: [workspace], readOnlyRoots: [] }, 'fs-local: readOnlyRoots must list at least one directory; omit it to add none'],
      [{ modelRoots: [workspace], readOnlyRoots: [dshHome] },
        `fs-local: readOnlyRoots entry ${JSON.stringify(dshHome)} must not be or contain the harness home ${JSON.stringify(dshHome)}; list the directories inside it that the model reads`],
      [{ modelRoots: [workspace], readOnlyRoots: [base] },
        `fs-local: readOnlyRoots entry ${JSON.stringify(base)} must not be or contain the harness home ${JSON.stringify(dshHome)}; list the directories inside it that the model reads`],
      [{ modelRoots: [workspace], readOnlyRoots: [home] },
        `fs-local: readOnlyRoots entry ${JSON.stringify(home)} must not be, contain, or lie inside the credential store ${JSON.stringify(join(home, '.ssh'))}`],
      [{ modelRoots: [workspace], readOnlyRoots: [attachments, join(home, '.config', 'gh')] },
        `fs-local: readOnlyRoots entry ${JSON.stringify(join(home, '.config', 'gh'))} must not be, contain, or lie inside the credential store ${JSON.stringify(join(home, '.config', 'gh'))}`],
      [{ modelRoots: [workspace], readOnlyRoots: [join(home, '.aws', 'sso')] },
        `fs-local: readOnlyRoots entry ${JSON.stringify(join(home, '.aws', 'sso'))} must not be, contain, or lie inside the credential store ${JSON.stringify(join(home, '.aws'))}`],
      [{ modelRoots: [workspace], readOnlyRoots: [join(workspace, 'docs')] },
        `fs-local: readOnlyRoots entry ${JSON.stringify(join(workspace, 'docs'))} must not overlap modelRoots entry ${JSON.stringify(workspace)}`],
      [{ modelRoots: [join(skills, 'mine')], readOnlyRoots: [skills] },
        `fs-local: readOnlyRoots entry ${JSON.stringify(skills)} must not overlap modelRoots entry ${JSON.stringify(join(skills, 'mine'))}`],
    ]
    for (const directory of [join(home, '.config', 'gh'), join(home, '.aws', 'sso'), join(workspace, 'docs'), join(skills, 'mine')]) {
      await mkdir(directory, { recursive: true })
    }
    for (const [config, message] of cases) {
      await expect(ctx.plugin(LocalFileSystem, config), message).rejects.toThrow(message)
      expect(ctx.get('fs')).toBeUndefined()
    }
  })

  it('compares against a home directory that does not exist by its written path', async () => {
    vi.stubEnv('HOME', join(base, 'no-home'))
    await expect(ctx.plugin(LocalFileSystem, { modelRoots: [workspace], readOnlyRoots: [join(base, 'no-home', '.ssh')] })).rejects.toThrow('must be an existing directory')
    await mkdir(join(base, 'no-home', '.ssh'), { recursive: true })
    await rm(join(base, 'no-home'), { recursive: true })
    await mount({ cwd: workspace, modelRoots: [workspace], readOnlyRoots: [attachments] })
  })

  it('reads and lists under a read-only root with the same descriptor checks as a model root', async () => {
    const fs = await mount({ cwd: workspace, modelRoots: [workspace], readOnlyRoots: [attachments, skills] })
    expect(await fs.readText(await fs.resolveModelPath(join(attachments, 'files', 'upload.csv')))).toBe('a,b')
    expect((await fs.listDir(await fs.resolveModelPath(skills))).map(entry => entry.name)).toEqual(['SKILL.md'])
    await symlink(outside, join(skills, 'escape'))
    expect(await rejection(fs.resolveModelPath(join(skills, 'escape', 'key'))))
      .toEqual(new FsError(`cannot access "${join(skills, 'escape', 'key')}": its real path is outside the directories you can access (${workspace}, ${attachments}, ${skills})`, 'FS_OUTSIDE_ROOTS'))
  })

  it('refuses every change under a read-only root, by its own path or through a link from a model root', async () => {
    const fs = await mount({ cwd: workspace, modelRoots: [workspace], readOnlyRoots: [attachments, skills] })
    const spawn = vi.spyOn(ctx.subprocess, 'spawn')
    await symlink(attachments, join(workspace, 'uploads'))
    const upload = await fs.resolveModelPath(join(attachments, 'files', 'upload.csv'))
    const linked = await fs.resolveModelPath('uploads/files/upload.csv')
    const created = await fs.resolveModelPath(join(skills, 'new.md'))
    const notes = await fs.resolveModelPath('notes.txt')
    const directory = await fs.resolveModelPath(join(skills, 'dir'))
    const attempts: [() => Promise<unknown>, string][] = [
      [() => fs.writeText(upload, 'changed'), `write "${upload.displayPath}"`],
      [() => fs.writeText(linked, 'changed'), `write "${linked.displayPath}"`],
      [() => fs.writeText(created, 'new'), `write "${created.displayPath}"`],
      [() => fs.editText(upload, { oldString: 'a', newString: 'b', replaceAll: false }), `edit "${upload.displayPath}"`],
      [() => fs.patchText(upload, []), `patch "${upload.displayPath}"`],
      [() => fs.deleteFile(upload), `delete "${upload.displayPath}"`],
      [() => fs.moveFile(upload, notes, {}), `move "${upload.displayPath}"`],
      [() => fs.moveFile(notes, created, {}), `move "${notes.displayPath}"`],
      [() => fs.makeDirectory(directory), `create directory "${join(skills, 'dir')}"`],
    ]
    for (const [attempt, verb] of attempts) expect(await rejection(attempt())).toEqual(readOnlyRefusal(verb))
    expect(await fs.readText(upload)).toBe('a,b')
    expect(await fs.readText(notes)).toBe('inside')
    expect(await fs.stat(created)).toBeUndefined()
    expect(spawn).not.toHaveBeenCalled()
  })

  it('reads a hard-linked file the run-as user does not own only under a read-only root', async () => {
    const fs = await mount({ cwd: workspace, modelRoots: [workspace], readOnlyRoots: [attachments, skills] })
    await link(join(attachments, 'files', 'upload.csv'), join(attachments, 'object'))
    await writeFile(join(workspace, 'original'), 'linked')
    await link(join(workspace, 'original'), join(workspace, 'hard'))
    const identity = vi.spyOn(ctx.subprocess, 'childIdentity', 'get').mockReturnValue({ uid: process.getuid!() + 1, gid: 1, groups: [] })
    try {
      await expect(fs.readText(await fs.resolveModelPath(join(attachments, 'object')))).resolves.toBe('a,b')
      await expect(fs.readText(await fs.resolveModelPath('hard'))).rejects.toMatchObject({ code: 'FS_OUTSIDE_ROOTS' })
    } finally {
      identity.mockRestore()
    }
  })
})

/**
 * Start a process that keeps repointing the link `<workspace>/l` between an empty directory inside the roots and the
 * secret directory, each time by renaming a new link over it.
 * @returns a stopper that ends the repointing and waits for the process to exit.
 */
function repointer(directory: string, secretDirectory: string): () => Promise<void> {
  const script = [
    "const fs = require('node:fs'); const path = require('node:path')",
    'const [dir, secret] = process.argv.slice(1)',
    "const decoy = path.join(dir, 'decoy'), link = path.join(dir, 'l'), next = path.join(dir, 'l.next')",
    'fs.mkdirSync(decoy)',
    'for (;;) { for (const target of [secret, decoy]) { try { fs.symlinkSync(target, next); fs.renameSync(next, link) } catch {} } }',
  ].join('\n')
  const child = spawn(process.execPath, ['-e', script, directory, secretDirectory], { stdio: 'ignore' })
  return () => new Promise((resolve) => { child.once('exit', () => { resolve() }); child.kill('SIGKILL') })
}

/**
 * Start a process that keeps swapping the empty directory `<workspace>/d` for a link to the secret directory and back.
 * @returns a stopper that ends the swapping and waits for the process to exit.
 */
function swapper(directory: string, secretDirectory: string): () => Promise<void> {
  const script = [
    "const fs = require('node:fs'); const path = require('node:path')",
    'const [dir, secret] = process.argv.slice(1)',
    "const d = path.join(dir, 'd'), aside = path.join(dir, 'd.aside')",
    'fs.mkdirSync(d)',
    'for (;;) { try { fs.renameSync(d, aside); fs.symlinkSync(secret, d); fs.unlinkSync(d); fs.renameSync(aside, d) } catch {} }',
  ].join('\n')
  const child = spawn(process.execPath, ['-e', script, directory, secretDirectory], { stdio: 'ignore' })
  return () => new Promise((resolve) => { child.once('exit', () => { resolve() }); child.kill('SIGKILL') })
}

describe.runIf(process.platform === 'linux')('model roots against a racing link swap', () => {
  it('tells nothing about names outside the roots through a directory swapped for a link between two steps of a resolution', async () => {
    const fs = await mount({ cwd: workspace, modelRoots: [workspace, scratch] })
    await mkdir(join(outside, 'directory'))
    const stop = swapper(workspace, outside)
    const outcomes = { file: new Map<string, number>(), back: new Map<string, number>() }
    const outcome = (promise: Promise<unknown>) => promise.then(() => 'resolved', (error: unknown) => error instanceof FsError ? `${error.code} ${error.message}` : `raw ${String(error)}`)
    const count = (seen: Map<string, number>, text: string) => { seen.set(text, (seen.get(text) ?? 0) + 1) }
    try {
      for (let index = 0; index < 3000; index++) {
        // In the secret directory `key` is a file, which a missing name is not.
        count(outcomes.file, await outcome(fs.resolveModelPath('d/key/x')))
        // The walk would come back from `directory` only because it exists there.
        count(outcomes.back, await outcome(fs.resolveModelPath('d/directory/../x')))
      }
    } finally {
      await stop()
    }
    const all = [...outcomes.file.keys(), ...outcomes.back.keys()]
    expect(all.filter(text => text.includes('not a directory') || text.startsWith('raw '))).toEqual([])
    expect(outcomes.back.has('resolved')).toBe(false)
    // Both sides of the swap were seen: the refusal through the link and the walk in the empty directory.
    expect(all.filter(text => text.startsWith('FS_OUTSIDE_ROOTS')).length).toBeGreaterThan(0)
    expect(outcomes.file.get('resolved') ?? 0).toBeGreaterThan(0)
  }, 60_000)


  it('tells nothing about names outside the roots through a link repointed while a path resolves', async () => {
    const fs = await mount({ cwd: workspace, modelRoots: [workspace, scratch] })
    await mkdir(join(outside, 'directory'))
    const stop = repointer(workspace, outside)
    const outcomes = { back: new Set<string>(), file: new Set<string>() }
    const outcome = (promise: Promise<unknown>) => promise.then(() => 'resolved', (error: unknown) => error instanceof FsError ? `${error.code} ${error.message}` : String(error))
    try {
      const deadline = Date.now() + 4_000
      while (Date.now() < deadline) {
        // Through the secret directory the walk would come back into the roots only because `directory` exists there.
        outcomes.back.add(await outcome(fs.resolveModelPath('l/directory/../../projects/notes.txt')))
        // Through the secret directory `key` is a file, which a missing name is not.
        outcomes.file.add(await outcome(fs.resolveModelPath('l/key/x')))
      }
    } finally {
      await stop()
    }
    expect([...outcomes.back].filter(text => text === 'resolved')).toEqual([])
    expect([...outcomes.file].filter(text => text.includes('not a directory'))).toEqual([])
    expect(outcomes.back.size + outcomes.file.size).toBeGreaterThan(2)
  })

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
