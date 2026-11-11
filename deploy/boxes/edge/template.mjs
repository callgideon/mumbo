// Build the `mumbo-box` E2B template from a shipped mumbo web image in ECR. dsh is not started here: the edge
// starts it per user with that user's box token (edge/edge.mjs startScript).
// Usage (needs the edge/node_modules e2b SDK and E2B_API_URL / E2B_SANDBOX_URL / E2B_API_KEY):
//   ECR_PASSWORD=$(aws ecr get-login-password --region us-east-1) node template.mjs (inside the edge image, or from deploy/boxes/edge) <ecr image uri>
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Sandbox, Template } from 'e2b'
import { PORTS, PORTS_MARKER } from './edge.mjs'
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
/** KasmVNC, the desktop's display and live view: its Debian bookworm amd64 release package (the web image is
 *  node:24-bookworm), pinned by version and sha256. Update both together (RUNBOOK "Person box desktop and Google Chrome"). */
export const KASMVNC = { version: '1.5.2', sha256: '5f4bfda43e89178782eac37ae463b1d95d16ac5e45da8b7989ec75404e764993' }
/** The template step that installs KasmVNC from its GitHub release, failing the build unless the download has the
 *  pinned sha256. It also caps the screen size the web client asks for at 1600x900: KasmVNC has no server-side limit,
 *  and the client sizes the screen to the element the added style limits (`#noVNC_container>div`). The same style hides
 *  the Displays button, whose additional displays (screen.html) size the screen to their own windows. The step fails
 *  when the style is not in both entry pages.
 *  @param {{ version: string, sha256: string }} pin KASMVNC
 *  @returns {string} the shell step */
export const kasmvncStep = ({ version, sha256 } = KASMVNC) => {
  const name = `kasmvncserver_debian_bookworm_${version}_amd64.deb`, deb = `/tmp/${name}`
  const style = '<style>#noVNC_container>div{max-width:1600px;max-height:900px}#noVNC_displays_button{display:none!important}</style>'
  const pages = '/usr/share/kasmvnc/www/index.html /usr/share/kasmvnc/www/vnc.html'
  return `curl -fsSL -o ${deb} https://github.com/kasmtech/KasmVNC/releases/download/v${version}/${name} && echo "${sha256}  ${deb}" | sha256sum -c - && apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ${deb} && rm -rf ${deb} /var/lib/apt/lists/* && sed -i 's|</head>|${style}</head>|' ${pages} && for f in ${pages}; do grep -qF '${style}' "$f" || { echo "mumbo-box: no screen cap in $f" >&2; exit 1; }; done`
}
/** The template step, after the user xvnc exists, that lets KasmVNC's server, which runs as xvnc, bind the live view's
 *  port below 1024 (edge PORTS): file capability cap_net_bind_service on Xkasmvnc's real path, which only root and the
 *  group xvnc may run (root:xvnc 0750), so no other user binds dsh's or the live view's port with it. chgrp drops file
 *  capabilities, so the capability is set last; both are checked. */
export const KASMVNC_BIND_STEP = 'x=$(readlink -f "$(command -v Xkasmvnc)") && chgrp xvnc "$x" && chmod 0750 "$x" && setcap cap_net_bind_service=+ep "$x" && getcap "$x" | grep -q cap_net_bind_service && [ "$(stat -c %a:%U:%G "$x")" = 750:root:xvnc ]'
/** The template step that writes edge PORTS_MARKER: boxes from this template run dsh and the live view on edge PORTS, and
 *  their start script treats a failed iptables rule as fatal. */
export const PORTS_STEP = `install -d -m 0755 ${dirname(PORTS_MARKER)} && printf '%s\\n' '${PORTS.dsh} ${PORTS.live}' > ${PORTS_MARKER} && chmod 0644 ${PORTS_MARKER}`
/** Agent containment's users and groups (B24, edge startScript), which the start script looks up by name at each start
 *  and writes into the containment rows by id, since E2B's own account `user` can take any id: `agent` runs the model's
 *  commands and owns the workspace; `mcpserver` runs the MCP servers the person adds. A person box adds `browsermcp` (the
 *  Playwright MCP server), `desktop` (the X clients of computer use and the Browser tab) and `xsession` (the XFCE
 *  session). Group `shared` holds the Downloads (agent, browsermcp, xsession, beside browser); `workspace` the workspace
 *  (agent and xsession; mcpserver joins at start with the edge's MCP_SERVER_WORKSPACE `readwrite`, and `workspace-read`
 *  with `read`); `desktop`, desktop's own group, reads the X cookie (browser, xvnc, xsession); the system group
 *  `uploads` enters browser consent's staged upload copies (browser, browsermcp). Homes are their users'
 *  alone, and the run-as TMPDIRs exist. An ACL check fails the build on a filesystem the start script's setfacl would
 *  fail on. No account keeps an empty password; the start script also takes the set-user-ID bit off su and sudo.
 *  @param {boolean} person a person box (mumbo-box), not a project box
 *  @returns {string[]} the steps */
export const usersSteps = (person) => {
  const users = ['agent', 'mcpserver', ...(person ? ['browsermcp', 'desktop', 'xsession'] : [])]
  const shell = (u) => ['agent', 'xsession'].includes(u) ? '/bin/bash' : '/usr/sbin/nologin'
  return [
    ...users.map(u => `id ${u} >/dev/null 2>&1 || useradd -m -s ${shell(u)} ${u}`),
    `groupadd -f workspace && groupadd -f workspace-read && usermod -aG workspace agent${person ? ' && for u in agent browsermcp xsession; do usermod -aG shared $u; done && usermod -aG workspace xsession && for u in browser xvnc xsession; do usermod -aG desktop $u; done && groupadd -f -r uploads && for u in browser browsermcp; do usermod -aG uploads $u; done' : ''}`,
    `for u in ${users.join(' ')}; do chmod 0700 /home/$u; done && for u in ${['agent', ...(person ? ['browsermcp', 'desktop'] : [])].join(' ')}; do install -d -o $u -g $u -m 0700 /home/$u/tmp; done`,
    'd=$(mktemp -d /var/tmp/acl.XXXXXX) && setfacl --set u::rwx,g::rwx,g:workspace-read:r-x,m::rwx,o::--- "$d" && getfacl -p "$d" | grep -qx group:workspace-read:r-x && rm -rf "$d"',
    'awk -F: \'$2 == "" { print $1 }\' /etc/shadow | xargs -r -n1 passwd -l',
    PORTS_STEP,
  ]
}
/** The user's box is their computer: KasmVNC's display and live view, the XFCE desktop and Google Chrome stable from
 *  Google's apt repository (each build installs the current release). The edge's start script runs KasmVNC as the user
 *  `xvnc`, Chrome as the user `browser` and, on an image with the B24 harness, the XFCE session as `xsession` (before it,
 *  as `browser`), and writes /usr/local/bin/google-chrome, the one way to start Chrome; the menu entry and XFCE's web
 *  browser are aimed at it here. */
export const BOX_STEPS = [
  ...(CHROME_SENSITIVE_SYNC ? [maskingGuardStep()] : []),
  'apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates curl && install -d -m 0755 /etc/apt/keyrings && curl -fsSL https://dl.google.com/linux/linux_signing_key.pub -o /etc/apt/keyrings/google-chrome.asc && chmod go+r /etc/apt/keyrings/google-chrome.asc && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.asc] https://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list && apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends xfce4-session xfwm4 xfce4-panel xfdesktop4 thunar xfce4-terminal tango-icon-theme librsvg2-common google-chrome-stable dbus-x11 xdotool wmctrl imagemagick xsel xauth fonts-noto-core fonts-noto-color-emoji fonts-noto-cjk procps iptables libcap2-bin acl && rm -rf /var/lib/apt/lists/*',
  kasmvncStep(),
  'id browser >/dev/null 2>&1 || useradd -m -s /bin/bash browser',
  // KasmVNC's server runs as its own system user, with no home or login, so browser cannot signal it or take its place.
  'id xvnc >/dev/null 2>&1 || useradd -r -U -M -d /nonexistent -s /usr/sbin/nologin xvnc',
  KASMVNC_BIND_STEP,
  // Downloads are shared through the group shared (B24 adds the agent's users): /home/shared is root's, so no member can
  // replace the folder itself. The browser's home stays its own.
  'groupadd -f shared && usermod -aG shared browser && chmod 0700 /home/browser && install -d -m 0755 /home/shared && install -d -o browser -g shared -m 2770 /home/shared/Downloads',
  chromePolicyStep(CHROME_SENSITIVE_SYNC),
  // The stock panels, without the panel's first-start dialog; XFCE's web browser and Chrome's menu entry start the box's Chrome.
  'cp /etc/xdg/xfce4/panel/default.xml /etc/xdg/xfce4/xfconf/xfce-perchannel-xml/xfce4-panel.xml && sed -i "s/^WebBrowser=.*/WebBrowser=google-chrome/" /etc/xdg/xfce4/helpers.rc && install -d /usr/local/share/applications && sed "s#/usr/bin/google-chrome-stable#/usr/local/bin/google-chrome#" /usr/share/applications/google-chrome.desktop > /usr/local/share/applications/google-chrome.desktop',
  ...usersSteps(true),
]
/** A project box is headless: git, gh (GitHub's apt repository) and openssl for the box-local GitHub proxy's CA, iptables
 *  and acl for the start script, the proxy's own system user ghproxy (edge startScript), and agent containment's users. */
export const PROJECT_STEPS = [
  'apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates curl gpg git openssl procps iptables acl && install -d -m 0755 /etc/apt/keyrings && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list && apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends gh && rm -rf /var/lib/apt/lists/*',
  'id ghproxy >/dev/null 2>&1 || useradd -r -U -M -d /nonexistent -s /usr/sbin/nologin ghproxy',
  ...usersSteps(false),
]

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await build(templateArgs(process.argv))

async function build({ image, name, memoryMB, cpuCount, minAvailMB }) {
let tpl = Template().fromImage(image, { username: 'AWS', password: process.env.ECR_PASSWORD }).setUser('root')
// Children (mumbo-child) stay headless.
if (name.startsWith('mumbo-box')) tpl = tpl.runCmd(BOX_STEPS)
if (name.startsWith('mumbo-project')) tpl = tpl.runCmd(PROJECT_STEPS)
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
