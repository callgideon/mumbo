// Build the `mumbo-box` E2B template from a shipped mumbo web image in ECR. dsh is not started here: the edge
// starts it per user with that user's box token (edge/edge.mjs startScript).
// Usage (needs the edge/node_modules e2b SDK and E2B_API_URL / E2B_SANDBOX_URL / E2B_API_KEY):
//   ECR_PASSWORD=$(aws ecr get-login-password --region us-east-1) node template.mjs (inside the edge image, or from deploy/boxes/edge) <ecr image uri>
import { Sandbox, Template } from 'e2b'
// Usage: template.mjs <ecr image> [name=mumbo-box] [memoryMB=4096]; children use: mumbo-child 2048.
const image = process.argv[2] ?? (() => { throw new Error('pass the ECR image URI') })()
const name = process.argv[3] ?? 'mumbo-box'
const memoryMB = Number(process.argv[4] ?? 4096)
let tpl = Template().fromImage(image, { username: 'AWS', password: process.env.ECR_PASSWORD }).setUser('root')
// The user's box is their computer: a virtual display, a window manager, Chromium and the noVNC live view
// (PRODUCTION.md stage 9). The edge's start script runs them; children (mumbo-child) stay headless.
if (name.startsWith('mumbo-box')) {
  tpl = tpl.runCmd([
    'apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends xvfb openbox x11vnc novnc websockify chromium dbus-x11 fonts-noto-core fonts-noto-color-emoji fonts-noto-cjk procps && rm -rf /var/lib/apt/lists/*',
    'id browser >/dev/null 2>&1 || useradd -m -s /bin/bash browser',
  ])
}
const info = await Template.build(tpl, name, { cpuCount: 2, memoryMB })
console.log('built', info.templateId, info.buildId)
// Smoke: a box from the template has the app, no prior user data, and curl for backups.
const s = await Sandbox.create(name, { timeoutMs: 120_000 })
const out = (await s.commands.run('test -f /src/apps/cli/src/bin.ts && echo app; test -e /root/.dsh && echo HAS-DSH-HOME || echo clean; command -v curl tar | wc -l')).stdout
await s.kill()
console.log(out.trim().replace(/\n/g, ' '))
if (!/app clean 2/.test(out.trim().replace(/\n/g, ' '))) process.exit(1)
