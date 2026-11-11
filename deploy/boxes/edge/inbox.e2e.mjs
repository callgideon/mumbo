// In-box agent test against production: a fresh person box (current template, start script and role) whose agent
// uses the live model host, driven over dsh unary RPC like the coordinator relay; result read from a file the agent
// writes. Env: E2B_API_URL, E2B_SANDBOX_URL, E2B_API_KEY (prod/check/tunnel.sh), EDGE_KEY (SSM /mumbo/boxes/edge-secret).
import * as e2b from 'e2b'
import { boxes, boxFetcher, boxSite } from './edge.mjs'
import { memoryStore } from './store.mjs'
const cfg = { publicHost: 'boxes.mumbo.si', llmHost: 'llm.boxes.mumbo.si', template: 'mumbo-box', idleMs: 3600_000, backupEveryMs: 3600_000, edgeRegion: 'us-east-1',
  allowed: ['@mumbo.si'], egressIps: [], pauseIdle: false }
// The module's Sandbox reads E2B_API_URL and E2B_API_KEY; boxes are reached at E2B_SANDBOX_URL.
const cells = new Map([['us-east-1', { region: 'us-east-1', Sandbox: e2b.Sandbox, proxy: new URL(process.env.E2B_SANDBOX_URL), maxUnits: 0, presignGet: async () => undefined, presignPut: async () => 'http://127.0.0.1:9/none' }]])
const store = memoryStore()
const box = boxes({ cells, store, cfg, edgeKey: process.env.EDGE_KEY, log: () => {} })
const user = `boxtest-${Date.now()}@mumbo.si`
const target = await box.ensure(user)
console.log('box', target.id)
const fetchBox = boxFetcher(cfg), host = boxSite(cfg, user).host
const signin = await fetchBox(target, host, `/?token=${target.token}`)
const cookie = signin.setCookie.map(c => c.split(';')[0]).find(c => c.startsWith('dsh-auth-'))
const rpc = async (method, request) => JSON.parse((await fetchBox(target, host, `/api/${method}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' },
  body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload: { args: { request } } }) })).body).result
const { sessionId } = (await rpc('session/create', { cwd: '/root/projects' })).value
const prompt = [
  'Test of your tools; do exactly this, without asking me anything:',
  '1. With the sandbox tools, create 3 sandboxes, run `nproc` in each, then kill all 3.',
  '2. With your browser tools, open https://example.com and read the page title.',
  '3. Write /root/projects/result.json as {"nproc": [<the 3 outputs>], "title": "<title>", "sandboxesLeft": <sandbox_list count>}.',
].join('\n')
console.log('prompt', JSON.stringify(await rpc('session/prompt', { requestId: crypto.randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text: prompt }] })))
const vm = await e2b.Sandbox.connect(target.id)
let out = ''
for (let i = 0; i < 40 && !out; i++) { await new Promise(r => setTimeout(r, 10_000)); out = (await vm.commands.run('cat /root/projects/result.json 2>/dev/null; true')).stdout.trim() }
console.log('result.json:', out || '(none after 400 s)')
const evidence = (await vm.commands.run(`grep -rhoE '"type":"(approval/[a-z-]+|tool/call)[^}]{0,160}' /root/.dsh 2>/dev/null | grep -oE '"type":"approval/[a-z-]+"|"(toolName|name)":"[a-z_:-]+"' | sort | uniq -c | sort -rn | head -20; true`)).stdout
console.log('session evidence:\n' + evidence)
console.log('dsh log tail:\n' + (await vm.commands.run('grep -iE "error|warn" /root/dsh.log | tail -5 | cut -c1-200; true')).stdout)
await e2b.Sandbox.kill(target.id)
