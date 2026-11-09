/** Pure archive-format and immutable-manifest helpers. */

import { createHash } from 'node:crypto'
import { AGENT_NOTE_CLASSES } from './agent-note-tree.ts'

/** Versioned fields in the frozen-content manifest. */
export interface ArchiveManifest {
  version: 1
  files: Readonly<Record<string, string>>
}

/** Hash one archived artifact independently of the repository's Git object format. */
function archiveContentHash(content: Buffer): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Parse the archive manifest and reject fields or hashes outside its closed schema. */
export function parseArchiveManifest(content: string): ArchiveManifest {
  const value: unknown = JSON.parse(content)
  if (!isRecord(value)) throw new Error('expected a JSON object')
  const fields = Object.keys(value).sort()
  if (fields.join(',') !== 'files,version') throw new Error('expected exactly the fields `version` and `files`')
  if (value.version !== 1) throw new Error('unsupported manifest version (expected 1)')
  if (!isRecord(value.files)) throw new Error('`files` must be an object')
  const files: Record<string, string> = {}
  for (const [path, hash] of Object.entries(value.files)) {
    if (typeof hash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(hash)) {
      throw new Error(`invalid content hash for ${path}`)
    }
    files[path] = hash
  }
  return { version: 1, files }
}

/** Render the archive manifest with deterministic path ordering. */
export function renderArchiveManifest(files: Readonly<Record<string, string>>): string {
  return `${JSON.stringify({
    version: 1,
    files: Object.fromEntries(Object.entries(files).sort(([left], [right]) => left.localeCompare(right))),
  }, null, 2)}\n`
}

function isBilingualOnly(path: string): boolean {
  return path.endsWith('.zh.md') || path.endsWith('.i18n.yaml')
}

/**
 * Digest of the English-only archive's replacement of the last bilingual
 * baseline: it removed every Chinese and pairing-record seal and three
 * translation-process notes, and resealed the other English notes without the
 * language switcher. A bilingual baseline accepts exactly this replacement;
 * after it, every seal is append-only again.
 */
const ENGLISH_ONLY_REPLACEMENT = 'sha256:8308d72743c8e9d804bc3ffe879988ce147cd7de7877232fa03ab037e3777f8c'

/** Hash each English baseline path with its old seal and its current seal, or `removed`. */
function englishOnlyReplacementDigest(baseline: ArchiveManifest, current: ArchiveManifest): string {
  const seals = Object.keys(baseline.files).filter(path => !isBilingualOnly(path)).sort()
    .map(path => `${path} ${baseline.files[path]} ${current.files[path] ?? 'removed'}\n`)
  return archiveContentHash(Buffer.from(seals.join('')))
}

/** Reject a removed or changed seal, except for the pinned English-only replacement of a bilingual baseline. */
export function validateArchiveManifestExtension(
  baseline: ArchiveManifest,
  current: ArchiveManifest,
): string[] {
  if (Object.keys(baseline.files).some(isBilingualOnly)) {
    return englishOnlyReplacementDigest(baseline, current) === ENGLISH_ONLY_REPLACEMENT ? [] : [
      'archived/manifest.json: a baseline that seals Chinese files accepts only the recorded English-only replacement; base the change on the English-only archive',
    ]
  }
  const errors: string[] = []
  for (const [path, expected] of Object.entries(baseline.files)) {
    const actual = current.files[path]
    if (actual === undefined) errors.push(`${path}: sealed manifest entry is missing`)
    else if (actual !== expected) errors.push(`${path}: sealed manifest hash changed`)
  }
  return errors
}

function validDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (match === null) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

function validateMetadata(path: string, content: Buffer, sourceBase: string): string[] {
  const errors: string[] = []
  const lines = content.toString('utf8').split('\n')
  const status = lines.findIndex(line => line.startsWith('Status:'))
  if (lines[status] !== 'Status: implemented') errors.push(`${path}: requires \`Status: implemented\``)
  const archived = /^Archived: (\d{4}-\d{2}-\d{2})$/.exec(lines[status + 1] ?? '')?.[1]
  if (status < 0 || archived === undefined || !validDate(archived)) {
    errors.push(`${path}: requires \`Archived: YYYY-MM-DD\` with a valid date immediately after the status`)
  } else if (archived < sourceBase.slice(0, 10)) {
    errors.push(`${path}: archive date ${archived} predates the note filename`)
  }
  return errors
}

/** Validate the closed kind tree and each archived note's implemented/archive metadata. */
export function validateArchiveArtifacts(artifacts: ReadonlyMap<string, Buffer>): string[] {
  const errors: string[] = []
  for (const [path, content] of [...artifacts].sort(([left], [right]) => left.localeCompare(right))) {
    const match = /^([^/]+)\/(\d{4}-\d{2}-\d{2}-.+)\.md$/.exec(path)
    if (match?.[1] === undefined || match[2] === undefined || match[2].endsWith('.zh')) {
      errors.push(`${path}: expected {kind}/yyyy-mm-dd-topic.md`)
      continue
    }
    if (!(AGENT_NOTE_CLASSES as readonly string[]).includes(match[1])) {
      errors.push(`${path}: unknown Agent Note kind ${JSON.stringify(match[1])}`)
      continue
    }
    errors.push(...validateMetadata(path, content, match[2]))
  }
  return errors
}

/** Preserve every sealed path/hash and append hashes for newly archived artifacts. */
export function extendArchiveManifest(
  existing: ArchiveManifest,
  artifacts: ReadonlyMap<string, Buffer>,
): { files: Record<string, string>; added: string[]; errors: string[] } {
  const errors: string[] = []
  const files: Record<string, string> = { ...existing.files }
  for (const [path, expected] of Object.entries(existing.files)) {
    const content = artifacts.get(path)
    if (content === undefined) errors.push(`${path}: sealed artifact is missing`)
    else if (archiveContentHash(content) !== expected) errors.push(`${path}: sealed content hash changed`)
  }
  const added: string[] = []
  for (const [path, content] of [...artifacts].sort(([left], [right]) => left.localeCompare(right))) {
    if (files[path] !== undefined) continue
    files[path] = archiveContentHash(content)
    added.push(path)
  }
  return { files, added, errors }
}
