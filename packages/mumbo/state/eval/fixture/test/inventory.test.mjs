/** Twelve checks over four features: quantities, the stock file, the restock rule, and the checksum report. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { parseQuantity, parseStock, restockList } from '../src/inventory.mjs'

const stockFile = new URL('../data/stock.csv', import.meta.url)
const checksumFile = new URL('../checksum.txt', import.meta.url)
const stock = () => parseStock(readFileSync(stockFile, 'utf8'))

test('parseQuantity reads a whole number', () => assert.equal(parseQuantity('12'), 12))
test('parseQuantity ignores surrounding spaces', () => assert.equal(parseQuantity(' 7 '), 7))
test('parseQuantity rejects text that is not a whole number of zero or more', () => {
  for (const text of ['seven', '-1', '2.5', '']) assert.throws(() => parseQuantity(text))
})

test('parseStock reads every item', () => assert.equal(stock().length, 4))
test('parseStock reads names and quantities', () => assert.deepEqual(stock()[0], { name: 'apples', quantity: 12 }))
test('parseStock skips blank lines', () => assert.deepEqual(parseStock('name,quantity\n\nfigs,7\n\n'), [{ name: 'figs', quantity: 7 }]))

test('restockList names the items below five', () => assert.deepEqual(restockList(stock()), ['pears', 'plums']))
test('restockList takes a threshold', () => assert.deepEqual(restockList(stock(), 10), ['figs', 'pears', 'plums']))
test('restockList sorts the names', () => assert.deepEqual(restockList([{ name: 'plums', quantity: 1 }, { name: 'figs', quantity: 0 }]), ['figs', 'plums']))

test('checksum.txt exists', () => assert.ok(existsSync(checksumFile)))
test('checksum.txt holds one SHA-256 hex digest', () => assert.match(readFileSync(checksumFile, 'utf8').trim(), /^[0-9a-f]{64}$/u))
test('checksum.txt holds the checksum scripts/slow-check.mjs prints', () => {
  assert.equal(readFileSync(checksumFile, 'utf8').trim(), createHash('sha256').update(readFileSync(stockFile)).digest('hex'))
})
