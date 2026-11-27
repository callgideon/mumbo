/**
 * Session working directories, durable changes, and model context.
 * @module @deepseek-ai/dsh-working-directory
 */

import { isAbsolute } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import { createUserMessage, errorChain } from '@deepseek-ai/dsh-llm'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { WorkingDirectoryError } from './error.ts'

export type * from './types.ts'
export { WorkingDirectoryError, type WorkingDirectoryErrorCode } from './error.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Coordinate directory validation and publication with a resource operation
     * on the directory, such as a checkout being removed. A listener that must
     * wait awaits that operation, then calls `next()`; every other listener
     * calls `next()` at once. A rejection fails this access and leaves the
     * recorded directory unchanged; it is not a fallback.
     * @param request - owner, requested path (null validates the current directory), and the access's cancellation.
     * @param next - perform validation and commit.
     * @mode waterfall
     */
    'working-directory/access'(
      request: { agent: Agent; path: string | null; signal: AbortSignal },
      next: () => Promise<string>,
    ): Promise<string>
  }
  interface Context {
    workingDirectory: WorkingDirectoryService
  }
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * Committed working-directory transition notices.
     * @persistenceAttribution
     */
    'working-directory': { kind: 'working-directory' }
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Directory change recorded by releases whose model could move the directory. Readers ignore it: a
     * Session that holds one resumes in its original project, or in the directory of its last
     * `workspace-root/change`.
     * @deprecated No writer records this event. `WorkingDirectoryService.set` records
     * `workspace-root/change`.
     */
    'working-directory/change': {
      /** Absolute directory the Session worked in after the change. */
      cwd: string
      /** @deprecated Logs stored on Mumbo boxes carry this field; nothing reads it. */
      chooser?: 'host'
    }
    /** Host move of the Session's directory; the immutable Session header retains the original project. */
    'workspace-root/change': {
      /** Absolute directory the Session works in from this event on. */
      cwd: string
    }
  }
}

/** Deployment default for Sessions without an original project directory. */
export interface Config {
  /** Absolute execution-world fallback directory; omitted values use the launch directory. */
  defaultDirectory?: string
}

/**
 * One owner for each Session's directory and its model-visible changes.
 *
 * A Session works in one directory. Relative paths resolve from it, and it is the workspace root that
 * the write boundary, file views, and discovery follow. Only Host operations move it, through {@link set}
 * or the recovery of {@link ensure}. The `working-directory/change` events of a log written while the
 * model could move the directory do not move it.
 */
export class WorkingDirectoryService extends Service {
  static inject = ['fs', 'sessionProjections', 'systemPrompt']

  static Config: z<Config> = z.object({
    defaultDirectory: z.string(),
  })

  /** Absolute deployment fallback for Sessions with no recorded original directory. */
  readonly defaultDirectory: string
  private readonly pending = new WeakMap<Session, Promise<void>>()
  private readonly operations = new Set<Promise<unknown>>()
  private readonly lifecycle = new AbortController()
  // ponytail: in-process only; restarts and folders recreated outside ensure need a durable per-Session marker.
  /** Original projects this process recreated, and the Sessions created before then that were told. */
  private readonly recreations = new Map<string, { at: number; told: Set<SessionId> }>()

  private workingDirectoryProjectionHandle!: ProjectionHandle<string | null>

  constructor(ctx: Context, config: Config) {
    super(ctx, 'workingDirectory')
    const directory = config.defaultDirectory ?? process.cwd()
    if (!isAbsolute(directory)) throw new Error('working-directory: defaultDirectory must be absolute')
    this.defaultDirectory = directory
  }

  protected async [Service.init](): Promise<void> {
    const ctx = this.ctx
    const directorySchema = zod.string().min(1).refine(isAbsolute).nullable()
    this.workingDirectoryProjectionHandle = await ctx.sessionProjections.register({
      key: 'workingDirectory',
      stateVersion: 3,
      stateSchema: directorySchema,
      init: header => header.cwd ?? null,
      apply: (state, event) => event.type === 'workspace-root/change' ? event.data.cwd : state,
      wire: { viewSchema: directorySchema, view: state => state },
    })
    ctx.systemPrompt.context({
      name: 'working-directory:current',
      order: ctx.systemPrompt.getContextOrder('WORKING_DIRECTORY'),
      required: true,
      interpolate: false,
      text: context => context.agent === undefined ? '' : this.contextText(context.agent.session),
    })
    ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      if (context.agent === undefined) return next()
      await this.ensure(context.agent, context.signal)
      const assembly = await next()
      this.lifecycle.signal.throwIfAborted()
      const text = this.contextText(context.agent.session)
      const contribution = assembly.contexts.find(entry => entry.name === 'working-directory:current')
      if (contribution === undefined) assembly.contexts.unshift({ name: 'working-directory:current', text, interpolate: false })
      else {
        contribution.text = text
        contribution.interpolate = false
      }
      return assembly
    }, { prepend: true })
    ctx.effect(() => async () => {
      this.lifecycle.abort(new WorkingDirectoryError('working-directory service disposed', 'WORKING_DIRECTORY_UNAVAILABLE'))
      await Promise.allSettled(this.operations)
    })
  }

  /**
   * Read the committed directory without filesystem I/O: where relative paths resolve, and the workspace
   * root of everything that follows the Session's checkout.
   * @param session - Session whose directory is requested.
   * @returns the directory of the last Host move, the original project before any, or the deployment
   * default when none is recorded.
   */
  get(session: Session): string {
    return this.workingDirectoryProjectionHandle.stateOf(session) ?? this.defaultDirectory
  }

  /**
   * Validate the current directory and restore the original project when the current directory disappeared or the
   * filesystem provider refuses it with `FS_OUTSIDE_ROOTS`, so no directory reader follows a link that leaves the
   * deployment's roots.
   * A missing original project is recreated empty through the filesystem provider and logged; files it held are not
   * restored. Every Session in this process that was created before the recreation and works in, or falls back to,
   * that project is told once.
   * @param agent - live or unpublished Agent owning the Session.
   * @param signal - cancellation for filesystem inspection and creation.
   * @returns the existing directory; recovery is committed before fulfillment. A notice failure is
   * warned without reverting the committed state.
   * @throws {@link WorkingDirectoryError} `WORKING_DIRECTORY_UNAVAILABLE` when the original project is missing and
   *   cannot be recreated, which is logged, when the provider also refuses the original project with
   *   `FS_OUTSIDE_ROOTS`, or when the service is disposed; or the rejection of a `working-directory/access` listener.
   */
  ensure(agent: Agent, signal?: AbortSignal): Promise<string> {
    return this.serialize(agent, signal, control => this.ctx.waterfall('working-directory/access', { agent, path: null, signal: control }, async () => {
      const current = this.get(agent.session)
      const original = agent.session.header.cwd ?? this.defaultDirectory
      const target = await this.available(current, control)
      const info = target === undefined ? undefined : await this.ctx.fs.stat(target, control)
      control.throwIfAborted()
      agent.ctx.fiber.assertActive()
      if (info?.type === 'directory') {
        if (this.workingDirectoryProjectionHandle.stateOf(agent.session) === null) {
          agent.session.append('workspace-root/change', { cwd: current })
        }
        const recreation = current === original ? this.untold(agent.session, original) : undefined
        if (recreation !== undefined) {
          this.commit(agent, current, 'recreated', control)
          recreation.told.add(agent.session.id)
        }
        return current
      }
      const origin = await this.available(original, control)
      if (origin === undefined) {
        throw new WorkingDirectoryError(
          `working-directory: the original directory ${JSON.stringify(original)} is outside the directories this deployment can access; the current working directory ${JSON.stringify(current)} is also unavailable; select another existing directory`,
          'WORKING_DIRECTORY_UNAVAILABLE',
        )
      }
      const originInfo = await this.ctx.fs.stat(origin, control)
      control.throwIfAborted()
      if (originInfo?.type !== 'directory') await this.recreate(original, origin, control)
      const restored = this.ctx.fs.processPath(origin)
      const recreation = this.untold(agent.session, original)
      this.commit(agent, restored, recreation === undefined ? 'recovered' : 'recreated', control)
      recreation?.told.add(agent.session.id)
      return restored
    }))
  }

  /**
   * Move one Session's directory to `path`. Existing processes keep their directories. Callers are
   * Host operations that chose the directory; a model-supplied path would move the workspace-write
   * boundary with it.
   * @param agent - live or unpublished Agent owning the Session.
   * @param path - absolute path or a path relative to its current directory.
   * @param signal - cancellation before the durable change.
   * @returns the canonical absolute directory, committed before fulfillment.
   * A notice failure is warned; the next request still receives the committed directory.
   * @throws {@link WorkingDirectoryError} `WORKING_DIRECTORY_INVALID` for an empty path and
   *   `WORKING_DIRECTORY_NOT_FOUND` when the path is not an existing directory, or the rejection of a
   *   `working-directory/access` listener.
   */
  set(agent: Agent, path: string, signal?: AbortSignal): Promise<string> {
    return this.serialize(agent, signal, control => this.ctx.waterfall('working-directory/access', { agent, path, signal: control }, async () => {
      if (path.length === 0) throw new WorkingDirectoryError('working-directory: path must not be empty', 'WORKING_DIRECTORY_INVALID')
      const directory = await this.directory(path, this.get(agent.session), control)
      this.commit(agent, directory, 'changed', control)
      return directory
    }))
  }

  private contextText(session: Session): string {
    return `Current working directory: ${JSON.stringify(this.get(session))}.`
  }

  /** Recreate a missing original project; once it exists, the notice stays owed even if cancellation interrupts. */
  private async recreate(original: string, origin: FsTarget, signal: AbortSignal): Promise<void> {
    try {
      // The original directory is Session metadata, not a model-selected path; Session creation creates it unconfined too.
      await this.ctx.fs.makeDirectory(origin, signal, { mode: 'danger-full-access', workspaceRoot: original })
    } catch (error) {
      if (signal.aborted) {
        // A remote provider may have created the directory before the cancelled call settled.
        const info = await this.ctx.fs.stat(origin, this.lifecycle.signal).catch(() => undefined)
        if (info?.type === 'directory') this.recreations.set(original, { at: Date.now(), told: new Set() })
        signal.throwIfAborted()
      }
      const failure = new WorkingDirectoryError(
        `working-directory: directory does not exist and could not be recreated: ${JSON.stringify(original)}: ${errorChain(error)}; restore it or select another existing directory`,
        'WORKING_DIRECTORY_UNAVAILABLE',
        { cause: error },
      )
      this.ctx.logger.error(failure.message)
      throw failure
    }
    this.recreations.set(original, { at: Date.now(), told: new Set() })
    this.ctx.logger.warn(`working-directory: recreated the missing directory ${JSON.stringify(original)} empty`)
  }

  private untold(session: Session, original: string): { told: Set<SessionId> } | undefined {
    const recreation = this.recreations.get(original)
    // A Session created in the recreation's millisecond counts as earlier: a stray notice costs less than a missed one.
    if (recreation === undefined || session.header.createdAt > recreation.at || recreation.told.has(session.id)) return undefined
    return recreation
  }

  /** The target of a recorded directory, or undefined when the provider refuses it with `FS_OUTSIDE_ROOTS`. */
  private async available(directory: string, signal: AbortSignal): Promise<FsTarget | undefined> {
    try {
      return await this.ctx.fs.resolve(directory, { signal })
    } catch (error) {
      if (error instanceof FsError && error.code === 'FS_OUTSIDE_ROOTS') return undefined
      throw error
    }
  }

  private async directory(path: string, cwd: string, signal: AbortSignal): Promise<string> {
    const target = await this.ctx.fs.resolve(path, { cwd, signal })
    const info = await this.ctx.fs.stat(target, signal)
    signal.throwIfAborted()
    if (info?.type !== 'directory') {
      throw new WorkingDirectoryError(`working-directory: directory does not exist: ${JSON.stringify(path)}`, 'WORKING_DIRECTORY_NOT_FOUND')
    }
    return this.ctx.fs.processPath(target)
  }

  private commit(agent: Agent, directory: string, transition: 'changed' | 'recovered' | 'recreated', signal: AbortSignal): void {
    signal.throwIfAborted()
    agent.ctx.fiber.assertActive()
    const previous = this.get(agent.session)
    if (previous !== directory) agent.session.append('workspace-root/change', { cwd: directory })
    else if (transition !== 'recreated') return
    const from = JSON.stringify(previous)
    const to = JSON.stringify(directory)
    const recreation = 'was missing and has been recreated empty; files that were in it before are gone.'
    const notice = createUserMessage({
      content: [{
        type: 'text',
        text: transition === 'changed'
          ? `The working directory changed from ${from} to ${to}.`
          : transition === 'recovered'
            ? `The working directory ${from} is unavailable. The working directory is now ${to}.`
            : previous === directory
              ? `The working directory ${to} ${recreation}`
              : `The working directory ${from} is unavailable. The original directory ${to} ${recreation} The working directory is now ${to}.`,
      }],
      source: { kind: 'working-directory' },
    })
    try {
      agent.inject(notice)
    } catch (error) {
      this.ctx.logger.warn(`working-directory: committed ${JSON.stringify(directory)}, but could not queue its notice: ${String(error)}`)
    }
  }

  private serialize<T>(agent: Agent, signal: AbortSignal | undefined, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const session = agent.session
    const control = signal === undefined
      ? this.lifecycle.signal
      : AbortSignal.any([this.lifecycle.signal, signal])
    const operation = (this.pending.get(session) ?? Promise.resolve()).then(() => {
      control.throwIfAborted()
      agent.ctx.fiber.assertActive()
      return action(control)
    })
    const settled = operation.finally(() => this.operations.delete(settled))
    this.operations.add(settled)
    this.pending.set(session, settled.then(() => {}, () => {}))
    return settled
  }
}

export default WorkingDirectoryService
