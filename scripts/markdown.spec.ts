/** Regression coverage for reusing one parse across the Markdown gate helpers, and for the generated-region grammar. */

import { describe, expect, it } from 'vitest'
import {
  generatedRegions,
  markdownHeadingLines,
  markdownProseLines,
  parseMarkdown,
  renderGeneratedRegion,
  spliceGeneratedRegion,
} from './markdown.ts'

const SOURCE = [
  '# Title',
  '',
  'Prose <!-- hidden --> kept.',
  '<!-- comment only -->',
  '',
  '```ts',
  '# not a heading',
  '```',
  '',
  'Setext heading',
  '--------------',
  '',
].join('\n')

describe('Markdown parse reuse', () => {
  it('derives prose lines and headings from a supplied parse exactly as from its own parse', () => {
    const tree = parseMarkdown(SOURCE)
    const unchanged = structuredClone(tree)

    const prose = markdownProseLines(SOURCE, tree)
    const headings = markdownHeadingLines(SOURCE, tree)

    expect(prose).toEqual(markdownProseLines(SOURCE))
    expect(headings).toEqual(markdownHeadingLines(SOURCE))
    expect(prose.map(line => line.index)).toEqual([1, 2, 3, 5, 9, 10, 11, 12])
    expect(headings).toEqual([
      { depth: 1, index: 1, raw: '# Title', text: 'Title' },
      { depth: 2, index: 10, raw: 'Setext heading', text: 'Setext heading' },
    ])
    expect(tree).toEqual(unchanged)
  })
})


describe('generated regions', () => {
  const BEGIN = '<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->'
  const END = '<!-- END GENERATED cordis-surface -->'

  it('locates marker-delimited regions with their slugs and marker lines', () => {
    const doc = `# T\n\nprose\n\n${BEGIN}\ninjected\n${END}\ntail\n`
    expect(generatedRegions(doc)).toEqual([
      { slug: 'cordis-surface', begin: 4, end: 6, text: `${BEGIN}\ninjected\n${END}` },
    ])
    expect(generatedRegions('# T\n\nprose\n')).toEqual([])
  })

  it('replaces exactly one region with the same slug', () => {
    const doc = `a\n${renderGeneratedRegion('x', 'old')}\n${renderGeneratedRegion('y', 'keep')}\nb\n`
    expect(spliceGeneratedRegion(doc, renderGeneratedRegion('x', 'new\nlines')))
      .toBe(`a\n${renderGeneratedRegion('x', 'new\nlines')}\n${renderGeneratedRegion('y', 'keep')}\nb\n`)
    expect(() => spliceGeneratedRegion('a\n', renderGeneratedRegion('x', 'new')))
      .toThrow("expected exactly 1 generated region 'x', found 0")
  })

  it('rejects unbalanced or nested markers', () => {
    expect(() => generatedRegions(`${END}\n`)).toThrow('without a BEGIN')
    expect(() => generatedRegions(`${BEGIN}\n`)).toThrow('without an END')
    expect(() => generatedRegions(`${BEGIN}\n${BEGIN}\n${END}\n`)).toThrow('nested')
  })

  it('rejects mismatched slugs and malformed marker lines', () => {
    expect(() => generatedRegions('<!-- BEGIN GENERATED a -->\nx\n<!-- END GENERATED b -->\n'))
      .toThrow("END slug 'b' does not match its BEGIN slug 'a'")
    expect(() => generatedRegions('<!-- BEGIN GENERATED a --> trailing\nx\n<!-- END GENERATED a -->\n'))
      .toThrow('malformed generated region marker line')
    expect(() => generatedRegions('x\n<!-- END GENERATED a --> tail\n'))
      .toThrow('malformed generated region marker line')
  })
})
