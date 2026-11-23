/**
 * Conversions in a helper process the subprocess provider starts: a real WASM conversion through the real helper,
 * and the parent's strict handling of stand-in helpers that answer, fail, misbehave, or stop.
 */
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { access, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import OfficeKit, { type OfficeSourceKey, type OfficeKitSource } from '../src/index.ts'
import { ChildConverter, HELPER_START_ALLOWANCE_MS, helperDeadlineMs, type HelperConverterOptions } from '../src/convert-child.ts'

const posix = process.platform === 'win32' ? describe.skip : describe
const FAKE_HELPER = fileURLToPath(new URL('./fixtures/fake-convert-helper.mjs', import.meta.url))
const PDF = Buffer.from('%PDF-1.7\nfake helper\n%%EOF\n')
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2])
const OPTIONS: HelperConverterOptions = { timeoutMs: 1_000, maxOutputBytes: 64 }
const SELECTION = { maxPages: 4, maxPixels: 1_000_000, maxDimension: 4096 } as const

let ctx: Context
let scratch: string

beforeEach(async () => {
  ctx = new Context()
  scratch = await mkdtemp(join(tmpdir(), 'dsh-convert-child-'))
  await ctx.plugin(LocalSubprocessRuntime)
})

afterEach(async () => {
  await ctx.fiber.dispose()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await rm(scratch, { recursive: true, force: true })
})

/** Record each spawn and, when `mode` is given, start that stand-in helper with `args` in place of the real one. */
function spawns(mode?: string, ...args: string[]): { specs: SubprocessSpawnSpec[]; handles: SubprocessHandle[] } {
  const spawn = ctx.subprocess.spawn.bind(ctx.subprocess)
  const specs: SubprocessSpawnSpec[] = []
  const handles: SubprocessHandle[] = []
  vi.spyOn(ctx.subprocess, 'spawn').mockImplementation((spec) => {
    specs.push(spec)
    const handle = spawn(mode === undefined ? spec : { ...spec, argv: [process.execPath, FAKE_HELPER, mode, ...args] })
    handles.push(handle)
    return handle
  })
  return { specs, handles }
}

async function sourcePath(): Promise<string> {
  const path = join(scratch, 'source.docx')
  await writeFile(path, 'source bytes')
  return path
}

function converter(deadlineMs = 60_000): ChildConverter {
  return new ChildConverter(ctx.subprocess, OPTIONS, deadlineMs)
}

/** The `ps` state of the process whose id the stand-in wrote to `pidFile`; empty until the id is written. */
async function processState(pidFile: string): Promise<string> {
  const pid = await readFile(pidFile, 'utf8').catch((_notYetWritten: unknown) => '')
  return pid === '' ? '' : execFileSync('ps', ['-o', 'stat=', '-p', pid], { encoding: 'utf8' }).trim()
}

posix('the parent of a conversion helper', () => {
  it('starts the helper with raw pipes and writes its outputs into the parent\'s paths', async () => {
    const { specs } = spawns('pdf')
    const outputPath = join(scratch, 'converted.pdf')
    await expect(converter().render({ inputPath: await sourcePath(), outputPath }, new AbortController().signal))
      .resolves.toEqual({ missingFonts: ['Fake Sans'], pageCount: 1 })
    expect(await readFile(outputPath)).toEqual(PDF)
    expect((await stat(outputPath)).mode & 0o777).toBe(0o600)
    expect(specs).toHaveLength(1)
    expect(specs[0]).toMatchObject({ cwd: '/', stdio: { stdin: 'pipe', stdout: 'pipe' } })
    expect(specs[0]!.argv.at(-1)).toMatch(/convert-helper\.(ts|js)$/u)
  })

  it('writes rendered images in the helper\'s order with their locations', async () => {
    spawns('images')
    const outputDir = join(scratch, 'images')
    const result = await converter().renderImages({ inputPath: await sourcePath(), outputDir, ...SELECTION },
      new AbortController().signal, PNG.length * 2)
    expect(result).toEqual({ pageCount: 3, dpi: 96, missingFonts: [], images: [
      { index: 1, page: 2, width: 10, height: 20, path: join(outputDir, 'image-0.png'), byteLength: PNG.length },
      { index: 0, sheet: 'Data', range: 'A1:B2', width: 10, height: 20, path: join(outputDir, 'image-1.png'), byteLength: PNG.length },
    ] })
    expect((await stat(outputDir)).mode & 0o777).toBe(0o700)
    expect(await readFile(join(outputDir, 'image-1.png'))).toEqual(PNG)
  })

  it('reads an answer that arrives in several chunks', async () => {
    spawns('large')
    const outputPath = join(scratch, 'converted.odt')
    await expect(new ChildConverter(ctx.subprocess, { ...OPTIONS, maxOutputBytes: 1024 * 1024 }, 60_000)
      .convert({ inputPath: await sourcePath(), outputPath }, new AbortController().signal)).resolves.toEqual({ missingFonts: [] })
    expect(await readFile(outputPath)).toEqual(Buffer.alloc(256 * 1024, 7))
  })

  it('sends a CSV worksheet and reports a helper failure with its code and message', async () => {
    const { specs } = spawns('failure')
    await expect(converter().convert({ inputPath: await sourcePath(), outputPath: join(scratch, 'out.csv'), sheet: 'Data' },
      new AbortController().signal))
      .rejects.toMatchObject({ name: 'OfficeKitError', code: 'invalid-document', message: 'forged\n[I] dsh launch token line' })
    expect(specs).toHaveLength(1)
  })

  it('refuses the answer of a helper that exits without reading its request', async () => {
    spawns('no-read')
    const inputPath = join(scratch, 'source.docx')
    // Larger than a pipe holds, so writing the request fails once the helper has exited.
    await writeFile(inputPath, Buffer.alloc(4 * 1024 * 1024))
    await expect(converter().render({ inputPath, outputPath: join(scratch, 'converted.pdf') }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'invalid-output' })
  })

  it('reports a helper that cannot start as unavailable', async () => {
    vi.spyOn(ctx.subprocess, 'spawn').mockImplementation(() => { throw new Error('spawn refused') })
    await expect(converter().render({ inputPath: await sourcePath(), outputPath: join(scratch, 'converted.pdf') }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'unavailable', message: 'The conversion helper could not start.' })
  })

  it('reports a helper whose process fails to run as unavailable', async () => {
    const spawn = ctx.subprocess.spawn.bind(ctx.subprocess)
    vi.spyOn(ctx.subprocess, 'spawn').mockImplementation(spec => spawn({ ...spec, argv: [join(scratch, 'missing-helper')] }))
    await expect(converter().render({ inputPath: await sourcePath(), outputPath: join(scratch, 'converted.pdf') }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'unavailable', message: 'The conversion helper could not run.' })
  })

  it.each(['empty', 'short-frame', 'trailing', 'exit-1'])('refuses a %s answer as invalid output', async (mode) => {
    spawns(mode)
    const outputPath = join(scratch, 'converted.pdf')
    await expect(converter().render({ inputPath: await sourcePath(), outputPath }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'invalid-output' })
    await expect(access(outputPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['not-json', 'extra-key', 'bad-page-count', 'unknown-code', 'oversized'])('refuses a %s answer and terminates the helper', async (mode) => {
    const { handles } = spawns(mode)
    await expect(converter().render({ inputPath: await sourcePath(), outputPath: join(scratch, 'converted.pdf') }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'invalid-output' })
    await expect(handles[0]!.done).resolves.toEqual({ exitCode: null, signal: 'SIGTERM' })
  })

  it.each(['too-many-images', 'zero-dpi', 'bad-image'])('refuses a %s render answer and terminates the helper', async (mode) => {
    const { handles } = spawns(mode)
    const outputDir = join(scratch, 'images')
    await expect(converter().renderImages({ inputPath: await sourcePath(), outputDir, ...SELECTION, maxPages: 2 },
      new AbortController().signal, 1024)).rejects.toMatchObject({ code: 'invalid-output' })
    await expect(handles[0]!.done).resolves.toEqual({ exitCode: null, signal: 'SIGTERM' })
    await expect(access(outputDir)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses images above the render\'s byte budget', async () => {
    spawns('images')
    const outputDir = join(scratch, 'images')
    await expect(converter().renderImages({ inputPath: await sourcePath(), outputDir, ...SELECTION },
      new AbortController().signal, PNG.length * 2 - 1)).rejects.toMatchObject({ code: 'invalid-output' })
    await expect(access(outputDir)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('terminates a stopped helper at its deadline and rejects with timeout', async () => {
    const pidFile = join(scratch, 'helper.pid')
    const { handles } = spawns('stop', pidFile)
    // The deadline fires only once the helper is stopped, so it can neither answer nor handle the provider's SIGTERM.
    const deadlineMs = 123_456
    const deadline = new AbortController()
    onTestFinished(() => { deadline.abort() })
    const timeout = AbortSignal.timeout.bind(AbortSignal)
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => ms === deadlineMs ? deadline.signal : timeout(ms))
    const rendering = converter(deadlineMs).render({ inputPath: await sourcePath(), outputPath: join(scratch, 'converted.pdf') },
      new AbortController().signal)
    await expect.poll(() => processState(pidFile), { interval: 20 }).toMatch(/^T/u)
    deadline.abort()
    await expect(rendering).rejects.toMatchObject({ code: 'timeout', message: `The conversion helper did not finish within ${deadlineMs} ms.` })
    await expect(handles[0]!.done).resolves.toEqual({ exitCode: null, signal: 'SIGKILL' })
  })

  it('terminates the helper when the caller cancels and rejects with the caller\'s reason', async () => {
    const { handles } = spawns('silent')
    const controller = new AbortController()
    const reason = new Error('cancelled by the caller')
    const rendering = converter().render({ inputPath: await sourcePath(), outputPath: join(scratch, 'converted.pdf') }, controller.signal)
    await vi.waitFor(() => { expect(handles).toHaveLength(1) })
    controller.abort(reason)
    await expect(rendering).rejects.toBe(reason)
    await expect(handles[0]!.done).resolves.toEqual({ exitCode: null, signal: 'SIGTERM' })
  })
})

it('bounds a helper run at the Kit deadline plus the fixed start allowance', () => {
  expect(HELPER_START_ALLOWANCE_MS).toBe(30_000)
  expect(helperDeadlineMs(60_000)).toBe(90_000)
  expect(helperDeadlineMs(2_147_483_647)).toBe(2_147_483_647)
})

async function fixture(name: string, bytes?: Buffer): Promise<OfficeKitSource> {
  const content = bytes ?? await readFile(new URL(`./fixtures/${name}`, import.meta.url))
  return { key: brandString<OfficeSourceKey>(name), version: 'v1', bytes: content.length,
    read: async () => ({ bytes: Uint8Array.from(content), version: 'v1' }) }
}

/** Whether the Kit's default system font roots hold a font; the engine refuses to convert a document without one. */
function hasSystemFont(): boolean {
  const roots = process.platform === 'darwin' ? ['/System/Library/Fonts', '/Library/Fonts'] : ['/usr/share/fonts', '/usr/local/share/fonts']
  return roots.some((root) => {
    try { return readdirSync(root, { recursive: true }).some(name => /\.(?:ttf|otf|ttc)$/iu.test(String(name))) }
    catch (_absentRoot) { return false }
  })
}

/** A fresh directory the helper uses as its `TMPDIR`. */
async function helperTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-convert-helper-tmp-'))
  onTestFinished(() => rm(directory, { recursive: true, force: true }))
  vi.stubEnv('TMPDIR', directory)
  return directory
}

/** Entries of the helper's private directories and the Kit's scratch directories directly under `directory`. */
async function helperScratch(directory: string): Promise<string[]> {
  return (await readdir(directory)).filter(name => /^(?:dsh-office-kit|libreoffice-kit)-/u.test(name))
}

// Skipped on a host without system fonts, such as a minimal container image, where the engine refuses every document.
const real = process.platform === 'win32' || !hasSystemFont() ? describe.skip : describe

real('a real conversion through the helper', () => {
  it('renders a presentation and converts and recalculates a workbook with the engine in a child process', async () => {
    const helperTmp = await helperTemporaryDirectory()
    vi.spyOn(ctx.subprocess, 'childIdentity', 'get').mockReturnValue({ uid: process.getuid!(), gid: process.getgid!(), groups: [] })
    const { specs } = spawns()
    await ctx.plugin(OfficeKit, { outputDirectory: join(scratch, 'outputs') })
    const kit = ctx.officeKit
    const slides = await kit.renderImages({ extension: 'pptx', source: await fixture('color-blocks.pptx'), dpi: 48,
      maxImages: 4, maxPixels: 1_000_000, maxDimension: 4096, maxBytes: 1_000_000 })
    expect(slides).toMatchObject({ pageCount: 1, dpi: 48, images: [{ page: 1 }] })
    expect(Buffer.from(slides.images[0]!.png).subarray(0, 8)).toEqual(PNG.subarray(0, 8))
    const pdf = await kit.convertTo({ extension: 'pptx', format: 'pdf', source: await fixture('color-blocks.pptx'),
      output: { owner: 'session', name: 'slides.pdf' } })
    expect(pdf.pageCount).toBe(1)
    expect((await readFile(pdf.path)).subarray(0, 5).toString()).toBe('%PDF-')
    const csv = await kit.convertTo({ extension: 'xlsx', format: 'csv', source: await fixture('color-blocks.xlsx'),
      output: { owner: 'session', name: 'book.csv' } })
    expect(await readFile(csv.path, 'utf8')).toContain('RED,BLUE')
    const workbook = await kit.recalculate({ extension: 'xlsx', format: 'xlsx', source: await fixture('color-blocks.xlsx'),
      output: { owner: 'session', name: 'book.xlsx' } })
    expect((await readFile(workbook.path)).subarray(0, 2).toString()).toBe('PK')
    await expect(kit.convertTo({ extension: 'pptx', format: 'pdf', source: await fixture('broken.pptx', Buffer.from('not a presentation')),
      output: { owner: 'session', name: 'broken.pdf' } })).rejects.toMatchObject({ code: 'invalid-document' })
    expect(specs).toHaveLength(5)
    for (const spec of specs) expect(spec.argv.at(-1)).toMatch(/convert-helper\.(ts|js)$/u)
    expect(await helperScratch(helperTmp)).toEqual([])
  }, 120_000)

  it('removes its private directory, which holds the Kit\'s scratch, when terminated during a conversion', async () => {
    const helperTmp = await helperTemporaryDirectory()
    const { handles } = spawns()
    const inputPath = join(scratch, 'source.pptx')
    await writeFile(inputPath, await readFile(new URL('./fixtures/color-blocks.pptx', import.meta.url)))
    const controller = new AbortController()
    const reason = new Error('cancelled by the caller')
    const rendering = new ChildConverter(ctx.subprocess, { timeoutMs: 60_000, maxOutputBytes: 10_000_000 }, helperDeadlineMs(60_000))
      .render({ inputPath, outputPath: join(scratch, 'converted.pdf') }, controller.signal)
    const kitScratch = async (): Promise<string[]> => (await Promise.all((await helperScratch(helperTmp))
      .map(async name => (await readdir(join(helperTmp, name))).filter(entry => entry.startsWith('libreoffice-kit-'))))).flat()
    await expect.poll(kitScratch, { timeout: 60_000, interval: 20 }).toHaveLength(1)
    controller.abort(reason)
    await expect(rendering).rejects.toBe(reason)
    await expect(handles[0]!.done).resolves.toEqual({ exitCode: 143, signal: null })
    expect(await helperScratch(helperTmp)).toEqual([])
  }, 120_000)
})
