/** Launcher-owned profile locations and composition inputs. */
import { join } from 'node:path'
import { composeEntries, loadProfileDirectory, PROFILE_PATCH_FILENAME, type Profile } from './profile.ts'
import { loadOptionalPatches, loadOverlayPatches } from './index.ts'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { interpolate } from '@deepseek-ai/cordis-plugin-loader'

/** Application-owned package manager executable; environment applies only to package operations. */
export interface ProfilePnpmInvocation {
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
}

/** Current profile facts; scheduling and mutation belong to their callers. */
export interface ProfileContext {
  readonly name: string
  /** Packaged applications supply their bundled runtime instead of a PATH executable. */
  readonly packageManager?: ProfilePnpmInvocation
  readonly dir: string
  readonly patchPath: string
  readonly installAnchor: string
  readonly cwd: string
  readonly home: string
  /** Bundle packages used to start this process, before any persisted edits. */
  readonly startedBundles: readonly string[]
  /** Absolute command-line overlay files in argv order, read on every composition and applied above profile and home patches. */
  readonly overlayPaths: readonly string[]
  /** Launch-time DSH_TELEMETRY_DISABLED value; any non-empty value opts out. */
  readonly telemetryDisabledEnv: string | undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Present only in a profile launched by dsh. */
    profileContext: ProfileContext
  }
}

const TELEMETRY_ROW_ID = 'session-telemetry-otel'

/**
 * Resolve the telemetry opt-out switch into its boot patch. ANY non-empty
 * value (including `'0'`/`'false'`) disables: a privacy switch prefers
 * off-by-mistake over on-by-mistake. A composition without the telemetry row
 * exports nothing, so the switch is then trivially satisfied and no patch is
 * generated — custom profiles need not mount telemetry to run with the
 * switch set.
 * @param disabledEnv - the raw `DSH_TELEMETRY_DISABLED` value (`undefined` when unset).
 * @param hasRow - whether the composition carries the telemetry row.
 * @returns the disable patch, or `undefined` when no hard-disable patch is required.
 */
export function resolveTelemetryPatch(disabledEnv: string | undefined, hasRow: boolean): PatchOptions | undefined {
  if ((disabledEnv ?? '') === '' || !hasRow) return undefined
  return { id: TELEMETRY_ROW_ID, disabled: true }
}

/** Read the selected bundles' patches, which apply before the profile patch file.
 * @param binName Diagnostic prefix for malformed or missing configuration.
 * @param context Data supplied by the profile launcher.
 * @param initialProfile Already loaded startup profile; omitted reads the current files.
 * @returns Bundle patches in application order.
 */
export function readBundlePatches(binName: string, context: ProfileContext, initialProfile?: Profile): PatchOptions[] {
  const profile = initialProfile ?? loadProfileDirectory(binName, context.dir, context.installAnchor, { userLayer: false })
  return profile.layers.flatMap(layer => layer.patches)
}

const DENY_LIST_ROW_ID = 'plugin-deny-list'

/** What the composed `plugin-deny-list` row forbids in this profile, and what profile composition left out for it. */
export interface ProfileDenyList {
  /** Bundle package names that contribute no patch layer and cannot be selected. */
  readonly bundles: readonly string[]
  /** Row ids whose `disabled` value the profile and home patch files cannot change. */
  readonly rows: readonly string[]
  /** The selected bundles and the patched rows that composition left out, in that order. */
  readonly dropped: readonly string[]
}

/** The current layers: bundle layers, then the profile and home patch files, then the command-line overlays. */
function readLayers(binName: string, context: ProfileContext, initialProfile?: Profile) {
  const profile = initialProfile ?? loadProfileDirectory(binName, context.dir, context.installAnchor, { userLayer: false })
  const user = [
    ...(initialProfile?.patches ?? loadOptionalPatches(binName, context.patchPath) ?? []),
    ...(loadOptionalPatches(binName, join(context.home, PROFILE_PATCH_FILENAME)) ?? []),
  ]
  const overlays = context.overlayPaths.flatMap(path => loadOverlayPatches(binName, path))
  const config: unknown = composeEntries([[...profile.layers.flatMap(layer => layer.patches), ...user, ...overlays]])
    .find(entry => entry.id === DENY_LIST_ROW_ID)?.config
  const list = (field: 'bundles' | 'rows'): string[] => {
    if (config === null || typeof config !== 'object' || !(field in config)) return []
    let value: unknown
    try {
      value = interpolate({}, (config as Record<string, unknown>)[field])
    } catch (error) {
      throw new Error(`${binName}: ${DENY_LIST_ROW_ID} ${field} could not be evaluated before plugins load`, { cause: error })
    }
    if (!Array.isArray(value) || value.some(name => typeof name !== 'string')) {
      throw new Error(`${binName}: ${DENY_LIST_ROW_ID} ${field} must be a list of strings`)
    }
    return value as string[]
  }
  const [bundles, rows] = [list('bundles'), list('rows')]
  const enables = (patch: PatchOptions): boolean => !('insert' in patch) && typeof patch.id === 'string' && rows.includes(patch.id)
    && 'disabled' in patch && patch.disabled !== true
  const dropped = [...new Set([
    ...profile.layers.map(layer => layer.packageName).filter(name => bundles.includes(name)),
    ...user.filter(enables).map(patch => patch.id as string),
  ])]
  return { profile, user, overlays, bundles, rows, dropped, enables }
}

/**
 * Read the deny list of the composed row with id `plugin-deny-list`. Composition runs before any plugin exists, so the
 * row's config is read even when the row is disabled, and disabling the row does not turn the list off. Its `!!js`
 * values are evaluated here without a plugin context, so they may read process facts such as `process.getuid()` but no service.
 * @param binName Diagnostic prefix for malformed configuration.
 * @param context Data supplied by the profile launcher.
 * @param initialProfile Already loaded startup profile; omitted reads the current files.
 * @returns The listed bundles and rows, and the ones {@link readProfilePatches} leaves out of the current files.
 * @throws When a patch file cannot be read, or a list cannot be evaluated or is not an array of strings.
 */
export function readProfileDenyList(binName: string, context: ProfileContext, initialProfile?: Profile): ProfileDenyList {
  const { bundles, rows, dropped } = readLayers(binName, context, initialProfile)
  return { bundles, rows, dropped }
}

/** Read current bundle, user, and command-line overlay layers. A selected bundle on the {@link readProfileDenyList deny list}
 * contributes no patches, and a `disabled` value other than `true` that the profile or home patch file gives a listed row is
 * left out; the files keep both. Command-line overlays are deliberately not filtered, because a deployment's own
 * overlays arrive that way.
 * @param binName Diagnostic prefix for malformed or missing configuration.
 * @param context Data supplied by the profile launcher.
 * @param initialProfile Already loaded startup profile; omitted reads the current files.
 * @returns Detached ordered patches; this function does not update the Loader.
 * @throws When a present patch file or any overlay file is missing, unreadable, or not a patch list, or when the deny
 * list is malformed.
 */
export function readProfilePatches(binName: string, context: ProfileContext, initialProfile?: Profile): PatchOptions[] {
  const { profile, user, overlays, bundles, enables } = readLayers(binName, context, initialProfile)
  const patches = structuredClone([
    ...profile.layers.filter(layer => !bundles.includes(layer.packageName)).flatMap(layer => layer.patches),
    ...user.map((patch) => {
      if (!enables(patch)) return patch
      const { disabled: _disabled, ...kept } = patch
      return kept
    }),
    ...overlays,
  ])
  const telemetryPatch = resolveTelemetryPatch(context.telemetryDisabledEnv,
    composeEntries([patches]).some(row => row.id === TELEMETRY_ROW_ID))
  if (telemetryPatch !== undefined) patches.push(telemetryPatch)
  return patches
}
