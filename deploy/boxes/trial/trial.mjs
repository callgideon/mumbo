// Week-1 trial: boot, pause/resume with memory, fork fan-out, nested-virt overhead, egress allowlist.
import { Sandbox } from 'e2b'
const t = async (label, fn) => { const s = performance.now(); const r = await fn(); console.log(`${label}: ${Math.round(performance.now() - s)} ms`); return r }
const sh = async (sbx, cmd, timeoutMs = 120_000) => (await sbx.commands.run(cmd, { timeoutMs })).stdout.trim()

// 1. boot
const box = await t('1 create base sandbox', () => Sandbox.create('base', { timeoutMs: 3_600_000 }))
console.log('  echo:', await sh(box, 'echo hello; nproc; free -m | sed -n 2p'))

// 2. pause/resume with memory: a background process and 1 GiB in RAM must survive
await sh(box, 'nohup sleep 86400 >/dev/null 2>&1 & echo $! > /tmp/pid; head -c 200M /dev/urandom > /dev/shm/blob; md5sum /dev/shm/blob | cut -c1-12 > /tmp/sum')
const before = await sh(box, 'cat /tmp/sum')
await t('2 pause (full memory, 200 MiB in RAM)', () => box.pause())
const resumed = await t('2 resume', () => Sandbox.connect(box.sandboxId, { timeoutMs: 3_600_000 }))
console.log('  process alive:', await sh(resumed, 'kill -0 $(cat /tmp/pid) && echo yes || echo no'),
  ' blob intact:', (await sh(resumed, 'md5sum /dev/shm/blob | cut -c1-12')) === before)

// 3. fork fan-out (20 per request is the SDK maximum)
const forks = await t('3 fork x19 (one request)', () => resumed.fork({ count: 19, timeoutMs: 600_000 }))
const ok = forks.filter(f => !(f instanceof Error))
console.log(`  forks ok ${ok.length}/19`, forks.find(f => f instanceof Error)?.message ?? '')
if (ok[0]) console.log('  fork has parent memory:', (await sh(ok[0], 'md5sum /dev/shm/blob | cut -c1-12')) === before, ' parent process copied:', await sh(ok[0], 'kill -0 $(cat /tmp/pid) && echo yes || echo no'))
await t('3 run a command in all forks', () => Promise.all(ok.map(f => sh(f, 'echo ok'))))
await Promise.all(ok.map(f => f.kill()))

// 4. nested-virt overhead: CPU and disk inside the microVM
console.log('4 cpu (sha256 of 512 MiB):', await sh(resumed, 'bash -c "time (head -c 512M /dev/zero | sha256sum >/dev/null)" 2>&1 | grep real'))
console.log('4 disk write 1 GiB:', await sh(resumed, 'dd if=/dev/zero of=/tmp/d bs=1M count=1024 oflag=direct 2>&1 | tail -1'))
console.log('4 disk read 1 GiB:', await sh(resumed, 'dd if=/tmp/d of=/dev/null bs=1M iflag=direct 2>&1 | tail -1'))
await resumed.kill()

// 6. egress allowlist: only registry.npmjs.org
const locked = await Sandbox.create('base', { timeoutMs: 600_000, network: { allowOut: ['registry.npmjs.org'], denyOut: ['0.0.0.0/0'] } })
const code = (url) => sh(locked, `curl -s -o /dev/null -m 8 -w '%{http_code}' ${url} || echo blocked`)
console.log('6 allowed npm:', await code('https://registry.npmjs.org/'), ' github:', await code('https://github.com/'), ' deepseek:', await code('https://api.deepseek.com/'))
await locked.kill()
