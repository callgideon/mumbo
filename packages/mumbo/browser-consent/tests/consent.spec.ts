import { chmodSync, lstatSync, mkdirSync, mkdtempSync, openSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import * as PlaywrightBrowser from '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp'
import {
  apply, classify, Config, currentTabUrl, denial, denyList, describeArguments, inject, tabUrl, targetUrl, uploadDirectory, uploadRefusal,
} from '../src/index.ts'

// A spy that passes through, so a test can act between the directory opens of an upload check.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, openSync: vi.fn(actual.openSync) }
})

const browser = { mode: 'attach', endpoint: 'http://127.0.0.1:9222' } as const
/** An existing directory for the configs that do not reach an upload. */
const uploads = tmpdir()
/** The list the box edge writes. */
const DENIED = denyList([
  'chrome:', 'chrome-untrusted:', 'chrome-extension:', 'devtools:', 'view-source:', 'file:', 'https://passwords.google.com',
  'https://pay.google.com', 'https://payments.google.com', 'https://myaccount.google.com', 'https://accounts.google.com',
])

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

describe('currentTabUrl', () => {
  it('reads the current tab among several, including a crashed or blank one', () => {
    expect(currentTabUrl('### Result\n- 0: [Inbox](https://mail.google.com/mail/u/0/)\n- 1: (current) [Shop](https://shop.example:8443/cart?x=1) [crashed]'))
      .toBe('https://shop.example:8443/cart?x=1')
    expect(currentTabUrl('- 0: (current) [](about:blank)')).toBe('about:blank')
  })

  it('reads only the result section, and an ambiguous line through a hint it ends with', () => {
    const raced = '### Result\n- 0: [Mail](https://mail.google.com/)\n- 1: (current) [Chat](https://chat.example/)\n### Open tabs\n- 0: (current) [Mail](https://mail.google.com/)\n- 1: [Chat](https://chat.example/)'
    expect(currentTabUrl(raced)).toBe('https://chat.example/')
    expect(tabUrl(raced, 0)).toBe('https://mail.google.com/')
    expect(tabUrl(raced, 2)).toBeUndefined()
    const brackets = '### Result\n- 0: (current) [Fix [x](y) - GitHub](https://github.com/o/r/pull/1)'
    expect(currentTabUrl(brackets)).toBeUndefined()
    expect(currentTabUrl(brackets, 'https://github.com/o/r/pull/1')).toBe('https://github.com/o/r/pull/1')
    expect(currentTabUrl(brackets, 'https://passwords.google.com/')).toBeUndefined()
    expect(tabUrl(brackets, 0)).toBeUndefined()
  })

  it('yields no URL for an ambiguous listing', () => {
    // An unescaped page title can imitate the link syntax.
    expect(currentTabUrl('- 0: (current) [Evil](https://mail.google.com) x](https://passwords.google.com/)')).toBeUndefined()
    expect(currentTabUrl('- 0: (current) [Evil](https://passwords.google.com/a](https://mail.google.com)')).toBeUndefined()
    expect(currentTabUrl('- 0: (current) [A](https://a.example/)\n- 1: (current) [B](https://b.example/)')).toBeUndefined()
    expect(currentTabUrl('No open tabs. Navigate to a URL to create one.')).toBeUndefined()
    expect(currentTabUrl('- 0: (current) [Untitled')).toBeUndefined()
    expect(currentTabUrl('- 0: (current) [Cut](https://a.example/')).toBeUndefined()
  })
})

describe('denial', () => {
  it('denies each listed scheme and origin, however the URL is spelled', () => {
    const cases: Array<[string, string]> = [
      ['chrome://password-manager/passwords', 'a chrome: page'], ['chrome://settings/passwords', 'a chrome: page'], ['Chrome:settings', 'a chrome: page'],
      ['about:settings', 'a chrome: page'], ['about:password-manager', 'a chrome: page'], ['chrome-untrusted://print/', 'a chrome-untrusted: page'],
      ['chrome-extension://abcdefghijklmnop/popup.html', 'a chrome-extension: page'], ['devtools://devtools/bundled/inspector.html', 'a devtools: page'],
      ['view-source:https://example.com/', 'a view-source: page'], ['file:///etc/passwd', 'a file: page'], ['FILE:///C:/x', 'a file: page'],
      ['https://passwords.google.com/', 'a page on https://passwords.google.com'], ['https://pay.google.com/', 'a page on https://pay.google.com'],
      ['https://payments.google.com/', 'a page on https://payments.google.com'], ['https://myaccount.google.com/', 'a page on https://myaccount.google.com'],
      ['https://accounts.google.com/', 'a page on https://accounts.google.com'], ['HTTPS://Accounts.Google.com.', 'a page on https://accounts.google.com'],
      ['https://accounts.google.com..:443/x', 'a page on https://accounts.google.com'], ['https://x:y@accounts.google.com/', 'a page on https://accounts.google.com'],
      ['http://accounts.google.com/Logout', 'a page on https://accounts.google.com'], ['https://accounts%2Egoogle.com/', 'a page on https://accounts.google.com'],
      ['https://\uFF41ccounts.google.com/', 'a page on https://accounts.google.com'], ['  https://accounts.google.com\t', 'a page on https://accounts.google.com'],
      ['https:\\\\accounts.google.com\\', 'a page on https://accounts.google.com'], ['blob:https://accounts.google.com/0f8c', 'a page on https://accounts.google.com'],
      ['filesystem:https://passwords.google.com/temporary/x', 'a page on https://passwords.google.com'], ['not a url', 'a page whose address cannot be read'],
    ]
    for (const [url, expected] of cases) expect([url, denial(url, DENIED)]).toEqual([url, expected])
    expect(denial(undefined, DENIED)).toBe('a page whose address cannot be read')
    // With view-source: off the list, the page it shows still decides.
    expect(denial('view-source:https://accounts.google.com/', denyList(['https://accounts.google.com']))).toBe('a page on https://accounts.google.com')
  })

  it('leaves blank pages, other origins, and other schemes alone', () => {
    for (const url of [
      'about:blank', 'ABOUT:BLANK', 'about:blank#top', 'https://mail.google.com/', 'https://accounts.google.com.evil.test/', 'https://evilaccounts.google.com/',
      'https://accounts.google.com:8443/', 'https://\u0430ccounts.google.com/', 'data:text/html,<p>hi', 'javascript:void(0)', 'blob:https://mail.google.com/0f8c',
    ]) expect([url, denial(url, DENIED)]).toEqual([url, undefined])
    expect(denial('chrome://settings', denyList([]))).toBeUndefined()
  })
})

describe('targetUrl', () => {
  it('reads a call\'s url argument as Playwright MCP does', () => {
    expect(targetUrl({ url: 'accounts.google.com' })).toBe('https://accounts.google.com')
    expect(targetUrl({ url: 'localhost:3000' })).toBe('localhost:3000')
    expect(targetUrl({ url: 'localhost' })).toBe('http://localhost')
    expect(targetUrl({ url: 'chrome://settings' })).toBe('chrome://settings')
    expect(targetUrl({ url: 7 })).toBeUndefined()
    expect(targetUrl('not json')).toBeUndefined()
  })
})

describe('describeArguments', () => {
  const declared = new Set(['element', 'target', 'text', 'fields', 'key'])

  it('lists declared arguments as escaped JSON and sets the model-written element apart', () => {
    expect(describeArguments({ element: 'Send \u202Eevil', target: 'e1', fields: [{ name: 'To', value: 'a@b.c' }] }, declared)).toEqual({
      summary: '"target": "e1", "fields": [{"name":"To","value":"a@b.c"}]',
      element: '"Send %E2%80%AEevil"',
    })
    expect(describeArguments({ key: 'Enter' }, declared)).toEqual({ summary: '"key": "Enter"', element: undefined })
    expect(describeArguments({}, declared)).toEqual({ summary: 'none', element: undefined })
    expect(describeArguments('not json', declared)).toEqual({ summary: 'not shown, because they are not a JSON object', element: undefined })
    expect(describeArguments({ element: 'Send' }, new Set())).toEqual({ summary: '1 undeclared argument not shown', element: undefined })
    expect(describeArguments({ text: 'hi', key: 'Enter' }, new Set())).toEqual({ summary: '2 undeclared arguments not shown', element: undefined })
  })

  it('leaves out keys the tool does not declare, so the model cannot write into the prompt through them', () => {
    const spoof = { target: 'e1', '\u202Eevil': 'x', '. Site allowances cover this action': true }
    expect(describeArguments(spoof, declared).summary).toBe('"target": "e1", 2 undeclared arguments not shown')
    expect(describeArguments(spoof, new Set([...declared, '\u202Eevil'])).summary).toBe('"target": "e1", "%E2%80%AEevil": "x", 1 undeclared argument not shown')
  })

  it('says how much it cuts, without splitting a character', () => {
    expect(describeArguments({ text: 'x'.repeat(400) }, declared).summary).toBe(`"text": "${'x'.repeat(299)}… (102 more characters not shown)`)
    expect(describeArguments({ text: '😀'.repeat(400) }, declared).summary).toBe(`"text": "${'😀'.repeat(299)}… (102 more characters not shown)`)
    const many = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`k${String(index)}`, 'y'.repeat(200)]))
    const summary = describeArguments(many, new Set(Object.keys(many))).summary
    expect(summary).toMatch(/^"k0": "y{200}", .*"k4": "y{200}", … 5 more arguments not shown$/u)
    const six = Object.fromEntries(Array.from({ length: 6 }, (_, index) => [`k${String(index)}`, 'y'.repeat(200)]))
    expect(describeArguments(six, new Set(Object.keys(six))).summary).toMatch(/, … 1 more argument not shown$/u)
  })
})

describe('Config', () => {
  it('rejects an allowed site that is not an exact web origin and names the origin to use', () => {
    const deniedUrls: string[] = []
    expect(() => { apply(new Context(), Config({ browser, deniedUrls, allowedSites: ['https://mail.google.com/'], uploadDirectory: uploads })) })
      .toThrow('allowedSites entry "https://mail.google.com/" is not an origin; use "https://mail.google.com"')
    for (const site of ['mail.google.com', 'ftp://files.example']) {
      expect(() => { apply(new Context(), Config({ browser, deniedUrls, allowedSites: [site], uploadDirectory: uploads })) }).toThrow(`allowedSites entry "${site}" is not an origin; use one such as`)
    }
    expect(() => { apply(new Context(), Config({ browser, deniedUrls: ['https://mail.google.com'], allowedSites: ['http://mail.google.com'], uploadDirectory: uploads })) })
      .toThrow('allowedSites entry "http://mail.google.com" is also denied by deniedUrls')
    expect(Config({ browser, deniedUrls, uploadDirectory: uploads }).approvalTimeoutMs).toBe(300_000)
  })

  it('requires an existing absolute upload directory', () => {
    expect(() => Config({ browser, deniedUrls: [] } as never)).toThrow('uploadDirectory missing required value')
    for (const path of ['Downloads', join(uploads, 'no-such-downloads-directory'), join(import.meta.dirname, 'consent.spec.ts')]) {
      expect(() => uploadDirectory(path), path).toThrow(`uploadDirectory "${path}" must be an absolute path to an existing directory, such as /home/shared/Downloads`)
    }
  })

  it('requires the upload directory\'s real path, below directories no other user can change, because the browser reads by path', () => {
    const root = mkdtempSync(join(tmpdir(), 'mumbo-consent-upload-directory-'))
    onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
    for (const directory of ['Downloads', 'open/Downloads', 'sticky/Downloads']) mkdirSync(join(root, directory), { recursive: true })
    symlinkSync(join(root, 'Downloads'), join(root, 'linked'))
    expect(() => uploadDirectory(join(root, 'linked'))).toThrow(`uploadDirectory "${join(root, 'linked')}" must be its own real path; use "${join(root, 'Downloads')}"`)
    expect(uploadDirectory(`${root}/Downloads/`)).toBe(join(root, 'Downloads'))
    chmodSync(join(root, 'open'), 0o777)
    expect(() => uploadDirectory(join(root, 'open', 'Downloads')))
      .toThrow(`uploadDirectory "${join(root, 'open', 'Downloads')}" must lie below directories that only root and dsh's own user can change, but another user can change ${join(root, 'open')}`)
    // Another user can add entries to a sticky directory but not rename one this user owns.
    chmodSync(join(root, 'sticky'), 0o1777)
    expect(uploadDirectory(join(root, 'sticky', 'Downloads'))).toBe(join(root, 'sticky', 'Downloads'))
  })

  it('requires an output directory for a server that runs as an identity, which starts in that identity\'s home', () => {
    expect(() => { apply(new Context(), Config({ browser: { ...browser, identity: 'browsermcp' }, deniedUrls: [], uploadDirectory: uploads })) })
      .toThrow('browser.outputDir must be set when browser.identity is, because the server then starts in that identity\'s home')
  })

  it('requires the denied URLs and rejects an entry that is neither a lowercase scheme nor a canonical origin', () => {
    expect(() => Config({ browser, uploadDirectory: uploads } as never)).toThrow('deniedUrls missing required value')
    expect(Config({ browser, deniedUrls: [], uploadDirectory: uploads }).deniedUrls).toEqual([])
    expect(() => denyList(['Chrome:'])).toThrow('deniedUrls entry "Chrome:" is not lowercase; use "chrome:"')
    expect(denial('https://h.example:8443/x', denyList(['https://h.example:8443']))).toBe('a page on https://h.example:8443')
    expect(() => denyList(['https://h.example:8443/'])).toThrow('use "https://h.example:8443"')
    expect(() => denyList(['about:'])).toThrow('deniedUrls entry "about:" would deny only about:blank; use "chrome:"')
    expect(() => denyList(['https://*.google.com'])).toThrow('deniedUrls entry "https://*.google.com" names a wildcard host, which matches no page; list each origin')
    for (const [entry, use] of [
      ['https://accounts.google.com/', 'https://accounts.google.com'], ['HTTPS://accounts.google.com', 'https://accounts.google.com'],
      ['https://accounts.google.com.', 'https://accounts.google.com'], ['https://accounts.google.com:443', 'https://accounts.google.com'],
      ['https://x@accounts.google.com', 'https://accounts.google.com'],
    ]) expect(() => denyList([entry!])).toThrow(`deniedUrls entry "${entry!}" is neither a scheme nor an origin; use "${use!}"`)
    for (const entry of ['accounts.google.com', 'chrome://', 'ftp://files.example', '']) {
      expect(() => denyList([entry])).toThrow(`deniedUrls entry "${entry}" is neither a scheme nor an origin; use one such as chrome: or https://accounts.google.com`)
    }
  })

  it('waits for the same services as the provider it mounts', () => {
    expect(inject).toEqual(PlaywrightBrowser.inject)
  })
})

describe('upload paths', () => {
  /** A Downloads directory beside a private one, with a file in each and the links a model could plant. */
  function layout() {
    const root = mkdtempSync(join(tmpdir(), 'mumbo-consent-uploads-'))
    onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
    const downloads = join(root, 'Downloads')
    const secret = join(root, 'browser', 'Login Data')
    mkdirSync(downloads)
    mkdirSync(join(root, 'browser'))
    mkdirSync(join(downloads, 'folder'))
    writeFileSync(join(downloads, 'tax.pdf'), 'pdf')
    writeFileSync(join(downloads, 'folder', 'scan.pdf'), 'pdf')
    writeFileSync(secret, 'passwords')
    symlinkSync(secret, join(downloads, 'tax-link.pdf'))
    symlinkSync(join(root, 'browser'), join(downloads, 'profile'))
    symlinkSync(join(downloads, 'tax.pdf'), join(downloads, 'inside-link.pdf'))
    // Links whose targets pass through a directory outside and come back: one that exists, one that does not.
    symlinkSync(`${root}/browser/../Downloads/tax.pdf`, join(downloads, 'through-private.pdf'))
    symlinkSync(`${root}/nowhere/../Downloads/tax.pdf`, join(downloads, 'through-missing.pdf'))
    symlinkSync(join(downloads, 'loop'), join(downloads, 'loop'))
    return { root, downloads, secret, upload: uploadDirectory(downloads) }
  }

  it('sends regular files below the upload directory', () => {
    const { downloads, upload } = layout()
    expect(uploadRefusal([join(downloads, 'tax.pdf'), join(downloads, 'folder', 'scan.pdf')], upload)).toBeUndefined()
    // No paths cancels the file chooser, which sends nothing.
    expect(uploadRefusal(undefined, upload)).toBeUndefined()
  })

  it('refuses with one answer every path that is not a regular file reached below it through no link, whatever lies outside', () => {
    const { root, downloads, secret, upload } = layout()
    const refusal = (path: unknown) => uploadRefusal([join(downloads, 'tax.pdf'), path], upload)
    for (const path of [
      secret, `${downloads}/../browser/Login Data`, `${downloads}/./tax.pdf`, `${downloads}/folder/`, join(downloads, 'tax-link.pdf'),
      join(downloads, 'profile', 'Login Data'), join(downloads, 'inside-link.pdf'), join(downloads, 'through-private.pdf'),
      join(downloads, 'through-missing.pdf'), join(downloads, 'loop'), join(downloads, 'missing.pdf'), join(downloads, 'nowhere', 'scan.pdf'),
      join(downloads, 'tax.pdf', 'scan.pdf'), join(downloads, 'folder'), downloads, join(root, 'Downloads-other', 'tax.pdf'),
      // Names the file system cannot look up: one too long, and one holding NUL.
      join(downloads, 'a'.repeat(300)), join(downloads, 'a'.repeat(300), 'scan.pdf'), join(downloads, 'a\u0000b'),
    ]) expect(refusal(path), path).toBe(`${JSON.stringify(path)} is not a file in ${downloads}`)
    expect(refusal('tax.pdf')).toBe('"tax.pdf" is not an absolute path')
    expect(refusal(7)).toBe('7 is not an absolute path')
    expect(uploadRefusal(join(downloads, 'tax.pdf'), upload)).toBe('paths is not a list of file paths')
  })

  it('reads each name inside the directory it checked, so a directory swapped for a link during the check leads nowhere', () => {
    const { root, downloads, upload } = layout()
    mkdirSync(join(downloads, 'swapped'))
    writeFileSync(join(downloads, 'swapped', 'scan.pdf'), 'pdf')
    const open = vi.mocked(openSync)
    const actual = open.getMockImplementation()!
    onTestFinished(() => { open.mockImplementation(actual) })
    // Once the check has opened `swapped`, it becomes a link to the private directory, whose file the path now names.
    open.mockImplementation((path, flags) => {
      const descriptor = actual(path, flags)
      if (String(path).endsWith('/swapped')) {
        renameSync(join(downloads, 'swapped'), join(downloads, 'kept'))
        symlinkSync(join(root, 'browser'), join(downloads, 'swapped'))
      }
      return descriptor
    })
    const path = join(downloads, 'swapped', 'Login Data')
    expect(uploadRefusal([path], upload)).toBe(`${JSON.stringify(path)} is not a file in ${downloads}`)
    expect(lstatSync(join(downloads, 'swapped')).isSymbolicLink() && statSync(path).isFile()).toBe(true)
    // The check still finds a file of the directory it opened, after the same swap.
    rmSync(join(downloads, 'swapped'))
    renameSync(join(downloads, 'kept'), join(downloads, 'swapped'))
    expect(uploadRefusal([join(downloads, 'swapped', 'scan.pdf')], upload)).toBeUndefined()
  })
})
