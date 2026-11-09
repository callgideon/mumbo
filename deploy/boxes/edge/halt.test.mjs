// node --test: the stop-everything switch.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { memoryStore } from './store.mjs'
import { projects } from './projects.mjs'
import { haltService } from './halt.mjs'

test('a halted person and every project they own are halted; others are not; clearing works', async () => {
  const store = memoryStore()
  const p = projects({ store, admitted: () => true, log: () => {} })
  const { id: mine } = await p.create('a@x.com', 'Mine')
  const { id: theirs } = await p.create('b@x.com', 'Theirs')
  await p.addMember('b@x.com', theirs, 'a@x.com')
  const halt = haltService({ store })
  assert.equal(await halt.isHalted('a@x.com'), false)
  assert.equal(await halt.get('a@x.com'), false)
  await halt.set('a@x.com', true)
  assert.equal(await halt.get('a@x.com'), true)
  assert.equal(await halt.isHalted('a@x.com'), true)
  assert.equal(await halt.isHalted(`project:${mine}`), true)
  assert.equal(await halt.isHalted(`project:${theirs}`), false)
  assert.equal(await halt.isHalted('b@x.com'), false)
  await halt.set('a@x.com', false)
  assert.equal(await halt.isHalted('a@x.com'), false)
  assert.equal(await halt.isHalted(`project:${mine}`), false)
})
