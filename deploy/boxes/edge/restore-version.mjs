// Restore a person's or project's box from an older backup version (RUNBOOK.md "Restore an older S3 version"). Lists the
// versions of the principal's latest.tar.gz, any pending restore record and their box; --set writes the one-shot record
// `restore:<principal>` (edge.mjs restoreKey) that the edge reads at the box's next creation, and --clear removes it.
// Nothing in S3 is changed. Dry run by default.
// Usage: node deploy/boxes/edge/restore-version.mjs <principal>         list versions, the pending record and the box
//        ... <principal> <versionId>                                  also check that version (dry run)
//        ... <principal> <versionId> --set <principal>                write the record (the principal repeated, as confirmation)
//        ... <principal> --clear <principal>                          remove a pending record
//        ... --allow-empty-store                                      accept a Redis with no `boxes` set
// <principal>: an email (compared lowercased) or project:<id>. Env and tunnels as offboard.mjs (RUNBOOK "Offboarding a
// person" step 4): E2B_API_URL, E2B_API_KEY, BACKUP_BUCKET, AWS_REGION, REDIS_URL, REDIS_SERVERNAME. The record takes effect
// only when the box is next created, so a running or paused box must be killed after --set.
import { pathToFileURL } from 'node:url'
import { restoreKey, userPrefix } from './edge.mjs'
import { assertEdgeStore, listSandboxes, s3Adapter } from './offboard.mjs'
import { isProjectId } from './projects.mjs'

const USAGE = 'usage: restore-version.mjs <email | project:id> [<versionId>] [--set <principal> | --clear <principal>] [--allow-empty-store]'

/** Parses argv (after the script name). Throws unless the principal is valid, --set has a version id, --clear has none, and
 *  either flag repeats the principal exactly. */
export function restoreArgs(args) {
  const allowEmptyStore = args.includes('--allow-empty-store')
  const a = args.filter(x => x !== '--allow-empty-store')
  const principal = a[0]?.toLowerCase()
  const versionId = a[1]?.startsWith('--') ? undefined : a[1]
  const [flag, confirm, ...rest] = a.slice(versionId === undefined ? 1 : 2)
  const valid = /^[^@\s]+@[^@\s]+$/.test(principal ?? '') || (principal?.startsWith('project:') && isProjectId(principal.slice('project:'.length)))
  if (!valid || rest.length || (flag !== undefined && flag !== '--set' && flag !== '--clear') || (flag === '--clear' && versionId !== undefined)) throw new Error(USAGE)
  if (flag === '--set' && versionId === undefined) throw new Error('--set needs the version id: <principal> <versionId> --set <principal>')
  if (flag !== undefined && confirm?.toLowerCase() !== principal) throw new Error(`${flag} needs the same principal again as confirmation`)
  return { principal, versionId, action: flag?.slice(2), allowEmptyStore }
}

/** Lists the principal's backup versions (newest first), pending record and box; with a version id, throws unless it is a
 *  version, not a delete marker, of exactly the principal's key. `action` 'set' then writes the record, 'clear' removes it. */
export async function restoreVersion({ principal, versionId, action, e2b, s3, bucket, store, say = console.log, now = Date.now }) {
  const key = `${userPrefix(principal)}/latest.tar.gz`
  // The listing is by prefix, which also matches longer keys.
  const versions = (await s3.listObjectVersions(bucket, key)).filter(v => v.Key === key).sort((x, y) => new Date(y.LastModified) - new Date(x.LastModified))
  const pending = await store.getDoc(restoreKey(principal))
  const boxes = (await listSandboxes(e2b, { metadata: { user: principal }, state: ['running', 'paused'] })).filter(s => s.metadata?.user === principal)
  say(`${principal}: ${versions.length} version(s) of s3://${bucket}/${key}, newest first`)
  for (const v of versions) say(`  ${new Date(v.LastModified).toISOString()}  ${v.DeleteMarker ? 'delete marker' : `${v.Size} bytes`}  ${v.VersionId}${v.IsLatest ? '  latest' : ''}`)
  say(pending ? `pending restore: ${pending.versionId}, set ${new Date(pending.at).toISOString()}` : 'pending restore: none')
  say(boxes.length ? `box: ${boxes.map(s => `${s.sandboxId} ${s.state}`).join(', ')}; a record takes effect only when the box is next created, so kill it after --set`
    : 'box: none running or paused; the next visit creates one')
  if (versionId !== undefined) {
    const v = versions.find(x => x.VersionId === versionId)
    if (!v) throw new Error(`${versionId} is not a version of ${key}`)
    if (v.DeleteMarker) throw new Error(`${versionId} is a delete marker of ${key}, not a backup`)
  }
  if (action === 'set') {
    await store.putDoc(restoreKey(principal), { versionId, at: now() })
    say(`set: the next creation of this box restores ${versionId}${pending ? ` (replaced ${pending.versionId})` : ''}`)
  } else if (action === 'clear') {
    await store.deleteDoc(restoreKey(principal))
    say(pending ? `cleared the pending restore of ${pending.versionId}` : 'cleared: nothing was pending')
  } else say(versionId === undefined ? 'dry run: nothing changed' : `dry run: ${versionId} is a backup version; rerun with --set ${principal} to restore it`)
  return { key, versions, pending, boxes }
}

async function main() {
  const { principal, versionId, action, allowEmptyStore } = restoreArgs(process.argv.slice(2))
  for (const k of ['BACKUP_BUCKET', 'REDIS_URL', 'REDIS_SERVERNAME', 'E2B_API_KEY']) if (!process.env[k]) throw new Error(`${k} is required`)
  const e2b = await import('e2b')
  const { S3Client, ListObjectVersionsCommand } = await import('@aws-sdk/client-s3')
  const { createClient } = await import('redis')
  const { redisStore } = await import('./store.mjs')
  const redis = createClient({ url: process.env.REDIS_URL, socket: { servername: process.env.REDIS_SERVERNAME } })
  await redis.connect()
  const store = redisStore(redis)
  try {
    await assertEdgeStore(redis, allowEmptyStore)
    const s3 = s3Adapter(new S3Client({ region: process.env.AWS_REGION ?? 'us-east-1' }), { ListObjectVersionsCommand })
    await restoreVersion({ principal, versionId, action, e2b: e2b.default?.Sandbox ? e2b.default : e2b, s3, bucket: process.env.BACKUP_BUCKET, store })
  } finally { await store.close() }
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main().catch((e) => { console.error(e.message); process.exit(1) })
