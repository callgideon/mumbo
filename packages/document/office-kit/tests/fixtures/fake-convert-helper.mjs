/**
 * Stand-in conversion helper that answers in one chosen way: `node fake-convert-helper.mjs <mode>`. Mode `stop`
 * writes its process id to the path in the next argument, then stops itself; mode `no-read` exits without reading.
 */
import { writeFileSync } from 'node:fs'

const mode = process.argv[2]
const PDF = Buffer.from('%PDF-1.7\nfake helper\n%%EOF\n')
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2])

function frame(bytes) {
  const prefix = Buffer.alloc(4)
  prefix.writeUInt32BE(bytes.length)
  return Buffer.concat([prefix, bytes])
}
const header = value => frame(Buffer.from(JSON.stringify(value)))
const image = (index, fields = {}) => ({ index, width: 10, height: 20, ...fields })
const pdf = () => [header({ ok: true, missingFonts: ['Fake Sans'], pageCount: 1 }), frame(PDF)]

/** Answers that end the process themselves; the others keep it running until the parent terminates it. */
const exiting = {
  pdf,
  images: () => [header({ ok: true, missingFonts: [], pageCount: 3, dpi: 96, images: [image(1, { page: 2 }), image(0, { sheet: 'Data', range: 'A1:B2' })] }),
    frame(PNG), frame(PNG)],
  failure: () => [header({ ok: false, code: 'invalid-document', message: 'forged\n[I] dsh launch token line' })],
  unavailable: () => [header({ ok: false, code: 'unavailable', message: 'forged\n[I] dsh launch token line' })],
  empty: () => [],
  'short-frame': () => [header({ ok: true, missingFonts: [] }), frame(PDF).subarray(0, 8)],
  trailing: () => [header({ ok: true, missingFonts: [] }), frame(PDF), Buffer.from('x')],
  'exit-1': pdf,
  large: () => [header({ ok: true, missingFonts: [] }), frame(Buffer.alloc(256 * 1024, 7))],
}
const holding = {
  silent: () => [],
  'not-json': () => [frame(Buffer.from('not json'))],
  'extra-key': () => [header({ ok: true, missingFonts: [], extra: 1 }), frame(PDF)],
  'unknown-code': () => [header({ ok: false, code: 'busy', message: 'busy' })],
  oversized: () => [header({ ok: true, missingFonts: [] }), frame(PDF).subarray(0, 4).fill(0x7f)],
  'too-many-images': () => [header({ ok: true, missingFonts: [], pageCount: 3, dpi: 96, images: [image(0), image(1), image(2)] })],
  'zero-dpi': () => [header({ ok: true, missingFonts: [], pageCount: 1, dpi: 0, images: [] })],
  'bad-page-count': () => [header({ ok: true, missingFonts: [], pageCount: -1 }), frame(PDF)],
  'bad-image': () => [header({ ok: true, missingFonts: [], pageCount: 1, dpi: 96, images: [image(0, { page: 0 })] })],
}

if (mode === 'no-read') process.exit(0)
if (mode === 'stop') {
  writeFileSync(process.argv[3], String(process.pid))
  process.kill(process.pid, 'SIGSTOP')
}
process.stdin.resume()
process.stdin.on('end', () => {
  const answer = exiting[mode] ?? holding[mode]
  if (answer === undefined) throw new Error(`unknown mode ${mode}`)
  process.stdout.write(Buffer.concat(answer()))
  if (mode === 'exit-1') process.exitCode = 1
  if (holding[mode] !== undefined) setInterval(() => {}, 60_000)
})
