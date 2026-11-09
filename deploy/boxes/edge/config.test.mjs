// node --test: the edge's M1 settings from the environment.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { admitted, config } from './edge.mjs'

const base = { PUBLIC_HOST: 'boxes.mumbo.si', LLM_HOST: 'llm.boxes.mumbo.si', BACKUP_BUCKET: 'backups' }
const M1 = ['APPROVE_HOST', 'GITHUB_AGENT_LOGIN', 'REQUIRED_CHECKS', 'DAILY_TOKENS_USER', 'DAILY_TOKENS_PROJECT', 'BOX_TEMPLATE', 'PROJECT_TEMPLATE',
  'AUDIT_PREFIX', 'GITHUB_AGENT_TOKEN', 'GITHUB_APP_ID', 'GITHUB_APP_KEY', 'GITHUB_MERGE_TOKEN', 'NTFY_TOPIC', 'SIGNIN_COOKIE']
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
  for (const k of ['agentLogin', 'agentToken', 'appId', 'appKey', 'ntfyTopic']) assert.equal(c[k], undefined, k)
  assert.equal('mergeToken' in c, false)
  assert.equal(configWith({ BOX_TEMPLATE: 'tpl' }).projectTemplate, 'tpl')
  const set = configWith({ GITHUB_APP_ID: '5295930', GITHUB_APP_KEY: 'PEM', REQUIRED_CHECKS: ' Static , unit,' })
  assert.equal(set.appId, '5295930'); assert.equal(set.appKey, 'PEM')
  assert.deepEqual(set.requiredChecks, ['Static', 'unit'], 'trimmed, case kept')
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
