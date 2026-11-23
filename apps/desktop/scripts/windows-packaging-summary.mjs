/** Render Windows packaging inputs and resolved build identity without loading machine configuration. */
import { appendFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

function text(value) {
  return value.replace(/[&<>"'|`\r\n\\*_\[\]()!~:]/gu, character => `&#${character.charCodeAt(0)};`)
}

/**
 * Summarize allowlisted workflow inputs separately from resolved checkout and version values.
 * @param {NodeJS.ProcessEnv} environment Workflow inputs and GitHub run identity.
 * @returns {string} Markdown parameter tables; no signature or publication success claim.
 */
export function windowsPackagingSummary(environment) {
  const row = (label, value, fallback = 'not provided') => `| ${label} | ${value ? `<code>${text(value)}</code>` : fallback} |`
  return [
    '## Windows packaging parameters', '',
    'These are the input parameters and resolved values; they do not indicate that build, signing, or publication succeeded. Each step status reports its own result.', '',
    '### Input parameters', '', '| Item | Selected value |', '| --- | --- |',
    row('Source ref', environment.PACKAGE_SOURCE_REF),
    row('Environment', environment.DSH_PACKAGING_PRESET),
    row('Update channel', environment.DSH_DESKTOP_UPDATE_CHANNEL),
    row('Version mode', environment.PACKAGE_INPUT_VERSION_MODE),
    row('Manual version', environment.PACKAGE_BUILD_VERSION, 'not set'),
    row('Signing (requested)', environment.PACKAGE_SIGNING),
    row('Installer compression level', environment.PACKAGE_WINDOWS_COMPRESSION_LEVEL),
    row('Test release ID (input)', environment.PACKAGE_TEST_RELEASE_ID, 'machine default (not read by this summary)'),
    row('Cache namespace', environment.PACKAGE_CACHE_NAMESPACE, 'shared cache'), '',
    '### Run information', '', '| Item | Known value |', '| --- | --- |',
    row('Platform', 'win-x64'),
    row('Workflow ref', environment.GITHUB_WORKFLOW_REF),
    row('Workflow SHA', environment.GITHUB_WORKFLOW_SHA),
    row('Checked-out source SHA', environment.PACKAGE_SOURCE_SHA, 'not available yet'),
    row('Resolved version', environment.PACKAGE_VERSION, 'not resolved yet'),
    row('Runner', environment.RUNNER_NAME),
    row('Run ID', environment.GITHUB_RUN_ID),
    row('Attempt', environment.GITHUB_RUN_ATTEMPT), '',
  ].join('\n')
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.env.GITHUB_STEP_SUMMARY) throw new Error('Windows packaging summary requires GITHUB_STEP_SUMMARY')
  await appendFile(process.env.GITHUB_STEP_SUMMARY, windowsPackagingSummary(process.env))
}
