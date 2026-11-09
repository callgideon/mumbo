// Offboard one person's data: kill their E2B boxes and children, delete every version of their backup, and list (never delete)
// the projects they own. Dry run by default. This does NOT revoke access: run RUNBOOK.md "Offboarding a person" steps 1-4 first
// (Google, Supabase, the `!email` deny entry), or the next visit by a still-admitted person recreates the box from nothing.
// Usage: node offboard.mjs <email>                     list what would be deleted
//        node offboard.mjs <email> --delete <email>    delete it (the email repeated, as confirmation)
// Env: E2B_API_URL, E2B_SANDBOX_URL, E2B_API_KEY (as template.mjs), BACKUP_BUCKET, AWS_REGION, REDIS_URL (project listing).
// Run from deploy/boxes/edge through the tunnel in RUNBOOK.md. The edge drops its Redis record of a box once E2B no longer has it.
import { pathToFileURL } from 'node:url'
import { userPrefix } from './edge.mjs'
import { projectsOwnedBy, projectPrincipal } from './projects.mjs'

/** Parses argv (after the script name). Throws unless the email is valid and any `--delete` repeats it exactly. */
export function offboardArgs(args) {
  const [email, flag, confirm, ...rest] = args
  if (!email || !/^[^@\s]+@[^@\s]+$/.test(email) || rest.length || (flag !== undefined && flag !== '--delete')) throw new Error('usage: offboard.mjs <email> [--delete <email>]')
  if (flag === '--delete' && confirm?.toLowerCase() !== email.toLowerCase()) throw new Error('--delete needs the same email again as confirmation')
  return { email: email.toLowerCase(), apply: flag === '--delete' }
}

/** The S3 operations the script needs, over an AWS SDK client and its command classes. */
export function s3Adapter(client, { ListObjectVersionsCommand, DeleteObjectsCommand }) {
  return {
    /** Every object version and delete marker under the prefix, across pages. */
    async listObjectVersions(Bucket, Prefix) {
      const out = []
      for (let KeyMarker, VersionIdMarker; ;) {
        const r = await client.send(new ListObjectVersionsCommand({ Bucket, Prefix, KeyMarker, VersionIdMarker }))
        out.push(...[...r.Versions ?? [], ...r.DeleteMarkers ?? []].map(v => ({ Key: v.Key, VersionId: v.VersionId })))
        if (!r.IsTruncated) return out
        KeyMarker = r.NextKeyMarker; VersionIdMarker = r.NextVersionIdMarker
      }
    },
    /** Deletes the versions 1000 at a time; throws if S3 reports any per-object error. */
    async deleteVersions(Bucket, objects) {
      for (let i = 0; i < objects.length; i += 1000) {
        const r = await client.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: objects.slice(i, i + 1000), Quiet: true } }))
        if (r.Errors?.length) throw new Error(`S3 refused ${r.Errors.length} deletion(s): ${r.Errors[0].Message}`)
      }
    },
  }
}

async function listSandboxes(e2b, query) {
  const pager = e2b.Sandbox.list({ query })
  const found = []
  while (pager.hasNext) found.push(...await pager.nextItems())
  return found
}

/** The person's own boxes (`metadata.user`) and children (`metadata.owner`), matched exactly; the query alone is not trusted. */
async function theirs(e2b, email) {
  const boxes = (await listSandboxes(e2b, { metadata: { user: email }, state: ['running', 'paused'] })).filter(s => s.metadata?.user === email)
  const children = (await listSandboxes(e2b, { metadata: { owner: email }, state: ['running', 'paused'] })).filter(s => s.metadata?.owner === email)
  return [...boxes.map(s => ({ id: s.sandboxId, kind: 'box', owner: s.metadata.user })), ...children.map(s => ({ id: s.sandboxId, kind: 'child', owner: s.metadata.owner }))]
}

/** Lists the person's sandboxes, backup versions and owned projects; with `apply`, kills the sandboxes, deletes the versions and verifies
 *  none remain (throws otherwise). Projects are only listed. */
export async function offboard({ email, apply, e2b, s3, bucket, store, say = console.log }) {
  const prefix = `${userPrefix(email)}/`
  const sandboxes = await theirs(e2b, email)
  const versions = await s3.listObjectVersions(bucket, prefix)
  const projects = await projectsOwnedBy(store, email)
  say(`${email}: ${sandboxes.length} sandbox(es), ${versions.length} backup version(s) under s3://${bucket}/${prefix}`)
  for (const s of sandboxes) say(`  ${s.kind} ${s.id} owner ${s.owner}`)
  for (const v of versions) say(`  backup ${v.Key} ${v.VersionId}`)
  for (const p of projects) {
    const live = (await listSandboxes(e2b, { metadata: { user: projectPrincipal(p) }, state: ['running', 'paused'] })).filter(s => s.metadata?.user === projectPrincipal(p))
    say(`  project ${p} owned by ${email}: sandbox(es) ${live.map(s => s.sandboxId).join(', ') || 'none'}; NOT deleted (founder decides: kill or transfer)`)
  }
  if (!apply) { say('dry run: nothing deleted'); return { sandboxes, versions, projects } }
  for (const s of sandboxes) { await e2b.Sandbox.kill(s.id); say(`killed ${s.id}`) }
  if (versions.length) { await s3.deleteVersions(bucket, versions); say(`deleted ${versions.length} version(s)`) }
  const left = [...await theirs(e2b, email), ...(await s3.listObjectVersions(bucket, prefix)).map(v => ({ id: `${v.Key}@${v.VersionId}` }))]
  if (left.length) throw new Error(`offboarding incomplete, still present: ${left.map(l => l.id).join(', ')}`)
  say(`verified: no sandbox or backup version of ${email} remains${projects.length ? `; ${projects.length} owned project(s) remain: ${projects.join(', ')}` : ''}`)
  return { sandboxes, versions, projects }
}

async function main() {
  const { email, apply } = offboardArgs(process.argv.slice(2))
  for (const k of ['BACKUP_BUCKET', 'REDIS_URL', 'E2B_API_KEY']) if (!process.env[k]) throw new Error(`${k} is required`)
  const e2b = await import('e2b')
  const { S3Client, ListObjectVersionsCommand, DeleteObjectsCommand } = await import('@aws-sdk/client-s3')
  const { createClient } = await import('redis')
  const { redisStore } = await import('./store.mjs')
  const redis = createClient({ url: process.env.REDIS_URL })
  await redis.connect()
  const s3 = s3Adapter(new S3Client({ region: process.env.AWS_REGION ?? 'us-east-1' }), { ListObjectVersionsCommand, DeleteObjectsCommand })
  const store = redisStore(redis)
  try { await offboard({ email, apply, e2b: e2b.default?.Sandbox ? e2b.default : e2b, s3, bucket: process.env.BACKUP_BUCKET, store }) } finally { await store.close() }
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main().catch((e) => { console.error(e.message); process.exit(1) })
