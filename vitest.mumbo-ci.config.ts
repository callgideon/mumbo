// mumbo-ci's unit selection: the root config without the tests scripts/mumbo-ci-unit-exclusions.ts lists. CLI
// --exclude does not reach the inline projects, so each project gets the globs.
import { defineConfig } from 'vitest/config'
import base from './vitest.config.ts'
import { mumboCiUnitExcludeGlobs } from './scripts/mumbo-ci-unit-exclusions.ts'

const excluded = mumboCiUnitExcludeGlobs()
const test = base.test ?? {}

export default defineConfig({
  ...base,
  test: {
    ...test,
    exclude: [...test.exclude ?? [], ...excluded],
    projects: (test.projects ?? []).map((project) => {
      if (typeof project !== 'object' || project instanceof Promise || project.test === undefined) {
        throw new Error('vitest.mumbo-ci.config.ts: every root project must be an inline config')
      }
      return { ...project, test: { ...project.test, exclude: [...project.test.exclude ?? [], ...excluded] } }
    }),
  },
})
