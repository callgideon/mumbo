// node --test: the edge's M1 settings from the environment.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { admitted, config, redisUrl, startScript } from './edge.mjs'

const base = { PUBLIC_HOST: 'boxes.mumbo.si', LLM_HOST: 'llm.boxes.mumbo.si', BACKUP_BUCKET: 'backups' }
const M1 = ['PROJECT_DOMAIN', 'APPROVE_HOST', 'GITHUB_AGENT_LOGIN', 'GITHUB_AGENT_ID', 'REQUIRED_CHECKS', 'DAILY_TOKENS_USER', 'DAILY_TOKENS_PROJECT', 'BOX_TEMPLATE', 'PROJECT_TEMPLATE',
  'AUDIT_PREFIX', 'GITHUB_AGENT_TOKEN', 'GITHUB_APP_ID', 'GITHUB_APP_KEY', 'GITHUB_MERGE_TOKEN', 'NTFY_TOPIC', 'SIGNIN_COOKIE', 'SUPABASE_URL', 'MUMBO_OAUTH_REDIRECT_URIS',
  'OPENROUTER_MODELS', 'OPENROUTER_API_KEY', 'OPENROUTER_ZDR', 'OPENROUTER_IMAGE_TOKENS', 'MCP_SERVER_WORKSPACE', 'DOOR_RATE_PER_MINUTE', 'DOOR_BURST',
  'WORKER_TOKEN_HOURS', 'RUN_WILD_DEFAULT_EMAILS', 'CELLS', 'EDGE_REGION', 'AWS_REGION', 'E2B_SANDBOX_URL', 'MAX_RUNNING_UNITS', 'PLACEMENT_CACHE_MS']
/** config() with exactly `base` plus `vars` set among the variables it reads here. */
function configWith(vars = {}) {
  const all = { ...Object.fromEntries(M1.map(k => [k, undefined])), ...base, ...vars }
  const saved = Object.fromEntries(Object.keys(all).map(k => [k, process.env[k]]))
  const apply = (values) => { for (const [k, v] of Object.entries(values)) if (v === undefined) delete process.env[k]; else process.env[k] = v }
  apply(all)
  try { return config() } finally { apply(saved) }
}

test('M1 settings: defaults, and secrets optional so the edge starts before they exist', () => {
  const c = configWith()
  assert.equal(c.approveHost, 'approve.boxes.mumbo.si')
  assert.deepEqual(c.requiredChecks, ['static', 'unit'])
  assert.equal(c.dailyTokensUser, 20_000_000); assert.equal(c.dailyTokensProject, 50_000_000)
  assert.equal(c.projectTemplate, 'mumbo-box'); assert.equal(c.auditPrefix, 'audit/approvals/')
  for (const k of ['agentLogin', 'agentId', 'appId', 'appKey', 'ntfyTopic']) assert.equal(c[k], undefined, k)
  for (const k of ['mergeToken', 'agentToken']) assert.equal(k in c, false, k)
  assert.equal('agentToken' in configWith({ GITHUB_AGENT_TOKEN: 'ghp_x' }), false, 'GITHUB_AGENT_TOKEN is not read')
  assert.equal(configWith({ BOX_TEMPLATE: 'tpl' }).projectTemplate, 'tpl')
  const set = configWith({ GITHUB_APP_ID: '5295930', GITHUB_APP_KEY: 'PEM', REQUIRED_CHECKS: ' Static , unit,' })
  assert.equal(set.appId, '5295930'); assert.equal(set.appKey, 'PEM')
  assert.deepEqual(set.requiredChecks, ['Static', 'unit'], 'trimmed, case kept')
})

test('production hosts: app.mumbo.si gives the project domain and the approve host; a new box\'s start script names only app.mumbo.si hosts', () => {
  const c = configWith({ PUBLIC_HOST: 'app.mumbo.si', LLM_HOST: 'llm.app.mumbo.si' })
  assert.equal(c.projectDomain, 'app.mumbo.si')
  assert.equal(c.approveHost, 'approve.app.mumbo.si')
  const script = startScript(c, 'mbx.t')
  assert.match(script, /DEEPSEEK_BASE_URL=https:\/\/llm\.app\.mumbo\.si\/anthropic DEEPSEEK_SEARCH_BASE_URL=https:\/\/llm\.app\.mumbo\.si /)
  assert.match(script, /url: https:\/\/llm\.app\.mumbo\.si\/mcp\n/)
  assert.match(script, / --public-url https:\/\/app\.mumbo\.si\/ --trusted-host app\.mumbo\.si /)
  assert.doesNotMatch(script, /boxes\.mumbo\.si/)
})

test('prod/modules/edge/edge.tf former-host redirects: 302 for now, path kept (projects to /home), query marked moved=1 first so no target equals a cached plain URL', () => {
  const tf = readFileSync(new URL('../prod/modules/edge/edge.tf', import.meta.url), 'utf8')
  const rule = /resource "aws_lb_listener_rule" "old_hosts" \{[\s\S]*?\n\}\n/.exec(tf)?.[0] ?? ''
  assert.match(rule, /main\s+= \[5, local\.old_hosts, local\.public_host, "\/#\{path\}"\]/)
  assert.match(rule, /approve\s+= \[6, \["approve\.\$\{local\.old_host\}"\], local\.approve_host, "\/#\{path\}"\]/)
  assert.match(rule, /projects = \[40, \["\*\.\$\{local\.old_host\}"\], local\.public_host, "\/home"\]/, 'the wildcard ranks below llm.boxes (model, 20)')
  assert.match(rule, /host\s+= each\.value\[2\]\n.*\n.*\n\s+path\s+= each\.value\[3\]\n\s+query\s+= "moved=1&#\{query\}"\n\s+status_code = "HTTP_302"\n/)
  assert.match(tf, /old_hosts\s+= \[local\.old_host, "api\.mumbo\.si"\]/)
  assert.match(tf, /old_host\s+= "boxes\.mumbo\.si"/)
})

test('an empty REQUIRED_CHECKS fails at start instead of dropping the merge gate\'s CI requirement', () => {
  for (const value of ['', ' ', ' , ,']) assert.throws(() => configWith({ REQUIRED_CHECKS: value }), /REQUIRED_CHECKS must name at least one check/, JSON.stringify(value))
})

test('SIGNIN_COOKIE: _oauth2_proxy_mumbo when unset; an empty or malformed cookie name fails at start', () => {
  assert.equal(configWith().signinCookie, '_oauth2_proxy_mumbo')
  assert.equal(configWith({ SIGNIN_COOKIE: '_other' }).signinCookie, '_other')
  for (const value of ['', ' ', 'a b', 'a=b', 'a;b', '_oauth2_proxy_mumbo,']) assert.throws(() => configWith({ SIGNIN_COOKIE: value }), /SIGNIN_COOKIE must be a cookie name/, JSON.stringify(value))
})

test('rollback safety: the pre-B13 edge filter strips the default sign-in cookie and its chunks', () => {
  // boxHeaders' cookie filter as at 41bac8fe7f: prefix _oauth2_proxy only. Older edge images run it.
  const preB13 = (cookie) => cookie.split(';').map(c => c.trim()).filter(c => c && !c.startsWith('_oauth2_proxy')).join('; ')
  const tfDefault = /variable "signin_cookie_name" \{[^}]*default\s*=\s*"([^"]*)"/.exec(readFileSync(new URL('../prod/edge.tf', import.meta.url), 'utf8'))?.[1]
  assert.equal(tfDefault, configWith().signinCookie, 'the Terraform default and the edge default agree')
  for (const name of [tfDefault, configWith().signinCookie]) assert.equal(preB13(`${name}=a; ${name}_1=b; dsh-auth-x=d`), 'dsh-auth-x=d', name)
})

test('capacity: node_count drives both the node group and the edge cap (24 units per node minus 4, max 10 nodes)', () => {
  const tf = (f) => readFileSync(new URL(`../prod/${f}`, import.meta.url), 'utf8')
  assert.match(tf('modules/edge/edge.tf'), /MAX_RUNNING_UNITS\s*=\s*tostring\(2 \* \(12 \* local\.home\.node_count - 2\)\)/)
  assert.match(tf('modules/edge/edge.tf'), /maxUnits = 2 \* \(12 \* c\.node_count - 2\)/, 'CELLS: the same formula on each cell\'s own node count')
  assert.match(tf('edge.tf'), /"us-east-1" = \{[^}]*node_count\s*= var\.node_count\n[^}]*\}\n\s*"ap-south-1" = \{[^}]*node_count\s*= var\.node_count_ap_south_1\n/)
  assert.match(tf('modules/cell/nodes.tf'), /min_size\s*=\s*min\(2, var\.node_count\)/)
  assert.match(tf('modules/cell/nodes.tf'), /termination_policies\s*=\s*\["OldestLaunchTemplate", "OldestInstance"\]/)
  assert.match(tf('modules/cell/nodes.tf'), /enabled_metrics\s*=\s*\["GroupInServiceInstances"/)
  assert.match(tf('modules/cell/alarms.tf'), /nodes-below-min = \{[^\n]*threshold = var\.node_count/)
  assert.match(tf('modules/edge/edge.tf'), /MAX_RUNNING_BOXES\s*=\s*tostring\(12 \* local\.home\.node_count - 2\)/)
  assert.match(tf('modules/cell/nodes.tf'), /desired_capacity\s*=\s*var\.node_count/)
  assert.doesNotMatch(tf('modules/cell/nodes.tf'), /ignore_changes\s*=\s*\[desired_capacity\]/)
  assert.match(tf('modules/cell/nodes.tf'), /node_max_size = 10\b/)
  assert.match(tf('main.tf'), /var\.node_count <= 10/)
  assert.equal(configWith({ MAX_RUNNING_UNITS: String(2 * (12 * 2 - 2)) }).cells['us-east-1'].maxUnits, 44)
})

test('ALLOWED_EMAILS: a malformed deny entry fails at startup, a well-formed one is kept', () => {
  assert.deepEqual(configWith({ ALLOWED_EMAILS: '@mumbo.si, !A@mumbo.si' }).allowed, ['@mumbo.si', '!a@mumbo.si'])
  for (const bad of ['!', '!mumbo.si', '!@mumbo.si', '!!a@mumbo.si', '!a@']) assert.throws(() => configWith({ ALLOWED_EMAILS: bad }), /must be !local@domain/, bad)
})

test('ALLOWED_EMAILS: comma-separated, trimmed and lowercased; empty admits nobody', () => {
  const allowed = configWith({ ALLOWED_EMAILS: ' @Mumbo.si , @cambrialabs.ai ,, Founder@X.com ' }).allowed
  assert.deepEqual(allowed, ['@mumbo.si', '@cambrialabs.ai', 'founder@x.com'])
  for (const email of ['New@Mumbo.SI', 'a@cambrialabs.ai', 'founder@x.com']) assert.ok(admitted(allowed, email), email)
  assert.equal(admitted(allowed, 'other@x.com'), false)
  assert.deepEqual(configWith({ ALLOWED_EMAILS: ' , ' }).allowed, [])
})

test('no oauth2-proxy launch turns off its email_verified check', () => {
  // The edge never sees the ID token, so oauth2-proxy alone refuses email_verified=false. v7.9.0 checks it only while
  // --insecure-oidc-allow-unverified-email is off and the email claim is `email`, which --oidc-email-claim and its
  // deprecated alias --user-id-claim change (providers/provider_data.go buildSessionFromClaims, providers/providers.go).
  const prod = new URL('../prod/', import.meta.url)
  const files = [...readdirSync(prod, { recursive: true }).filter(f => !f.startsWith('.terraform') && (f.endsWith('.tf') || f === 'terraform.tfvars')).map(f => new URL(f, prod)),
    new URL('./compose.yaml', import.meta.url), new URL('./up.sh', import.meta.url)]
  for (const file of [new URL('modules/edge/edge.tf', prod), new URL('./compose.yaml', import.meta.url)]) assert.match(readFileSync(file, 'utf8'), /--provider=oidc/, file.pathname)
  for (const file of files) assert.doesNotMatch(readFileSync(file, 'utf8'), /allow[-_]?unverified[-_]?email|email[-_]?claim|user[-_]?id[-_]?claim/i, file.pathname)
})

test('the agent is the mumbo-bot App\'s bot user: GITHUB_AGENT_ID is its numeric id, set together with GITHUB_AGENT_LOGIN', () => {
  const c = configWith({ GITHUB_AGENT_LOGIN: 'mumbo-bot[bot]', GITHUB_AGENT_ID: '341797844' })
  assert.equal(c.agentLogin, 'mumbo-bot[bot]')
  assert.equal(c.agentId, 341797844)
  for (const vars of [{ GITHUB_AGENT_LOGIN: 'mumbo-bot[bot]' }, { GITHUB_AGENT_ID: '341797844' }]) assert.throws(() => configWith(vars), /set GITHUB_AGENT_ID and GITHUB_AGENT_LOGIN together/, JSON.stringify(vars))
  for (const id of ['abc', '0', '-1', '1.5', '1e3', ' 1', '12345678901234567']) assert.throws(() => configWith({ GITHUB_AGENT_LOGIN: 'mumbo-bot[bot]', GITHUB_AGENT_ID: id }), /GITHUB_AGENT_ID must be a numeric GitHub user id/, id)
})

test('PAGE_AFTER_MS: default 3000, and a value below 1000 or not a number stops the edge', () => {
  assert.equal(configWith().pageAfterMs, 3000)
  assert.equal(configWith({ PAGE_AFTER_MS: '5000' }).pageAfterMs, 5000)
  for (const bad of ['999', 'soon', '-1', 'Infinity', '']) assert.throws(() => configWith({ PAGE_AFTER_MS: bad }), /PAGE_AFTER_MS/, bad)
})

test('MUMBO_OAUTH_REDIRECT_URIS: with SUPABASE_URL, exact origin-and-path URIs only; anything else stops the edge', () => {
  const sb = { SUPABASE_URL: 'https://ref.supabase.co' }
  assert.equal(configWith({ MUMBO_OAUTH_REDIRECT_URIS: 'not read' }).oauthRedirectUris, undefined)
  assert.deepEqual(configWith({ ...sb, MUMBO_OAUTH_REDIRECT_URIS: ' https://boxes.mumbo.si/oauth2/callback , https://approve.app.mumbo.si/cb,' }).oauthRedirectUris,
    ['https://boxes.mumbo.si/oauth2/callback', 'https://approve.app.mumbo.si/cb'])
  for (const bad of [undefined, '', ' , ', 'https://boxes.mumbo.si', 'https://boxes.mumbo.si/oauth2/callback?x=1', 'https://boxes.mumbo.si/oauth2/callback?', 'https://boxes.mumbo.si/oauth2/callback#x',
    'https://Boxes.mumbo.si/oauth2/callback', 'https://boxes.mumbo.si:443/oauth2/callback', 'https://boxes.mumbo.si/a/../oauth2/callback', '/oauth2/callback', 'not a url',
    'https://boxes.mumbo.si/oauth2/callback,https://boxes.mumbo.si/x?y']) {
    assert.throws(() => configWith({ ...sb, MUMBO_OAUTH_REDIRECT_URIS: bad }), /MUMBO_OAUTH_REDIRECT_URIS/, String(bad))
  }
})

test('OpenRouter route: off unless OPENROUTER_MODELS names models (exact ids, trimmed); ZDR-only unless OPENROUTER_ZDR=false', () => {
  const off = configWith()
  assert.deepEqual(off.openrouterModels, []); assert.equal(off.openrouterKey, undefined); assert.equal(off.openrouterZdr, true)
  const on = configWith({ OPENROUTER_MODELS: ' qwen/qwen3.8-27b , qwen/Qwen3.5-9b,', OPENROUTER_API_KEY: 'k', OPENROUTER_ZDR: 'false' })
  assert.deepEqual(on.openrouterModels, ['qwen/qwen3.8-27b', 'qwen/Qwen3.5-9b'])
  assert.equal(on.openrouterKey, 'k'); assert.equal(on.openrouterZdr, false)
  assert.equal(off.openrouterImageTokens, 16384)
  assert.equal(configWith({ OPENROUTER_IMAGE_TOKENS: '0' }).openrouterImageTokens, 0)
  for (const bad of ['-1', 'many']) assert.throws(() => configWith({ OPENROUTER_IMAGE_TOKENS: bad }), /OPENROUTER_IMAGE_TOKENS/, bad)
})

test('MCP_SERVER_WORKSPACE: none by default, read or readwrite; anything else stops the edge', () => {
  assert.equal(configWith().mcpServerWorkspace, 'none')
  for (const v of ['none', 'read', 'readwrite']) assert.equal(configWith({ MCP_SERVER_WORKSPACE: v }).mcpServerWorkspace, v)
  for (const bad of ['', 'write', 'Read']) assert.throws(() => configWith({ MCP_SERVER_WORKSPACE: bad }), /MCP_SERVER_WORKSPACE must be one of none, read, readwrite/, bad)
})

test('the door\'s rate limit: 60 calls a minute and a burst of 20 by default; a value below 1 or not a number stops the edge', () => {
  const c = configWith()
  assert.equal(c.doorRatePerMinute, 60); assert.equal(c.doorBurst, 20)
  const set = configWith({ DOOR_RATE_PER_MINUTE: '120', DOOR_BURST: '5' })
  assert.equal(set.doorRatePerMinute, 120); assert.equal(set.doorBurst, 5)
  for (const name of ['DOOR_RATE_PER_MINUTE', 'DOOR_BURST']) for (const bad of ['0', '-1', 'fast', 'Infinity', '']) assert.throws(() => configWith({ [name]: bad }), new RegExp(name), `${name}=${bad}`)
})

test('a worker token lasts 8 hours by default; a value below 1 or not a number stops the edge', () => {
  assert.equal(configWith().workerTokenHours, 8)
  assert.equal(configWith({ WORKER_TOKEN_HOURS: '2' }).workerTokenHours, 2)
  for (const bad of ['0', '-1', 'abc', 'Infinity', '']) assert.throws(() => configWith({ WORKER_TOKEN_HOURS: bad }), /WORKER_TOKEN_HOURS/, bad)
})

test('RUN_WILD_DEFAULT_EMAILS: empty by default; exact addresses, trimmed and lowercased; any other entry stops the edge', () => {
  assert.deepEqual(configWith().runWildDefaultEmails, [])
  assert.deepEqual(configWith({ RUN_WILD_DEFAULT_EMAILS: ' , ' }).runWildDefaultEmails, [])
  assert.deepEqual(configWith({ RUN_WILD_DEFAULT_EMAILS: ' Hi@Mumbo.si ,, a@x.com,' }).runWildDefaultEmails, ['hi@mumbo.si', 'a@x.com'])
  for (const bad of ['@mumbo.si', '!a@mumbo.si', 'mumbo.si', 'a@', 'a b@x.com', 'a@b@x.com', 'hi@mumbo.si,@x.com']) {
    assert.throws(() => configWith({ RUN_WILD_DEFAULT_EMAILS: bad }), /RUN_WILD_DEFAULT_EMAILS entry .* must be an exact address/, bad)
  }
  const tf = (f) => readFileSync(new URL(`../prod/${f}`, import.meta.url), 'utf8')
  assert.match(tf('edge.tf'), /variable "run_wild_default_emails" \{[^}]*default\s*=\s*""/)
  assert.match(tf('modules/edge/edge.tf'), /RUN_WILD_DEFAULT_EMAILS\s*=\s*var\.run_wild_default_emails\n/)
})

test('a malformed REDIS_URL stops the edge with a line naming REDIS_URL that never carries its password', async () => {
  const { spawnSync } = await import('node:child_process')
  const r = spawnSync(process.execPath, ['edge.mjs'], { cwd: new URL('.', import.meta.url), encoding: 'utf8', timeout: 60_000,
    env: { PATH: process.env.PATH, PUBLIC_HOST: 'boxes.mumbo.si', LLM_HOST: 'llm.boxes.mumbo.si', BACKUP_BUCKET: 'backups', REDIS_URL: 'rediss://edge:CANARY-pw@bad host:6379' } })
  assert.equal(r.status, 1)
  assert.match(r.stdout + r.stderr, /REDIS_URL/)
  assert.doesNotMatch(r.stdout + r.stderr, /CANARY/)
})

test('PLACEMENT_CACHE_MS: 30000 by default, 0 turns the cache off; anything but a whole number stops the edge', () => {
  assert.equal(configWith().placementCacheMs, 30_000)
  assert.equal(configWith({ PLACEMENT_CACHE_MS: '0' }).placementCacheMs, 0)
  assert.equal(configWith({ PLACEMENT_CACHE_MS: '5000' }).placementCacheMs, 5000)
  for (const bad of ['', ' ', '-1', '1.5', '30s', 'Infinity', '1e4']) assert.throws(() => configWith({ PLACEMENT_CACHE_MS: bad }), /PLACEMENT_CACHE_MS must be a whole number/, JSON.stringify(bad))
})

test('cells in config(): without CELLS one us-east-1 cell from the single-cell variables; with CELLS, its cells and EDGE_REGION', () => {
  const one = configWith({ E2B_SANDBOX_URL: 'http://sandbox.boxes.internal:3002', MAX_RUNNING_UNITS: '44' })
  assert.deepEqual(Object.keys(one.cells), ['us-east-1'])
  assert.equal(one.edgeRegion, 'us-east-1')
  assert.deepEqual([one.cells['us-east-1'].sandbox.href, one.cells['us-east-1'].bucket], ['http://sandbox.boxes.internal:3002/', 'backups'])
  for (const gone of ['proxy', 'bucket', 'maxRunningUnits']) assert.equal(gone in one, false, gone)
  assert.throws(() => configWith({ AWS_REGION: 'ap-south-1' }), /without CELLS the edge serves only us-east-1/)
  const CELLS = JSON.stringify({ 'us-east-1': { api: 'http://api.boxes.internal:3000', sandbox: 'http://sandbox.boxes.internal:3002', bucket: 'bucket-1', maxUnits: 44, e2bKeyEnv: 'K1' },
    'ap-south-1': { api: 'http://api.ap-south-1.boxes.internal:3000', sandbox: 'http://sandbox.ap-south-1.boxes.internal:3002', bucket: 'bucket-2', maxUnits: 20, e2bKeyEnv: 'K2' } })
  process.env.K1 = 'k1'; process.env.K2 = 'k2'
  try {
    const two = configWith({ CELLS, EDGE_REGION: 'ap-south-1', AWS_REGION: 'ap-south-1' })
    assert.deepEqual([Object.keys(two.cells), two.edgeRegion], [['us-east-1', 'ap-south-1'], 'ap-south-1'])
  } finally { delete process.env.K1; delete process.env.K2 }
})

test('the edge key and the model key are EDGE_SECRET and MODEL_KEY (ECS secrets), never SSM or Secrets Manager reads; an unset or empty one stops the edge', async () => {
  const { spawnSync } = await import('node:child_process')
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  // No AWS credentials and no instance metadata: an SDK read would fail on credentials instead of naming the variable.
  const home = mkdtempSync(join(tmpdir(), 'edge-home-'))
  const start = (vars) => spawnSync(process.execPath, ['edge.mjs'], { cwd: new URL('.', import.meta.url), encoding: 'utf8', timeout: 60_000,
    env: { PATH: process.env.PATH, HOME: home, AWS_EC2_METADATA_DISABLED: 'true', ...base, ...vars } })
  try {
    for (const [vars, name] of [[{}, 'EDGE_SECRET'], [{ EDGE_SECRET: '' }, 'EDGE_SECRET'], [{ EDGE_SECRET: 'CANARY-k' }, 'MODEL_KEY'], [{ EDGE_SECRET: 'CANARY-k', MODEL_KEY: '' }, 'MODEL_KEY']]) {
      const r = start(vars)
      assert.equal(r.status, 1, JSON.stringify(vars))
      assert.match(r.stderr, new RegExp(`edge: set ${name}\\n`), JSON.stringify(vars))
      assert.doesNotMatch(r.stdout + r.stderr, /CANARY/)
    }
  } finally { rmSync(home, { recursive: true, force: true }) }
  assert.doesNotMatch(readFileSync(new URL('./edge.mjs', import.meta.url), 'utf8'), /client-ssm|client-secrets-manager|EDGE_SECRET_PARAM|MODEL_KEY_SECRET/)
})

test('REDIS_URL: the production rediss:// URL with the user edge works as is; anything else is refused without showing its value', async () => {
  const prod = `rediss://edge:${'a1B2'.repeat(10)}@master.mumbo-boxes-edge.x.use1.cache.amazonaws.com:6379`
  assert.equal(redisUrl(prod), prod)
  assert.equal(redisUrl('redis://localhost:6379'), 'redis://localhost:6379')
  const { createClient } = await import('redis')
  const { socket, username, password } = createClient({ url: prod }).options
  assert.deepEqual([socket.tls, socket.host, socket.port, username, password], [true, 'master.mumbo-boxes-edge.x.use1.cache.amazonaws.com', 6379, 'edge', 'a1B2'.repeat(10)])
  for (const bad of ['rediss://edge:CANARY-pw@bad host:6379', 'http://edge:CANARY-pw@h:6379', 'redis://edge:CANARY-pw@h:6379', 'rediss://edge:CANARY-pw@']) {
    assert.throws(() => redisUrl(bad), (e) => /^edge: REDIS_URL must be a redis:\/\/ or rediss:\/\/ URL with a host, and credentials only over rediss:\/\/; its value is not shown$/.test(e.message) && !e.message.includes('CANARY'), bad)
  }
})

test('prod Terraform: CELLS as edge/cells.mjs parses it, each cell\'s E2B key and the edge and model keys as ECS secrets by ARN; single-cell until edge_cells', async () => {
  const { cellsConfig } = await import('./cells.mjs')
  const tf = (f) => readFileSync(new URL(`../prod/${f}`, import.meta.url), 'utf8')
  const mod = tf('modules/edge/edge.tf'), root = tf('edge.tf')
  // The CELLS fields Terraform writes are exactly the ones cellsConfig takes (it refuses any other).
  const fields = /CELLS = jsonencode\(\{ for r, c in var\.cells : r => \{\n\s*(.*)\n/.exec(mod)?.[1].split(', ').map(f => f.split(' = ')[0])
  assert.deepEqual(fields, ['api', 'sandbox', 'bucket', 'maxUnits', 'e2bKeyEnv'])
  assert.match(mod, /e2b_key_env = \{ for r in keys\(var\.cells\) : r => "E2B_API_KEY_\$\{upper\(replace\(r, "-", "_"\)\)\}" \}/)
  const keyEnv = (r) => `E2B_API_KEY_${r.toUpperCase().replaceAll('-', '_')}`
  // Production's values as Terraform renders them (modules/cell outputs, node_count 2 and 1).
  const cell = (r, names, bucket, nodes) => ({ api: `http://api.${names}:3000`, sandbox: `http://sandbox.${names}:3002`, bucket, maxUnits: 2 * (12 * nodes - 2), e2bKeyEnv: keyEnv(r) })
  const CELLS = JSON.stringify({ 'ap-south-1': cell('ap-south-1', 'ap-south-1.boxes.internal', 'mumbo-boxes-aps1-backup-641134885443', 1), 'us-east-1': cell('us-east-1', 'boxes.internal', 'mumbo-boxes-backup-641134885443', 2) })
  const parsed = cellsConfig({ CELLS, EDGE_REGION: 'us-east-1', E2B_API_KEY_US_EAST_1: 'k1', E2B_API_KEY_AP_SOUTH_1: 'k2' })
  assert.deepEqual([parsed.cells['us-east-1'].maxUnits, parsed.cells['ap-south-1'].maxUnits, parsed.cells['ap-south-1'].e2bKeyEnv], [44, 20, 'E2B_API_KEY_AP_SOUTH_1'])
  assert.match(mod, /EDGE_REGION = local\.region/)
  assert.match(mod, /e2b_keys\s*= var\.cells_enabled \? tomap\(\{ for r, c in var\.cells : local\.e2b_key_env\[r\] => c\.e2b_secret_arn \}\) : tomap\(\{ E2B_API_KEY = local\.home\.e2b_secret_arn \}\)/)
  assert.match(mod, /environment = \[for k, v in merge\(var\.cells_enabled \? tomap\(local\.cells_env\) : tomap\(local\.single_cell_env\), \{/)
  assert.match(mod, /\{ name = "EDGE_SECRET", valueFrom = var\.edge_secret_arn \}/)
  assert.match(mod, /\{ name = "MODEL_KEY", valueFrom = var\.model_key_secret_arn \}/)
  assert.match(root, /edge_secret_arn\s+= aws_ssm_parameter\.edge\["edge-secret"\]\.arn/)
  assert.match(root, /model_key_secret_arn\s+= data\.aws_secretsmanager_secret\.model_key\.arn/)
  assert.match(root, /variable "edge_cells" \{[^}]*default\s*= false/, 'single-cell until R6 part 1 sets it')
  assert.match(root, /variable "placement_cache_ms" \{[^}]*default\s*= 30000/)
  assert.match(mod, /PLACEMENT_CACHE_MS\s*= tostring\(var\.placement_cache_ms\)/)
  // The edge reads neither key through its task role any more; the grants stay only for a rollback to an older image.
  assert.match(mod, /Remove once a B21 revision is steady/)
  assert.match(mod, /Action = "s3:PutObject", Resource = "arn:aws:s3:::\$\{local\.audit_bucket\}\/\$\{local\.audit_prefix\}\*"/)
  assert.match(mod, /audit_bucket = var\.cells\["us-east-1"\]\.backup_bucket/)
})
