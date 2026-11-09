// node --test: the edge's M1 settings from the environment.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { config } from './edge.mjs'

const base = { PUBLIC_HOST: 'boxes.mumbo.si', LLM_HOST: 'llm.boxes.mumbo.si', BACKUP_BUCKET: 'backups' }
const M1 = ['APPROVE_HOST', 'GITHUB_AGENT_LOGIN', 'REQUIRED_CHECKS', 'DAILY_TOKENS_USER', 'DAILY_TOKENS_PROJECT', 'BOX_TEMPLATE', 'PROJECT_TEMPLATE',
  'AUDIT_PREFIX', 'GITHUB_AGENT_TOKEN', 'GITHUB_APP_ID', 'GITHUB_APP_KEY', 'GITHUB_MERGE_TOKEN', 'NTFY_TOPIC']
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
