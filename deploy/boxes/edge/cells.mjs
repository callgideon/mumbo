// Cells (spec section 17c): a cell is one region's E2B (API and client-proxy), backup bucket and capacity. CELLS names
// every cell the edge serves, keyed by region; EDGE_REGION is the cell newcomers are placed in. Without CELLS the edge
// serves one cell, us-east-1, from the single-cell variables (BACKUP_BUCKET, E2B_SANDBOX_URL, MAX_RUNNING_UNITS, and the
// SDK's own E2B_API_URL and E2B_API_KEY). Person docs (`person:<email>`), box records and project docs carry `region`;
// regionOf is the one place that says a record without one is in us-east-1.

/** The region of every record written before cells, and the cell that must always exist. */
export const LEGACY_REGION = 'us-east-1'
/** A record's region; records without one (and absent records) are in us-east-1. */
export const regionOf = (record) => record?.region ?? LEGACY_REGION
/** The store doc that places a principal: `person:<email>`, or a project's own doc `project:<id>` (the principal itself). */
export const placementKey = (principal) => principal.startsWith('project:') ? principal : `person:${principal}`

const FIELDS = ['api', 'sandbox', 'bucket', 'maxUnits', 'e2bKeyEnv']
const fail = (message) => { throw new Error(`edge: ${message}`) }
/** An http(s) origin as a URL: no credentials, path, query or fragment. The message never shows the value. */
const origin = (name, value) => {
  const u = typeof value === 'string' && URL.canParse(value) ? new URL(value) : undefined
  if (!u || !['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.pathname !== '/' || u.search || u.hash) {
    fail(`${name} must be an http:// or https:// origin with no credentials, path, query or fragment; its value is not shown`)
  }
  return u
}

/**
 * The cells and the newcomers' region, from the environment; any violation throws at start, naming the setting.
 * @param {Record<string, string | undefined>} env process.env
 * @returns {{ cells: Record<string, { api?: string, sandbox: URL, bucket: string, maxUnits: number, e2bKeyEnv?: string }>, edgeRegion: string }}
 *   without CELLS, one us-east-1 cell without `api` and `e2bKeyEnv`, whose E2B the SDK takes from its environment
 */
export function cellsConfig(env) {
  if (env.CELLS === undefined) {
    // An edge in another region would aim every person at its own E2B and find no backups: empty boxes for everyone.
    if ((env.AWS_REGION ?? LEGACY_REGION) !== LEGACY_REGION || (env.EDGE_REGION ?? LEGACY_REGION) !== LEGACY_REGION) fail('without CELLS the edge serves only us-east-1; set CELLS and EDGE_REGION')
    if (env.BACKUP_BUCKET === undefined) fail('set BACKUP_BUCKET')
    return { cells: { [LEGACY_REGION]: { sandbox: new URL(env.E2B_SANDBOX_URL ?? 'http://127.0.0.1:3002'), bucket: env.BACKUP_BUCKET, maxUnits: Number(env.MAX_RUNNING_UNITS ?? '0') } }, edgeRegion: LEGACY_REGION }
  }
  let parsed
  try { parsed = JSON.parse(env.CELLS) } catch { fail('CELLS must be JSON') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).length === 0) fail('CELLS must be a JSON object with at least one cell')
  const cells = {}
  for (const [region, c] of Object.entries(parsed)) {
    // The key is also the region the cell's bucket is signed for (cellClients).
    if (!/^[a-z]{2}(-[a-z]+)+-\d+$/.test(region)) fail(`CELLS key ${JSON.stringify(region)} must be a region name such as ap-south-1`)
    const at = `CELLS["${region}"]`
    const keys = c && typeof c === 'object' && !Array.isArray(c) ? Object.keys(c) : []
    const unknown = keys.filter(k => !FIELDS.includes(k)), missing = FIELDS.filter(k => !keys.includes(k))
    if (unknown.length || missing.length) fail(`${at} must have exactly ${FIELDS.join(', ')} (unknown: ${unknown.map(k => JSON.stringify(k)).join(', ') || 'none'}; missing: ${missing.join(', ') || 'none'})`)
    if (typeof c.bucket !== 'string' || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(c.bucket)) fail(`${at}.bucket must be an S3 bucket name`)
    // 0 is no edge-side cap, as MAX_RUNNING_UNITS. Terraform never sends a negative (its formula is at least 0, also for a
    // cell of 0 nodes), so one is a misconfiguration and stops the edge.
    if (!Number.isInteger(c.maxUnits) || c.maxUnits < 0) fail(`${at}.maxUnits must be a whole number of at least 0`)
    if (typeof c.e2bKeyEnv !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(c.e2bKeyEnv)) fail(`${at}.e2bKeyEnv must name an environment variable`)
    // The SDK takes E2B_API_KEY for an empty key, which is another cell's.
    if (!env[c.e2bKeyEnv]) fail(`${at}.e2bKeyEnv names ${c.e2bKeyEnv}, which is unset or empty`)
    cells[region] = { api: origin(`${at}.api`, c.api).origin, sandbox: origin(`${at}.sandbox`, c.sandbox), bucket: c.bucket, maxUnits: c.maxUnits, e2bKeyEnv: c.e2bKeyEnv }
  }
  // Two cells sharing one would mix their backups, keys or boxes.
  for (const f of ['api', 'sandbox', 'bucket', 'e2bKeyEnv']) {
    const values = Object.values(cells).map(c => String(c[f]))
    if (new Set(values).size !== values.length) fail(`two CELLS share one ${f}`)
  }
  if (!cells[LEGACY_REGION]) fail(`CELLS must have ${LEGACY_REGION}, where records without a region are`)
  if (!Object.hasOwn(cells, env.EDGE_REGION ?? '')) fail(`EDGE_REGION must name one of the CELLS: ${Object.keys(cells).join(', ')}`)
  return { cells, edgeRegion: env.EDGE_REGION }
}

/**
 * boxes()'s presignGet over an S3 client, its command classes and the presigner.
 * @returns {(key: string, versionId?: string) => Promise<string | undefined>} HEADs the object, at `versionId` when given
 *   (s3:GetObjectVersion), and presigns a 15-minute GET of the same; undefined on NotFound, and any other error throws.
 */
export const presignGetter = ({ s3, bucket, HeadObjectCommand, GetObjectCommand, getSignedUrl }) => async (key, versionId) => {
  try { await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId })) } catch (e) { if (e.name === 'NotFound') return undefined; throw e }
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId }), { expiresIn: 900 })
}

/**
 * Every cell's clients, built once at start: `Sandbox`, the E2B SDK class bound to the cell's API, key and client-proxy
 * (the module's own class for a cell without `api`, which reads the SDK's environment); `proxy`, the client-proxy the
 * edge sends box requests to; an S3 client signed for the cell's region; and presigners for its bucket.
 * @param {ReturnType<typeof cellsConfig>['cells']} cells
 * @param {object} deps `env` (process.env), the e2b module's `E2B` and `Sandbox`, and @aws-sdk's `S3Client`,
 *   `PutObjectCommand`, `GetObjectCommand`, `HeadObjectCommand` and `getSignedUrl`
 * @returns {Map<string, { region: string, Sandbox: object, proxy: URL, bucket: string, maxUnits: number, s3: object,
 *   presignGet: ReturnType<typeof presignGetter>, presignPut: (key: string) => Promise<string> }>} by region
 */
export function cellClients(cells, { env, E2B, Sandbox, S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, getSignedUrl }) {
  return new Map(Object.entries(cells).map(([region, c]) => {
    const s3 = new S3Client({ region, requestChecksumCalculation: 'WHEN_REQUIRED' })  // presigned for curl, which sends no checksum
    return [region, {
      region, proxy: c.sandbox, bucket: c.bucket, maxUnits: c.maxUnits, s3,
      // The SDK uses sandboxUrl verbatim as the base of every in-box (envd) request: the origin, without a trailing slash.
      // e2b marks sandboxUrl deprecated, to be removed in its next major version; that upgrade must keep a way to set
      // each cell's client-proxy.
      Sandbox: c.e2bKeyEnv ? new E2B({ apiKey: env[c.e2bKeyEnv], apiUrl: c.api, sandboxUrl: c.sandbox.origin }).Sandbox : Sandbox,
      presignGet: presignGetter({ s3, bucket: c.bucket, HeadObjectCommand, GetObjectCommand, getSignedUrl }),
      presignPut: (key) => getSignedUrl(s3, new PutObjectCommand({ Bucket: c.bucket, Key: key, ContentType: 'application/gzip' }), { expiresIn: 900 }),
    }]
  }))
}

/** The cell of `region`; a region without one throws 503 `no cell for region <region>`, never a fallback to us-east-1. */
export function cellIn(cells, region) {
  const cell = cells.get(region)
  if (!cell) throw Object.assign(new Error(`no cell for region ${region}`), { status: 503 })
  return cell
}
