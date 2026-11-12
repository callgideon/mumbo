/** Applies the next pending migration to db.json, which takes about two minutes, and says how many remain. */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'

const dbFile = new URL('./db.json', import.meta.url)
const read = () => JSON.parse(readFileSync(dbFile, 'utf8'))
const next = readdirSync(new URL('./migrations/', import.meta.url)).sort().find(name => !read().applied.includes(name))
if (next === undefined) {
  console.log('all migrations applied')
} else {
  console.log(`applying ${next}; this takes about two minutes`)
  setTimeout(() => {
    // Another run may have applied it meanwhile.
    const db = read()
    if (db.applied.includes(next)) return console.log(`${next} was applied meanwhile`)
    const migration = JSON.parse(readFileSync(new URL(`./migrations/${next}`, import.meta.url), 'utf8'))
    db.tables[migration.table] = migration.columns
    db.applied.push(next)
    writeFileSync(dbFile, JSON.stringify(db, null, 2) + '\n')
    const left = 4 - db.applied.length
    console.log(left === 0 ? `applied ${next}; all migrations applied` : `applied ${next}; ${left} left`)
  }, 120_000)
}
