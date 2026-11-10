// node --test: the edge's M1 settings from the environment.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { admitted, config, startScript } from './edge.mjs'

const base = { PUBLIC_HOST: 'boxes.mumbo.si', LLM_HOST: 'llm.boxes.mumbo.si', BACKUP_BUCKET: 'backups' }
const M1 = ['PROJECT_DOMAIN', 'APPROVE_HOST', 'GITHUB_AGENT_LOGIN', 'GITHUB_AGENT_ID', 'REQUIRED_CHECKS', 'DAILY_TOKENS_USER', 'DAILY_TOKENS_PROJECT', 'BOX_TEMPLATE', 'PROJECT_TEMPLATE',
  'AUDIT_PREFIX', 'GITHUB_AGENT_TOKEN', 'GITHUB_APP_ID', 'GITHUB_APP_KEY', 'GITHUB_MERGE_TOKEN', 'NTFY_TOPIC', 'SIGNIN_COOKIE', 'SUPABASE_URL', 'MUMBO_OAUTH_REDIRECT_URIS',
  'OPENROUTER_MODELS', 'OPENROUTER_API_KEY', 'OPENROUTER_ZDR', 'OPENROUTER_IMAGE_TOKENS']
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

test('prod/edge.tf former-host redirects: 302 for now, path kept (projects to /home), query marked moved=1 first so no target equals a cached plain URL', () => {
  const tf = readFileSync(new URL('../prod/edge.tf', import.meta.url), 'utf8')
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
  assert.match(tf('edge.tf'), /MAX_RUNNING_UNITS\s*=\s*tostring\(2 \* \(12 \* var\.node_count - 2\)\)/)
  assert.match(tf('nodes.tf'), /min_size\s*=\s*min\(2, var\.node_count\)/)
  assert.match(tf('nodes.tf'), /termination_policies\s*=\s*\["OldestLaunchTemplate", "OldestInstance"\]/)
  assert.match(tf('nodes.tf'), /enabled_metrics\s*=\s*\["GroupInServiceInstances"/)
  assert.match(tf('ops.tf'), /nodes-below-min = \{[^\n]*threshold = var\.node_count/)
  assert.match(tf('edge.tf'), /MAX_RUNNING_BOXES\s*=\s*tostring\(12 \* var\.node_count - 2\)/)
  assert.match(tf('nodes.tf'), /desired_capacity\s*=\s*var\.node_count/)
  assert.doesNotMatch(tf('nodes.tf'), /ignore_changes\s*=\s*\[desired_capacity\]/)
  assert.match(tf('nodes.tf'), /node_max_size = 10\b/)
  assert.match(tf('nodes.tf'), /var\.node_count <= 10/)
  assert.equal(configWith({ MAX_RUNNING_UNITS: String(2 * (12 * 2 - 2)) }).maxRunningUnits, 44)
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
  const files = [...readdirSync(prod).filter(f => f.endsWith('.tf') || f === 'terraform.tfvars').map(f => new URL(f, prod)),
    new URL('./compose.yaml', import.meta.url), new URL('./up.sh', import.meta.url)]
  for (const file of [new URL('edge.tf', prod), new URL('./compose.yaml', import.meta.url)]) assert.match(readFileSync(file, 'utf8'), /--provider=oidc/, file.pathname)
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
