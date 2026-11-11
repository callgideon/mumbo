// Throwaway B24 real-box check (not committed): a box from mumbo-box-b24test with the edge's own start.sh.
import { Sandbox } from 'e2b'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
Object.assign(process.env, { PUBLIC_HOST: 'app.mumbo.si', LLM_HOST: 'llm.app.mumbo.si', PROJECT_DOMAIN: 'app.mumbo.si', BACKUP_BUCKET: 'unused', BOX_TEMPLATE: 'mumbo-box-b24test' })
const { config, startScript, signBox, boxSite, roleInstructions, mumboMcpKey, mcpPrincipal } = await import('./edge.mjs')
const cfg = config(), email = 'b24-throwaway@mumbo.si', edgeKey = randomBytes(32).toString('base64url')
const box = await Sandbox.create(cfg.template, { timeoutMs: 1_800_000, metadata: { user: email }, network: { allowPublicTraffic: false, maskRequestHost: boxSite(cfg, email).host } })
console.log('box', box.sandboxId)
const sh = (c, t = 60_000) => box.commands.run(c, { timeoutMs: t }).then(r => r.stdout + r.stderr, e => `ERR ${e.message} ${e.result?.stdout ?? ''}${e.result?.stderr ?? ''}`)
const proxy = async (port, path = '/', init = {}) => {
  const r = await fetch('http://127.0.0.1:13002' + path, { ...init, headers: { host: 'sandbox.app.mumbo.si', 'e2b-sandbox-id': box.sandboxId, 'e2b-sandbox-port': String(port), ...(box.trafficAccessToken ? { 'e2b-traffic-access-token': box.trafficAccessToken } : {}), ...init.headers } })
  return `${r.status} ${(await r.text()).slice(0, 100).replace(/\s+/g, ' ')}`
}
try {
  const mcpKey = mumboMcpKey(edgeKey, box.sandboxId)
  await box.files.write('/root/.mumbo/start.sh', startScript(cfg, signBox(edgeKey, email, box.sandboxId), boxSite(cfg, email), roleInstructions(cfg, email), undefined, undefined, undefined, { key: mcpKey, principal: mcpPrincipal(email) }))
  console.log('== start.sh\n' + (await sh('chmod 0700 /root/.mumbo/start.sh && /root/.mumbo/start.sh', 300_000)).slice(-1500))
  console.log('== 1 envd after start.sh:', await sh('id -un; echo envd-ok'))
  console.log('== envd from inside (expect refused):', await sh('curl -s -m 3 -o /dev/null -w "%{http_code}" http://127.0.0.1:49983/health; echo " rc=$?"'))
  console.log('== marker:', await sh('cat /usr/local/share/mumbo/ports'))
  await new Promise(r => setTimeout(r, 20_000))
  console.log('== 2 proxy 880:', await proxy(880))
  console.log('== 2 proxy 881:', await proxy(881, '/vnc.html'))
  console.log('== 2 proxy 882 (no key):', await proxy(882, '/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }))
  console.log('== 2 proxy 882 (Authorization):', await proxy(882, '/mcp', { method: 'POST', headers: { authorization: `Bearer ${mcpKey}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }))
  console.log('== 3 desktop:', await sh('ps -eo user:12,comm | grep -E "xfce4-session|xfwm4|dbus-daemon|Xkasmvnc|chrome$" | sort | uniq -c; mount | grep " /proc "; tail -5 /tmp/desktop.log'))
  console.log('== 4 Xkasmvnc:', await sh('p=$(command -v Xkasmvnc); stat -c "%U:%G %a %n" "$p"; getcap "$p"; ss -ltnp | grep -E ":(880|881|882) "'))
  await box.files.write('/root/.mumbo/escape-test.sh', readFileSync(new URL('./escape-test.sh', import.meta.url), 'utf8'))
  console.log('== 5 escape-test\n' + await sh('sh /root/.mumbo/escape-test.sh', 600_000))
} finally {
  await box.kill(); console.log('killed', box.sandboxId)
}
