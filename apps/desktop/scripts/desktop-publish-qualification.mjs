/** Explain why retained debugging packages cannot enter either publication environment. */

/**
 * Return rebuilding instructions for debugging packages.
 * @param {string} qualification Recorded package qualification.
 * @returns {string | undefined} Diagnostic, or undefined for a non-debugging qualification.
 */
export function desktopPublishQualificationError(qualification) {
  const remedy = qualification === 'unsigned'
    ? 'This package is unsigned. Re-run Windows packaging and select signing=signed.'
    : qualification === 'unnotarized'
      ? 'This package skipped notarization (unnotarized). Re-run macOS packaging, clear the "skip notarization" option, and complete notarization and stapling.'
      : undefined
  return remedy && `desktop publish: ${remedy} This artifact is for internal debugging only and cannot be published to test or production or used for automatic updates. After packaging succeeds, publish with the new run ID / attempt; re-running the current publish job has no effect.`
}
