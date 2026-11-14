/**
 * Office conversions in a helper process that the subprocess provider starts as its run-as identity, so LibreOffice
 * parses documents as that user instead of inside the harness process. One helper process serves one operation over
 * raw pipes, in frames of a 4-byte big-endian length followed by that many bytes. The parent writes a JSON
 * {@link HelperRequest} frame and the source frame. The helper answers with a JSON {@link HelperAnswer} frame; a
 * successful answer is followed by the PDF or converted file frame, or by one PNG frame per listed image. The answer
 * is untrusted: the parent decodes it strictly, bounds every frame, and writes the outputs into its own scratch paths.
 * @module dsh-office-kit/convert-child
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import type { ConversionRequest, ConverterOptions, RenderImagesRequest, RenderResult, RenderedImage } from '@deepseek-ai/libreoffice-kit'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { OfficeKitError } from './errors.ts'
import type { OfficeKitErrorCode } from './types.ts'

/**
 * Milliseconds the parent allows one helper run beyond the Kit's own `timeoutMs`, for Node start, Kit import, engine
 * start, and moving the source and outputs through the pipes. A protocol constant, not a deployment choice.
 */
export const HELPER_START_ALLOWANCE_MS = 30_000

/** Node's largest timer delay; a longer deadline would fire at once. */
const MAX_TIMER_DELAY_MS = 2_147_483_647
/** Grace between the provider's termination signals to a helper. */
const HELPER_GRACE_MS = 2_000
/** Retained tail of the helper's stderr. The parent never reads it, so no helper text reaches a log. */
const HELPER_STDERR_BYTES = 4 * 1024
/** Largest answer header frame the parent reads. */
const HEADER_MAX_BYTES = 1024 * 1024
/** Longest failure message, in UTF-16 code units, that the helper sends and the parent accepts. */
export const MESSAGE_MAX_LENGTH = 2048

/** Kit failure codes whose Kit message describes the failure; the Kit's `failed` keeps a fixed message instead. */
const KIT_CODES: ReadonlySet<unknown> = new Set<OfficeKitErrorCode>([
  'input-too-large', 'output-too-large', 'invalid-document', 'unsupported-format', 'invalid-output', 'timeout', 'unavailable',
])
/** Codes a helper failure answer may carry: every code {@link conversionFailure} produces. */
const ANSWER_CODES: ReadonlySet<unknown> = new Set<unknown>([...KIT_CODES, 'failed', 'invalid-request'])

function isCode(codes: ReadonlySet<unknown>, code: unknown): code is OfficeKitErrorCode {
  return codes.has(code)
}

/**
 * Classify a converter failure, both in the provider for its in-process Kit and in the conversion helper.
 * @param cause - the value the converter or an output read threw.
 * @returns `cause` itself when it is an {@link OfficeKitError}; otherwise a new error carrying `cause`:
 * `invalid-request` with the engine's description for a `TypeError` or `RangeError`, the Kit's code and message for
 * a Kit failure code other than `failed`, and `failed` with a fixed message for anything else.
 */
export function conversionFailure(cause: unknown): OfficeKitError {
  if (cause instanceof OfficeKitError) return cause
  if (cause instanceof TypeError || cause instanceof RangeError) return new OfficeKitError('invalid-request', cause.message, { cause })
  const code = typeof cause === 'object' && cause !== null && 'code' in cause ? cause.code : undefined
  if (isCode(KIT_CODES, code)) return new OfficeKitError(code, cause instanceof Error ? cause.message : 'LibreOffice conversion failed.', { cause })
  return new OfficeKitError('failed', 'LibreOffice conversion failed.', { cause })
}

/**
 * The parent's bound on one helper run, from spawn to exit.
 * @param timeoutMs - the Kit's conversion deadline, which the helper applies itself.
 * @returns `timeoutMs` plus {@link HELPER_START_ALLOWANCE_MS}, at most Node's largest timer delay.
 */
export function helperDeadlineMs(timeoutMs: number): number {
  return Math.min(timeoutMs + HELPER_START_ALLOWANCE_MS, MAX_TIMER_DELAY_MS)
}

/**
 * Encode the length prefix of one frame.
 * @param length - payload bytes, below 4 GiB.
 * @returns the 4-byte big-endian length.
 */
export function framePrefix(length: number): Buffer {
  const prefix = Buffer.alloc(4)
  prefix.writeUInt32BE(length)
  return prefix
}

/** Kit options of the helper's converter; the helper resolves the engine itself. */
export type HelperConverterOptions = Omit<ConverterOptions, 'resolveEnginePackage'> & { readonly maxOutputBytes: number }

/** The helper's request header; `input` and `output` are file extensions without the dot. */
export type HelperRequest =
  | {
    readonly operation: 'render' | 'convert' | 'recalculate'
    readonly input: string
    readonly output: string
    /** Worksheet of a CSV conversion. */
    readonly sheet?: string
    readonly options: HelperConverterOptions
  }
  | {
    readonly operation: 'renderImages'
    readonly input: string
    /** The Kit's page, sheet, or range selection, resolution, and per-image limits. */
    readonly selection: Omit<RenderImagesRequest, 'inputPath' | 'outputDir'>
    /** Inclusive PNG bytes across all images. */
    readonly maxBytes: number
    readonly options: HelperConverterOptions
  }

/** One image a render answer lists; its PNG frame follows in the same order. */
export interface HelperImage {
  readonly index: number
  readonly width: number
  readonly height: number
  readonly page?: number
  readonly sheet?: string
  readonly range?: string
}

/**
 * The helper's answer header: a file result followed by one file frame, a render result followed by one PNG frame
 * per image, or a failure followed by nothing.
 */
export type HelperAnswer =
  | { readonly ok: true; readonly missingFonts: string[]; readonly pageCount?: number }
  | { readonly ok: true; readonly missingFonts: string[]; readonly pageCount: number; readonly dpi: number; readonly images: HelperImage[] }
  | { readonly ok: false; readonly code: OfficeKitErrorCode; readonly message: string }

/** Result of a file-producing operation, as the provider reads it. */
export type FileResult = Pick<RenderResult, 'missingFonts' | 'pageCount'>

/** Result of an image render, as the provider reads it. */
export interface ImagesResult {
  readonly images: readonly Pick<RenderedImage, 'index' | 'path' | 'width' | 'height' | 'page' | 'sheet' | 'range' | 'byteLength'>[]
  readonly pageCount: number
  readonly dpi: number
  readonly missingFonts: string[]
}

/**
 * The Kit converter methods the provider calls for one operation; the Kit's own converter and {@link ChildConverter}
 * both provide them. `renderImages` takes the render's total PNG byte budget, which the Kit's converter ignores.
 */
export interface OperationConverter {
  render(request: { inputPath: string; outputPath: string }, signal: AbortSignal): Promise<FileResult>
  convert(request: ConversionRequest, signal: AbortSignal): Promise<FileResult>
  recalculate(request: Omit<ConversionRequest, 'sheet'>, signal: AbortSignal): Promise<FileResult>
  renderImages(request: RenderImagesRequest & { readonly maxPages: number }, signal: AbortSignal, maxBytes: number): Promise<ImagesResult>
}

/**
 * The argv and environment that start the helper in the active runtime form.
 * @returns the helper invocation; source form loads it through tsx with the workspace path map.
 */
export function helperInvocation(): { argv: string[]; env: Record<string, string> } {
  /* v8 ignore next 3 -- built-artifact runs resolve the emitted helper; source-unit coverage cannot change import.meta.url. */
  if (extname(fileURLToPath(import.meta.url)) !== '.ts') {
    return { argv: [process.execPath, fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-office-kit/convert-helper'))], env: {} }
  }
  return {
    argv: [process.execPath, '--import', import.meta.resolve('tsx/esm'), fileURLToPath(new URL('./convert-helper.ts', import.meta.url))],
    env: { TSX_TSCONFIG_PATH: fileURLToPath(new URL('../../../../tsconfig.base.json', import.meta.url)) },
  }
}

function invalidOutput(message: string): OfficeKitError {
  return new OfficeKitError('invalid-output', message)
}

/** Reads frames from the helper's stdout, never further than the frame being read requires. */
class FrameReader {
  private chunks: Buffer[] = []
  private buffered = 0

  constructor(private readonly source: AsyncIterator<Buffer>) {}

  /** Read one frame, refusing a declared length above `limit` before reading its payload. */
  async frame(limit: number, what: string): Promise<Buffer> {
    const length = (await this.take(4)).readUInt32BE(0)
    if (length > limit) throw invalidOutput(`The conversion helper sent ${what} above its ${limit}-byte limit.`)
    return this.take(length)
  }

  /** Require the end of the stream. */
  async end(): Promise<void> {
    if (this.buffered > 0 || (await this.source.next()).done !== true) throw invalidOutput('The conversion helper sent more than its answer.')
  }

  private async take(count: number): Promise<Buffer> {
    while (this.buffered < count) {
      const next = await this.source.next()
      if (next.done === true) throw invalidOutput('The conversion helper ended its answer early.')
      this.chunks.push(next.value)
      this.buffered += next.value.length
    }
    const all = this.chunks.length === 1 ? this.chunks[0] as Buffer : Buffer.concat(this.chunks)
    this.chunks = all.length > count ? [all.subarray(count)] : []
    this.buffered = all.length - count
    return all.subarray(0, count)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether `value` has every required key and no key outside the required and optional ones. */
function hasKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  return required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => required.includes(key) || optional.includes(key))
}

const isCount = (value: unknown, min: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min
const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string')
const isOptional = (value: unknown, check: (value: unknown) => boolean): boolean => value === undefined || check(value)
const isString = (value: unknown): value is string => typeof value === 'string'
const isPage = (value: unknown): value is number => isCount(value, 1)

function isImage(value: unknown): value is HelperImage {
  return isRecord(value) && hasKeys(value, ['index', 'width', 'height'], ['page', 'sheet', 'range'])
    && isCount(value.index, 0) && isCount(value.width, 1) && isCount(value.height, 1)
    && isOptional(value.page, isPage) && isOptional(value.sheet, isString) && isOptional(value.range, isString)
}

/** Decode a failure answer; `undefined` when the answer does not claim to be one. */
function decodeFailure(answer: unknown): OfficeKitError | undefined {
  if (!isRecord(answer) || answer.ok !== false) return undefined
  if (!hasKeys(answer, ['ok', 'code', 'message']) || !isCode(ANSWER_CODES, answer.code)
    || typeof answer.message !== 'string' || answer.message.length > MESSAGE_MAX_LENGTH) {
    throw invalidOutput('The conversion helper sent a malformed failure.')
  }
  return new OfficeKitError(answer.code, answer.message)
}

function decodeFile(answer: unknown): FileResult {
  if (isRecord(answer) && answer.ok === true && hasKeys(answer, ['ok', 'missingFonts'], ['pageCount']) && isStrings(answer.missingFonts)) {
    if (answer.pageCount === undefined) return { missingFonts: answer.missingFonts }
    if (isCount(answer.pageCount, 0)) return { missingFonts: answer.missingFonts, pageCount: answer.pageCount }
  }
  throw invalidOutput('The conversion helper sent a malformed answer.')
}

function decodeImages(answer: unknown, maxImages: number): Omit<ImagesResult, 'images'> & { images: HelperImage[] } {
  if (!isRecord(answer) || answer.ok !== true || !hasKeys(answer, ['ok', 'missingFonts', 'pageCount', 'dpi', 'images'])
    || !isStrings(answer.missingFonts) || !isCount(answer.pageCount, 0) || !isCount(answer.dpi, 1) || !Array.isArray(answer.images)) {
    throw invalidOutput('The conversion helper sent a malformed answer.')
  }
  if (answer.images.length > maxImages) throw invalidOutput(`The conversion helper sent more than ${maxImages} images.`)
  const images: unknown[] = answer.images
  if (!images.every(isImage)) throw invalidOutput('The conversion helper sent a malformed image.')
  return { images, pageCount: answer.pageCount, dpi: answer.dpi, missingFonts: answer.missingFonts }
}

function parseHeader(header: Buffer): unknown {
  try {
    return JSON.parse(header.toString('utf8'))
  } catch (_quotesHelperText) {
    // The parse error quotes the helper's bytes, so it is not kept as a cause.
    throw invalidOutput('The conversion helper sent a malformed answer.')
  }
}

function suffix(path: string): string {
  return extname(path).slice(1)
}

/**
 * Runs each Kit operation in a fresh conversion helper started through the subprocess provider, as the provider's
 * run-as identity. Each method reads the source from the parent's scratch input path, sends it to the helper, decodes
 * the answer, and writes the outputs to the parent's own output paths, created exclusively with mode `0600`. Helper
 * text reaches only the message of a failure the helper reports with its code.
 */
export class ChildConverter implements OperationConverter {
  /**
   * @param subprocess - the provider that starts each helper.
   * @param options - Kit options of the helper's converter; `maxOutputBytes` also bounds a file output frame.
   * @param deadlineMs - bound on one helper run from spawn to exit; on expiry the helper is terminated and the
   * operation rejects with `timeout`. The provider passes {@link helperDeadlineMs} of its `timeoutMs`.
   */
  constructor(
    private readonly subprocess: SubprocessRuntime,
    private readonly options: HelperConverterOptions,
    private readonly deadlineMs: number,
  ) {}

  /**
   * Convert to a PDF in the helper.
   * @param request - absolute scratch input path and fresh PDF output path.
   * @param signal - cancellation; terminates the helper.
   * @returns missing fonts and the PDF page count.
   */
  render(request: { inputPath: string; outputPath: string }, signal: AbortSignal): Promise<FileResult> {
    return this.file('render', request, signal)
  }

  /**
   * Convert to the output path's format in the helper.
   * @param request - absolute scratch input path, fresh output path, and the worksheet of a CSV conversion.
   * @param signal - cancellation; terminates the helper.
   * @returns missing fonts, and the page count of a PDF.
   */
  convert(request: ConversionRequest, signal: AbortSignal): Promise<FileResult> {
    return this.file('convert', request, signal)
  }

  /**
   * Recalculate a workbook in the helper.
   * @param request - absolute scratch input path and fresh output path.
   * @param signal - cancellation; terminates the helper.
   * @returns missing fonts.
   */
  recalculate(request: Omit<ConversionRequest, 'sheet'>, signal: AbortSignal): Promise<FileResult> {
    return this.file('recalculate', request, signal)
  }

  /**
   * Render PNG images in the helper and write them into `request.outputDir`, which this creates with mode `0700`.
   * @param request - the Kit request; `maxPages` also bounds the images the helper may list.
   * @param signal - cancellation; terminates the helper.
   * @param maxBytes - inclusive PNG bytes across all images the helper may send.
   * @returns the images in the helper's order with their saved paths and sizes, the page count, DPI, and missing fonts.
   */
  async renderImages(
    request: RenderImagesRequest & { readonly maxPages: number }, signal: AbortSignal, maxBytes: number,
  ): Promise<ImagesResult> {
    const { inputPath, outputDir, ...selection } = request
    const { answer, pngs } = await this.run({ operation: 'renderImages', input: suffix(inputPath), selection, maxBytes, options: this.options },
      inputPath, signal, async (header, frames) => {
        const answer = decodeImages(header, request.maxPages)
        const pngs: Buffer[] = []
        let remaining = maxBytes
        for (const _image of answer.images) {
          const png = await frames.frame(remaining, 'images')
          remaining -= png.length
          pngs.push(png)
        }
        return { answer, pngs }
      })
    await mkdir(outputDir, { mode: 0o700 })
    const images = []
    for (const [position, image] of answer.images.entries()) {
      const png = pngs[position] as Buffer
      const path = join(outputDir, `image-${position}.png`)
      await writeFile(path, png, { flag: 'wx', mode: 0o600, signal })
      images.push({ ...image, path, byteLength: png.length })
    }
    return { images, pageCount: answer.pageCount, dpi: answer.dpi, missingFonts: answer.missingFonts }
  }

  private async file(operation: 'render' | 'convert' | 'recalculate', request: ConversionRequest, signal: AbortSignal): Promise<FileResult> {
    const { inputPath, outputPath, sheet } = request
    const { result, data } = await this.run({ operation, input: suffix(inputPath), output: suffix(outputPath),
      ...(sheet === undefined ? {} : { sheet }), options: this.options }, inputPath, signal, async (header, frames) =>
      ({ result: decodeFile(header), data: await frames.frame(this.options.maxOutputBytes, 'an output') }))
    await writeFile(outputPath, data, { flag: 'wx', mode: 0o600, signal })
    return result
  }

  /**
   * Start one helper, send the request and source, and decode its complete answer. A successful answer must end the
   * stream and be followed by a zero exit. On every exit path the helper is terminated and its exit awaited, which the
   * provider bounds by the grace period, so a stopped helper holds no conversion slot past the deadline.
   */
  private async run<T>(request: HelperRequest, inputPath: string, signal: AbortSignal,
    read: (header: unknown, frames: FrameReader) => Promise<T>): Promise<T> {
    const source = await readFile(inputPath, { signal })
    const deadline = AbortSignal.timeout(this.deadlineMs)
    const lifetime = AbortSignal.any([signal, deadline])
    const invocation = helperInvocation()
    let handle: SubprocessHandle
    try {
      handle = this.subprocess.spawn({
        argv: invocation.argv, cwd: '/', env: invocation.env,
        stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: HELPER_STDERR_BYTES } },
        graceMs: HELPER_GRACE_MS, signal: lifetime,
      })
    } catch (cause) {
      throw new OfficeKitError('unavailable', 'The conversion helper could not start.', { cause })
    }
    // Piped stdio always yields both streams.
    const stdin = handle.stdin as Writable
    const stdout = handle.stdout as Readable
    const stop = (): void => { stdout.destroy() }
    lifetime.addEventListener('abort', stop, { once: true })
    stdin.on('error', (_closedPipe: Error) => {
      // A helper that exits before reading its request closes the pipe; its answer, or the lack of one, decides the outcome.
    })
    const header = Buffer.from(JSON.stringify(request))
    stdin.write(framePrefix(header.length))
    stdin.write(header)
    stdin.write(framePrefix(source.length))
    stdin.end(source)
    try {
      const frames = new FrameReader(stdout[Symbol.asyncIterator]())
      const answer = parseHeader(await frames.frame(HEADER_MAX_BYTES, 'an answer header'))
      const failure = decodeFailure(answer)
      if (failure !== undefined) {
        await frames.end()
        throw failure
      }
      const result = await read(answer, frames)
      await frames.end()
      if ((await handle.done).exitCode !== 0) throw invalidOutput('The conversion helper failed after its answer.')
      return result
    } catch (error) {
      handle.terminate()
      const exit = await handle.done.then(() => undefined, (spawnFailure: unknown) => ({ spawnFailure }))
      if (deadline.aborted && !signal.aborted) throw new OfficeKitError('timeout', `The conversion helper did not finish within ${this.deadlineMs} ms.`)
      signal.throwIfAborted()
      if (exit !== undefined) throw new OfficeKitError('unavailable', 'The conversion helper could not run.', { cause: exit.spawnFailure })
      throw error
    } finally {
      lifetime.removeEventListener('abort', stop)
      stdout.destroy()
      handle.terminate()
    }
  }
}
