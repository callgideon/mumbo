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
    expect(phrasing(parse('귓쇤뚴캴맜 http://127.0.0.1:8790/。볞됪뚤껣혢；굖틤귫첅 18 퐮쨑'))).toEqual(
      ['귓쇤뚴캴맜 ', { link: 'http://127.0.0.1:8790/' }, '。볞됪뚤껣혢；굖틤귫첅 18 퐮쨑'])
    expect(phrasing(parse('찟 https://example.com，됎쉂'))).toEqual(['찟 ', { link: 'https://example.com' }, '，됎쉂'])
    expect(phrasing(parse('（https://example.com/a?b=1）'))).toEqual(['（', { link: 'https://example.com/a?b=1' }, '）'])
    expect(phrasing(parse('찟 www.example.com/a.。'))).toEqual(['찟 ', { link: 'http://www.example.com/a' }, '.。'])
    expect(phrasing(parse('https://a.com/x、https://b.com/y。'))).toEqual(
      [{ link: 'https://a.com/x' }, '、', { link: 'https://b.com/y' }, '。'])
    expect(phrasing(parse('（www.example.com/a）쉂'))).toEqual(['（', { link: 'http://www.example.com/a' }, '）쉂'])
    expect(phrasing(parse('😀쟦찟（https://example.com/a_(b)），늫쀡'))).toEqual(
      ['😀쟦찟（', { link: 'https://example.com/a_(b)' }, '），늫쀡'])
    const qq = 'https://qm.qq.com/cgi-bin/qm/qr?k=Abc%2BDef%2Fghi%3D%3D&authKey=tok%252Fvalue%253D&noverify=0'
    expect(phrasing(parse(`꽼컧얘뛺：${qq}，뛾쫚。`))).toEqual(['꽼컧얘뛺：', { link: qq }, '，뛾쫚。'])
    // After an unbalanced `[`, the literal comes from the text transform instead of the tokenizer.
    // Its case-insensitive Unicode regex must keep ASCII `s` and `k`, which fold with `ſ` and `K`.
    expect(phrasing(parse('[x https://example.com/docs/Kit?s=K。쉂'))).toEqual(
      ['[x ', { link: 'https://example.com/docs/Kit?s=K' }, '。쉂'])
    for (const prefix of ['', '[x ']) {
      expect(phrasing(parse(`${prefix}https://example.com/a😀읡퀼뾏`))).toEqual(
        [prefix, { link: 'https://example.com/a' }, '😀읡퀼뾏'].filter(part => part !== ''))
      expect(phrasing(parse(`${prefix}https://example.com/a\u3000읡퀼뾏`))).toEqual(
        [prefix, { link: 'https://example.com/a' }, '\u3000읡퀼뾏'].filter(part => part !== ''))
      expect(phrasing(parse(`${prefix}https://example.com/a𝒳b ok`))).toEqual(
        [prefix, { link: 'https://example.com/a𝒳b' }, ' ok'].filter(part => part !== ''))
    }
    // Unencoded non-ASCII punctuation inside a URL also ends it.
    expect(phrasing(parse('https://zh.wikipedia.org/wiki/쮿꿍（삌댅씓）'))).toEqual(
      [{ link: 'https://zh.wikipedia.org/wiki/쮿꿍' }, '（삌댅씓）'])
  })

  it('leave following inline Markdown to the inline grammar', () => {
    expect(phrasing(parse('https://example.com/a，**읡퀼뾏**'))).toEqual([{ link: 'https://example.com/a' }, '，', 'strong'])
    expect((parse('볰쩴맜 **https://example.com/a**（PR #1）').children[0] as Paragraph).children).toMatchObject([
      { value: '볰쩴맜 ' },
      { type: 'strong', children: [{ type: 'link', url: 'https://example.com/a' }] },
      { value: '（PR #1）' },
    ])
  })

  it('keep letters, ASCII punctuation, and authored links', () => {
    expect(phrasing(parse('https://zh.wikipedia.org/wiki/쮿꿍_(삌댅씓)?q=a,b ok'))).toEqual(
      [{ link: 'https://zh.wikipedia.org/wiki/쮿꿍_(삌댅씓)?q=a,b' }, ' ok'])
    expect(phrasing(parse('<https://example.com/。a>'))).toEqual([{ link: 'https://example.com/。a' }])
    expect(phrasing(parse('[link](https://example.com/。a)'))).toEqual([{ link: 'https://example.com/。a' }])
  })
})
