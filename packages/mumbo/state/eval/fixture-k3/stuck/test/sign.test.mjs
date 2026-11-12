/** The signature the release pipeline published for release 1.4.0, made with the operator's key. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sign } from '../src/app.mjs'

test('signs the release note with the operator key', () => {
  assert.equal(sign('release 1.4.0'), 'b3df87dff0de1285ada066e6d3af4f6be04dc0af9aaeaa9e716717204913ba72')
})
