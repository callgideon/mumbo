// Build the `mumbo-box` E2B template from a shipped mumbo web image in ECR. dsh is not started here: the edge
// starts it per user with that user's box token (edge/edge.mjs startScript).
// Usage (needs the edge/node_modules e2b SDK and E2B_API_URL / E2B_SANDBOX_URL / E2B_API_KEY):
//   ECR_PASSWORD=$(aws ecr get-login-password --region us-east-1) node template.mjs (inside the edge image, or from deploy/boxes/edge) <ecr image uri>
import { pathToFileURL } from 'node:url'
import { Sandbox, Template } from 'e2b'
// Usage: template.mjs <ecr image> [name=mumbo-box] [memoryMB=4096] [cpuCount=2]; children use: mumbo-child 2048.
// MIN_AVAIL_MB (default 9216, 9 GiB): the least free space on / a box from the new build may have, or the script fails.
export function templateArgs(argv, env = process.env) {
  const minAvail = env.MIN_AVAIL_MB ?? '9216'
  if (!/^\d+$/.test(minAvail)) throw new Error('MIN_AVAIL_MB must be a whole number of MiB')
  return {
    image: argv[2] ?? (() => { throw new Error('pass the ECR image URI') })(),
    name: argv[3] ?? 'mumbo-box',
    memoryMB: Number(argv[4] ?? 4096),
    cpuCount: Number(argv[5] ?? 2),
    minAvailMB: Number(minAvail),
  }
}

/** Google Chrome's managed policy in person boxes. Chrome Sync, passwords and payment cards stay at Chrome's defaults
 *  (founder decision 2026-11-10); downloads land where the assistant reads them (edge roleInstructions). */
const CHROME_POLICY = { RestoreOnStartup: 1, DefaultBrowserSettingEnabled: false, MetricsReportingEnabled: false, DownloadDirectory: '/home/browser/Downloads' }
/** The user's box is their computer: a virtual display, the XFCE desktop, Google Chrome stable from Google's apt
 *  repository (each build installs the current release) and the noVNC live view. The edge's start script runs them as
 *  the user `browser`, and writes /usr/local/bin/google-chrome, the one way to start Chrome; the menu entry and XFCE's
 *  web browser are aimed at it here. */
export const BOX_STEPS = [
  'apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates curl && install -d -m 0755 /etc/apt/keyrings && curl -fsSL https://dl.google.com/linux/linux_signing_key.pub -o /etc/apt/keyrings/google-chrome.asc && chmod go+r /etc/apt/keyrings/google-chrome.asc && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.asc] https://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list && apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends xvfb x11vnc novnc websockify xfce4-session xfwm4 xfce4-panel xfdesktop4 thunar xfce4-terminal tango-icon-theme librsvg2-common google-chrome-stable dbus-x11 xdotool imagemagick xsel xauth fonts-noto-core fonts-noto-color-emoji fonts-noto-cjk procps && rm -rf /var/lib/apt/lists/*',
  'id browser >/dev/null 2>&1 || useradd -m -s /bin/bash browser',
  `install -d -m 0755 /etc/opt/chrome/policies/managed && printf '%s\\n' '${JSON.stringify(CHROME_POLICY)}' > /etc/opt/chrome/policies/managed/mumbo.json && chmod 0644 /etc/opt/chrome/policies/managed/mumbo.json`,
  // The stock panels, without the panel's first-start dialog; XFCE's web browser and Chrome's menu entry start the box's Chrome.
  'cp /etc/xdg/xfce4/panel/default.xml /etc/xdg/xfce4/xfconf/xfce-perchannel-xml/xfce4-panel.xml && sed -i "s/^WebBrowser=.*/WebBrowser=google-chrome/" /etc/xdg/xfce4/helpers.rc && install -d /usr/local/share/applications && sed "s#/usr/bin/google-chrome-stable#/usr/local/bin/google-chrome#" /usr/share/applications/google-chrome.desktop > /usr/local/share/applications/google-chrome.desktop',
]

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await build(templateArgs(process.argv))

async function build({ image, name, memoryMB, cpuCount, minAvailMB }) {
let tpl = Template().fromImage(image, { username: 'AWS', password: process.env.ECR_PASSWORD }).setUser('root')
// Children (mumbo-child) stay headless.
if (name.startsWith('mumbo-box')) tpl = tpl.runCmd(BOX_STEPS)
// A project box is headless: git, gh (GitHub's apt repository) and openssl for the box-local GitHub proxy's CA.
if (name.startsWith('mumbo-project')) {
  tpl = tpl.runCmd([
    'apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates curl gpg git openssl procps && install -d -m 0755 /etc/apt/keyrings && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list && apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends gh && rm -rf /var/lib/apt/lists/*',
  ])
}
const info = await Template.build(tpl, name, { cpuCount, memoryMB })
console.log('built', info.templateId, info.buildId)
// Smoke: a box from the template has the app, no prior user data, curl for backups, and at least minAvailMB free on /.
const s = await Sandbox.create(name, { timeoutMs: 120_000 })
const out = (await s.commands.run('test -f /src/apps/cli/src/bin.ts && echo app; test -e /root/.dsh && echo HAS-DSH-HOME || echo clean; command -v curl tar | wc -l; df --output=avail -m / | tail -1')).stdout
await s.kill()
const line = out.trim().replace(/\s+/g, ' ')
console.log(line)
const avail = /^app clean 2 (\d+)$/.exec(line)?.[1]
if (avail === undefined) process.exit(1)
// The template is already built and named by now: a failure means rebuild before boxes are created from it.
if (Number(avail) < minAvailMB) { console.error(`template: ${avail} MiB free on /, below MIN_AVAIL_MB ${minAvailMB}; raise box_step_disk in prod/control.tf (RUNBOOK "Changing E2B limits")`); process.exit(1) }
}
