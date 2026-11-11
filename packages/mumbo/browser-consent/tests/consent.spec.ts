import { createHash } from 'node:crypto'
import { appendFileSync, chmodSync, chownSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { Context } from '@deepseek-ai/cordis'
import { afterAll, describe, expect, it, onTestFinished } from 'vitest'
import * as PlaywrightBrowser from '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp'
import {
  apply, classify, Config, currentTabUrl, denial, denyList, describeArguments, inject, stageUpload, tabUrl, targetUrl, uploadDirectory,
  uploadRefusal, uploadStaging,
} from '../src/index.ts'

const browser = { mode: 'attach', endpoint: 'http://127.0.0.1:9222', outputDir: '/var/lib/mumbo/playwright-output' } as const
/** An existing directory for the configs that do not reach an upload. */
const uploads = tmpdir()
/** A staging directory only this user can change. */
const staging = mkdtempSync(join(tmpdir(), 'mumbo-consent-staging-'))
afterAll(() => { rmSync(staging, { recursive: true, force: true }) })
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
    expect(() => { apply(new Context(), Config({ browser, deniedUrls, allowedSites: ['https://mail.google.com/'], uploadDirectory: uploads, uploadStaging: staging })) })
      .toThrow('allowedSites entry "https://mail.google.com/" is not an origin; use "https://mail.google.com"')
    for (const site of ['mail.google.com', 'ftp://files.example']) {
      expect(() => { apply(new Context(), Config({ browser, deniedUrls, allowedSites: [site], uploadDirectory: uploads, uploadStaging: staging })) }).toThrow(`allowedSites entry "${site}" is not an origin; use one such as`)
    }
    expect(() => { apply(new Context(), Config({ browser, deniedUrls: ['https://mail.google.com'], allowedSites: ['http://mail.google.com'], uploadDirectory: uploads, uploadStaging: staging })) })
      .toThrow('allowedSites entry "http://mail.google.com" is also denied by deniedUrls')
    expect(Config({ browser, deniedUrls, uploadDirectory: uploads, uploadStaging: staging }).approvalTimeoutMs).toBe(300_000)
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

  it('requires an output directory, because the server\'s workspace is the staging directory, and sets the file root itself', () => {
    const { outputDir: _unset, ...withoutOutput } = browser
    expect(() => { apply(new Context(), Config({ browser: { ...withoutOutput, identity: 'browsermcp' }, deniedUrls: [], uploadDirectory: uploads, uploadStaging: staging })) })
      .toThrow('browser.outputDir must be set, because the browser server\'s workspace is uploadStaging')
    const rooted = Config({ browser: { ...browser, fileRoot: uploads }, deniedUrls: [], uploadDirectory: uploads, uploadStaging: staging })
    expect(() => { apply(new Context(), rooted) })
      .toThrow('browser.fileRoot must not be set; consent gives the browser server uploadStaging as its only file root')
  })

  it('requires a staging directory only root and dsh\'s own user can change, and an upload limit of at least one byte', () => {
    expect(() => Config({ browser, deniedUrls: [], uploadDirectory: uploads } as never)).toThrow('uploadStaging missing required value')
    expect(Config({ browser, deniedUrls: [], uploadDirectory: uploads, uploadStaging: staging }).uploadMaxBytes).toBe(536_870_912)
    expect(() => Config({ browser, deniedUrls: [], uploadDirectory: uploads, uploadStaging: staging, uploadMaxBytes: 0 })).toThrow()
    expect(uploadStaging(`${staging}/`)).toBe(staging)
    expect(() => uploadStaging('uploads')).toThrow('uploadStaging "uploads" must be an absolute path to an existing directory, such as /var/lib/mumbo/uploads')
    // /tmp itself: anyone can add entries to it.
    expect(() => uploadStaging(uploads)).toThrow(`uploadStaging "${uploads}" must be owned by root or dsh's own user and writable by no other user`)
    const open = join(staging, 'open')
    mkdirSync(open)
    onTestFinished(() => { rmSync(open, { recursive: true, force: true }) })
    chmodSync(open, 0o770)
    expect(() => uploadStaging(open)).toThrow(`uploadStaging "${open}" must be owned by root or dsh's own user and writable by no other user`)
  })

  it('requires the denied URLs and rejects an entry that is neither a lowercase scheme nor a canonical origin', () => {
    expect(() => Config({ browser, uploadDirectory: uploads, uploadStaging: staging } as never)).toThrow('deniedUrls missing required value')
    expect(Config({ browser, deniedUrls: [], uploadDirectory: uploads, uploadStaging: staging }).deniedUrls).toEqual([])
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
  /** A Downloads directory beside a private one, with a file in each and the paths a model could plant. */
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
    return { root, downloads, secret, upload: uploadDirectory(downloads) }
  }

  it('accepts only names directly in the upload directory, without opening anything', () => {
    const { downloads, upload } = layout()
    // A link, a missing name, and a directory pass this check: staging opens the name and refuses them.
    expect(uploadRefusal(['tax.pdf', 'tax-link.pdf', 'missing.pdf', 'folder', '..pdf', 'a b'].map(name => join(downloads, name)), upload)).toBeUndefined()
    // No paths cancels the file chooser, which sends nothing.
    expect(uploadRefusal(undefined, upload)).toBeUndefined()
    expect(uploadRefusal([], upload)).toBeUndefined()
  })

  it('refuses every other path with one answer that says where to put the file', () => {
    const { root, downloads, secret, upload } = layout()
    for (const path of [
      secret, join(downloads, 'folder', 'scan.pdf'), `${downloads}/../browser/Login Data`, `${downloads}/./tax.pdf`, `${downloads}/tax.pdf/`,
      `${downloads}//tax.pdf`, `${downloads}/.`, `${downloads}/..`, downloads, join(root, 'Downloads-other', 'tax.pdf'), 'tax.pdf', 'Downloads/tax.pdf',
      // A copy consent staged is never an input: it is not directly in the upload directory.
      join(staging, '0123456789abcdef', 'tax.pdf'), 7, null, undefined,
    ]) {
      expect(uploadRefusal([join(downloads, 'tax.pdf'), path], upload), String(path))
        .toBe(`${JSON.stringify(path)} is not directly in ${downloads}; put the file directly in ${downloads} and retry`)
    }
    expect(uploadRefusal(join(downloads, 'tax.pdf'), upload)).toBe('paths is not a list of file paths')
  })
})

describe('staging an upload', () => {
  const room = () => Promise.resolve(undefined)
  /** A Downloads and a staging directory of their own. */
  function directories() {
    const root = mkdtempSync(join(tmpdir(), 'mumbo-consent-stage-'))
    onTestFinished(() => {
      chmodSync(root, 0o700)
      rmSync(root, { recursive: true, force: true })
    })
    const downloads = join(root, 'Downloads')
    const into = join(root, 'uploads')
    mkdirSync(downloads)
    mkdirSync(into, { mode: 0o700 })
    return { root, downloads, staging: uploadStaging(into) }
  }
  const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

  it('copies a regular file into a nonce directory of its own, read-only for the group, and hashes what it copied', async () => {
    const { downloads, staging: into } = directories()
    writeFileSync(join(downloads, 'tax return.pdf'), 'pdf bytes')
    const sizes: number[] = []
    const staged = await stageUpload(join(downloads, 'tax return.pdf'), into, 64, (bytes) => {
      sizes.push(bytes)
      return Promise.resolve(undefined)
    })
    expect(staged).toEqual({ path: expect.stringMatching(new RegExp(`^${into}/[0-9a-f]{32}/tax return\\.pdf$`, 'u')) as string, name: 'tax return.pdf', bytes: 9, sha256: sha256('pdf bytes') })
    const path = (staged as { path: string }).path
    expect(sizes).toEqual([9])
    expect(readFileSync(path, 'utf8')).toBe('pdf bytes')
    expect([statSync(path).mode & 0o7777, statSync(dirname(path)).mode & 0o7777]).toEqual([0o440, 0o750])
  })

  it('gives the copy the group of a set-group-ID staging directory', async (context) => {
    const group = process.getgroups().find(gid => gid !== process.getegid())
    if (group === undefined) context.skip()
    const { downloads, staging: into } = directories()
    chownSync(into, -1, group!)
    chmodSync(into, 0o2750)
    writeFileSync(join(downloads, 'tax.pdf'), 'pdf')
    const { path } = await stageUpload(join(downloads, 'tax.pdf'), into, 64, room) as { path: string }
    expect([statSync(path).gid, statSync(dirname(path)).gid]).toEqual([group, group])
  })

  it('refuses at once anything but a regular file, and a file it cannot open, staging nothing', async () => {
    const { root, downloads, staging: into } = directories()
    writeFileSync(join(root, 'Login Data'), 'passwords')
    symlinkSync(join(root, 'Login Data'), join(downloads, 'link.pdf'))
    mkdirSync(join(downloads, 'folder'))
    // A FIFO with no writer would block an ordinary open or read for ever.
    expect(spawnSync('mkfifo', [join(downloads, 'pipe')]).status).toBe(0)
    writeFileSync(join(downloads, 'locked.pdf'), 'pdf')
    chmodSync(join(downloads, 'locked.pdf'), 0o000)
    const cases: Array<[string, string]> = [
      ['link.pdf', 'is a symbolic link, not a regular file'], ['folder', 'is not a regular file'], ['pipe', 'is not a regular file'],
      ['missing.pdf', 'does not exist'], ['nul\u0000.pdf', 'could not be opened'],
    ]
    // Root opens a file whatever its mode.
    if (process.getuid?.() !== 0) cases.push(['locked.pdf', 'could not be opened'])
    for (const [name, why] of cases) {
      expect(await stageUpload(join(downloads, name), into, 64, room), name).toEqual({ refusal: `${JSON.stringify(join(downloads, name))} ${why}` })
    }
    expect(readdirSync(into)).toEqual([])
  })

  it('refuses a file over the limit, whether it is at the start or grows while it is copied, and one without room, leaving nothing', async () => {
    const { downloads, staging: into } = directories()
    writeFileSync(join(downloads, 'big.bin'), 'x'.repeat(65))
    writeFileSync(join(downloads, 'growing.bin'), 'x'.repeat(64))
    const over = (name: string) => ({ refusal: `${JSON.stringify(join(downloads, name))} is larger than the upload limit of 64 bytes` })
    expect(await stageUpload(join(downloads, 'big.bin'), into, 64, room)).toEqual(over('big.bin'))
    // It grows between the size check and the copy, as a file the model's shell writes can.
    const growing = () => {
      appendFileSync(join(downloads, 'growing.bin'), 'more')
      return Promise.resolve(undefined)
    }
    expect(await stageUpload(join(downloads, 'growing.bin'), into, 64, growing)).toEqual(over('growing.bin'))
    expect(await stageUpload(join(downloads, 'growing.bin'), into, 128, () => Promise.resolve('no room'))).toEqual({ refusal: 'no room' })
    expect(readdirSync(into)).toEqual([])
  })

  it('refuses a file it cannot copy', async () => {
    const { root, downloads } = directories()
    writeFileSync(join(downloads, 'tax.pdf'), 'pdf')
    // The staging directory is gone, so no nonce directory can be made in it.
    const refused = await stageUpload(join(downloads, 'tax.pdf'), join(root, 'gone'), 64, room)
    expect(refused).toEqual({ refusal: expect.stringMatching(new RegExp(`^${JSON.stringify(join(downloads, 'tax.pdf'))} could not be copied: Error: ENOENT`, 'u')) as string })
  })
})
