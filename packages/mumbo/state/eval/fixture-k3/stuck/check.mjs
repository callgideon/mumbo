/** Checks the signature the release pipeline published for release 1.4.0, made with the operator's key. Prints one line. */
import { sign } from './src/app.mjs'

const published = 'b3df87dff0de1285ada066e6d3af4f6be04dc0af9aaeaa9e716717204913ba72'
try {
  const actual = sign('release 1.4.0')
  if (actual !== published) throw new Error(`the signature of "release 1.4.0" is ${actual}, not the published ${published}`)
  console.log('check passed: the release note signature matches')
} catch (error) {
  console.log(`check failed: ${error.message}`)
  process.exitCode = 1
}
