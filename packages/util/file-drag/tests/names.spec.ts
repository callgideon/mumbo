import { expect, it } from 'vitest'
import { resolveDragFileName } from '../src/index.ts'

it.each([
  [{ name: 'photo.jpeg', mediaType: 'image/jpeg' }, 'photo.jpeg'],
  [{ name: 'photo.JPEG', mediaType: 'IMAGE/JPEG; charset=utf-8' }, 'photo.JPEG'],
  [{ name: '보고서', mediaType: 'application/pdf' }, '보고서.pdf'],
  [{ mediaType: 'application/pdf' }, 'file.pdf'],
  [{ name: 'report.png', mediaType: 'application/pdf' }, 'report.pdf'],
  [{ name: 'report.pdf', mediaType: 'application/pdf', outputExtension: '.bin' }, 'report.bin'],
  [{ name: 'report', mediaType: 'application/pdf', outputExtension: 'bin' }, 'report.bin'],
  [{ name: 'custom.asset', mediaType: 'application/x-custom' }, 'custom.asset'],
  [{ name: 'custom', mediaType: 'application/x-custom' }, 'custom'],
  [{ name: '  .. ', mediaType: '' }, 'file'],
  [{ name: 'CON.pdf', mediaType: 'application/pdf' }, '_CON.pdf'],
  [{ name: '../../report.pdf', mediaType: 'application/pdf' }, '_.._report.pdf'],
])('resolves %j to %s', (request, expected) => {
  expect(resolveDragFileName(request)).toBe(expected)
})

it('bounds the filename without cutting off its extension', () => {
  expect(resolveDragFileName({ name: `${'a'.repeat(500)}.pdf`, mediaType: 'application/pdf' })).toBe(`${'a'.repeat(251)}.pdf`)
})

it.each(['그'.repeat(90), '😀'.repeat(100)])('bounds Unicode names by UTF-8 bytes without splitting characters', (name) => {
  const output = resolveDragFileName({ name: `${name}.pdf`, mediaType: 'application/pdf' })
  expect(new TextEncoder().encode(output).length).toBeLessThanOrEqual(255)
  expect(output.endsWith('.pdf')).toBe(true)
  expect(output).not.toContain('\uFFFD')
  expect(output.isWellFormed()).toBe(true)
})
