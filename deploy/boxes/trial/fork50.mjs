// Fan-out: fork one parent into 50 copies (20 + 20 + 10 requests) and report time, success and host page use.
import { Sandbox } from 'e2b'
const sh = async (sbx, cmd) => (await sbx.commands.run(cmd, { timeoutMs: 120_000 })).stdout.trim()
const parent = await Sandbox.create('base', { timeoutMs: 24 * 3_600_000 })
console.log('24h timeout accepted; ends', (await parent.getInfo()).endAt)
await sh(parent, 'nohup sleep 86400 >/dev/null 2>&1 & head -c 100M /dev/urandom > /dev/shm/blob')
const s = performance.now()
const batches = []
for (const count of [20, 20, 10]) { const b = performance.now(); try { batches.push(await parent.fork({ count, timeoutMs: 600_000 })) } catch (e) { console.log('  batch failed:', e.message.slice(0, 160)); break } console.log(`  batch of ${count}: ${Math.round(performance.now() - b)} ms`) }
const all = batches.flat()
const ok = all.filter(f => !(f instanceof Error))
console.log(`fork 50 (3 sequential requests): ${Math.round(performance.now() - s)} ms, ok ${ok.length}/50`, all.find(f => f instanceof Error)?.message ?? '')
const r = performance.now()
const outs = await Promise.all(ok.map(f => sh(f, 'test -s /dev/shm/blob && echo ok').catch(e => 'dead')))
console.log(`command in all forks: ${Math.round(performance.now() - r)} ms, blob present in ${outs.filter(o => o === 'ok').length}`)
await Promise.all([...ok, parent].map(f => f.kill()))
process.on('exit', () => {})
