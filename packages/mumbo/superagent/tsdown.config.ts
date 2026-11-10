import { clientBundle } from '../../client/tsdown.client.ts'

export default clientBundle(import.meta.dirname, ['lib/types/index.js'], {
  lib: { entry: { index: 'lib/types/index.js', 'github-watch': 'lib/types/sources/github.js', 'feishu-watch': 'lib/types/sources/feishu.js' } },
})
