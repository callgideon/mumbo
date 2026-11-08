// Build a mumbo box template from the shipped ECR image, then time create, pause/resume and fork of a real dsh web box.
// ECR_PASSWORD is a 12-hour token from `aws ecr get-login-password`.
import { Sandbox, Template, waitForPort } from 'e2b'
const image = process.argv[2]
const t = async (label, fn) => { const s = performance.now(); const r = await fn(); console.log(`${label}: ${Math.round(performance.now() - s)} ms`); return r }
const sh = async (sbx, cmd) => (await sbx.commands.run(cmd, { timeoutMs: 120_000 })).stdout.trim()
const PROBE = `curl -s -o /dev/null -w '%{http_code}' http://$(hostname -I | cut -d' ' -f1):3080/`
const DSH = 'cd /src && mkdir -p /root/projects /root/.dsh && HOME=/root DSH_HOME=/root/.dsh DSH_TELEMETRY_DISABLED=1 node --import tsx/esm apps/cli/src/bin.ts --profile web --patch /src/deploy/mumbo.overlay.yml --patch /src/deploy/mumbo-personal.overlay.yml --no-open --host $(hostname -I | cut -d" " -f1) --port 3080 > /root/dsh.log 2>&1'

if (process.argv[3] !== 'skip-build') {
  const template = Template().fromImage(image, { username: 'AWS', password: process.env.ECR_PASSWORD }).setUser('root').setStartCmd(DSH, waitForPort(3080))
  await t('template build', () => Template.build(template, 'mumbo-box', { cpuCount: 2, memoryMB: 2048, onBuildLogs: e => { if (/error|fail/i.test(String(e.message ?? e))) console.log('  build:', String(e.message ?? e).slice(0, 200)) } }))
}
const box = await t('create box (dsh web already running from snapshot)', () => Sandbox.create('mumbo-box', { timeoutMs: 3_600_000 }))
console.log('  dsh answers:', await sh(box, PROBE), ' rss MiB:', await sh(box, "free -m | awk 'NR==2{print $3}'"))
console.log('  public URL:', `https://${box.getHost(3080)}`)
await t('pause box', () => box.pause())
const back = await t('resume box', () => Sandbox.connect(box.sandboxId, { timeoutMs: 3_600_000 }))
console.log('  dsh still answers:', await sh(back, PROBE))
const forks = await t('fork box x10', () => back.fork({ count: 10, timeoutMs: 600_000 }))
const ok = forks.filter(f => !(f instanceof Error))
console.log(`  forks ok ${ok.length}/10; dsh answers in fork:`, ok[0] ? await sh(ok[0], PROBE) : '-')
await Promise.all([...ok, back].map(f => f.kill()))
