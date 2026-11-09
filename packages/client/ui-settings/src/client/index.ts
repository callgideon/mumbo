/** Shared configuration forms and their Host describe mirror. */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the ctx.remote merge and the carrier's `connection/reset`
// lifecycle event, all through the assembly package.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only pair supplying `$on` and its key face without dragging a build
// artifact into the Host graph (rationale beside the same pair in
// config-form.ts).
import type {} from '@deepseek-ai/dsh-api-remotes/types'
// Type-only: pulls the remoteAccess service merge (ctx.remoteAccess).
import type {} from '@deepseek-ai/dsh-api-remote-access/client'
import type {} from '@deepseek-ai/dsh-settings/types'
import { SettingsSchemaService } from './schema.ts'
import { ConfigForms } from './config-form.ts'
import { SettingsDescribeMirror } from './settings-mirror.ts'

export type {
  SettingsLauncherOwnerProps, SettingsGeneralItemOwnerProps, SettingsHeaderOwnerProps, SettingsOnboardingOwnerProps,
  SettingsPluginsTabOwnerProps, SettingsSectionIconOwnerProps, SettingsSectionOwnerProps, SettingsTriggerOwnerProps,
} from './contract/slots.ts'
export type { ConfigForms } from './config-form.ts'
export type { ConfigForm, ConfigFormSnapshot } from './config-form-types.ts'
export type { SettingsSchemaService } from './schema.ts'
export type { SchemaNode } from './schema.ts'
export type {
  SettingsDescribeFace, SettingsDescribeView, SettingsMirrorSnapshot,
} from './settings-mirror.ts'

/**
 * Required services: the Remote namespace the mirror reads through, the
 * forwarded settings invalidation it refreshes on, and the access answer
 * that decides whether this page reads the settings document at all.
 */
export const inject = ['remote', 'remote.settings', 'remoteAccess']

/** Provide shared forms and refresh them on document changes and reconnects.
 * @param ctx Client provider context.
 */
export function apply(ctx: Context): void {
  const schema = new SettingsSchemaService(ctx)
  // Persistence policy: every authenticated browser persists through the Host document
  // (.agents/notes/implemented/bug-fix/2026-09-15-authenticated-browser-host-preferences.md).
  // A page whose Peer may not call `settings/describe` reads nothing, so its forms stay unanswered.
  let readable = false
  const mirror = new SettingsDescribeMirror(ctx, () => readable)
  ctx.remoteAccess.whenAccess('settings/describe', function* () {
    readable = true
    yield () => { readable = false }
    yield ctx.remote.$on('settings/document-updated', () => { void mirror.load() })
    yield ctx.on('connection/reset', () => { void mirror.load() })
    // The first connection also emits connection/reset, so startup normally
    // costs two reads (budgeted in startup-rpc-budget.e2e.ts). The in-flight
    // fold does not merge them into one; it guarantees at most one pending
    // read at a time and that no invalidation arriving mid-read is lost.
    void mirror.ensure()
  })
  new ConfigForms(ctx, { mirror, schema })
}
