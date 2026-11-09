/**
 * Reject CJK Unified Ideographs (U+3400–U+9FFF, U+F900–U+FAFF,
 * U+20000–U+2FFFF) in every tracked text file. A file containing a NUL byte
 * is binary and skipped; symbolic links are skipped because their target is
 * scanned on its own. Each `scripts/no-cjk-allowlist.json` entry names a path
 * or glob, an optional line regular expression, and a required reason; an
 * entry that allows nothing fails so stale exceptions cannot accumulate.
 */

import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync } from 'node:fs'
import { posix, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const ALLOWLIST_PATH = 'scripts/no-cjk-allowlist.json'
const CJK = /[\u{3400}-\u{9FFF}\u{F900}-\u{FAFF}\u{20000}-\u{2FFFF}]/u

/** One allowlisted exception. */
export interface CjkAllowEntry {
  /** Repository-relative path or glob, with `/` separators. */
  path: string
  /** Regular expression an allowed line must match; every line of a matched path when absent. */
  line?: string
  /** Why the text stays. */
  reason: string
}

/** One tracked line containing a CJK ideograph. */
export interface CjkViolation {
  /** Repository-relative path with `/` separators. */
  file: string
  /** 1-based line number. */
  line: number
  /** The line's text. */
  text: string
}

/**
 * Parse and validate the allowlist file.
 * @param content - JSON text of `scripts/no-cjk-allowlist.json`.
 * @returns The validated entries in file order.
 * @throws When the file is not an array of `{ path, line?, reason }` objects with non-empty strings and valid line patterns.
 */
export function parseCjkAllowlist(content: string): CjkAllowEntry[] {
  const value: unknown = JSON.parse(content)
  if (!Array.isArray(value)) throw new Error(`${ALLOWLIST_PATH}: expected an array of entries`)
  const entries: unknown[] = value
  return entries.map((entry, index) => {
    const label = `${ALLOWLIST_PATH}[${String(index)}]`
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new Error(`${label}: expected an object`)
    const fields = entry as Record<string, unknown>
    const unknown = Object.keys(fields).filter(key => key !== 'path' && key !== 'line' && key !== 'reason')
    if (unknown.length > 0) throw new Error(`${label}: unsupported field(s) ${unknown.join(', ')}`)
    const { path, line, reason } = fields
    if (typeof path !== 'string' || path.trim() === '') throw new Error(`${label}: path must be a non-empty string`)
    if (typeof reason !== 'string' || reason.trim() === '') throw new Error(`${label}: reason must be a non-empty string`)
    if (line === undefined) return { path, reason }
    if (typeof line !== 'string' || line === '') throw new Error(`${label}: line must be a non-empty regular expression`)
    try {
      RegExp(line, 'u')
    } catch (error) {
      throw new Error(`${label}: line is not a valid regular expression: ${String(error)}`)
    }
    return { path, line, reason }
  })
}

/**
 * Find CJK ideographs in one file's bytes.
 * @param file - Repository-relative path reported with each line.
 * @param content - Complete file bytes.
 * @returns One violation per offending line; empty for binary content.
 */
export function findCjkLines(file: string, content: Buffer): CjkViolation[] {
  if (content.includes(0)) return []
  const text = content.toString('utf8')
  if (!CJK.test(text)) return []
  return text.split(/\r?\n/u).flatMap((line, index) => CJK.test(line) ? [{ file, line: index + 1, text: line }] : [])
}

/**
 * Scan every tracked file of a Git work tree.
 * @param repoRoot - Work tree root.
 * @returns Violations in path order and the number of files read.
 */
export function scanTrackedFiles(repoRoot: string): { violations: CjkViolation[]; scanned: number } {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 1 << 28 })
    .split('\0').filter(file => file !== '').sort()
  const violations: CjkViolation[] = []
  let scanned = 0
  for (const file of files) {
    const absolute = resolve(repoRoot, file)
    const stats = lstatSync(absolute, { throwIfNoEntry: false })
    // Deleted-but-staged paths, symbolic links, and submodule directories have no text of their own.
    if (stats?.isFile() !== true) continue
    scanned++
    violations.push(...findCjkLines(file, readFileSync(absolute)))
  }
  return { violations, scanned }
}

function allows(entry: CjkAllowEntry, violation: CjkViolation): boolean {
  return (entry.path === violation.file || posix.matchesGlob(violation.file, entry.path))
    && (entry.line === undefined || new RegExp(entry.line, 'u').test(violation.text))
}

/**
 * Remove allowlisted violations and report entries that allowed nothing.
 * @param violations - Every scanned violation.
 * @param entries - Validated allowlist entries.
 * @returns The violations no entry allows, and the entries that allowed no violation.
 */
export function applyCjkAllowlist(
  violations: readonly CjkViolation[],
  entries: readonly CjkAllowEntry[],
): { remaining: CjkViolation[]; unused: CjkAllowEntry[] } {
  const used = new Set<CjkAllowEntry>()
  const remaining = violations.filter((violation) => {
    const entry = entries.find(candidate => allows(candidate, violation))
    if (entry === undefined) return true
    used.add(entry)
    return false
  })
  return { remaining, unused: entries.filter(entry => !used.has(entry)) }
}

/**
 * Run the gate over one work tree and its allowlist.
 * @param repoRoot - Work tree root containing `scripts/no-cjk-allowlist.json`.
 * @returns Failure lines (empty when the tree passes) and the number of files read.
 */
export function verifyNoCjk(repoRoot: string): { failures: string[]; scanned: number } {
  const entries = parseCjkAllowlist(readFileSync(resolve(repoRoot, ALLOWLIST_PATH), 'utf8'))
  const { violations, scanned } = scanTrackedFiles(repoRoot)
  const { remaining, unused } = applyCjkAllowlist(violations, entries)
  return {
    scanned,
    failures: [
      ...remaining.map(violation => `${violation.file}:${String(violation.line)}: ${violation.text.trim().slice(0, 120)}`),
      ...unused.map(entry => `${ALLOWLIST_PATH}: entry ${JSON.stringify(entry.path)}${entry.line === undefined ? '' : ` (line ${JSON.stringify(entry.line)})`} allows nothing; remove it`),
    ],
  }
}

if (import.meta.filename === resolve(process.argv[1] ?? '')) {
  const { failures, scanned } = verifyNoCjk(root)
  if (failures.length > 0) {
    console.error(`verify-no-cjk: ${String(failures.length)} failure(s) in ${String(scanned)} tracked file(s). Write English, or add a reasoned entry to ${ALLOWLIST_PATH}:`)
    for (const failure of failures) console.error(`  ${failure}`)
    process.exitCode = 1
  } else {
    console.log(`verify-no-cjk: ${String(scanned)} tracked file(s) contain no CJK ideographs outside the allowlist.`)
  }
}
