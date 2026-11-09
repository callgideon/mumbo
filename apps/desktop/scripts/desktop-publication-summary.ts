/** Render the verified publication plan for GitHub's native deployment reviewers. */
import { load } from 'js-yaml'
import { z } from 'zod'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { desktopWebsiteInstallerUrl } from './desktop-auto-update-environment.mjs'
import type { DesktopRetainedSource } from './desktop-release-store.ts'
import type { DesktopUploadPlan } from './desktop-upload-plan.ts'

function text(value: string): string {
  return value.replace(/[&<>"'|`\r\n\\*_\[\]()!~:]/gu, character => `&#${character.charCodeAt(0)};`)
}

function code(value: string): string { return `<code>${text(value)}</code>` }
function row(label: string, value: string): string { return `| ${label} | ${value} |` }
function link(url: string, label = url): string { return `<a href="${text(url)}">${text(label)}</a>` }

/**
 * Render Chinese approval details after package, destination and signature verification succeeds.
 * @param source Verified retained packaging identity; a test plan requires its validated release ID.
 * @param plan Validated upload plan; YAML contents are the bytes that will be uploaded.
 * @param approval Digest bound to the approved manifest and upload plan.
 * File SHA-256 hex supports `shasum -a 256` on downloads; upload reconciliation separately uses SHA-512 base64.
 * @param uploadWebsite Whether the selected operation also replaces the production website installer.
 * @returns GitHub-flavored Markdown with final URLs and upload-byte fingerprints, without credentials or local paths.
 */
export async function desktopPublicationSummary(
  source: DesktopRetainedSource, plan: DesktopUploadPlan, approval: string, uploadWebsite: boolean,
): Promise<string> {
  const origin = new URL(plan.publicUrl).origin
  const url = (key: string) => `${origin}/${key.split('/').map(encodeURIComponent).join('/')}`
  const files = []
  for (const file of plan.artifacts) {
    const hash = createHash('sha256')
    let size = 0
    const bytes = file.contents === undefined ? createReadStream(file.path) : [Buffer.from(file.contents)]
    for await (const chunk of bytes) { size += chunk.length; hash.update(chunk) }
    files.push(row(link(url(file.key), file.filename), `${size} bytes | ${code(hash.digest('hex'))}`))
  }
  const installerExtension = plan.target === 'win-x64' ? '.exe' : '.dmg'
  const installers = plan.artifacts.filter(file => !file.channelMetadata && file.filename.endsWith(installerExtension))
  const feeds = plan.artifacts.filter(file => file.channelMetadata)
  const runUrl = `https://github.com/${source.repository}/actions/runs/${source.runId}/attempts/${source.attempt}`
  const environment = plan.environment === 'test' ? 'desktop-test' : 'desktop-production'
  const tag = plan.environment === 'production' ? code(`desktop-v${plan.version}`) : 'Not created (test environment)'
  return [
    '', '## Confirm before publishing', '',
    `After checking the information below, click **Review deployments**, select ${code(environment)}, and click **Approve and deploy**; if anything is wrong, click **Reject**.`, '',
    '| Item | Release information |', '| --- | --- |',
    row('Environment', code(plan.environment)),
    row('Version', code(plan.version)),
    row('Update channel', code(source.channel)),
    ...feeds.map((feed) => {
      const metadata = z.object({ stagingPercentage: z.number().optional() }).parse(load(feed.contents!))
      return row('Staged rollout percentage', metadata.stagingPercentage === undefined ? 'Full (not set)' : `${metadata.stagingPercentage}%`)
    }),
    row('Platform', code(plan.target)),
    ...(plan.environment === 'test' ? [row('Test release ID', `${code(source.testReleaseId!)}<br>Random prefix of the test download path, used to make the address harder to guess; consecutive upgrade tests must use the same value.`)] : []),
    row('Download URL preview', `${installers.map(file => link(url(file.key))).join('<br>')}<br>Target addresses after publishing; downloads are not guaranteed before approval.`),
    row('Update YAML', `${feeds.map(file => link(url(file.key))).join('<br>')}<br>This release will update this file; before approval it may not exist or may still point to the old version.`),
    row('Package source', `${link(runUrl, `View packaging run #${source.runId} · attempt ${source.attempt}`)}<br>Source: ${code(`${source.sourceRef} @ ${source.commit}`)}<br>Packaging machine: ${code(source.runnerName)}`),
    row('Signing and notarization', plan.target === 'win-x64' ? 'EXE signature verified' : 'DMG verified<br>App inside ZIP verified'),
    ...(uploadWebsite && plan.environment === 'production' ? [row('Pinned website installer',
      `${link(desktopWebsiteInstallerUrl(plan.target))}<br>Replaced with version ${code(plan.version)}; the existing installer will be replaced, with no downgrade protection; the website upload and refresh run in a later job and may need separate approval.`)] : []),
    row('Git tag', tag), '', '### Runs after approval', '',
    '1. Re-verify the artifacts and release target; stop if they differ from the approval digest.',
    '2. Upload missing files and skip existing files with identical content; stop on a content conflict.',
    '3. Update the update YAML above and save the release record.',
    ...(plan.environment === 'production' ? ['4. Create the Git tag above for the commit that was actually packaged; if tag creation fails, record "published, tag pending".'] : []), '',
    ...(plan.environment === 'test' ? ['**This release publishes to test only and does not modify production.**', ''] : []),
    '<details>', '<summary>Technical details and file list</summary>', '',
    `COS bucket: ${code(plan.bucket)}`, '',
    ...(plan.environment === 'test' ? [
      'The release ID comes from the original package manifest. When packaging, the form field `test_release_id` takes precedence; if left empty, `DOWNLOAD_TEST_RELEASE_ID` from the machine `presets/test.env` is used. It is not re-selected at publish time.', '',
    ] : []),
    `Approval digest SHA-256: ${code(approval)}`, '',
    `${plan.artifacts.length} files in total; sizes and SHA-256 correspond to the bytes actually uploaded, including the updated YAML content.`, '',
    '| File | Size | SHA-256 |', '| --- | --- | --- |', ...files, '', '</details>', '',
    'If the repository is public, the download paths in this summary and the release ID of a test release are also public. A random prefix is not a substitute for access authentication.', '',
  ].join('\n')
}
