/** Plugin feature previews are one fixed-canvas English SVG beside their detail document. */
import { globSync, readFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { JSDOM } from 'jsdom'
import { expect, it, onTestFinished } from 'vitest'

const root = `${import.meta.dirname}/..`
const svgPaths = globSync('packages/*/*/docs/*.svg', { cwd: root }).sort()
/** Size limit for one preview, as the standalone bundle and Host routes both serve the file individually. */
const MAX_PREVIEW_BYTES = 1024 * 1024

it('keeps every preview a self-contained 640×300 SVG', () => {
  // Guard against a narrowed corpus: each preview moved into a bundle's docs directory stays checked.
  expect(svgPaths.length).toBeGreaterThan(0)
  const browser = new JSDOM('')
  onTestFinished(() => { browser.window.close() })
  const parser = new browser.window.DOMParser()
  for (const path of svgPaths) {
    expect(extname(path), path).toBe('.svg')
    expect(basename(path, '.svg'), path).not.toMatch(/\.[a-z]{2}(?:-[A-Za-z]+)?$/u)
    const svg = readFileSync(join(root, path), 'utf8')
    expect(Buffer.byteLength(svg), path).toBeLessThanOrEqual(MAX_PREVIEW_BYTES)
    const document = parser.parseFromString(svg, 'image/svg+xml')
    expect(document.querySelector('parsererror'), path).toBeNull()
    expect(document.documentElement.namespaceURI, path).toBe('http://www.w3.org/2000/svg')
    expect(document.documentElement.localName, path).toBe('svg')
    expect(document.documentElement.getAttribute('width'), path).toBe('640')
    expect(document.documentElement.getAttribute('height'), path).toBe('300')
    expect(document.documentElement.getAttribute('viewBox'), path).toBe('0 0 640 300')
    expect(document.querySelector('path, rect, circle, ellipse, line, polyline, polygon'), path).not.toBeNull()
    expect(document.querySelector('script, style, foreignObject, text, animate, animateTransform, animateMotion, set'), path).toBeNull()
    const ids = new Set([...document.querySelectorAll('[id]')].map(element => element.id))
    for (const element of [document.documentElement, ...document.querySelectorAll('*')]) {
      for (const attribute of element.attributes) {
        expect(attribute.name, path).not.toMatch(/^on/iu)
        const references = [...attribute.value.matchAll(/url\(([^)]+)\)/gu)].map(match => (match[1] ?? '').replace(/['"]/gu, '').trim())
        if (attribute.localName === 'href') references.push(attribute.value)
        for (const reference of references) {
          if (element.localName === 'image' && attribute.localName === 'href'
            && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z\d+/]+=*$/u.test(reference)) continue
          expect(reference.startsWith('#') && ids.has(reference.slice(1)), `${path}: ${reference}`).toBe(true)
        }
      }
    }
  }
})
