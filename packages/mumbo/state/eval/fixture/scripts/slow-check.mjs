/** The slow check: prints the stock file's checksum after two minutes. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

console.log('slow check started; the checksum follows in about two minutes')
setTimeout(() => {
  console.log(createHash('sha256').update(readFileSync(new URL('../data/stock.csv', import.meta.url))).digest('hex'))
}, 120_000)
