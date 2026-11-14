/** The conversion helper, run in this process with a stand-in Kit: request checks, Kit failures, and its answers. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Converter, RenderImagesRequest, RenderedImage } from '@deepseek-ai/libreoffice-kit'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { framePrefix, MESSAGE_MAX_LENGTH } from '../src/convert-child.ts'
import { runConvertHelper } from '../src/convert-helper.ts'
import { KIT_INSTALL_HINT, resolveKitModule } from '../src/locate.ts'

const kit = vi.hoisted(() => ({ create: vi.fn<(options: unknown) => Promise<Converter>>() }))
vi.mock('@deepseek-ai/libreoffice-kit', () => ({ createConverter: kit.create }))
vi.mock('../src/locate.ts', async (original) => {
  const actual = await original<typeof import('../src/locate.ts')>()
  return { ...actual, resolveKitModule: vi.fn(actual.resolveKitModule) }
})

const PDF = Buffer.from('%PDF-1.7\nhelper\n%%EOF\n')
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2])
const OPTIONS = { timeoutMs: 1_000, maxOutputBytes: 64 }
const SELECTION = { maxPages: 4, maxPixels: 1_000_000, maxDimension: 4096 }

let directory: string
let converter: { [K in keyof Converter]: K extends 'backend' ? Converter[K] : ReturnType<typeof vi.fn<Converter[Exclude<K, 'backend'>]>> }

function image(request: RenderImagesRequest, index: number, fields: Partial<RenderedImage> = {}): RenderedImage {
  return { index, path: join(request.outputDir, `image-${index}.png`), width: 10, height: 20,
    rectangle: { x: 0, y: 0, width: 1, height: 1 }, byteLength: PNG.length, ...fields }
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-convert-helper-'))
  converter = {
    backend: 'wasm',
    render: vi.fn<Converter['render']>(async ({ outputPath }) => {
      await writeFile(outputPath, PDF)
      return { backend: 'wasm', missingFonts: ['Sans'], pageCount: 2 }
    }),
    convert: vi.fn<Converter['convert']>(async ({ outputPath }) => {
      await writeFile(outputPath, 'a,b\n')
      return { backend: 'wasm', missingFonts: [] }
    }),
    recalculate: vi.fn<Converter['recalculate']>(async ({ outputPath }) => {
      await writeFile(outputPath, 'PK')
      return { backend: 'wasm', missingFonts: [] }
    }),
    renderImages: vi.fn<Converter['renderImages']>(async (request) => {
      const images = [image(request, 1, { page: 2 }), image(request, 0, { sheet: 'Data', range: 'A1:B2' })]
      await mkdir(request.outputDir)
      for (const entry of images) await writeFile(entry.path, PNG)
      return { schemaVersion: 1, backend: 'wasm', rasterEngine: 'libreoffice', source: 'saved', inputPath: request.inputPath,
        sourceSha256: 'digest', dpi: 96, pageCount: 3, images, missingFonts: ['Sans'] }
    }),
    dispose: vi.fn<Converter['dispose']>().mockResolvedValue(undefined),
  }
  kit.create.mockReset().mockResolvedValue(converter)
})

afterEach(async () => {
  vi.mocked(resolveKitModule).mockReset()
  await rm(directory, { recursive: true, force: true })
})

function frames(header: unknown, source = Buffer.from('source')): Buffer {
  const encoded = Buffer.from(JSON.stringify(header))
  return Buffer.concat([framePrefix(encoded.length), encoded, framePrefix(source.length), source])
}

async function run(input: Buffer): Promise<{ answer: unknown; outputs: Buffer[] }> {
  const [header, ...outputs] = await runConvertHelper(input, directory)
  return { answer: JSON.parse(header!.toString('utf8')), outputs }
}

it('converts the source in the given directory and answers with the file, then disposes of the converter', async () => {
  await expect(run(frames({ operation: 'render', input: 'pptx', output: 'pdf', options: OPTIONS })))
    .resolves.toEqual({ answer: { ok: true, missingFonts: ['Sans'], pageCount: 2 }, outputs: [PDF] })
  expect(kit.create).toHaveBeenCalledOnce()
  expect(kit.create.mock.calls[0]![0]).toMatchObject(OPTIONS)
  expect(kit.create.mock.calls[0]![0]).toHaveProperty('resolveEnginePackage')
  expect(converter.render).toHaveBeenCalledExactlyOnceWith({ inputPath: join(directory, 'source.pptx'), outputPath: join(directory, 'output.pdf') })
  expect(converter.dispose).toHaveBeenCalledOnce()
})

it.each([
  ['a CSV conversion', { operation: 'convert', input: 'xlsx', output: 'csv', sheet: 'Data' }, 'a,b\n'],
  ['a conversion', { operation: 'convert', input: 'docx', output: 'odt' }, 'a,b\n'],
  ['a recalculation', { operation: 'recalculate', input: 'xlsx', output: 'xlsx' }, 'PK'],
])('answers %s without a page count, passing a worksheet only when the request names one', async (_case, request, output) => {
  await expect(run(frames({ ...request, options: OPTIONS })))
    .resolves.toEqual({ answer: { ok: true, missingFonts: [] }, outputs: [Buffer.from(output)] })
  const [call] = [...converter.convert.mock.calls, ...converter.recalculate.mock.calls]
  expect(call![0]).toEqual({ inputPath: join(directory, `source.${request.input}`), outputPath: join(directory, `output.${request.output}`),
    ...('sheet' in request ? { sheet: request.sheet } : {}) })
})

it('answers rendered images with their locations, followed by their PNGs in the same order', async () => {
  await expect(run(frames({ operation: 'renderImages', input: 'pptx', selection: SELECTION, maxBytes: PNG.length * 2, options: OPTIONS })))
    .resolves.toEqual({ answer: { ok: true, missingFonts: ['Sans'], pageCount: 3, dpi: 96, images: [
      { index: 1, width: 10, height: 20, page: 2 }, { index: 0, width: 10, height: 20, sheet: 'Data', range: 'A1:B2' },
    ] }, outputs: [PNG, PNG] })
  expect(converter.renderImages).toHaveBeenCalledExactlyOnceWith({ ...SELECTION, inputPath: join(directory, 'source.pptx'),
    outputDir: join(directory, 'images') })
})

it('refuses rendered images above the byte budget', async () => {
  const { answer } = await run(frames({ operation: 'renderImages', input: 'pptx', selection: SELECTION, maxBytes: PNG.length * 2 - 1, options: OPTIONS }))
  expect(answer).toMatchObject({ ok: false, code: 'output-too-large' })
})

it.each([
  ['a truncated header', Buffer.from([0, 0])],
  ['a source of another length', frames({ operation: 'render', input: 'pptx', output: 'pdf', options: OPTIONS }).subarray(0, -1)],
  ['an unknown operation', frames({ operation: 'edit', input: 'pptx', output: 'pdf', options: OPTIONS })],
  ['an input extension that leaves the directory', frames({ operation: 'render', input: '../x', output: 'pdf', options: OPTIONS })],
  ['an uppercase output extension', frames({ operation: 'render', input: 'pptx', output: 'PDF', options: OPTIONS })],
])('refuses %s as an invalid request before loading the Kit', async (_case, input) => {
  const { answer, outputs } = await run(input)
  expect(answer).toMatchObject({ ok: false, code: 'invalid-request' })
  expect(outputs).toEqual([])
  expect(kit.create).not.toHaveBeenCalled()
})

it.each([
  ['missing', 'LibreOffice Kit is not installed.', () => ({ kind: 'missing', error: new Error('absent') }) as const],
  ['unloadable', 'LibreOffice Kit could not be loaded.', () => ({ kind: 'available', entry: 'file:///nonexistent/libreoffice-kit.js',
    resolveEnginePackage: (name: string) => name }) as const],
])('answers unavailable for a %s Kit', async (_case, message, resolution) => {
  vi.mocked(resolveKitModule).mockImplementation(resolution)
  await expect(run(frames({ operation: 'render', input: 'pptx', output: 'pdf', options: OPTIONS }))).resolves.toEqual({
    answer: { ok: false, code: 'unavailable', message: `${message} ${KIT_INSTALL_HINT}` }, outputs: [],
  })
})

it('answers a Kit failure with its code and a bounded message, and survives a failed disposal', async () => {
  converter.render.mockRejectedValueOnce(Object.assign(new Error('x'.repeat(MESSAGE_MAX_LENGTH + 1)), { code: 'invalid-document' }))
  converter.dispose.mockRejectedValueOnce(new Error('worker stuck'))
  await expect(run(frames({ operation: 'render', input: 'docx', output: 'pdf', options: OPTIONS }))).resolves.toEqual({
    answer: { ok: false, code: 'invalid-document', message: 'x'.repeat(MESSAGE_MAX_LENGTH) }, outputs: [],
  })
})
