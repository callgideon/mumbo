// node --test: cells (spec section 17c): CELLS and EDGE_REGION, the single-cell fallback, every cell's clients, and the
// region default.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { LEGACY_REGION, cellClients, cellIn, cellsConfig, placementKey, regionOf } from './cells.mjs'

const US = { api: 'http://api.boxes.internal:3000', sandbox: 'http://sandbox.boxes.internal:3002', bucket: 'mumbo-boxes-backup-641134885443', maxUnits: 44, e2bKeyEnv: 'E2B_API_KEY_US_EAST_1' }
const APS1 = { api: 'http://api.ap-south-1.boxes.internal:3000', sandbox: 'http://sandbox.ap-south-1.boxes.internal:3002', bucket: 'mumbo-boxes-aps1-backup-641134885443', maxUnits: 20, e2bKeyEnv: 'E2B_API_KEY_AP_SOUTH_1' }
const KEYS = { E2B_API_KEY_US_EAST_1: 'key-us', E2B_API_KEY_AP_SOUTH_1: 'key-aps1' }
const two = (cells = { 'us-east-1': US, 'ap-south-1': APS1 }, env = {}) => cellsConfig({ CELLS: JSON.stringify(cells), EDGE_REGION: 'ap-south-1', ...KEYS, ...env })

test('without CELLS: one us-east-1 cell from E2B_SANDBOX_URL, BACKUP_BUCKET and MAX_RUNNING_UNITS, newcomers in us-east-1', () => {
  const { cells, edgeRegion } = cellsConfig({ E2B_SANDBOX_URL: 'http://sandbox.boxes.internal:3002', BACKUP_BUCKET: 'backups', MAX_RUNNING_UNITS: '44', AWS_REGION: 'us-east-1' })
  assert.equal(edgeRegion, 'us-east-1')
  assert.deepEqual(Object.keys(cells), ['us-east-1'])
  const c = cells['us-east-1']
  assert.deepEqual([c.sandbox.href, c.bucket, c.maxUnits, 'api' in c, 'e2bKeyEnv' in c], ['http://sandbox.boxes.internal:3002/', 'backups', 44, false, false])
  // Today's defaults: the local client-proxy and no edge-side cap.
  assert.deepEqual([cellsConfig({ BACKUP_BUCKET: 'b' }).cells['us-east-1'].sandbox.href, cellsConfig({ BACKUP_BUCKET: 'b' }).cells['us-east-1'].maxUnits], ['http://127.0.0.1:3002/', 0])
  assert.equal(cellsConfig({ BACKUP_BUCKET: 'b', EDGE_REGION: 'us-east-1' }).edgeRegion, 'us-east-1')
  assert.throws(() => cellsConfig({}), /edge: set BACKUP_BUCKET/)
  // An edge outside us-east-1 never runs as a single cell: it would give every person an empty box from its own E2B.
  for (const env of [{ AWS_REGION: 'ap-south-1' }, { EDGE_REGION: 'ap-south-1' }]) assert.throws(() => cellsConfig({ BACKUP_BUCKET: 'b', ...env }), /without CELLS the edge serves only us-east-1; set CELLS and EDGE_REGION/, JSON.stringify(env))
})

test('the brief\'s two cells with EDGE_REGION=ap-south-1', () => {
  const { cells, edgeRegion } = two()
  assert.equal(edgeRegion, 'ap-south-1')
  assert.deepEqual(Object.keys(cells), ['us-east-1', 'ap-south-1'])
  assert.deepEqual({ ...cells['ap-south-1'], sandbox: cells['ap-south-1'].sandbox.href }, { ...APS1, sandbox: 'http://sandbox.ap-south-1.boxes.internal:3002/' })
  assert.equal(cells['us-east-1'].api, US.api)
  assert.equal(two({ 'us-east-1': US }, { EDGE_REGION: 'us-east-1' }).edgeRegion, 'us-east-1', 'one cell is enough')
})

test('every CELLS violation stops the edge with a message naming the setting, never a URL or key value', () => {
  const bad = (cells, pattern, env) => assert.throws(() => (typeof cells === 'string' ? cellsConfig({ CELLS: cells, EDGE_REGION: 'us-east-1', ...KEYS }) : two(cells, env)), pattern)
  bad('{"us-east-1":', /^Error: edge: CELLS must be JSON$/)
  bad('{}', /CELLS must be a JSON object with at least one cell/)
  bad('[]', /CELLS must be a JSON object with at least one cell/)
  bad({ 'US-East-1': US }, /CELLS key "US-East-1" must be a region name/)
  bad({ 'us-east-1': US, mumbai: APS1 }, /CELLS key "mumbai" must be a region name/)
  const { bucket, ...noBucket } = APS1
  bad({ 'us-east-1': US, 'ap-south-1': noBucket }, /CELLS\["ap-south-1"\] must have exactly api, sandbox, bucket, maxUnits, e2bKeyEnv \(unknown: none; missing: bucket\)/)
  bad({ 'us-east-1': US, 'ap-south-1': { ...APS1, kmsAlias: 'alias/mumbo-boxes-aps1-backups' } }, /CELLS\["ap-south-1"\] must have exactly .* \(unknown: "kmsAlias"; missing: none\)/)
  bad({ 'us-east-1': US, 'ap-south-1': 'x' }, /CELLS\["ap-south-1"\] must have exactly/)
  const url = /CELLS\["ap-south-1"\]\.(api|sandbox) must be an http:\/\/ or https:\/\/ origin with no credentials, path, query or fragment; its value is not shown/
  for (const [field, value] of [['api', 'ftp://api.x:3000'], ['sandbox', 'http://user:SECRET-pw@sandbox.x:3002'], ['api', 'http://api.x:3000/v1'], ['sandbox', 'http://sandbox.x:3002/?a=1'], ['api', 'not a url'], ['api', 3000]]) {
    assert.throws(() => two({ 'us-east-1': US, 'ap-south-1': { ...APS1, [field]: value } }), (e) => url.test(e.message) && !e.message.includes('SECRET') && !e.message.includes(String(value)), `${field} ${value}`)
  }
  for (const b of ['ab', 'Upper-Case', 'under_score', '-dash-first']) bad({ 'us-east-1': US, 'ap-south-1': { ...APS1, bucket: b } }, /CELLS\["ap-south-1"\]\.bucket must be an S3 bucket name/)
  for (const n of [-4, 1.5, '20', null]) bad({ 'us-east-1': US, 'ap-south-1': { ...APS1, maxUnits: n } }, /CELLS\["ap-south-1"\]\.maxUnits must be a whole number of at least 0/)
  assert.equal(two({ 'us-east-1': US, 'ap-south-1': { ...APS1, maxUnits: 0 } }).cells['ap-south-1'].maxUnits, 0, '0: no edge-side cap')
  bad({ 'us-east-1': US, 'ap-south-1': { ...APS1, e2bKeyEnv: 'lower' } }, /CELLS\["ap-south-1"\]\.e2bKeyEnv must name an environment variable/)
  for (const key of [undefined, '']) {
    assert.throws(() => two(undefined, { E2B_API_KEY_AP_SOUTH_1: key }), (e) => /CELLS\["ap-south-1"\]\.e2bKeyEnv names E2B_API_KEY_AP_SOUTH_1, which is unset or empty/.test(e.message) && !e.message.includes('key-'), JSON.stringify(key))
  }
  // Two cells sharing one would mix backups, keys or boxes.
  for (const field of ['api', 'sandbox', 'bucket', 'e2bKeyEnv']) bad({ 'us-east-1': US, 'ap-south-1': { ...APS1, [field]: US[field] } }, new RegExp(`two CELLS share one ${field}`))
  bad({ 'ap-south-1': APS1 }, /CELLS must have us-east-1, where records without a region are/)
  for (const region of [undefined, '', 'eu-west-1', 'constructor']) bad(undefined, /EDGE_REGION must name one of the CELLS: us-east-1, ap-south-1/, { EDGE_REGION: region })
})

/** A fake E2B client class that records the options each client was made with. */
class FakeE2B {
  static made = []
  constructor(opts) { FakeE2B.made.push(opts); this.Sandbox = { boundTo: opts } }
}
class FakeS3 { constructor(opts) { this.opts = opts } }
const deps = (env = KEYS) => ({ env, E2B: FakeE2B, Sandbox: { module: true }, S3Client: FakeS3, PutObjectCommand: class { constructor(input) { this.input = input } },
  GetObjectCommand: class {}, HeadObjectCommand: class {}, getSignedUrl: async (s3, command) => `signed:${s3.opts.region}:${command.input.Bucket}/${command.input.Key}` })

test('cellClients: each cell\'s E2B class bound to its API, key and client-proxy, its S3 client in its region, and presigners for its bucket', async () => {
  FakeE2B.made = []
  const cells = cellClients(two().cells, deps())
  assert.deepEqual(FakeE2B.made, [
    { apiKey: 'key-us', apiUrl: 'http://api.boxes.internal:3000', sandboxUrl: 'http://sandbox.boxes.internal:3002' },
    { apiKey: 'key-aps1', apiUrl: 'http://api.ap-south-1.boxes.internal:3000', sandboxUrl: 'http://sandbox.ap-south-1.boxes.internal:3002' },
  ], 'the key from the named variable; sandboxUrl is the origin, without a trailing slash')
  const aps1 = cellIn(cells, 'ap-south-1')
  assert.equal(aps1.Sandbox.boundTo, FakeE2B.made[1])
  assert.deepEqual([aps1.region, aps1.proxy.href, aps1.bucket, aps1.maxUnits], ['ap-south-1', 'http://sandbox.ap-south-1.boxes.internal:3002/', APS1.bucket, 20])
  assert.deepEqual([cellIn(cells, 'us-east-1').s3.opts, aps1.s3.opts], [{ region: 'us-east-1', requestChecksumCalculation: 'WHEN_REQUIRED' }, { region: 'ap-south-1', requestChecksumCalculation: 'WHEN_REQUIRED' }])
  assert.equal(await aps1.presignPut('users/x/latest.tar.gz'), `signed:ap-south-1:${APS1.bucket}/users/x/latest.tar.gz`)
  assert.equal(cellIn(cells, 'ap-south-1'), aps1, 'built once')
  assert.throws(() => cellIn(cells, 'eu-west-1'), (e) => e.status === 503 && e.message === 'no cell for region eu-west-1')
  // Without CELLS the module's own Sandbox, which reads E2B_API_URL and E2B_API_KEY as before.
  FakeE2B.made = []
  const one = cellClients(cellsConfig({ BACKUP_BUCKET: 'backups' }).cells, deps({}))
  assert.deepEqual([FakeE2B.made, cellIn(one, LEGACY_REGION).Sandbox], [[], { module: true }])
})

test('cellClients with the real SDK: a cell\'s list reaches its own API with its own key', async () => {
  const { E2B, Sandbox } = await import('e2b')
  const seen = []
  const api = createServer((req, res) => { seen.push([req.url.split('?')[0], req.headers['x-api-key']]); res.writeHead(200, { 'content-type': 'application/json' }).end('[]') })
  await new Promise(r => api.listen(0, '127.0.0.1', r))
  try {
    const at = `http://127.0.0.1:${api.address().port}`
    const { cells } = two({ 'us-east-1': US, 'ap-south-1': { ...APS1, api: at } })
    const { S3Client } = await import('@aws-sdk/client-s3')
    const aps1 = cellIn(cellClients(cells, { ...deps(), E2B, Sandbox, S3Client }), 'ap-south-1')
    await aps1.Sandbox.list({ query: { state: ['running'] } }).nextItems()
    assert.deepEqual(seen, [['/v2/sandboxes', 'key-aps1']])
  } finally { api.close() }
})

test('regionOf: a record\'s region, us-east-1 for one without; placementKey: person docs by email, a project its own doc', () => {
  assert.equal(regionOf({ region: 'ap-south-1' }), 'ap-south-1')
  assert.equal(regionOf({ id: 'p', name: 'old project' }), 'us-east-1')
  assert.equal(regionOf(undefined), 'us-east-1')
  assert.equal(placementKey('a@x.com'), 'person:a@x.com')
  assert.equal(placementKey('project:0123456789abcdef'), 'project:0123456789abcdef')
})
