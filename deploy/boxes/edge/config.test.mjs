// node --test: the edge's M1 settings from the environment.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { config } from './edge.mjs'

const base = { PUBLIC_HOST: 'boxes.mumbo.si', LLM_HOST: 'llm.boxes.mumbo.si', BACKUP_BUCKET: 'backups' }
const M1 = ['APPROVE_HOST', 'GITHUB_AGENT_LOGIN', 'GITHUB_AGENT_ID', 'REQUIRED_CHECKS', 'DAILY_TOKENS_USER', 'DAILY_TOKENS_PROJECT', 'BOX_TEMPLATE', 'PROJECT_TEMPLATE',
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
  for (const k of ['agentLogin', 'agentId', 'appId', 'appKey', 'ntfyTopic']) assert.equal(c[k], undefined, k)
  for (const k of ['mergeToken', 'agentToken']) assert.equal(k in c, false, k)
  assert.equal('agentToken' in configWith({ GITHUB_AGENT_TOKEN: 'ghp_x' }), false, 'GITHUB_AGENT_TOKEN is not read')
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

test('the agent is the mumbo-bot App\'s bot user: GITHUB_AGENT_ID is its numeric id, set together with GITHUB_AGENT_LOGIN', () => {
  const c = configWith({ GITHUB_AGENT_LOGIN: 'mumbo-bot[bot]', GITHUB_AGENT_ID: '341797844' })
  assert.equal(c.agentLogin, 'mumbo-bot[bot]')
  assert.equal(c.agentId, 341797844)
  for (const vars of [{ GITHUB_AGENT_LOGIN: 'mumbo-bot[bot]' }, { GITHUB_AGENT_ID: '341797844' }]) assert.throws(() => configWith(vars), /set GITHUB_AGENT_ID and GITHUB_AGENT_LOGIN together/, JSON.stringify(vars))
  for (const id of ['abc', '0', '-1', '1.5', '1e3', ' 1', '12345678901234567']) assert.throws(() => configWith({ GITHUB_AGENT_LOGIN: 'mumbo-bot[bot]', GITHUB_AGENT_ID: id }), /GITHUB_AGENT_ID must be a numeric GitHub user id/, id)
})
