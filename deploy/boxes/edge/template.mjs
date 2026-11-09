// Build the `mumbo-box` E2B template from a shipped mumbo web image in ECR. dsh is not started here: the edge
// starts it per user with that user's box token (edge/edge.mjs startScript).
// Usage (needs the edge/node_modules e2b SDK and E2B_API_URL / E2B_SANDBOX_URL / E2B_API_KEY):
//   ECR_PASSWORD=$(aws ecr get-login-password --region us-east-1) node template.mjs (inside the edge image, or from deploy/boxes/edge) <ecr image uri>
import { pathToFileURL } from 'node:url'
import { Sandbox, Template } from 'e2b'
// Usage: template.mjs <ecr image> [name=mumbo-box] [memoryMB=4096] [cpuCount=2]; children use: mumbo-child 2048.
export function templateArgs(argv) {
  return {
    image: argv[2] ?? (() => { throw new Error('pass the ECR image URI') })(),
    name: argv[3] ?? 'mumbo-box',
    memoryMB: Number(argv[4] ?? 4096),
    cpuCount: Number(argv[5] ?? 2),
  }
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await build(templateArgs(process.argv))

async function build({ image, name, memoryMB, cpuCount }) {
let tpl = Template().fromImage(image, { username: 'AWS', password: process.env.ECR_PASSWORD }).setUser('root')
// The user's box is their computer: a virtual display, a window manager, Chromium and the noVNC live view
// (PRODUCTION.md stage 9). The edge's start script runs them; children (mumbo-child) stay headless.
if (name.startsWith('mumbo-box')) {
  tpl = tpl.runCmd([
    'apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends xvfb openbox x11vnc novnc websockify chromium dbus-x11 fonts-noto-core fonts-noto-color-emoji fonts-noto-cjk procps && rm -rf /var/lib/apt/lists/*',
    'id browser >/dev/null 2>&1 || useradd -m -s /bin/bash browser',
  ])
}
// A project box is headless: git, gh (GitHub's apt repository) and openssl for the box-local GitHub proxy's CA.
if (name.startsWith('mumbo-project')) {
  tpl = tpl.runCmd([
    'apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates curl gpg git openssl procps && install -d -m 0755 /etc/apt/keyrings && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list && apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends gh && rm -rf /var/lib/apt/lists/*',
  ])
}
const info = await Template.build(tpl, name, { cpuCount, memoryMB })
console.log('built', info.templateId, info.buildId)
// Smoke: a box from the template has the app, no prior user data, and curl for backups.
const s = await Sandbox.create(name, { timeoutMs: 120_000 })
const out = (await s.commands.run('test -f /src/apps/cli/src/bin.ts && echo app; test -e /root/.dsh && echo HAS-DSH-HOME || echo clean; command -v curl tar | wc -l')).stdout
await s.kill()
console.log(out.trim().replace(/\n/g, ' '))
if (!/app clean 2/.test(out.trim().replace(/\n/g, ' '))) process.exit(1)
}
