/**
 * What a project member may call: the roles every `edge-member` principal holds and the resources they bind.
 *
 * @module @mumbo/edge-member/src/access
 */

import type { Context } from '@deepseek-ai/cordis'
import type { RemoteAccessBinding, RemoteAccessRole } from '@deepseek-ai/dsh-api-remote-access'
import type { SessionId } from '@deepseek-ai/dsh-session'

/**
 * Host-wide reads a collaborator's page needs, and starting a Session; list and follow results are filtered per
 * Session and Workspace. `hostFiles/readAny` is excluded: `/api/file` reads any file the box can read, including
 * its secrets and every Session log.
 */
export const MEMBER_GLOBAL_ROLE: RemoteAccessRole<'global'> = {
  name: 'mumbo:member-global',
  resource: 'global',
  actions: [
    'agentPresets/list',
    'commands/list',
    'llm/listConfigurableProviders',
    'llm/listProviders',
    'session/canOpenWorkspacePath',
    'session/control',
    'session/create',
    'session/list',
    'session/modelCatalog',
    'session/search',
    'web/listProviders',
    'workspace/follow',
  ],
}

/**
 * Reading, following, prompting, and stopping one Session, reading its jobs and workspace files, uploading files
 * for it through the Remote or the browser's binary route, downloading its log archive and copying it as Markdown,
 * answering its questions, and reusing it as a blank Session. Queue edits are excluded: an edit keeps the edited
 * message's source, so it would record one person's text as another's.
 */
export const MEMBER_SESSION_ROLE: RemoteAccessRole<'session'> = {
  name: 'mumbo:member-session',
  resource: 'session',
  actions: [
    'commands/list',
    'fileUploads/upload',
    'fileUploads/uploadBinary',
    'goals/get',
    'job/list',
    'session/attachment',
    'session/cancel',
    'session/control',
    'session/create',
    'session/events',
    'session/follow',
    'session/list',
    'session/observeEvent',
    'session/observeProjections',
    'session/observeState',
    'session/page',
    'session/projections',
    'session/prompt',
    'session/search',
    'session/state',
    'session/wait',
    'sessionLog/export',
    'sessionLog/markdown',
    'skills/list',
    'toolResults/watch',
    'userQuestions/answer',
    'userQuestions/attachWait',
    'workspace/follow',
    'workspaceFiles/changes',
    'workspaceFiles/list',
    'event:api-session/activity',
    'event:api-session/added',
    'event:api-session/error',
    'event:api-session/removed',
    'event:api-session/status',
  ],
}

/** Following one Workspace and starting a Session in it. */
export const MEMBER_WORKSPACE_ROLE: RemoteAccessRole<'workspace'> = {
  name: 'mumbo:member-workspace',
  resource: 'workspace',
  actions: ['workspace/follow', 'session/create'],
}

/**
 * The bindings every member holds, rebuilt only after the Sessions or Workspaces change.
 *
 * Every member holds the global role, the Workspace role on every Workspace, and the Session role on every
 * Session a Workspace lists and every live Session, which includes subagent children while they run.
 */
export class MemberBindings {
  private cached: readonly RemoteAccessBinding[] | undefined

  /** @param ctx - context carrying the Workspace registry and the live Session registry. */
  constructor(private readonly ctx: Context) {}

  /** @returns the current bindings of any `edge-member` principal. */
  current(): readonly RemoteAccessBinding[] {
    this.cached ??= this.build()
    return this.cached
  }

  /** Drop the cached bindings after a Session or Workspace change. */
  reset(): void {
    this.cached = undefined
  }

  private build(): RemoteAccessBinding[] {
    const bindings: RemoteAccessBinding[] = [{ role: MEMBER_GLOBAL_ROLE, resource: { kind: 'global' } }]
    const sessions = new Set<SessionId>()
    for (const workspace of this.ctx.workspaceRegistry.list()) {
      bindings.push({ role: MEMBER_WORKSPACE_ROLE, resource: { kind: 'workspace', id: workspace.id } })
      for (const id of workspace.sessionIds) sessions.add(id)
    }
    for (const session of this.ctx.sessions.list()) sessions.add(session.id)
    for (const id of sessions) bindings.push({ role: MEMBER_SESSION_ROLE, resource: { kind: 'session', id } })
    return bindings
  }
}
