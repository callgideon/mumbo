/**
 * The provider runs each conversion in the helper when the subprocess provider starts children as another identity,
 * in the in-process Kit converter otherwise, and nowhere when DSH runs as root without a subprocess provider.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import type { Converter } from '@deepseek-ai/libreoffice-kit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import OfficeKit, { OfficeSourceKey, type OfficeKitRequest } from '../src/index.ts'

const kit = vi.hoisted(() => ({ create: vi.fn<() => Promise<Converter>>() }))
vi.mock('@deepseek-ai/libreoffice-kit', () => ({ createConverter: kit.create }))

const posix = process.platform === 'win32' ? describe.skip : describe
const FAKE_HELPER = fileURLToPath(new URL('./fixtures/fake-convert-helper.mjs', import.meta.url))
const KIT_PDF = Buffer.from('%PDF-1.7\nin-process\n%%EOF\n')
const HELPER_PDF = Buffer.from('%PDF-1.7\nfake helper\n%%EOF\n')
const request: OfficeKitRequest = { extension: 'docx', priority: 'foreground', source: {
  key: OfficeSourceKey('source'), version: 'v1', bytes: 4, read: async () => ({ bytes: new Uint8Array([80, 75, 3, 4]), version: 'v1' }),
} }

let ctx: Context
let outputDirectory: string
const logged = vi.fn()

beforeEach(async () => {
  ctx = new Context()
  for (const level of ['error', 'warn', 'info', 'debug'] as const) ctx.logger[level] = logged
  outputDirectory = await mkdtemp(join(tmpdir(), 'dsh-office-kit-routing-'))
  kit.create.mockReset().mockImplementation(async () => ({
    backend: 'wasm',
    render: async ({ outputPath }) => {
      await writeFile(outputPath, KIT_PDF)
      return { backend: 'wasm', missingFonts: [] }
    },
    renderImages: () => Promise.reject(new Error('Unexpected Converter.renderImages call')),
    convert: () => Promise.reject(new Error('Unexpected Converter.convert call')),
    recalculate: () => Promise.reject(new Error('Unexpected Converter.recalculate call')),
    dispose: async () => {},
  }))
})

afterEach(async () => {
  await ctx.fiber.dispose()
  vi.restoreAllMocks()
  logged.mockReset()
  await rm(outputDirectory, { recursive: true, force: true })
})

/** Mount the subprocess provider, optionally reporting a child identity, and start `mode` of the stand-in helper. */
async function subprocess(identity: boolean, mode: string): Promise<SubprocessSpawnSpec[]> {
  await ctx.plugin(LocalSubprocessRuntime)
  if (identity) vi.spyOn(ctx.subprocess, 'childIdentity', 'get').mockReturnValue({ uid: 1003, gid: 1003, groups: [1003] })
  const spawn = ctx.subprocess.spawn.bind(ctx.subprocess)
  const specs: SubprocessSpawnSpec[] = []
  vi.spyOn(ctx.subprocess, 'spawn').mockImplementation((spec) => {
    specs.push(spec)
    return spawn({ ...spec, argv: [process.execPath, FAKE_HELPER, mode] })
  })
  return specs
}

async function officeKit(): Promise<OfficeKit> {
  await ctx.plugin(OfficeKit, { outputDirectory })
  return ctx.officeKit
}

posix('conversion routing', () => {
  it('runs a conversion in the helper when the subprocess provider has a child identity', async () => {
    const specs = await subprocess(true, 'pdf')
    const result = await (await officeKit()).convert(request)
    expect(Buffer.from(result.pdf)).toEqual(HELPER_PDF)
    expect(result.missingFonts).toEqual(['Fake Sans'])
    expect(specs).toHaveLength(1)
    expect(specs[0]!.argv.at(-1)).toMatch(/convert-helper\.(ts|js)$/u)
    expect(kit.create).not.toHaveBeenCalled()
  })

  it('logs no helper text when the helper reports a failure', async () => {
    await subprocess(true, 'unavailable')
    await expect((await officeKit()).convert(request))
      .rejects.toMatchObject({ code: 'unavailable', message: 'forged\n[I] dsh launch token line' })
    const text = (value: unknown): string => value instanceof Error ? `${value.message} ${text(value.cause)}` : String(value)
    expect(logged.mock.calls.flat().map(text).join('\n')).not.toContain('forged')
  })

  it('runs a conversion in the in-process Kit converter when the subprocess provider has no child identity', async () => {
    vi.spyOn(process, 'getuid').mockReturnValue(1000)
    const specs = await subprocess(false, 'pdf')
    const result = await (await officeKit()).convert(request)
    expect(Buffer.from(result.pdf)).toEqual(KIT_PDF)
    expect(kit.create).toHaveBeenCalledOnce()
    expect(specs).toEqual([])
  })

  it('refuses every conversion as root without a subprocess provider', async () => {
    vi.spyOn(process, 'getuid').mockReturnValue(0)
    await expect((await officeKit()).convert(request)).rejects.toMatchObject({ name: 'OfficeKitError', code: 'unavailable' })
    expect(kit.create).not.toHaveBeenCalled()
  })

  it('refuses every conversion as root when the subprocess provider has no child identity', async () => {
    vi.spyOn(process, 'getuid').mockReturnValue(0)
    const specs = await subprocess(false, 'pdf')
    await expect((await officeKit()).convert(request)).rejects.toMatchObject({ name: 'OfficeKitError', code: 'unavailable' })
    expect(kit.create).not.toHaveBeenCalled()
    expect(specs).toEqual([])
  })
})
