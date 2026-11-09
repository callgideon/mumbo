import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import * as PlaywrightBrowser from '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp'
import { apply, classify, Config, currentTabOrigin, describeArguments, inject } from '../src/index.ts'

describe('classify', () => {
  it('lets reads and web navigation pass, and treats code, other schemes, and unknown tools as unbounded', () => {
    expect(classify('browser_snapshot', {})).toBe('read')
    expect(classify('browser_navigate_forward', {})).toBe('read')
    expect(classify('browser_navigate', { url: 'https://mail.google.com/' })).toBe('read')
    expect(classify('browser_navigate', { url: 'javascript:alert(1)' })).toBe('always-ask')
    expect(classify('browser_navigate', 'not json')).toBe('always-ask')
    expect(classify('browser_tabs', { action: 'list' })).toBe('read')
    expect(classify('browser_tabs', { action: 'new' })).toBe('read')
    for (const url of ['javascript:alert(1)', 'data:text/html,<form>', 'chrome://settings', 'file:///etc/passwd', 'mail.google.com']) {
      expect(classify('browser_tabs', { action: 'new', url })).toBe('always-ask')
    }
    expect(classify('browser_tabs', { action: 'close', index: 2 })).toBe('always-ask')
    for (const tool of ['browser_click', 'browser_check', 'browser_uncheck', 'browser_press_sequentially', 'browser_keydown', 'browser_keyup', 'browser_reload']) {
      expect(classify(tool, { target: 'e1' })).toBe('site-write')
    }
    expect(classify('browser_drop', { target: 'e1', data: { 'text/plain': 'hi' } })).toBe('site-write')
    expect(classify('browser_drop', { target: 'e1', paths: ['/root/a.pdf'] })).toBe('always-ask')
    expect(classify('browser_file_upload', { paths: ['/root/a.pdf'] })).toBe('always-ask')
    expect(classify('browser_evaluate', { function: '() => 1' })).toBe('always-ask')
    expect(classify('browser_run_code_unsafe', { code: '' })).toBe('always-ask')
    expect(classify('browser_cookie_set', {})).toBe('always-ask')
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

describe('describeArguments', () => {
  it('shows each argument as escaped, bounded JSON and sets the model-written element apart', () => {
    expect(describeArguments({ element: 'Send \u202Eevil', target: 'e1', fields: [{ name: 'To', value: 'a@b.c' }] })).toEqual({
      summary: 'target="e1", fields=[{"name":"To","value":"a@b.c"}]',
      element: '"Send %E2%80%AEevil"',
    })
    expect(describeArguments({ key: 'Enter' })).toEqual({ summary: 'key="Enter"', element: undefined })
    expect(describeArguments({})).toEqual({ summary: 'none', element: undefined })
    expect(describeArguments('not json')).toEqual({ summary: 'arguments="not json"', element: undefined })
    const long = describeArguments({ text: 'x'.repeat(400) }).summary
    expect(long).toBe(`text="${'x'.repeat(299)}…`)
    const many = describeArguments(Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`k${String(index)}`, 'y'.repeat(200)]))).summary
    expect(many).toHaveLength(1201)
    expect(many.endsWith('…')).toBe(true)
  })
})

describe('Config', () => {
  it('rejects an allowed site that is not an exact web origin and names the origin to use', () => {
    const browser = { mode: 'attach', endpoint: 'http://127.0.0.1:9222' } as const
    expect(() => { apply(new Context(), Config({ browser, allowedSites: ['https://mail.google.com/'] })) })
      .toThrow('allowedSites entry "https://mail.google.com/" is not an origin; use "https://mail.google.com"')
    for (const site of ['mail.google.com', 'ftp://files.example']) {
      expect(() => { apply(new Context(), Config({ browser, allowedSites: [site] })) }).toThrow(`allowedSites entry "${site}" is not an origin; use one such as`)
    }
    expect(Config({ browser }).approvalTimeoutMs).toBe(300_000)
  })

  it('waits for the same services as the provider it mounts', () => {
    expect(inject).toEqual(PlaywrightBrowser.inject)
  })
})
