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
    expect(phrasing(parse('workbench still http://127.0.0.1:8790/. Rehearse first; if it exceeds 18 min'))).toEqual(
      ['workbench still ', { link: 'http://127.0.0.1:8790/' }, '. Rehearse first; if it exceeds 18 min'])
    expect(phrasing(parse('see https://example.com, then'))).toEqual(['see ', { link: 'https://example.com' }, ', then'])
    expect(phrasing(parse('(https://example.com/a?b=1)'))).toEqual(['(', { link: 'https://example.com/a?b=1' }, ')'])
    expect(phrasing(parse('see www.example.com/a..'))).toEqual(['see ', { link: 'http://www.example.com/a' }, '..'])
    expect(phrasing(parse('https://a.com/x, https://b.com/y.'))).toEqual(
      [{ link: 'https://a.com/x' }, ',', { link: 'https://b.com/y' }, '.'])
    expect(phrasing(parse('(www.example.com/a) after'))).toEqual(['(', { link: 'http://www.example.com/a' }, ') after'])
    expect(phrasing(parse('😀see (https://example.com/a_(b)), then look'))).toEqual(
      ['😀see (', { link: 'https://example.com/a_(b)' }, '), then look'])
    const qq = 'https://qm.qq.com/cgi-bin/qm/qr?k=Abc%2BDef%2Fghi%3D%3D&authKey=tok%252Fvalue%253D&noverify=0'
    expect(phrasing(parse(`Join group chat:${qq}, welcome.`))).toEqual(['Join group chat:', { link: qq }, ', welcome.'])
    // After an unbalanced `[`, the literal comes from the text transform instead of the tokenizer.
    // Its case-insensitive Unicode regex must keep ASCII `s` and `k`, which fold with `ſ` and `K`.
    expect(phrasing(parse('[x https://example.com/docs/Kit?s=K. After'))).toEqual(
      ['[x ', { link: 'https://example.com/docs/Kit?s=K' }, '. After'])
    for (const prefix of ['', '[x ']) {
      expect(phrasing(parse(`${prefix}https://example.com/a😀next sentence`))).toEqual(
        [prefix, { link: 'https://example.com/a' }, '😀next sentence'].filter(part => part !== ''))
      expect(phrasing(parse(`${prefix}https://example.com/a\u3000 next sentence`))).toEqual(
        [prefix, { link: 'https://example.com/a' }, '\u3000 next sentence'].filter(part => part !== ''))
      expect(phrasing(parse(`${prefix}https://example.com/a𝒳b ok`))).toEqual(
        [prefix, { link: 'https://example.com/a𝒳b' }, ' ok'].filter(part => part !== ''))
    }
    // Unencoded non-ASCII punctuation inside a URL also ends it.
    expect(phrasing(parse('https://zh.wikipedia.org/wiki/Chinese(disambiguation)'))).toEqual(
      [{ link: 'https://zh.wikipedia.org/wiki/Chinese' }, '(disambiguation)'])
  })

  it('leave following inline Markdown to the inline grammar', () => {
    expect(phrasing(parse('https://example.com/a,**next sentence**'))).toEqual([{ link: 'https://example.com/a' }, ',', 'strong'])
    expect((parse('Preview at **https://example.com/a**(PR #1)').children[0] as Paragraph).children).toMatchObject([
      { value: 'Preview at ' },
      { type: 'strong', children: [{ type: 'link', url: 'https://example.com/a' }] },
      { value: '(PR #1)' },
    ])
  })

  it('keep letters, ASCII punctuation, and authored links', () => {
    expect(phrasing(parse('https://zh.wikipedia.org/wiki/Chinese_(disambiguation)?q=a,b ok'))).toEqual(
      [{ link: 'https://zh.wikipedia.org/wiki/Chinese_(disambiguation)?q=a,b' }, ' ok'])
    expect(phrasing(parse('<https://example.com/. a>'))).toEqual([{ link: 'https://example.com/. a' }])
    expect(phrasing(parse('[link](https://example.com/. a)'))).toEqual([{ link: 'https://example.com/. a' }])
  })
})
