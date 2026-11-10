/**
 * Host-filesystem implementation of `ctx.fs`. Realpath-derived target identity makes aliases
 * share stale guards, and writes through a symlink update its target without replacing the link.
 * Optional model roots confine model-supplied paths and refuse any path that leaves them
 * through a symbolic link.
 * @module @deepseek-ai/dsh-fs-local
 */

import { applyHunks } from '@deepseek-ai/dsh-fs-patch'
import type { PatchHunk } from '@deepseek-ai/dsh-fs-patch'
import { Context } from '@deepseek-ai/cordis'
import { constants as bufferConstants } from 'node:buffer'
import { once } from 'node:events'
import { realpathSync, statSync } from 'node:fs'
import { watch } from 'chokidar'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { FileSystem, FsError, FsVersion } from '@deepseek-ai/dsh-fs'
import type {
  FsDeleteOutcome,
  FsMoveOutcome,
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsPathInfo,
  FsTarget,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import {
  applyLiteralEdit,
  createDirectory,
  expandHomePrefix,
  listDirectory,
  localDisplayPath,
  normalizeLineEndings,
  probe,
  probeNoFollow,
  readForEdit,
  readByteWindow,
  readTextForDiff,
  readWholeBytes,
  readWholeText,
  resolveLocalTarget,
  restoreLineEndings,
  removeFile,
  streamWholeText,
  writeFileAtomic,
} from './fsio.ts'
import type { FsIoInternals, LocalTarget, PathInfo, ReadPin } from './fsio.ts'
import { mutateInChild } from './child-mutations.ts'
import type { MutationOutcomes, MutationRequest } from './child-mutations.ts'
import type {} from '@deepseek-ai/dsh-subprocess'

/** Configuration for the local filesystem backend. */
export interface Config {
  /** Base directory for relative paths. Defaults to `process.cwd()`. */
  cwd?: string
  /**
   * Exclusive UTF-8 byte limit on each overwrite-diff side, capped by the
   * runtime's safe allocation/decode maximum. Defaults to 10 MiB.
   */
  diffBasisMaxBytes?: number
  /**
   * Existing absolute directories the model's file tools are confined to. When set,
   * {@link LocalFileSystem.resolveModelPath} refuses a real path outside every root, and every
   * resolution refuses a path under a root whose real path leaves all roots, the symbolic-link
   * escape. Omitted, model paths are unrestricted.
   */
  modelRoots?: string[] | undefined
}

/** A target reduced to its two fields, as the change helper receives it. */
function plainTarget(target: FsTarget): FsTarget {
  return { targetKey: target.targetKey, displayPath: target.displayPath }
}

/** One model root as configured (for paths written under it) and as its real path. */
interface ModelRoot {
  configured: string
  canonical: string
}

/** Whether `path` is `root` or lies below it; both are absolute. */
function isUnder(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/**
 * Canonicalize the configured model roots once, failing loudly on an unusable entry.
 * @param roots - configured absolute directories.
 * @returns each root's configured and real form.
 */
function modelRootsOf(roots: readonly string[], platform: NodeJS.Platform): ModelRoot[] {
  // Reads confirm each opened descriptor through /proc/self/fd, which only Linux provides.
  if (platform !== 'linux') throw new Error(`fs-local: modelRoots requires Linux; this host is ${platform}`)
  if (roots.length === 0) throw new Error('fs-local: modelRoots must list at least one directory; omit it to leave model paths unrestricted')
  return roots.map((root) => {
    if (!isAbsolute(root)) throw new Error(`fs-local: modelRoots entry ${JSON.stringify(root)} must be an absolute path`)
    let canonical: string
    try {
      canonical = realpathSync.native(root)
    } catch (error) {
      throw new Error(`fs-local: modelRoots entry ${JSON.stringify(root)} must be an existing directory: ${(error as Error).message}`, { cause: error })
    }
    if (!statSync(canonical).isDirectory()) throw new Error(`fs-local: modelRoots entry ${JSON.stringify(root)} must be an existing directory`)
    return { configured: resolve(root), canonical }
  })
}

type ResolvedConfig = Required<Config>
const DEFAULT_DIFF_BASIS_MAX_BYTES = 10 * 1024 * 1024
const MAX_DIFF_BASIS_BYTES = Math.min(
  bufferConstants.MAX_LENGTH,
  bufferConstants.MAX_STRING_LENGTH,
)

/**
 * The host-filesystem backend. Reads resolve relative paths from {@link Config.cwd}
 * (a resolution default, NOT a containment boundary — see the filesystem
 * capability-seam Agent Note); enforce
 * containment with a stricter backend or a `tools/execute` permission plugin.
 */
export class LocalFileSystem extends FileSystem {
  override async watch(target: FsTarget, changed: (error?: Error) => void, signal: AbortSignal): Promise<() => Promise<void>> {
    signal.throwIfAborted()
    const path = resolve(this.processPath(target))
    const directory = (await this.stat(target, signal))?.type === 'directory'
    signal.throwIfAborted()
    const root = directory ? path : dirname(path)
    const watcher = watch(root, {
      ignoreInitial: true, depth: 0,
      ignored: entry => !directory && resolve(entry) !== root && resolve(entry) !== path,
    })
    watcher.on('all', (_event, entry) => {
      if (directory || resolve(entry) === path) changed()
    })
    watcher.on('error', (error) => { changed(error instanceof Error ? error : new Error(String(error))) })
    try {
      await once(watcher, 'ready', { signal })
      return () => watcher.close()
    } catch (error) {
      await watcher.close()
      throw error
    }
  }

  static Config: z<Config> = z.object({
    cwd: z.string().default(process.cwd()),
    diffBasisMaxBytes: z.number().default(DEFAULT_DIFF_BASIS_MAX_BYTES),
    modelRoots: z.union([z.array(String), z.const(undefined)]),
  })

  /** Validated config (schemastery applied the defaults before construction). */
  readonly config: ResolvedConfig
  /** The roots model paths are confined to; undefined leaves them unrestricted. */
  private readonly modelRoots: readonly ModelRoot[] | undefined
  /** With model roots, every read and listing opens its target once and accepts only the resolved file. */
  private readonly readPin: ReadPin | undefined
  /** Test hook forwarded to fsio for atomic-publication boundaries. */
  internals: FsIoInternals = {}
  /** Per-targetKey tail promise: serializes mutating ops so the read→guard→write
   * window can't interleave, making concurrent writes/edits deterministically
   * ordered (one wins, the rest see the new version and reject as stale). */
  private locks = new Map<string, Promise<unknown>>()

  constructor(ctx: Context, config: Config) {
    super(ctx)
    const resolved = config as ResolvedConfig
    if (!Number.isSafeInteger(resolved.diffBasisMaxBytes)
      || resolved.diffBasisMaxBytes <= 0
      || resolved.diffBasisMaxBytes > MAX_DIFF_BASIS_BYTES) {
      throw new Error(`fs-local: diffBasisMaxBytes must be a positive safe integer no greater than ${MAX_DIFF_BASIS_BYTES}`)
    }
    this.config = resolved
    this.modelRoots = resolved.modelRoots === undefined ? undefined : modelRootsOf(resolved.modelRoots, process.platform)
    const roots = this.modelRoots
    this.readPin = roots === undefined ? undefined : (opened: string, target: LocalTarget) => {
      if (opened === target.targetKey) return
      // A link swapped in after resolution: the descriptor names another file than the one resolved.
      if (!roots.some(root => isUnder(root.canonical, opened))) throw this.outsideRoots(roots, target.displayPath)
      throw new FsError(`cannot read "${target.displayPath}": the path changed while it was being opened`, 'FS_STALE_VERSION')
    }
  }

  /**
   * The child that performs mutations, when the subprocess provider runs children as a separate
   * identity: the kernel then judges every model-chosen path with that identity's permissions.
   * With model roots and no subprocess provider mounted, mutations are refused rather than
   * performed by this process.
   * @param verb - the operation named in a refusal.
   * @returns the child runner, or undefined to mutate in this process.
   */
  private childMutation(verb: string): (<K extends MutationRequest['op']>(request: Extract<MutationRequest, { op: K }>, signal?: AbortSignal) => Promise<MutationOutcomes[K]>) | undefined {
    const subprocess = this.ctx.get('subprocess')
    if (subprocess === undefined) {
      if (this.modelRoots !== undefined) throw new FsError(`cannot ${verb}: no process provider is mounted to make the change as the run-as user`, 'FS_IO_ERROR')
      return undefined
    }
    if (subprocess.childIdentity === undefined) return undefined
    return (request, signal) => mutateInChild(subprocess, request, this.config.diffBasisMaxBytes, signal)
  }

  /** Run one mutation under the same lock ordering as multi-target operations. */
  private withLock<T>(targetKey: string, op: () => Promise<T>): Promise<T> {
    return this.withLocks([targetKey], op)
  }

  /** Acquire distinct keys in lexical order and release inner locks before outer locks. */
  private withLocks<T>(keys: string[], op: () => Promise<T>): Promise<T> {
    const ordered = [...new Set(keys)].sort()
    const acquire = async (index: number): Promise<T> => {
      const key = ordered[index]
      if (key === undefined) return op()
      const prior = this.locks.get(key) ?? Promise.resolve()
      const run = prior.then(() => acquire(index + 1))
      const tail = run.then(() => undefined, () => undefined)
      this.locks.set(key, tail)
      try {
        return await run
      } finally {
        if (this.locks.get(key) === tail) this.locks.delete(key)
      }
    }
    return acquire(0)
  }

  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    if (opts?.signal?.aborted) throw new FsError('resolve aborted', 'FS_ABORTED')
    const local = await resolveLocalTarget(opts?.cwd ?? this.config.cwd, expandHomePrefix(path))
    if (opts?.signal?.aborted) throw new FsError('resolve aborted', 'FS_ABORTED')
    const roots = this.modelRoots
    // The model can create symbolic links under its roots, so no caller follows one out of them.
    if (roots !== undefined && roots.some(root => isUnder(root.configured, local.displayPath) || isUnder(root.canonical, local.displayPath))
      && !roots.some(root => isUnder(root.canonical, local.targetKey))) {
      throw this.outsideRoots(roots, local.displayPath)
    }
    return { targetKey: local.targetKey, displayPath: local.displayPath }
  }

  /**
   * Resolve like {@link resolve}, then refuse a real path outside every configured model root.
   * @param path - the model-supplied path; relative paths resolve against `opts.cwd`.
   * @param opts - optional cwd override and cancellation signal.
   * @returns the stable target, under a model root when roots are configured.
   */
  override async resolveModelPath(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    const target = await this.resolve(path, opts)
    const roots = this.modelRoots
    if (roots !== undefined && !roots.some(root => isUnder(root.canonical, target.targetKey))) {
      throw this.outsideRoots(roots, target.displayPath)
    }
    return target
  }

  private outsideRoots(roots: readonly ModelRoot[], displayPath: string): FsError {
    return new FsError(
      `cannot access "${displayPath}": its real path is outside the directories you can access (${roots.map(root => root.configured).join(', ')})`,
      'FS_OUTSIDE_ROOTS',
    )
  }

  override processPath(target: FsTarget): string {
    return String(target.targetKey)
  }

  override processPathFromHostPath(hostPath: string): string | undefined {
    return isAbsolute(hostPath) ? resolve(hostPath) : undefined
  }

  override fileUrl(target: FsTarget): string {
    return pathToFileURL(this.processPath(target)).href
  }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    return isUnder(this.processPath(parent), this.processPath(child))
  }

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    if (signal?.aborted) throw new FsError('stat aborted', 'FS_ABORTED')
    const info = await probe(target.targetKey)
    if (signal?.aborted) throw new FsError('stat aborted', 'FS_ABORTED')
    if (!info) return undefined
    return { version: info.version, type: info.type, size: info.size }
  }

  override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    if (signal?.aborted) throw new FsError('lstat aborted', 'FS_ABORTED')
    if (path.trim().length === 0) throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
    const cwd = opts?.cwd ?? this.config.cwd
    const info = await probeNoFollow(localDisplayPath(cwd, expandHomePrefix(path)))
    if (signal?.aborted) throw new FsError('lstat aborted', 'FS_ABORTED')
    if (!info) return undefined
    return { version: info.version, type: info.type, size: info.size }
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    return readWholeText({ displayPath: target.displayPath, targetKey: target.targetKey }, signal, this.readPin)
  }

  override streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    return Promise.resolve(streamWholeText({ displayPath: target.displayPath, targetKey: target.targetKey }, signal, this.readPin))
  }

  override async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    return readWholeBytes({ displayPath: target.displayPath, targetKey: target.targetKey }, signal, maxBytes, this.internals, this.readPin)
  }

  override async readByteRange(target: FsTarget, range: { offset: number; length: number }, signal?: AbortSignal): Promise<Uint8Array> {
    return readByteWindow({ displayPath: target.displayPath, targetKey: target.targetKey }, range, signal, this.readPin)
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    const entries = await listDirectory({ displayPath: target.displayPath, targetKey: target.targetKey }, signal, this.readPin)
    return entries.map(entry => ({
      name: entry.name,
      type: entry.type,
      target: { targetKey: entry.target.targetKey, displayPath: entry.target.displayPath },
      ...(entry.version !== undefined ? { version: entry.version } : {}),
      ...(entry.size !== undefined ? { size: entry.size } : {}),
    }))
  }

  override async makeDirectory(target: FsTarget, signal?: AbortSignal): Promise<void> {
    const child = this.childMutation(`create directory "${target.displayPath}"`)
    if (child !== undefined) {
      await child({ op: 'mkdir', target: { targetKey: target.targetKey, displayPath: target.displayPath } }, signal)
      return
    }
    return createDirectory({ displayPath: target.displayPath, targetKey: target.targetKey }, signal)
  }

  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
  ): Promise<FsWriteOutcome> {
    const child = this.childMutation(`write "${target.displayPath}"`)
    if (child !== undefined) {
      return this.withLock(target.targetKey, () => child({ op: 'write', target: plainTarget(target), content, ...expected === undefined ? {} : { expected } }, signal))
    }
    return this.withLock(target.targetKey, async () => {
      const existing = await this.writeTarget(target, expected)

      // Capture an optional contextual-diff basis before the write. The bounded
      // reader checks the opened file itself, so an external replacement after
      // `probe()` cannot turn this best-effort presentation read into an
      // unbounded allocation. Either side at/above the configured limit yields
      // `before: null`; consumers retain their whole-file fallback.
      const diffable = existing !== null
        && Buffer.byteLength(content, 'utf8') < this.config.diffBasisMaxBytes
      const before = diffable
        ? await readTextForDiff(target.targetKey, this.config.diffBasisMaxBytes, signal)
        : null
      await writeFileAtomic(target.targetKey, content, existing?.mode, signal, this.internals,
        { displayPath: target.displayPath, createIfAbsent: expected?.kind === 'createIfAbsent' })
      const after = await probe(target.targetKey)
      return {
        operation: existing ? 'update' : 'create',
        version: this.versionAfterWrite(after, target),
        before,
        // LF-normalized to share the diff basis with `before` (also LF): a CRLF
        // overwrite must not read as every line changed. Line-ending restoration
        // is a storage detail the applied-hunk diff ignores.
        after: normalizeLineEndings(content),
      }
    })
  }

  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
  ): Promise<FsEditOutcome> {
    const child = this.childMutation(`edit "${target.displayPath}"`)
    if (child !== undefined) {
      return this.withLock(target.targetKey, () => child({ op: 'edit', target: plainTarget(target), edit, ...expected === undefined ? {} : { expected } }, signal))
    }
    return this.withLock(target.targetKey, async () => {
      const existing = await probe(target.targetKey)
      // Stale guard before literal matching: an edit based on an old read reports
      // FS_STALE_VERSION, not FS_EDIT_NOT_FOUND/FS_AMBIGUOUS_EDIT against newer content.
      // Missing targets use the same stale code on guarded and unconditional edit paths.
      if (!existing) throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      if (existing.type !== 'file') throw new FsError(`cannot edit "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      // expected === undefined: unconditional edit of the current content — no
      // version guard. Still inside the per-target lock, so the read→match→write
      // window is serialized and atomic.
      if (expected && existing.version !== expected.version) {
        throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }

      const original = await readForEdit(target.targetKey, target.displayPath, signal)
      const edited = applyLiteralEdit(original.content, edit.oldString, edit.newString, edit.replaceAll, target.displayPath)
      const content = restoreLineEndings(edited.content, original.lineEndings)
      await writeFileAtomic(target.targetKey, content, existing.mode, signal, this.internals, { displayPath: target.displayPath })

      const after = await probe(target.targetKey)
      return {
        version: this.versionAfterWrite(after, target),
        // The LF-normalized before/after text (the applied-hunk diff basis);
        // line-ending restoration is a storage detail the diff ignores.
        before: original.content,
        after: edited.content,
      }
    })
  }

  override async patchText(
    target: FsTarget, hunks: readonly PatchHunk[], expected?: { version: FsVersion }, signal?: AbortSignal,
  ): Promise<FsEditOutcome> {
    const child = this.childMutation(`patch "${target.displayPath}"`)
    if (child !== undefined) {
      return this.withLock(target.targetKey, () => child({ op: 'patch', target: plainTarget(target), hunks, ...expected === undefined ? {} : { expected } }, signal))
    }
    return this.withLock(target.targetKey, async () => {
      const existing = await this.requireFile(target, expected, 'patch')
      const original = await readForEdit(target.targetKey, target.displayPath, signal)
      const after = this.patchContent(target, original.content, hunks)
      await writeFileAtomic(target.targetKey, restoreLineEndings(after, original.lineEndings), existing.mode, signal, this.internals,
        { displayPath: target.displayPath })
      return { version: this.versionAfterWrite(await probe(target.targetKey), target), before: original.content, after }
    })
  }

  override async deleteFile(target: FsTarget, expected?: { version: FsVersion }, signal?: AbortSignal): Promise<FsDeleteOutcome> {
    const child = this.childMutation(`delete "${target.displayPath}"`)
    if (child !== undefined) {
      return this.withLock(target.targetKey, () => child({ op: 'delete', target: plainTarget(target), ...expected === undefined ? {} : { expected } }, signal))
    }
    return this.withLock(target.targetKey, async () => {
      await this.requireFile(target, expected, 'delete')
      const before = await readTextForDiff(target.targetKey, this.config.diffBasisMaxBytes, signal)
      await this.internals.inspectBeforeMutation?.(target)
      if (signal?.aborted) throw new FsError('delete aborted', 'FS_ABORTED')
      await removeFile(target.targetKey, target.displayPath, this.internals)
      return { before }
    })
  }

  override async moveFile(
    source: FsTarget, destination: FsTarget, options: Parameters<FileSystem['moveFile']>[2], signal?: AbortSignal,
  ): Promise<FsMoveOutcome> {
    if (source.targetKey === destination.targetKey) {
      throw new FsError(`cannot move "${source.displayPath}" to itself`, 'FS_SAME_TARGET')
    }
    const child = this.childMutation(`move "${source.displayPath}"`)
    if (child !== undefined) {
      const request = { op: 'move' as const, source: plainTarget(source), destination: plainTarget(destination), options }
      return this.withLocks([source.targetKey, destination.targetKey], () => child(request, signal))
    }
    return this.withLocks([source.targetKey, destination.targetKey], async () => {
      const sourceInfo = await this.requireFile(source, options.expectedSource, 'move')
      const existing = await this.writeTarget(destination, options.expectedDestination)
      const original = await readForEdit(source.targetKey, source.displayPath, signal)
      const after = options.hunks === undefined ? original.content : this.patchContent(source, original.content, options.hunks)
      const content = restoreLineEndings(after, original.lineEndings)
      const before = existing && Buffer.byteLength(content, 'utf8') < this.config.diffBasisMaxBytes
        ? await readTextForDiff(destination.targetKey, this.config.diffBasisMaxBytes, signal) : null
      await this.internals.inspectBeforeMutation?.(source)
      if (signal?.aborted) throw new FsError('move aborted', 'FS_ABORTED')
      // After this checkpoint, complete both effects and report them even if cancellation arrives.
      await writeFileAtomic(destination.targetKey, content, sourceInfo.mode, undefined, this.internals, {
        displayPath: destination.displayPath,
        createIfAbsent: options.expectedDestination?.kind === 'createIfAbsent',
        existingDestination: existing !== null,
      })
      const outcome: FsWriteOutcome = {
        operation: existing ? 'update' : 'create',
        version: this.versionAfterWrite(await probe(destination.targetKey), destination), before, after,
      }
      const sourceBefore = Buffer.byteLength(original.content, 'utf8') < this.config.diffBasisMaxBytes ? original.content : null
      try {
        await removeFile(source.targetKey, source.displayPath, this.internals)
      } catch (error) {
        // removeFile maps I/O failures; unexpected defects must still reject.
        if (!(error instanceof FsError)) throw error
        return { sourceBefore, destination: outcome, sourceDeleted: false, sourceFailure: { code: error.code, message: error.message } }
      }
      return { sourceBefore, destination: outcome, sourceDeleted: true }
    })
  }

  private async writeTarget(target: FsTarget, expected?: FsWriteIntent): Promise<PathInfo | null> {
    const existing = await probe(target.targetKey)
    if (existing && existing.type !== 'file') {
      throw new FsError(`cannot write "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    }

    if (expected?.kind === 'replaceIfVersion') {
      // Stale guard: the file must still exist at the version the owner observed.
      if (!existing) throw new FsError(`cannot write "${target.displayPath}": file no longer exists`, 'FS_STALE_VERSION')
      if (existing.version !== expected.version) {
        throw new FsError(`cannot write "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }
    } else if (expected?.kind === 'createIfAbsent' && existing) {
      // createIfAbsent onto an existing file: a blind overwrite — require a read first.
      throw new FsError(`cannot overwrite existing "${target.displayPath}" without reading it first`, 'FS_NOT_OBSERVED')
    }
    // No expectation means an unconditional but still atomic write.

    return existing
  }

  private async requireFile(target: FsTarget, expected: { version: FsVersion } | undefined, verb: string): Promise<PathInfo> {
    const existing = await probe(target.targetKey)
    if (!existing) throw new FsError(`cannot ${verb} "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
    if (existing.type !== 'file') throw new FsError(`cannot ${verb} "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    if (expected && existing.version !== expected.version) {
      throw new FsError(`cannot ${verb} "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
    }
    return existing
  }

  private patchContent(target: FsTarget, before: string, hunks: readonly PatchHunk[]): string {
    const result = applyHunks(before, hunks)
    if (!result.ok) {
      throw new FsError(`cannot patch "${target.displayPath}": hunk at patch line ${result.failure.hunkLineNumber} (${result.failure.stage}) does not match`, 'FS_PATCH_MISMATCH')
    }
    return result.after
  }

  /* v8 ignore next 5 -- the post-write probe finding the file absent requires a
   * concurrent unlink between rename and stat; fall back to a sentinel version. */
  private versionAfterWrite(after: { version: FsVersion } | null, target: FsTarget): FsVersion {
    if (after) return after.version
    return FsVersion(`missing:${target.targetKey}`)
  }
}

export default LocalFileSystem
