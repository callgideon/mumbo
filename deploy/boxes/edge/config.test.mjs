// node --test: the edge's M1 settings from the environment.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { config, startScript } from './edge.mjs'

const base = { PUBLIC_HOST: 'boxes.mumbo.si', LLM_HOST: 'llm.boxes.mumbo.si', BACKUP_BUCKET: 'backups' }
const M1 = ['PROJECT_DOMAIN', 'APPROVE_HOST', 'GITHUB_AGENT_LOGIN', 'REQUIRED_CHECKS', 'DAILY_TOKENS_USER', 'DAILY_TOKENS_PROJECT', 'BOX_TEMPLATE', 'PROJECT_TEMPLATE',
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

test('PAGE_AFTER_MS: default 3000, and a value below 1000 or not a number stops the edge', () => {
  assert.equal(configWith().pageAfterMs, 3000)
  assert.equal(configWith({ PAGE_AFTER_MS: '5000' }).pageAfterMs, 5000)
  for (const bad of ['999', 'soon', '-1', 'Infinity', '']) assert.throws(() => configWith({ PAGE_AFTER_MS: bad }), /PAGE_AFTER_MS/, bad)
})
