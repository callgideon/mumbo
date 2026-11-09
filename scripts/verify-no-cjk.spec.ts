import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applyCjkAllowlist, findCjkLines, parseCjkAllowlist, verifyNoCjk, type CjkAllowEntry } from './verify-no-cjk.ts'

const roots: string[] = []
// Escapes keep this spec itself free of the ideographs the gate rejects.
const IDEOGRAPH = '中文'
const COMPATIBILITY_IDEOGRAPH = '豈'
const EXTENSION_B_IDEOGRAPH = String.fromCodePoint(0x20000)

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function write(root: string, file: string, contents: string | Buffer): void {
  const path = join(root, file)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
}

function fixture(files: Record<string, string | Buffer>, allowlist: readonly CjkAllowEntry[] = []): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-no-cjk-'))
  roots.push(root)
  execFileSync('git', ['init', '--quiet'], { cwd: root })
  write(root, 'scripts/no-cjk-allowlist.json', `${JSON.stringify(allowlist)}\n`)
  for (const [file, contents] of Object.entries(files)) write(root, file, contents)
  execFileSync('git', ['add', '.'], { cwd: root })
  return root
}

describe('findCjkLines', () => {
  it('reports each line containing an ideograph from every rejected range', () => {
    const text = ['ascii', `a ${IDEOGRAPH}`, `b ${COMPATIBILITY_IDEOGRAPH}`, `c ${EXTENSION_B_IDEOGRAPH}`, '가あ · ，'].join('\r\n')
    expect(findCjkLines('doc.md', Buffer.from(text)).map(violation => violation.line)).toEqual([2, 3, 4])
  })

  it('skips binary content', () => {
    expect(findCjkLines('image.png', Buffer.concat([Buffer.from([0x89, 0x50, 0x00]), Buffer.from(IDEOGRAPH)]))).toEqual([])
  })
})

describe('verify-no-cjk', () => {
  it('rejects a planted CJK file with its path and line', () => {
    const root = fixture({ 'docs/guide.md': `# Guide\n\n${IDEOGRAPH}\n`, 'docs/clean.md': '# Clean\n' })
    expect(verifyNoCjk(root)).toEqual({ scanned: 3, failures: [`docs/guide.md:3: ${IDEOGRAPH}`] })
  })

  it('passes a clean tree and ignores untracked, binary, and symbolic-link paths', () => {
    const root = fixture({ 'docs/clean.md': '# Clean\n', 'assets/image.png': Buffer.concat([Buffer.from([0]), Buffer.from(IDEOGRAPH)]) })
    write(root, 'untracked.md', IDEOGRAPH)
    write(root, 'linked/target.md', '# Target\n')
    symlinkSync('../docs/clean.md', join(root, 'linked/alias.md'))
    execFileSync('git', ['add', 'linked'], { cwd: root })
    expect(verifyNoCjk(root).failures).toEqual([])
  })

  it('accepts an allowlisted path and line pattern but still rejects other lines', () => {
    const root = fixture(
      { 'docs/mixed.md': `keep ${IDEOGRAPH}\ndrop ${IDEOGRAPH}\n` },
      [{ path: 'docs/mixed.md', line: '^keep ', reason: 'Quoted product name.' }],
    )
    expect(verifyNoCjk(root).failures).toEqual([`docs/mixed.md:2: drop ${IDEOGRAPH}`])
  })

  it('accepts files a glob entry matches and still rejects files it does not match', () => {
    const root = fixture(
      {
        'packages/a/locale/ja.json': `{"title":"${IDEOGRAPH}"}\n`,
        'packages/b/locale/tools/ja.json': `{"title":"${IDEOGRAPH}"}\n`,
        'packages/c/locale/en.json': `{"title":"${IDEOGRAPH}"}\n`,
      },
      [{ path: '**/locale/**/ja.json', reason: 'Japanese locale.' }],
    )
    expect(verifyNoCjk(root).failures).toEqual([`packages/c/locale/en.json:1: {"title":"${IDEOGRAPH}"}`])
  })

  it('rejects exact, line, and glob entries that allow nothing', () => {
    const root = fixture(
      { 'docs/guide.md': `${IDEOGRAPH}\n` },
      [
        { path: 'docs/guide.md', reason: 'Used.' },
        { path: 'docs/removed.md', reason: 'Stale.' },
        { path: 'docs/guide.md', line: '^never$', reason: 'Stale pattern.' },
        { path: '**/locale/**/ja.json', reason: 'No Japanese locale.' },
      ],
    )
    expect(verifyNoCjk(root).failures).toEqual([
      'scripts/no-cjk-allowlist.json: entry "docs/removed.md" allows nothing; remove it',
      'scripts/no-cjk-allowlist.json: entry "docs/guide.md" (line "^never$") allows nothing; remove it',
      'scripts/no-cjk-allowlist.json: entry "**/locale/**/ja.json" allows nothing; remove it',
    ])
  })

  it('matches a bracketed exact path literally', () => {
    const violation = { file: 'apps/web/[id].tsx', line: 1, text: IDEOGRAPH }
    expect(applyCjkAllowlist([violation], [{ path: 'apps/web/[id].tsx', reason: 'Fixture.' }]))
      .toEqual({ remaining: [], unused: [] })
  })
})

describe('parseCjkAllowlist', () => {
  it.each([
    ['{}', 'expected an array'],
    ['[1]', 'expected an object'],
    ['[{"path":"a.md"}]', 'reason must be a non-empty string'],
    ['[{"path":"","reason":"r"}]', 'path must be a non-empty string'],
    ['[{"path":"a.md","reason":"r","note":"x"}]', 'unsupported field(s) note'],
    ['[{"path":"a.md","reason":"r","line":"("}]', 'line is not a valid regular expression'],
  ])('rejects %s', (content, message) => {
    expect(() => parseCjkAllowlist(content)).toThrow(message)
  })

  it('accepts the checked-in allowlist', () => {
    expect(() => parseCjkAllowlist(readFileSync(new URL('./no-cjk-allowlist.json', import.meta.url), 'utf8'))).not.toThrow()
  })
})
