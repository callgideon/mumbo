import type { Paragraph, Root } from 'mdast'
import { describe, expect, it } from 'vitest'
import { parseGfm, parseGfmWithMath } from '../src/markdown/parse.ts'

/** Each phrasing child as a link destination, its literal text, or its type. */
function phrasing(root: Root): unknown[] {
  return (root.children[0] as Paragraph).children.map(node =>
    node.type === 'link' ? { link: node.url } : node.type === 'text' ? node.value : node.type)
}

describe.each([parseGfm, parseGfmWithMath])('autolink literals in %o', (parse) => {
  it('end before non-ASCII punctuation', () => {
    expect(phrasing(parse('헥읜쯰낐켨 http://127.0.0.1:8790/。훺걦쥈흩꿮；톂돸긽끿 18 쨆땗'))).toEqual(
      ['헥읜쯰낐켨 ', { link: 'http://127.0.0.1:8790/' }, '。훺걦쥈흩꿮；톂돸긽끿 18 쨆땗'])
    expect(phrasing(parse('혝 https://example.com，붒찎'))).toEqual(['혝 ', { link: 'https://example.com' }, '，붒찎'])
    expect(phrasing(parse('(https://example.com/a?b=1)'))).toEqual(['(', { link: 'https://example.com/a?b=1' }, ')'])
    expect(phrasing(parse('혝 www.example.com/a.。'))).toEqual(['혝 ', { link: 'http://www.example.com/a' }, '.。'])
    expect(phrasing(parse('https://a.com/x, https://b.com/y.'))).toEqual(
      [{ link: 'https://a.com/x' }, ',', { link: 'https://b.com/y' }, '.'])
    expect(phrasing(parse('（www.example.com/a）찎'))).toEqual(['（', { link: 'http://www.example.com/a' }, '）찎'])
    expect(phrasing(parse('😀쯂혝（https://example.com/a_(b)），즍썧'))).toEqual(
      ['😀쯂혝（', { link: 'https://example.com/a_(b)' }, '），즍썧'])
    const qq = 'https://qm.qq.com/cgi-bin/qm/qr?k=Abc%2BDef%2Fghi%3D%3D&authKey=tok%252Fvalue%253D&noverify=0'
    expect(phrasing(parse(`쪠쥥찀첦：${qq}，띾낆。`))).toEqual(['쪠쥥찀첦：', { link: qq }, '，띾낆。'])
    // After an unbalanced `[`, the literal comes from the text transform instead of the tokenizer.
    // Its case-insensitive Unicode regex must keep ASCII `s` and `k`, which fold with `ſ` and `K`.
    expect(phrasing(parse('[x https://example.com/docs/Kit?s=K。찎'))).toEqual(
      ['[x ', { link: 'https://example.com/docs/Kit?s=K' }, '。찎'])
    for (const prefix of ['', '[x ']) {
      expect(phrasing(parse(`${prefix}https://example.com/a😀옋였쯥`))).toEqual(
        [prefix, { link: 'https://example.com/a' }, '😀옋였쯥'].filter(part => part !== ''))
      expect(phrasing(parse(`${prefix}https://example.com/a\u3000옋였쯥`))).toEqual(
        [prefix, { link: 'https://example.com/a' }, '\u3000옋였쯥'].filter(part => part !== ''))
      expect(phrasing(parse(`${prefix}https://example.com/a𝒳b ok`))).toEqual(
        [prefix, { link: 'https://example.com/a𝒳b' }, ' ok'].filter(part => part !== ''))
    }
    // Unencoded non-ASCII punctuation inside a URL also ends it.
    expect(phrasing(parse('https://zh.wikipedia.org/wiki/옭뇣（매럃왉）'))).toEqual(
      [{ link: 'https://zh.wikipedia.org/wiki/옭뇣' }, '（매럃왉）'])
  })

  it('leave following inline Markdown to the inline grammar', () => {
    expect(phrasing(parse('https://example.com/a，**옋였쯥**'))).toEqual([{ link: 'https://example.com/a' }, '，', 'strong'])
    expect((parse('뤼혤켨 **https://example.com/a**（PR #1）').children[0] as Paragraph).children).toMatchObject([
      { value: '뤼혤켨 ' },
      { type: 'strong', children: [{ type: 'link', url: 'https://example.com/a' }] },
      { value: '(PR #1)' },
    ])
  })

  it('keep letters, ASCII punctuation, and authored links', () => {
    expect(phrasing(parse('https://zh.wikipedia.org/wiki/옭뇣_(매럃왉)?q=a,b ok'))).toEqual(
      [{ link: 'https://zh.wikipedia.org/wiki/옭뇣_(매럃왉)?q=a,b' }, ' ok'])
    expect(phrasing(parse('<https://example.com/. a>'))).toEqual([{ link: 'https://example.com/. a' }])
    expect(phrasing(parse('[link](https://example.com/. a)'))).toEqual([{ link: 'https://example.com/. a' }])
  })
})
