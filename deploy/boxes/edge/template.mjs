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

/** true: the founder's full sync (decision 2026-11-10), passwords and payment cards included, since browser snapshots
 *  mask password and card fields (B25). false keeps Chrome from saving or syncing them. */
const CHROME_SENSITIVE_SYNC = true
/** Chrome's own pages for saved passwords, payment cards, addresses and their internals, blocked for everyone in the box's
 *  Chrome (spec section 17b, B25): computer use drives Chrome without going through browser consent. The person manages
 *  passwords and cards on their own devices. */
export const CHROME_URL_BLOCKLIST = ['chrome://password-manager', 'chrome://settings/passwords', 'chrome://settings/payments', 'chrome://settings/autofill',
  'chrome://settings/addresses', 'chrome://sync-internals', 'chrome://autofill-internals', 'chrome://password-manager-internals']
/** The template step that fails the build unless the image's browser consent knows `deniedUrls` and the image installs
 *  playwright-core with the masking patch (B25), so full sync never ships on an image whose snapshots show passwords:
 *  pnpm-workspace.yaml must list the patch file under patches/ for one playwright-core version, and every installed copy
 *  of that version must carry it. Other playwright-core versions (the test runner's) are not checked.
 *  @param {string} src the image's source checkout, /src
 *  @returns {string} the shell step */
export const maskingGuardStep = (src = '/src') => [
  `grep -q deniedUrls ${src}/packages/mumbo/browser-consent/src/index.ts || { echo 'mumbo-box: this image has no B25 browser consent (deniedUrls)' >&2; exit 1; }`,
  `l=$(sed -n "s/^ *'\\{0,1\\}playwright-core@\\([^:' ]*\\)'\\{0,1\\}: *\\(patches\\/playwright-core@[^ ]*\\.patch\\) *$/\\1 \\2/p" ${src}/pnpm-workspace.yaml); v=\${l% *}; p=\${l#* }`,
  `[ -n "$l" ] && [ -f "${src}/$p" ] || { echo 'mumbo-box: pnpm-workspace.yaml lists no playwright-core patch under patches/' >&2; exit 1; }`,
  `n=0; for d in ${src}/node_modules/.pnpm/playwright-core@*; do case "\${d##*/}" in "playwright-core@$v"|"playwright-core@\${v}_"*|"playwright-core@\${v}("*) grep -q maskedInjectedScriptSource "$d/node_modules/playwright-core/lib/coreBundle.js" 2>/dev/null || { echo "mumbo-box: \${d##*/} lacks the masking patch" >&2; exit 1; }; n=$((n + 1));; esac; done`,
  `[ "$n" -gt 0 ] || { echo "mumbo-box: playwright-core $v is not installed" >&2; exit 1; }`,
].join('; ')
/** The template step that writes Google Chrome's managed policy, root-owned. Downloads land in the shared folder the
 *  assistant reads (edge roleInstructions).
 *  @param {boolean} sensitiveSync CHROME_SENSITIVE_SYNC
 *  @returns {string} the shell step */
export const chromePolicyStep = (sensitiveSync) => {
  const policy = { RestoreOnStartup: 1, DefaultBrowserSettingEnabled: false, MetricsReportingEnabled: false, DownloadDirectory: '/home/shared/Downloads',
    URLBlocklist: CHROME_URL_BLOCKLIST,
    ...(sensitiveSync ? {} : { SyncTypesListDisabled: ['passwords', 'payments'], PasswordManagerEnabled: false, AutofillCreditCardEnabled: false }) }
  return `install -d -m 0755 /etc/opt/chrome/policies/managed && printf '%s\\n' '${JSON.stringify(policy)}' > /etc/opt/chrome/policies/managed/mumbo.json && chmod 0644 /etc/opt/chrome/policies/managed/mumbo.json`
}
/** The user's box is their computer: a virtual display, the XFCE desktop, Google Chrome stable from Google's apt
 *  repository (each build installs the current release) and the noVNC live view. The edge's start script runs them as
 *  the user `browser`, and writes /usr/local/bin/google-chrome, the one way to start Chrome; the menu entry and XFCE's
 *  web browser are aimed at it here. */
export const BOX_STEPS = [
  ...(CHROME_SENSITIVE_SYNC ? [maskingGuardStep()] : []),
  'apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates curl && install -d -m 0755 /etc/apt/keyrings && curl -fsSL https://dl.google.com/linux/linux_signing_key.pub -o /etc/apt/keyrings/google-chrome.asc && chmod go+r /etc/apt/keyrings/google-chrome.asc && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.asc] https://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list && apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends xvfb x11vnc novnc websockify xfce4-session xfwm4 xfce4-panel xfdesktop4 thunar xfce4-terminal tango-icon-theme librsvg2-common google-chrome-stable dbus-x11 xdotool wmctrl imagemagick xsel xauth fonts-noto-core fonts-noto-color-emoji fonts-noto-cjk procps && rm -rf /var/lib/apt/lists/*',
  'id browser >/dev/null 2>&1 || useradd -m -s /bin/bash browser',
  // Downloads are shared through the group shared (B24 adds the agent's users): /home/shared is root's, so no member can
  // replace the folder itself. The browser's home stays its own.
  'groupadd -f shared && usermod -aG shared browser && chmod 0700 /home/browser && install -d -m 0755 /home/shared && install -d -o browser -g shared -m 2770 /home/shared/Downloads',
  chromePolicyStep(CHROME_SENSITIVE_SYNC),
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
if (Number(avail) < minAvailMB) { console.error(`template: ${avail} MiB free on /, below MIN_AVAIL_MB ${minAvailMB}; raise box_step_disk in prod/modules/cell/control.tf (RUNBOOK "Changing E2B limits")`); process.exit(1) }
}
