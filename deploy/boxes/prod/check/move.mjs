// Stage 4 check: a box created on one node, paused, then resumed on the other node keeps its disk and memory.
// The first node is marked draining before the resume, so placement must pick another node.
// Env: E2B_API_URL, E2B_SANDBOX_URL, E2B_API_KEY, E2B_ADMIN_TOKEN. Run with deploy/boxes/edge/node_modules on NODE_PATH.
import { Sandbox } from 'e2b'
const api = process.env.E2B_API_URL, admin = { 'X-Admin-Token': process.env.E2B_ADMIN_TOKEN, 'content-type': 'application/json' }
const nodes = async () => (await fetch(`${api}/nodes`, { headers: admin })).json()
const setStatus = (nodeID, status) => fetch(`${api}/nodes/${nodeID}`, { method: 'POST', headers: admin, body: JSON.stringify({ status }) }).then(r => r.status)
// The api's per-node counts follow node syncs, so wait for one node to report the box.
const where = async () => {
  for (let i = 0; i < 60; i++) { const on = (await nodes()).filter(n => n.sandboxCount > 0).map(n => n.id); if (on.length) return on; await new Promise(r => setTimeout(r, 1000)) }
  return []
}
let ok = true
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name} ${extra}`); ok &&= cond }

const s = await Sandbox.create('mumbo-box', { timeoutMs: 600_000 })
await s.commands.run('echo persisted > /root/move-check; nohup sh -c "x=$(date +%s%N); echo $x > /tmp/mem-token; while :; do sleep 3600; done" >/dev/null 2>&1 &')
const token = (await s.commands.run('cat /tmp/mem-token')).stdout.trim()
const [a] = await where()
console.log('box', s.sandboxId, 'on', a)
let t = performance.now(); await s.pause()
// pause() returns once the box is pausing; it has left the node when the node no longer counts it.
for (let i = 0; i < 300 && (await nodes()).some(n => n.id === a && n.sandboxCount > 0); i++) await new Promise(r => setTimeout(r, 1000))
console.log(`pause until off the node ${Math.round(performance.now() - t)} ms`)
console.log('mark', a, 'draining:', await setStatus(a, 'draining'))
await new Promise(r => setTimeout(r, 25_000)) // every api replica sees the status on its next node sync
try {
  t = performance.now(); const r = await Sandbox.connect(s.sandboxId, { timeoutMs: 600_000 }); console.log(`resume ${Math.round(performance.now() - t)} ms`)
  const [b] = await where()
  check('resumed on another node', b && b !== a, `${a} -> ${b}`)
  check('disk kept', (await r.commands.run('cat /root/move-check')).stdout.trim() === 'persisted')
  check('memory kept (process from before the pause still runs)', (await r.commands.run('cat /tmp/mem-token; pgrep -f "sleep 3600" >/dev/null && echo alive')).stdout.includes(`${token}\nalive`))
  await r.kill()
} finally { console.log('mark', a, 'ready:', await setStatus(a, 'ready')) }
process.exit(ok ? 0 : 1)
