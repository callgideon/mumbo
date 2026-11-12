import { clientBundle } from '../../client/tsdown.client.ts'

export default clientBundle(import.meta.dirname, ['lib/types/index.js'], {
  hostPhase: true,
  lib: { entry: { index: 'lib/types/index.js', 'project-workspace': 'lib/types/project-workspace.js' } },
})
