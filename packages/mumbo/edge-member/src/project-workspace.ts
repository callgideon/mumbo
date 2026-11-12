/**
 * The project box's own Workspace: the Host registers one directory as a Workspace while it starts, before the
 * Loader settles, and registers it again after the owner deletes it, so a member's first page always finds the
 * Workspace it may start Sessions in. Members never create it.
 *
 * @module @mumbo/edge-member/project-workspace
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: the domain/changed event merge.
import type {} from '@deepseek-ai/dsh-storage-domain'
// Type-only: the Workspace registry service merge (ctx.workspaceRegistry).
import type {} from '@deepseek-ai/dsh-workspace'
import z from '@deepseek-ai/schemastery'

/** Storage domain and table of the Workspace registry's records; persisted names never change. */
const WORKSPACE_DOMAIN = 'workspace'
const WORKSPACE_TABLE = 'workspaces'

/** Cordis function-plugin name. */
export const name = 'mumbo-project-workspace'
/** The Workspace registry that owns the record. */
export const inject = ['workspaceRegistry']

/** Project Workspace configuration. */
export interface Config {
  /**
   * Existing directory registered as the project Workspace, in a canonical absolute spelling; the same value as
   * `@mumbo/edge-member`'s `workspace`.
   */
  readonly workspace: string
}

export const Config: z<Config> = z.object({
  workspace: z.string().required(),
})

/**
 * Register the project Workspace unless one exists at its path, and register it again whenever its own record is
 * deleted. The registry matches the canonical path, so a present Workspace causes no write. Deleting another
 * Workspace, or the registry rolling back a failed create, deletes a different record and starts no create.
 * @param ctx - plugin context carrying the Workspace registry.
 * @param config - validated configuration.
 * @throws when the path is relative, missing, or not a directory, or the registry write fails; the entry then fails
 *   at load and other entries keep running.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  let id: string | undefined
  ctx.on('domain/changed', (change) => {
    if (change.domain !== WORKSPACE_DOMAIN || change.table !== WORKSPACE_TABLE || change.operation !== 'deleted'
      || change.key !== id) return
    // The registry queues this create behind the deletion that emitted the change.
    ctx.workspaceRegistry.create(config.workspace).then((workspace) => { id = workspace.id }, (error: unknown) => {
      ctx.logger.error(`mumbo-project-workspace: registering ${config.workspace} again after a deletion failed`, error)
    })
  })
  id = (await ctx.workspaceRegistry.create(config.workspace)).id
}
