import { describe, expect, it } from 'vitest'
import {
  extendArchiveManifest,
  parseArchiveManifest,
  renderArchiveManifest,
  validateArchiveArtifacts,
  validateArchiveManifestExtension,
  type ArchiveManifest,
} from './archived-agent-notes.ts'
import { isArchivedAgentNotePath } from './repo-files.ts'

const BASE = '2026-07-26-example'

function fixture(): Map<string, Buffer> {
  return new Map([
    [`process/${BASE}.md`, Buffer.from('# Agent Note: Example\n\nStatus: implemented\nArchived: 2026-07-26\n\n## Problem\n\nExample.\n')],
  ])
}

describe('archived Agent Notes', () => {
  it('recognizes archived paths with POSIX and Windows separators', () => {
    expect(isArchivedAgentNotePath('.agents/notes/archived/process/example.md')).toBe(true)
    expect(isArchivedAgentNotePath('.agents\\notes\\archived\\process\\example.md')).toBe(true)
    expect(isArchivedAgentNotePath('.agents/notes/implemented/process/example.md')).toBe(false)
  })

  it('accepts one implemented note with matching archive metadata', () => {
    expect(validateArchiveArtifacts(fixture())).toEqual([])
  })

  it('preserves historical formatting', () => {
    const artifacts = new Map([[`process/${BASE}.md`, Buffer.from('# Historical decision\nStatus: implemented\nArchived: 2026-07-26\n')]])
    expect(validateArchiveArtifacts(artifacts)).toEqual([])
  })

  it.each([
    ['Status: proposed\nArchived: 2026-07-26', /requires `Status: implemented`/],
    ['Status: implemented\n\nArchived: 2026-07-26', /immediately after the status/],
    ['Status: implemented\nArchived: 2026-02-30', /valid date/],
    ['Status: implemented\nArchived: 2026-07-25', /predates the note filename/],
  ])('rejects invalid archive metadata: %s', (metadata, error) => {
    const artifacts = new Map([[`process/${BASE}.md`, Buffer.from(`# Historical decision\n${metadata}\n`)]])
    expect(validateArchiveArtifacts(artifacts).join('\n')).toMatch(error)
  })

  it.each([`process/${BASE}.zh.md`, `process/${BASE}.i18n.yaml`, 'process/example.md'])('rejects the non-note file %s', (path) => {
    const artifacts = fixture()
    artifacts.set(path, Buffer.from('Status: implemented\nArchived: 2026-07-26\n'))
    expect(validateArchiveArtifacts(artifacts)).toEqual([`${path}: expected {kind}/yyyy-mm-dd-topic.md`])
  })

  it('extends the manifest without permitting a sealed change or removal', () => {
    const artifacts = fixture()
    const empty: ArchiveManifest = { version: 1, files: {} }
    const first = extendArchiveManifest(empty, artifacts)
    expect(first.errors).toEqual([])
    expect(first.added).toHaveLength(1)

    const sealed: ArchiveManifest = { version: 1, files: first.files }
    const changed = new Map(artifacts)
    changed.set('process/2026-07-26-example.md', Buffer.from('changed'))
    expect(extendArchiveManifest(sealed, changed).errors).toEqual([
      'process/2026-07-26-example.md: sealed content hash changed',
    ])
    changed.delete('process/2026-07-26-example.md')
    expect(extendArchiveManifest(sealed, changed).errors).toEqual([
      'process/2026-07-26-example.md: sealed artifact is missing',
    ])
  })

  it('rejects replacing manifest seals alongside changed archive content', () => {
    const artifacts = fixture()
    const initial = extendArchiveManifest({ version: 1, files: {} }, artifacts)
    const baseline: ArchiveManifest = { version: 1, files: initial.files }
    const path = 'process/2026-07-26-example.md'
    const changedArtifacts = new Map(artifacts)
    changedArtifacts.set(path, Buffer.from('changed'))
    const replacement = extendArchiveManifest({ version: 1, files: {} }, changedArtifacts)
    const current: ArchiveManifest = { version: 1, files: replacement.files }

    expect(extendArchiveManifest(current, changedArtifacts).errors).toEqual([])
    expect(validateArchiveManifestExtension(baseline, current)).toEqual([
      `${path}: sealed manifest hash changed`,
    ])
    const removed: ArchiveManifest = {
      version: 1,
      files: Object.fromEntries(Object.entries(current.files).filter(([candidate]) => candidate !== path)),
    }
    expect(validateArchiveManifestExtension(baseline, removed)).toContain(
      `${path}: sealed manifest entry is missing`,
    )
  })

  it('replaces a baseline that still seals bilingual files only with the recorded English-only archive', () => {
    const hash = (digit: string): string => `sha256:${digit.repeat(64)}`
    const bilingual: ArchiveManifest = {
      version: 1,
      files: { 'process/a.md': hash('1'), 'process/a.zh.md': hash('2'), 'process/a.i18n.yaml': hash('3') },
    }
    const english: ArchiveManifest = { version: 1, files: { 'process/a.md': hash('4') } }
    expect(validateArchiveManifestExtension(bilingual, english)).toEqual([
      'archived/manifest.json: a baseline that seals Chinese files accepts only the recorded English-only replacement; base the change on the English-only archive',
    ])
    expect(validateArchiveManifestExtension(english, { version: 1, files: { 'process/a.md': hash('5') } })).toEqual([
      'process/a.md: sealed manifest hash changed',
    ])
    expect(validateArchiveManifestExtension(english, { version: 1, files: {} })).toEqual([
      'process/a.md: sealed manifest entry is missing',
    ])
  })

  it('round-trips the deterministic manifest schema', () => {
    const content = renderArchiveManifest({ 'process/z.md': `sha256:${'a'.repeat(64)}` })
    expect(parseArchiveManifest(content)).toEqual({
      version: 1,
      files: { 'process/z.md': `sha256:${'a'.repeat(64)}` },
    })
  })
})
