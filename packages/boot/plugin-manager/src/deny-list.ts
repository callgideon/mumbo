/**
 * The row that carries a deployment's deny list. Profile composition and the plugin manager read the row's config
 * through `readProfileDenyList` of `@deepseek-ai/dsh-app-boot`; this plugin validates the config and registers nothing.
 * The config is read before any plugin exists, so it is read even when the row is disabled: disabling the row does not
 * turn the list off.
 */
import z from '@deepseek-ai/schemastery'

/** Stable plugin name. */
export const name = 'plugin-deny-list'

/** What cannot be enabled in this deployment, by any caller. */
export interface Config {
  /** Bundle package names: a selected one contributes no rows, and `setBundleEnabled` and installation cannot select one. */
  bundles?: string[]
  /** Row ids: `setPluginEnabled` cannot enable one, and the profile and home patch files cannot change its `disabled` value. */
  rows?: string[]
}

/** Schema for {@link Config}. */
export const Config: z<Config> = z.object({
  bundles: z.array(z.string()).default([]),
  rows: z.array(z.string()).default([]),
})

/** Register nothing: the config is read from the composed profile, before and after this row mounts. */
export function apply(): void {}
