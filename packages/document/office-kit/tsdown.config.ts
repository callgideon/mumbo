import { defineConfig } from 'tsdown'

const options = { outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2024', fixedExtension: false, dts: false, clean: false } as const

/** Bundle the package root and the conversion helper separately, so neither entry imports a shared chunk. */
export default defineConfig([
  { ...options, entry: ['lib/types/index.js'] },
  { ...options, entry: { 'convert-helper': 'lib/types/convert-helper.js' } },
])
