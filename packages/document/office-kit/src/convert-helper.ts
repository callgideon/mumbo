/**
 * Entry of the conversion helper: read one request header frame and the source frame from stdin, convert with
 * LibreOffice Kit in this process inside a private `0700` directory under this process's temporary directory, remove
 * that directory, and write one answer to stdout. The directory is also this process's `TMPDIR`, so it holds the Kit's
 * own scratch, and a `SIGTERM` removes it before the process exits with status 143. The subprocess provider starts the
 * helper as its run-as identity, so the engine parses documents as that user. `convert-child.ts` defines the frames.
 * @module dsh-office-kit/convert-helper
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Converter } from '@deepseek-ai/libreoffice-kit'
import { conversionFailure, framePrefix, MESSAGE_MAX_LENGTH, type HelperAnswer, type HelperRequest } from './convert-child.ts'
import { OfficeKitError } from './errors.ts'
import { KIT_INSTALL_HINT, resolveKitModule } from './locate.ts'
import { readOutput } from './output.ts'

type KitModule = Pick<typeof import('@deepseek-ai/libreoffice-kit'), 'createConverter'>

const OPERATIONS: ReadonlySet<unknown> = new Set(['render', 'convert', 'recalculate', 'renderImages'])
/** File extensions the provider sends; anything else could name a path outside the private directory. */
const EXTENSION = /^[a-z]{1,8}$/u
/** Output reads in the helper are never cancelled; the parent terminates the whole process instead. */
const UNCANCELLED = new AbortController().signal

function decodeRequest(input: Buffer): { request: HelperRequest; source: Buffer } {
  const headerEnd = 4 + input.readUInt32BE(0)
  const source = input.subarray(headerEnd + 4)
  const request = JSON.parse(input.subarray(4, headerEnd).toString('utf8')) as HelperRequest
  if (source.length !== input.readUInt32BE(headerEnd) || !OPERATIONS.has(request.operation) || !EXTENSION.test(request.input)
    || (request.operation !== 'renderImages' && !EXTENSION.test(request.output))) {
    throw new TypeError('The conversion helper received a malformed request.')
  }
  return { request, source }
}

async function createConverter(request: HelperRequest): Promise<Converter> {
  const kit = resolveKitModule(() => import.meta.resolve('@deepseek-ai/libreoffice-kit'))
  if (kit.kind === 'missing') throw new OfficeKitError('unavailable', `LibreOffice Kit is not installed. ${KIT_INSTALL_HINT}`, { cause: kit.error })
  let module: KitModule
  try {
    module = await import(kit.entry) as KitModule
  } catch (cause) {
    throw new OfficeKitError('unavailable', `LibreOffice Kit could not be loaded. ${KIT_INSTALL_HINT}`, { cause })
  }
  return module.createConverter({ ...request.options, resolveEnginePackage: kit.resolveEnginePackage })
}

function answer(value: HelperAnswer): Buffer {
  return Buffer.from(JSON.stringify(value))
}

async function perform(converter: Converter, request: HelperRequest, inputPath: string, directory: string): Promise<Buffer[]> {
  if (request.operation === 'renderImages') {
    const result = await converter.renderImages({ ...request.selection, inputPath, outputDir: join(directory, 'images') })
    const declared = result.images.reduce((sum, image) => sum + image.byteLength, 0)
    if (declared > request.maxBytes) {
      throw new OfficeKitError('output-too-large', `The rendered images total ${declared} bytes, above the ${request.maxBytes}-byte limit.`)
    }
    const pngs: Buffer[] = []
    let remaining = request.maxBytes
    for (const image of result.images) {
      const png = await readOutput(image.path, remaining, UNCANCELLED)
      remaining -= png.length
      pngs.push(png)
    }
    const images = result.images.map(({ index, width, height, page, sheet, range }) => ({ index, width, height,
      ...(page === undefined ? {} : { page }), ...(sheet === undefined ? {} : { sheet }), ...(range === undefined ? {} : { range }) }))
    return [answer({ ok: true, missingFonts: result.missingFonts, pageCount: result.pageCount, dpi: result.dpi, images }), ...pngs]
  }
  const outputPath = join(directory, `output.${request.output}`)
  const result = request.operation === 'render' ? await converter.render({ inputPath, outputPath })
    : request.operation === 'convert'
      ? await converter.convert({ inputPath, outputPath, ...(request.sheet === undefined ? {} : { sheet: request.sheet }) })
      : await converter.recalculate({ inputPath, outputPath })
  const data = await readOutput(outputPath, request.options.maxOutputBytes, UNCANCELLED)
  const { missingFonts, pageCount } = result
  return [answer({ ok: true, missingFonts, ...(pageCount === undefined ? {} : { pageCount }) }), data]
}

/**
 * Perform one request with a fresh Kit converter, then dispose of the converter.
 * @param input - the complete stdin: the request header frame and the source frame.
 * @param directory - an empty private directory for the source and outputs; the caller removes it.
 * @returns the payloads to write to stdout, one frame each: the answer header, then the outputs of a successful answer.
 * A failure becomes a failure answer with its code and a message of at most `MESSAGE_MAX_LENGTH` code units.
 */
export async function runConvertHelper(input: Buffer, directory: string): Promise<Buffer[]> {
  let converter: Converter | undefined
  try {
    const { request, source } = decodeRequest(input)
    converter = await createConverter(request)
    const inputPath = join(directory, `source.${request.input}`)
    await writeFile(inputPath, source, { flag: 'wx', mode: 0o600 })
    return await perform(converter, request, inputPath, directory)
  } catch (error) {
    const failure = conversionFailure(error)
    return [answer({ ok: false, code: failure.code, message: failure.message.slice(0, MESSAGE_MAX_LENGTH) })]
  } finally {
    try { await converter?.dispose() }
    catch (_disposeFailure) {
      // The process exits once its answer is written, which also ends an engine Worker that outlived the failure.
    }
  }
}

/* v8 ignore start -- runs only as the helper process, whose answers and cleanup the provider tests observe. */
if (import.meta.main) {
  const remove = (): void => { rmSync(directory, { recursive: true, force: true, maxRetries: 3 }) }
  // The listener precedes the directory: a SIGTERM before any listener ends the process at once and would leave it.
  process.once('SIGTERM', () => {
    remove()
    process.exit(143)
  })
  const directory = mkdtempSync(join(tmpdir(), 'dsh-office-kit-'))
  process.env.TMPDIR = directory
  const chunks: Buffer[] = []
  process.stdin.on('data', (chunk: Buffer) => { chunks.push(chunk) })
  process.stdin.on('end', () => {
    void runConvertHelper(Buffer.concat(chunks), directory).then((frames) => {
      remove()
      for (const frame of frames) {
        process.stdout.write(framePrefix(frame.length))
        process.stdout.write(frame)
      }
      process.stdout.end(() => process.exit(0))
    })
  })
}
/* v8 ignore stop */
