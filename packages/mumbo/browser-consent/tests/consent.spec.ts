import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { apply, classify, Config, currentTabOrigin } from '../src/index.ts'

describe('classify', () => {
  it('lets reads and web navigation pass, and treats code, other schemes, and unknown tools as unbounded', () => {
    expect(classify('browser_snapshot', {})).toBe('read')
    expect(classify('browser_navigate', { url: 'https://mail.google.com/' })).toBe('read')
    expect(classify('browser_navigate', { url: 'javascript:alert(1)' })).toBe('unbounded')
    expect(classify('browser_navigate', 'not json')).toBe('unbounded')
    expect(classify('browser_tabs', { action: 'list' })).toBe('read')
    expect(classify('browser_tabs', { action: 'new' })).toBe('read')
    expect(classify('browser_tabs', { action: 'new', url: 'file:///etc/passwd' })).toBe('unbounded')
    expect(classify('browser_tabs', { action: 'close', index: 2 })).toBe('unbounded')
    expect(classify('browser_click', { target: 'e1' })).toBe('site-write')
    expect(classify('browser_file_upload', { paths: ['/root/a.pdf'] })).toBe('site-write')
    expect(classify('browser_evaluate', { function: '() => 1' })).toBe('unbounded')
    expect(classify('browser_run_code_unsafe', { code: '' })).toBe('unbounded')
    expect(classify('browser_cookie_set', {})).toBe('unbounded')
  })
})

describe('currentTabOrigin', () => {
  it('reads the current tab among several, including a crashed one', () => {
    expect(currentTabOrigin('### Result\n- 0: [Inbox](https://mail.google.com/mail/u/0/)\n- 1: (current) [Shop](https://shop.example:8443/cart?x=1) [crashed]'))
      .toBe('https://shop.example:8443')
  })

  it('yields no origin for an ambiguous or non-web listing', () => {
    // An unescaped page title can imitate the link syntax.
    expect(currentTabOrigin('- 0: (current) [Evil](https://mail.google.com) x](https://evil.example/)')).toBeUndefined()
    expect(currentTabOrigin('- 0: (current) [Evil](https://evil.example/a](https://mail.google.com)')).toBeUndefined()
    expect(currentTabOrigin('- 0: (current) [](about:blank)')).toBeUndefined()
    expect(currentTabOrigin('- 0: (current) [A](https://a.example/)\n- 1: (current) [B](https://b.example/)')).toBeUndefined()
    expect(currentTabOrigin('No open tabs. Navigate to a URL to create one.')).toBeUndefined()
    expect(currentTabOrigin('- 0: (current) [Untitled')).toBeUndefined()
    expect(currentTabOrigin('- 0: (current) [Cut](https://a.example/')).toBeUndefined()
  })
})

describe('Config', () => {
  it('rejects an allowed site that is not an exact web origin', () => {
    for (const site of ['https://mail.google.com/', 'mail.google.com', 'ftp://files.example']) {
      expect(() => { apply(new Context(), Config({ allowedSites: [site] })) }).toThrow(`allowedSites entry "${site}"`)
    }
  })
})
