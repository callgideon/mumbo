/**
 * The tests mumbo-ci's unit job leaves out: tests of code that no mumbo profile loads (the person box, the project box
 * and the desktop), of Windows-only code, and of gates that no mumbo pipeline runs. `vitest.mumbo-ci.config.ts`
 * applies the list; `mumbo-ci-unit-exclusions.spec.ts` fails when a mumbo profile starts loading an excluded package
 * or a mumbo pipeline starts running a script an excluded spec tests.
 */

/**
 * The evidence an exclusion rests on: no row, preset, optional bundle or loaded package reaches the package
 * (`not-mounted`), only Windows rows or Windows branches run it (`windows-only`), or no mumbo pipeline runs the
 * script the spec tests (`gate-not-run`).
 */
export type ExclusionCategory = 'not-mounted' | 'windows-only' | 'gate-not-run'

/** One path the unit job leaves out. */
export interface UnitExclusion {
  /** A package directory or package-directory glob, whose tests are left out, or a test-file glob; repository-relative. */
  readonly path: string
  /** The evidence category. */
  readonly category: ExclusionCategory
  /** One line naming the evidence. */
  readonly reason: string
  /** For a `windows-only` package: the loaded packages that depend on it for a Windows-only row or branch. */
  readonly loadedDependents?: readonly string[]
  /** For a `gate-not-run` spec: the scripts it tests, which no mumbo pipeline runs. */
  readonly subjects?: readonly string[]
}

/** The unit job's exclusions, one entry per package, package glob or spec glob. */
export const MUMBO_CI_UNIT_EXCLUSIONS: readonly UnitExclusion[] = [
  { path: 'packages/experimental/ptc-runtime-python', category: 'not-mounted', reason: 'No row or preset names it; only the installation manifest lists it, and its README says no shipped profile enables it.' },
  { path: 'packages/subagent/subagent-acp', category: 'not-mounted', reason: 'No bundle, preset or overlay row names it; only its own test fixtures mount it.' },
  { path: 'packages/subagent/subagent-dsh-sdk', category: 'not-mounted', reason: 'No bundle, preset or overlay row names it; only its own test fixtures mount it.' },
  { path: 'packages/sdk/client', category: 'not-mounted', reason: 'Client library for programs that drive dsh over stdio; no profile imports it.' },
  { path: 'packages/sdk/server', category: 'not-mounted', reason: 'Mounted only by the sdk profile bundles, which no mumbo box or desktop runs.' },
  { path: 'packages/acp/acp', category: 'not-mounted', reason: 'Mounted only by the acp profile bundle, which no mumbo box or desktop runs.' },
  { path: 'packages/bundle/acp-app', category: 'not-mounted', reason: 'The acp profile bundle; mumbo runs only the web profile.' },
  { path: 'packages/bundle/headless', category: 'not-mounted', reason: 'The headless profile bundle; mumbo runs only the web profile.' },
  { path: 'packages/bundle/sdk-app', category: 'not-mounted', reason: 'The sdk profile bundle; mumbo runs only the web profile.' },
  { path: 'packages/bundle/sdk-minimal', category: 'not-mounted', reason: 'The sdk-minimal profile bundle; mumbo runs only the web profile.' },
  { path: 'packages/lsp/*', category: 'not-mounted', reason: 'No row names the language-server packages.' },
  { path: 'packages/ssh/*', category: 'not-mounted', reason: 'No row names the SSH execution packages.' },
  { path: 'packages/storage/storage-sqlite', category: 'not-mounted', reason: 'No row names it.' },
  { path: 'packages/fs/tool-str-replace-editor', category: 'not-mounted', reason: 'Only the installation manifest lists it; no web-profile row names it.' },
  { path: 'packages/context/tmux-context', category: 'not-mounted', reason: 'Only the installation manifest lists it; no web-profile row names it.' },
  { path: 'packages/experimental/hooks-codex', category: 'not-mounted', reason: 'Boxes mount only hooks-claude-code, for the first-run welcome; no row names hooks-codex.' },
  { path: 'packages/experimental/browser-use-stagehand-native', category: 'not-mounted', reason: 'Box browser tools run through browser-consent or playwright-mcp; no row names this provider.' },
  { path: 'packages/experimental/browser-use-chrome-devtools-mcp', category: 'not-mounted', reason: 'Box browser tools run through browser-consent or playwright-mcp; no row names this provider.' },
  { path: 'packages/experimental/computer-use-cua-driver-mcp', category: 'not-mounted', reason: 'No row names it, and cua-bundle does not depend on it.' },
  { path: 'packages/experimental/computer-use-cua-driver-native', category: 'not-mounted', reason: 'No row names it, and cua-bundle does not depend on it.' },
  { path: 'packages/experimental/subagent-oar', category: 'not-mounted', reason: 'No row names it.' },
  { path: 'packages/experimental/tool-subagent-oar', category: 'not-mounted', reason: 'No row names it.' },
  { path: 'packages/experimental/webhook', category: 'not-mounted', reason: 'No row names it.' },
  { path: 'packages/experimental/webhook-github', category: 'not-mounted', reason: 'No row names it.' },
  { path: 'packages/experimental/webworker-packer', category: 'not-mounted', reason: 'Packs the worker-preview image for apps/web build:preview, which no deploy build runs.' },
  { path: 'packages/experimental/client-ui-claude-code-mods', category: 'not-mounted', reason: 'Only claude-code-mods\' source-mode patch mounts it, and no profile applies that patch.' },
  { path: 'apps/plugin-market-generator', category: 'not-mounted', reason: 'Command that writes plugin-market indexes; no profile loads it.' },
  { path: 'packages/test-support/*', category: 'not-mounted', reason: 'Test infrastructure; no profile loads it.' },

  { path: 'packages/shell/pwsh-local', category: 'windows-only', reason: 'PowerShell executor; its rows are disabled off Windows, and terminal-bash imports only its pwsh-dialect helpers.', loadedDependents: ['@deepseek-ai/dsh-terminal-bash'] },
  { path: 'packages/shell/pwsh-sandbox', category: 'windows-only', reason: 'Every row that names it is disabled off Windows.', loadedDependents: ['@deepseek-ai/dsh-base', '@mumbo/superagent'] },
  { path: 'packages/shell/tool-pwsh', category: 'windows-only', reason: 'Every row that names it is disabled off Windows.', loadedDependents: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@mumbo/superagent'] },
  { path: 'packages/shell/tool-pwsh-persistent', category: 'windows-only', reason: 'Every row that names it is disabled off Windows.', loadedDependents: ['@deepseek-ai/dsh-web-app'] },
  { path: 'packages/sandbox/sandbox-windows-acl', category: 'windows-only', reason: 'Win32 ACL runner; sandbox-local imports it for its win32 chain only.', loadedDependents: ['@deepseek-ai/dsh-sandbox-local'] },
  { path: 'packages/subprocess/win32-process', category: 'windows-only', reason: 'Win32 process bindings; subprocess-local imports it for its win32 branch only.', loadedDependents: ['@deepseek-ai/dsh-subprocess-local'] },
  { path: 'apps/desktop/tests/*windows*.spec.ts', category: 'windows-only', reason: 'Windows packaging, signing and runtime of the desktop app; mumbo-desktop.yml builds macOS arm64 only.' },

  { path: 'scripts/oxlint-contract.spec.ts', category: 'gate-not-run', reason: 'The lint gate; mumbo-ci runs no lint gate.', subjects: ['scripts/run-oxlint.ts'] },
  { path: 'scripts/release/verify-packed-install.spec.ts', category: 'gate-not-run', reason: 'Installs packed npm release tarballs; mumbo publishes no npm packages.', subjects: ['scripts/release/verify-packed-install.ts'] },
  { path: 'scripts/migrate-sessions-to-v4.spec.ts', category: 'gate-not-run', reason: 'One-time contributor command; no mumbo pipeline runs it.', subjects: ['scripts/migrate-sessions-to-v4.ts'] },
  { path: 'scripts/{gen-third-party-notices,browser-bundled-externals}.spec.ts', category: 'gate-not-run', reason: 'Release third-party notices; neither the static job nor the image build writes them.', subjects: ['scripts/gen-third-party-notices.ts', 'scripts/browser-bundled-externals.ts'] },
  { path: 'scripts/local-bundle-registry.spec.ts', category: 'gate-not-run', reason: 'The dev:bundle-registry development server; no pipeline runs it.', subjects: ['scripts/local-bundle-registry.ts'] },
  { path: 'scripts/publint-all.spec.ts', category: 'gate-not-run', reason: 'The publint gate; mumbo-ci runs no publint gate.', subjects: ['scripts/publint-all.ts'] },
  { path: 'scripts/build-exe-for-python-sdk*.spec.ts', category: 'gate-not-run', reason: 'The Python SDK executable build; mumbo ships no Python SDK.', subjects: ['scripts/build-exe-for-python-sdk.ts'] },
  { path: 'scripts/python-runtime-download.spec.ts', category: 'gate-not-run', reason: 'The Python SDK runtime download; mumbo ships no Python SDK.', subjects: ['python/sdk-runtime/runtime-bootstrap.mjs'] },
  { path: 'scripts/cua-helper/payload.spec.ts', category: 'gate-not-run', reason: 'Staging of the released computer-use helper payload; the desktop package step does not run it.', subjects: ['scripts/cua-helper/payload.ts'] },
  { path: 'scripts/rescope-vendor.spec.ts', category: 'gate-not-run', reason: 'The vendor rescope command; mumbo-upstream-sync does not run it.', subjects: ['scripts/rescope-vendor.ts'] },
  { path: 'scripts/session-query-spill-command.spec.ts', category: 'gate-not-run', reason: 'A recorded-session snapshot fixture; mumbo-ci runs no snapshot lane.', subjects: ['scripts/snapshot-spill-locators.ts'] },
  { path: 'scripts/snapshot-shell-path.spec.ts', category: 'gate-not-run', reason: 'A recorded-session snapshot helper; mumbo-ci runs no snapshot lane.', subjects: ['scripts/snapshot-shell-path.ts'] },
]

/**
 * The Vitest exclude globs for the exclusions.
 * @returns one glob per exclusion: a test-file glob as written, a package directory or directory glob followed by `/**`.
 */
export function mumboCiUnitExcludeGlobs(): string[] {
  return MUMBO_CI_UNIT_EXCLUSIONS.map(({ path }) => path.endsWith('.ts') ? path : `${path}/**`)
}
