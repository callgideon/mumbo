// Offboard one person: kill their E2B box(es) and delete every version of their backup. Dry-run by default.
// Usage: node offboard.mjs <email>                     list what would be deleted
//        node offboard.mjs <email> --delete <email>    delete it (the email repeated, as confirmation)
// Env: E2B_API_URL, E2B_SANDBOX_URL, E2B_API_KEY (as template.mjs), BACKUP_BUCKET, AWS_REGION. Run from deploy/boxes/edge
// through the tunnel in RUNBOOK.md "Offboarding a person". The edge's Redis record for the box is dropped by the edge
// itself once E2B no longer has the box (edge.mjs reconcile); remove the person from the allowlist first or their next visit recreates it.
import { pathToFileURL } from 'node:url'
import { userPrefix } from './edge.mjs'

/** Parses argv (after the script name). Throws unless the email is valid and any `--delete` repeats it exactly. */
export function offboardArgs(args) {
  const [email, flag, confirm, ...rest] = args
  if (!email || !/^[^@\s]+@[^@\s]+$/.test(email) || rest.length || (flag !== undefined && flag !== '--delete')) throw new Error('usage: offboard.mjs <email> [--delete <email>]')
  if (flag === '--delete' && confirm?.toLowerCase() !== email.toLowerCase()) throw new Error('--delete needs the same email again as confirmation')
  return { email: email.toLowerCase(), apply: flag === '--delete' }
}

/** Lists the person's boxes and backup object versions; with `apply`, deletes them. Returns what it found. */
export async function offboard({ email, apply, e2b, s3, bucket, say = console.log }) {
  const boxes = []
  const pager = e2b.Sandbox.list({ query: { metadata: { user: email }, state: ['running', 'paused'] } })
  while (pager.hasNext) boxes.push(...await pager.nextItems())
  const prefix = `${userPrefix(email)}/`
  const listed = await s3.listObjectVersions(bucket, prefix)
  say(`${email}: ${boxes.length} box(es) [${boxes.map(b => b.sandboxId).join(', ')}], ${listed.length} backup version(s) under s3://${bucket}/${prefix}`)
  if (!apply) { say('dry run: nothing deleted'); return { boxes, versions: listed } }
  for (const b of boxes) { await e2b.Sandbox.kill(b.sandboxId); say(`killed ${b.sandboxId}`) }
  if (listed.length) { await s3.deleteVersions(bucket, listed); say(`deleted ${listed.length} version(s)`) }
  return { boxes, versions: listed }
}

async function main() {
  const { email, apply } = offboardArgs(process.argv.slice(2))
  const bucket = process.env.BACKUP_BUCKET
  if (!bucket) throw new Error('BACKUP_BUCKET is required')
  const e2b = await import('e2b')
  const { S3Client, ListObjectVersionsCommand, DeleteObjectsCommand } = await import('@aws-sdk/client-s3')
  const client = new S3Client({ region: process.env.AWS_REGION ?? 'us-east-1' })
  const s3 = {
    async listObjectVersions(Bucket, Prefix) {
      const out = []
      for (let KeyMarker, VersionIdMarker; ;) {
        const r = await client.send(new ListObjectVersionsCommand({ Bucket, Prefix, KeyMarker, VersionIdMarker }))
        out.push(...[...r.Versions ?? [], ...r.DeleteMarkers ?? []].map(v => ({ Key: v.Key, VersionId: v.VersionId })))
        if (!r.IsTruncated) return out
        KeyMarker = r.NextKeyMarker; VersionIdMarker = r.NextVersionIdMarker
      }
    },
    async deleteVersions(Bucket, objects) {
      for (let i = 0; i < objects.length; i += 1000) {
        const r = await client.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: objects.slice(i, i + 1000), Quiet: true } }))
        if (r.Errors?.length) throw new Error(`S3 refused ${r.Errors.length} deletion(s): ${r.Errors[0].Message}`)
      }
    },
  }
  await offboard({ email, apply, e2b: e2b.default?.Sandbox ? e2b.default : e2b, s3, bucket })
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main().catch((e) => { console.error(e.message); process.exit(1) })
