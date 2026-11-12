/** Vitest configuration for the on-demand K eval; no CI project matches `*.eval.ts`. */
import { fileURLToPath } from 'node:url'
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin, vitestExecArgv } from '../../../../vitest.shared.ts'

export default defineConfig({
  plugins: [tsconfigPaths({ projects: [fileURLToPath(new URL('../../../../tsconfig.base.json', import.meta.url))] }), standardDecoratorPlugin()],
  test: {
    root: fileURLToPath(new URL('.', import.meta.url)),
    include: ['*.eval.ts'],
    execArgv: vitestExecArgv,
    // Each run plays up to K_EVAL_MAX_TURNS real model turns and waits on a two-minute background check.
    testTimeout: 24 * 60 * 60_000,
  },
})
