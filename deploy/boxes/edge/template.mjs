// Build the `mumbo-box` E2B template from a shipped mumbo web image in ECR. dsh is not left running here: the edge
// starts it per user with that user's box token (edge/edge.mjs startScript); the build only checks that it starts
// (dshSmokeStep).
// Usage (needs the edge/node_modules e2b SDK and E2B_API_URL / E2B_SANDBOX_URL / E2B_API_KEY):
//   ECR_PASSWORD=$(aws ecr get-login-password --region us-east-1) node template.mjs (inside the edge image, or from deploy/boxes/edge) <ecr image uri>
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Sandbox, Template } from 'e2b'
import { PORTS, PORTS_MARKER, OLD_PORTS, ENVD_PORT, MUMBO_MCP_PORT, startScript, boxSite, signBox, memberKey, mumboMcpKey, mcpPrincipal, roleInstructions, containmentRows } from './edge.mjs'
// Usage: template.mjs <ecr image> [name=mumbo-box] [memoryMB=4096] [cpuCount=2]; children use: mumbo-child 2048.
// MIN_AVAIL_MB (default 30720, 30 GiB: box_free_disk in prod/modules/cell/control.tf less margin): the least free space on / a box from the new build may have, or the script fails.
export function templateArgs(argv, env = process.env) {
  const minAvail = env.MIN_AVAIL_MB ?? '30720'
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
 *  their start script loads its nftables firewall (edge hardening) and stops when the load fails. */
export const PORTS_STEP = `install -d -m 0755 ${dirname(PORTS_MARKER)} && printf '%s\\n' '${PORTS.dsh} ${PORTS.live}' > ${PORTS_MARKER} && chmod 0644 ${PORTS_MARKER}`
/** The users usersSteps adds. */
const containmentUsers = (person) => ['agent', 'mcpserver', ...(person ? ['browsermcp', 'desktop', 'xsession'] : [])]
/** Agent containment's users and groups (B24, edge startScript), which the start script looks up by name at each start
 *  and writes into the containment rows by id, since E2B's own account `user` can take any id: `agent` runs the model's
 *  commands and owns the workspace; `mcpserver` runs the MCP servers the person adds. A person box adds `browsermcp` (the
 *  Playwright MCP server), `desktop` (the X clients of computer use and the Browser tab) and `xsession` (the XFCE
 *  session). Group `shared` holds the Downloads (agent and xsession, beside browser); `workspace` the workspace
 *  (agent and xsession; mcpserver joins at start with the edge's MCP_SERVER_WORKSPACE `readwrite`, and `workspace-read`
 *  with `read`); `desktop`, desktop's own group, reads the X cookie (browser, xvnc, xsession); the system group
 *  `uploads` enters browser consent's staged upload copies (browser, browsermcp). Homes are their users'
 *  alone, and the run-as TMPDIRs exist. An ACL check fails the build on a filesystem the start script's setfacl would
 *  fail on. No account keeps an empty password; the start script also takes the set-user-ID bit off su and sudo.
 *  @param {boolean} person a person box (mumbo-box), not a project box
 *  @returns {string[]} the steps */
export const usersSteps = (person) => {
  const users = containmentUsers(person)
  const shell = (u) => ['agent', 'xsession'].includes(u) ? '/bin/bash' : '/usr/sbin/nologin'
  return [
    ...users.map(u => `id ${u} >/dev/null 2>&1 || useradd -m -s ${shell(u)} ${u}`),
    `groupadd -f workspace && groupadd -f workspace-read && usermod -aG workspace agent${person ? ' && for u in agent xsession; do usermod -aG shared $u; done && usermod -aG workspace xsession && for u in browser xvnc xsession; do usermod -aG desktop $u; done && groupadd -f -r uploads && for u in browser browsermcp; do usermod -aG uploads $u; done' : ''}`,
    `for u in ${users.join(' ')}; do chmod 0700 /home/$u; done && for u in ${['agent', ...(person ? ['browsermcp', 'desktop'] : [])].join(' ')}; do install -d -o $u -g $u -m 0700 /home/$u/tmp; done`,
    'd=$(mktemp -d /var/tmp/acl.XXXXXX) && setfacl --set u::rwx,g::rwx,g:workspace-read:r-x,m::rwx,o::--- "$d" && getfacl -p "$d" | grep -qx group:workspace-read:r-x && rm -rf "$d"',
    'awk -F: \'$2 == "" { print $1 }\' /etc/shadow | xargs -r -n1 passwd -l',
    PORTS_STEP,
  ]
}
/** The port NFT_SMOKE_STEP probes; nothing in a box uses it. */
const NFT_PROBE_PORT = 47999
/** The template step, last, after the users exist, that fails the build unless this kernel enforces the kind of rule the
 *  start script's nftables firewall is made of (edge hardening): it loads the probe table `inet mumbo_probe`, whose output
 *  chain accepts root's TCP connections to NFT_PROBE_PORT (`meta skuid 0`) and resets every other one, runs a listener on
 *  127.0.0.1 there as root with node (the image's runtime), and requires that root connects and that agent is refused
 *  (ECONNREFUSED). It deletes the table and stops the listener before it checks, and a table it cannot delete fails the
 *  build too, so neither reaches the template. It first prints the kernel release and its NFT_REJECT_INET setting into the
 *  build log, for the operator to match against the boxes' kernel. A subshell: e2b's runCmd joins the steps with `&&`, which then carries the
 *  step's status and skips it after a failed step. */
export const NFT_SMOKE_STEP = `(${[
  'echo "mumbo-box: nftables smoke check on kernel $(uname -r 2>/dev/null)"; zcat /proc/config.gz 2>/dev/null | grep NFT_REJECT_INET || :',
  `N=$(command -v node) || { echo 'mumbo-box: the nftables smoke check needs node' >&2; exit 1; }`,
  `C='const s=require("net").connect(${NFT_PROBE_PORT},"127.0.0.1");s.on("connect",()=>process.exit(0));s.on("error",e=>process.exit(e.code==="ECONNREFUSED"?3:1));setTimeout(()=>process.exit(2),5000)'`,
  'export N C',
  `nft 'table inet mumbo_probe { chain output { type filter hook output priority 0; policy accept; tcp dport ${NFT_PROBE_PORT} meta skuid 0 accept; tcp dport ${NFT_PROBE_PORT} reject with tcp reset; }; }' || { echo 'mumbo-box: nft cannot load the probe table inet mumbo_probe' >&2; exit 1; }`,
  `"$N" -e 'require("net").createServer(s=>s.end()).listen(${NFT_PROBE_PORT},"127.0.0.1")' </dev/null >/dev/null 2>&1 & l=$!`,
  'r=1; for i in 1 2 3 4 5 6 7 8 9 10; do "$N" -e "$C" && { r=0; break; } || r=$?; sleep 1; done',
  `a=0; su -s /bin/sh agent -c '"$N" -e "$C"' </dev/null || a=$?`,
  'kill $l 2>/dev/null || :; wait $l 2>/dev/null || :',
  `nft delete table inet mumbo_probe || { echo 'mumbo-box: nft could not delete the probe table inet mumbo_probe' >&2; exit 1; }`,
  `[ $r = 0 ] && [ $a = 3 ] || { echo "mumbo-box: the nftables smoke check failed: root's connection ended with $r and agent's with $a, not 0 and 3 (refused)" >&2; exit 1; }`,
].join('; ')})`

/** The edge config of the dsh smoke check's start script: hosts under .invalid, which never resolve, and an agent login
 *  and id, which production sets (prod/terraform.tfvars). */
const SMOKE_CFG = { llmHost: 'llm.invalid', publicHost: 'box.invalid', projectDomain: 'box.invalid', agentLogin: 'smoke[bot]', agentId: 1 }
/** `text` less its part from `from` up to `to`.
 *  @throws unless each marker occurs once, `from` first */
const without = (text, from, to) => {
  const i = text.indexOf(from), j = text.indexOf(to)
  if (i < 0 || j < i || text.includes(from, i + 1) || text.includes(to, j + 1)) throw new Error(`template: the start script has no one part from ${JSON.stringify(from)} to ${JSON.stringify(to)}`)
  return text.slice(0, i) + text.slice(j)
}
/** The start script of a box from this template, made as the edge makes it (edge boxes create) from dummy values (box
 *  `smoke`, edge key `smoke`, SMOKE_CFG, a person `smoke@box.invalid` or the project `0000000000000000`), less the parts
 *  whose effects would stay in the template: of the kernel and network part (edge hardening), the /proc mount, su's and
 *  sudo's set-user-ID bits and the firewall table; a person box's desktop (X server, Chrome and session processes, their
 *  profiles, the X cookie, the launchers in /usr/local/bin); and a project box's GitHub proxy (a CA the system trusts).
 *  It keeps hardening's sysctls (the unprivileged port floor 1024, fs.protected_hardlinks=1, fs.protected_symlinks=1),
 *  set and checked: the run-as provider refuses to load without fs.protected_hardlinks=1, and every box's start script
 *  writes the same values at each start, so a template that keeps them runs no box differently. It keeps the system
 *  repair too (edge systemRepair), whose owners and modes every box's start script sets again. dsh runs as root, which
 *  the firewall refuses only envd, and NFT_SMOKE_STEP covers that kind of rule. Without the desktop, computer use's row
 *  does not activate and dsh warns (INACTIVE_ALLOWLIST).
 *  @param {boolean} person a person box (mumbo-box), not a project box
 *  @returns {string} the script */
export function smokeStartScript(person) {
  const principal = person ? 'smoke@box.invalid' : 'project:0000000000000000', key = 'smoke', box = 'smoke'
  const s = startScript(SMOKE_CFG, signBox(key, principal, box), boxSite(SMOKE_CFG, principal), roleInstructions(SMOKE_CFG, principal),
    person ? undefined : memberKey(key, box).toString('base64url'), { proxy: '', gh: '' }, person ? undefined : ['smoke@box.invalid'],
    person ? { key: mumboMcpKey(key, box), principal: mcpPrincipal(principal) } : undefined, principal)
  const local = without(s, '  # Every user but root sees only its own processes', 'fi\nCONTAINMENT_PATCH=\n')
  return person ? without(local, '# Desktop: XFCE', '# dsh\'s own temporary directory') : without(local, '# Project box: a TLS-terminating GitHub proxy', '# Project box: members sign in')
}
/** The seconds dshSmokeStep waits for dsh's start line. */
export const DSH_SMOKE_SECONDS = 60
/** The seconds dshSmokeStep waits after dsh's start line for dsh's warning that entries did not activate: both follow
 *  the Loader's settling, each after its own audit of the entries (app-boot boot and web-app). */
export const DSH_SMOKE_SETTLE_SECONDS = 3
/** Entries dshSmokeStep accepts in dsh's warning that entries did not activate, each with the reason. */
export const INACTIVE_ALLOWLIST = [
  { id: 'computer-use-x11', reason: "a person box's computer use on X display :1 runs `xdotool getdisplaygeometry` when it loads, and this check starts no X server" },
]
/** The paths dshSmokeStep's check for world-writable files skips, each with the reason. */
export const WRITABLE_EXCLUDES = [
  { path: '/proc', reason: "the kernel's view of processes and settings" },
  { path: '/sys', reason: "the kernel's view of devices and drivers" },
  { path: '/dev', reason: 'device nodes, and /dev/shm, which is sticky' },
  { path: '/run', reason: "runtime sockets and state, this check's own directory among them" },
  { path: '/tmp', reason: "every user's temporary files, in a sticky directory, where only a file's owner removes or renames it" },
]
/** The directories on the run-as users' PATHs, from containmentRows' `PATH:` values: `own`, those in agent's home on
 *  agent's PATH (runAs) and no other user's, which agent may own; `root`, every other, which only root may change.
 *  @param {boolean} person a person box
 *  @returns {{ own: string[], root: string[] }} */
const rowPaths = (person) => {
  const rows = containmentRows(SMOKE_CFG, person), dirs = (re) => [...rows.matchAll(re)].flatMap(m => m[1].split(':'))
  const agent = dirs(/^ {8}PATH: (\S+)$/gm), others = dirs(/^ {10}PATH: (\S+)$/gm)
  const own = agent.filter(d => d.startsWith('/home/agent/') && !others.includes(d))
  return { own, root: [...new Set([...agent, ...others])].filter(d => !own.includes(d)) }
}
/** agent's environment in the containment rows (runAs `set`) that agentInstallScript needs, as `NAME=value` words. */
const agentEnv = (person) => [...containmentRows(SMOKE_CFG, person).matchAll(/^ {8}(HOME|TMPDIR|NPM_CONFIG_PREFIX|PATH): (\S+)$/gm)].map(m => `${m[1]}=${m[2]}`)
/** The script dshSmokeStep runs as agent, with agent's HOME, TMPDIR, NPM_CONFIG_PREFIX and PATH from the containment
 *  rows, to show that agent installs packages without /usr/local, which is root's alone (edge systemRepair): `npm i -g`
 *  of a package it packs from a directory in its TMPDIR must land in its npm prefix and run from its PATH; then, when
 *  the image has python3, a venv in its TMPDIR, the supported route for Python packages, whose pip installs a wheel the
 *  script makes, which must import. Nothing reaches the network; dshSmokeStep removes what it leaves in /home.
 *  @param {boolean} person a person box
 *  @returns {string} the script */
export const agentInstallScript = (person) => `set -eu
export ${agentEnv(person).join(' ')}
d=$(mktemp -d)
mkdir $d/js
printf '%s\\n' '{"name":"mumbo-smoke","version":"1.0.0","bin":{"mumbo-smoke":"cli.js"}}' > $d/js/package.json
printf '#!/usr/bin/env node\\nconsole.log("mumbo-smoke npm")\\n' > $d/js/cli.js
cd $d
npm pack ./js --pack-destination $d --silent >/dev/null
npm install -g --offline --no-audit --no-fund --silent $d/mumbo-smoke-1.0.0.tgz
[ "$(command -v mumbo-smoke)" = "$NPM_CONFIG_PREFIX/bin/mumbo-smoke" ] || { echo "agent's PATH finds mumbo-smoke at $(command -v mumbo-smoke || echo nothing), not in $NPM_CONFIG_PREFIX/bin"; exit 1; }
[ "$(mumbo-smoke)" = 'mumbo-smoke npm' ] || { echo 'mumbo-smoke did not run'; exit 1; }
command -v python3 >/dev/null || { echo 'mumbo-box: this image has no python3, so the dsh smoke check makes no venv'; exit 0; }
python3 -m venv $d/venv
python3 - $d <<'PY'
import sys, zipfile
info = 'mumbo_smoke-1.0.dist-info/'
files = {'mumbo_smoke.py': 'OK = 42\\n', info + 'METADATA': 'Metadata-Version: 2.1\\nName: mumbo-smoke\\nVersion: 1.0\\n',
         info + 'WHEEL': 'Wheel-Version: 1.0\\nGenerator: mumbo-smoke\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n'}
files[info + 'RECORD'] = ''.join(p + ',,\\n' for p in [*files, info + 'RECORD'])
with zipfile.ZipFile(sys.argv[1] + '/mumbo_smoke-1.0-py3-none-any.whl', 'w') as z:
    for p, text in files.items(): z.writestr(p, text)
PY
$d/venv/bin/pip install --no-index --disable-pip-version-check --quiet $d/mumbo_smoke-1.0-py3-none-any.whl
[ "$($d/venv/bin/python -c 'import mumbo_smoke; print(mumbo_smoke.OK)')" = 42 ] || { echo "the venv's python did not import what its pip installed"; exit 1; }
`
/** Listeners dshSmokeStep accepts though their user is not agent and the output chain lets agent connect to their port,
 *  each with the reason. */
export const LISTENER_ALLOWLIST = [
  { port: '8899', reason: "the project box's GitHub proxy (user ghproxy; this check does not start it): agent's git and gh use it as HTTPS_PROXY, and it tunnels only to what the firewall lets ghproxy reach" },
]
/** The directories dshSmokeStep compares before and after, for what the start script and dsh made. */
const SMOKE_SCAN = '/root /home /src /var/lib/mumbo /usr/local/share/mumbo /run/dsh-shell /tmp /var/tmp /dev/shm'
/** The template step, after NFT_SMOKE_STEP, that fails the build unless dsh starts on this template as a box starts it:
 *  it runs smokeStartScript as root in a session of its own (setsid), which lays the box out (containmentLayout, and the
 *  containment rows on an image with serverIdentity), writes the overlays and starts dsh with the box's profile, patches
 *  and rows, and requires dsh's line `dsh web: http…?token=` in /root/dsh.log within DSH_SMOKE_SECONDS. DSH_SMOKE_SETTLE_SECONDS
 *  later it fails on any entry outside INACTIVE_ALLOWLIST in dsh's warning that entries did not activate: a failed row
 *  that is not required, such as subprocess, no longer stops dsh's start. Then it lists the
 *  TCP listeners as root (`ss -ltnpeH`; `-e` prints a socket's uid, except root's) and fails on any whose user is not
 *  agent and whose port is neither in the output chain's reset set (envd, dsh, the live view, the door, 5900 to 5999,
 *  9222) nor in LISTENER_ALLOWLIST. With the start script's system repair done, it fails on any world-writable file or
 *  directory without the sticky bit on the root filesystem outside WRITABLE_EXCLUDES, and on any file a user other than
 *  root can change (another owner, o+w, or g+w with a group other than root) in a directory on root's PATH or a run-as
 *  user's (containmentRows), or anywhere in dsh's code tree, the real paths of /src and `npm root -g`: root runs and
 *  imports them, so this check also names what a system user or group could change there, which the repair leaves
 *  (edge systemRepair). agent may also own the directories in its home on its own PATH alone (rowPaths). Then it runs
 *  agentInstallScript as agent, and fails unless it succeeds. On a failure it prints the reason, with mode, owner and
 *  path for each file named, and the tails of start.sh's output, /root/dsh.log and dsh's start-up audit
 *  (/root/.dsh/logs/startup-*.log), and dsh's whole warning that entries did not activate. Either way it then kills every process of the containment
 *  users and every process that started during the step (one whose pid `ps -e` did not list before start.sh) but kernel
 *  threads, the step's own session and envd's children (its socat port forwarders, which envd stops itself):
 *  dsh-subprocess-local starts each child in a session of its own, and as root on an image without serverIdentity. A
 *  process another service starts while the step runs is killed too. It removes every path that appeared under
 *  SMOKE_SCAN, restores the modes of /root and its entries (the layout sets them at every start), and fails unless no
 *  such process is left and SMOKE_SCAN and those modes read as before. dsh runs at a box's own paths (HOME /root, DSH_HOME /root/.dsh, its log /root/dsh.log), which
 *  the rows and the layout name, so the step refuses a template that already has /root/.dsh, /root/.mumbo, /root/dsh.log,
 *  /root/projects or /root/work. What stays: mcpserver's supplementary groups set to none (`usermod -G ''`), as
 *  usersSteps left them, and smokeStartScript's sysctls and system repair, which every box's start script sets the same way. A template without the marker runs dsh on OLD_PORTS, as its boxes would; an image without
 *  serverIdentity runs it as root without the rows. No text of the step matches start.sh's
 *  `pkill -f 'apps/cli/src/bin.ts'`, which would kill the step. A subshell, as NFT_SMOKE_STEP.
 *  @param {boolean} person a person box (mumbo-box), not a project box
 *  @returns {string} the shell step */
export const dshSmokeStep = (person) => {
  const open = [ENVD_PORT, '$DSH_PORT', '$LIVE_PORT', MUMBO_MCP_PORT, '5900-5999', '9222', ...LISTENER_ALLOWLIST.map(l => l.port)].join(' ')
  // One line per listener whose user is not agent (ss -e prints no uid for root) and whose port is not in `open`.
  const listeners = `awk -v a="$(id -u agent)" -v open="${open}" '{ p = $4; sub(/.*:/, "", p); u = 0; for (i = 5; i <= NF; i++) if ($i ~ /^uid:/) u = substr($i, 5); if ((u "") == a) next; n = split(open, o, " "); for (i = 1; i <= n; i++) { split(o[i], r, "-"); if (p + 0 >= r[1] + 0 && p + 0 <= (r[2] == "" ? r[1] : r[2]) + 0) next } print }'`
  // The ids in dsh's warning (app-boot activationDiagnostic: its count, then one `<id> (<package>): <detail>` line per
  // entry, which stack lines may follow) that INACTIVE_ALLOWLIST does not name.
  const inactive = `awk -v ok=" ${INACTIVE_ALLOWLIST.map(e => e.id).join(' ')} " '/^dsh: warning: [0-9]+ entr(y|ies) did not activate$/ { n = $3 + 0; next } n > 0 && /^[^ ]+ [(]/ { n--; if (!index(ok, " " $1 " ")) printf " %s", $1 }' /root/dsh.log`
  const listed = `-printf '%M %u:%g %p\\n'`, changeable = (owners) => `\\( ${owners} -o -perm -0002 -o ! -gid 0 -perm -0020 \\)`
  const paths = rowPaths(person), real = (dirs) => `$(for d in ${dirs}; do [ ! -d "$d" ] || readlink -f "$d"; done | sort -u)`
  return `(${[
    'export LC_ALL=C; echo "mumbo-box: dsh smoke check: start dsh as a box does, with dummy values"',
    'for p in /root/.dsh /root/.mumbo /root/dsh.log /root/projects /root/work; do [ ! -e "$p" ] || { echo "mumbo-box: the dsh smoke check needs a template without $p, which a box\'s start script makes" >&2; exit 1; }; done',
    `DSH_PORT=${OLD_PORTS.dsh} LIVE_PORT=${OLD_PORTS.live}; [ ! -e ${PORTS_MARKER} ] || read -r DSH_PORT LIVE_PORT < ${PORTS_MARKER}`,
    `S='${SMOKE_SCAN}'; T=$(mktemp -d /run/mumbo-smoke.XXXXXX) || exit 1`,
    'find $S -xdev 2>/dev/null | sort -T $T > $T/before; find /root -maxdepth 1 ! -type l -printf \'%m %p\\n\' | sort > $T/modes',
    `echo ${Buffer.from(smokeStartScript(person)).toString('base64')} | base64 -d > $T/start.sh`,
    'why=; ps -e -o pid= > $T/pids; setsid -w sh -c \'echo $$ > "$1"; exec sh "$2"\' - $T/sid $T/start.sh </dev/null >$T/start.log 2>&1 || why="start.sh failed (status $?)"',
    'sid=$(cat $T/sid 2>/dev/null); case $sid in \'\'|0|*[!0-9]*) sid=; [ -n "$why" ] || why=\'start.sh wrote no session id\';; esac',
    `n=0; while [ -z "$why" ] && ! grep -qs 'dsh web: http[^ ]*[?]token=' /root/dsh.log; do if ! pgrep -s "$sid" -f 'apps/cli/src/bin[.]ts' >/dev/null; then why='dsh exited before its start line'; elif [ $n -ge ${DSH_SMOKE_SECONDS} ]; then why='dsh printed no start line within ${DSH_SMOKE_SECONDS} s'; else sleep 1; n=$((n + 1)); fi; done`,
    `[ -n "$why" ] || { sleep ${DSH_SMOKE_SETTLE_SECONDS}; bad=$(${inactive}); [ -z "$bad" ] || why="these dsh entries did not activate, outside INACTIVE_ALLOWLIST (template.mjs):$bad"; }`,
    `[ -n "$why" ] || { L=$(ss -ltnpeH) || why='ss could not list the TCP listeners'; }; [ -n "$why" ] || { bad=$(printf '%s\\n' "$L" | ${listeners}); [ -z "$bad" ] || why="agent may connect to these listeners of other users, outside the output chain's reset set and LISTENER_ALLOWLIST (template.mjs): $bad"; }`,
    `[ -n "$why" ] || { bad=$(find / -xdev -ignore_readdir_race \\( ${WRITABLE_EXCLUDES.map(e => `-path ${e.path}`).join(' -o ')} \\) -prune -o \\( -type f -o -type d \\) -perm -0002 ! \\( -type d -perm -1000 \\) ${listed}) || why='find could not list the world-writable files'; }; [ -n "$why" ] || [ -z "$bad" ] || why="these are world-writable, outside WRITABLE_EXCLUDES (template.mjs), and no sticky directory: $bad"`,
    `[ -n "$why" ] || { A=$(id -u agent) && G=$(npm root -g --logs-max=0) && P=${real(`$(printf '%s' "$PATH" | tr : ' ') ${paths.root.join(' ')}`)} && O=${real(paths.own.join(' '))} && C=$(readlink -f /src "$G") && bad=$(find $P -maxdepth 1 ! -type l ${changeable('! -uid 0')} ${listed} && { [ -z "$O" ] || find $O -maxdepth 1 ! -type l ${changeable('! -uid 0 ! -uid $A')} ${listed}; } && find $C -xdev -ignore_readdir_race ! -type l ${changeable('! -uid 0')} ${listed}) || why="could not list root's and the run-as users' PATH directories and dsh's code tree"; }; [ -n "$why" ] || [ -z "$bad" ] || why="a user other than root can change these (in agent's own PATH directories, a user other than root or agent), which root or a run-as user runs or dsh imports (on root's or a run-as user's PATH, or in dsh's code tree): $bad"`,
    `[ -n "$why" ] || { su -s /bin/sh agent -c "$(echo ${Buffer.from(agentInstallScript(person)).toString('base64')} | base64 -d)" </dev/null >$T/agent.log 2>&1 && { grep '^mumbo-box: ' $T/agent.log || :; } || why="agent could not install packages into its own prefixes (npm -g, pip in a venv): $(tail -n 20 $T/agent.log)"; }`,
    '[ -z "$why" ] || { echo "mumbo-box: the dsh smoke check failed: $why"; echo "--- start.sh"; tail -n 20 $T/start.log; echo "--- /root/dsh.log"; tail -n 60 /root/dsh.log; for f in /root/.dsh/logs/startup-*.log; do [ ! -e "$f" ] || { echo "--- $f"; tail -n 60 "$f"; }; done; ! grep -qs \' did not activate$\' /root/dsh.log || { echo "--- dsh\'s entries that did not activate"; awk \'/^dsh: .* did not activate$/ { p = 1 } p\' /root/dsh.log; }; } >&2',
    `U=$(for u in ${containmentUsers(person).join(' ')}; do id -u $u 2>/dev/null; done | tr '\\n' ' '); E=$(pgrep -x envd | tr '\\n' ' '); me=$(ps -e -o pid=,sid= | awk -v p=$$ '$1 == p { print $2 }')`,
    // The containment users' processes, and those that started during the step (not in $T/pids) but kernel threads
    // (kthreadd, pid 2, and its children), the step's own session and envd's children.
    `procs() { ps -e -o pid=,ppid=,sid=,uid=,stat=,args= | awk -v u=" $U" -v e=" $E" -v me="$me" 'NR == FNR { old[$1]; next } $5 !~ /^Z/ && (index(u, " " $4 " ") || !($1 in old) && $1 != 2 && $2 != 2 && $3 != me && !index(e, " " $2 " "))' $T/pids -; }`,
    'n=0; while [ -n "$(procs)" ] && [ $n -lt 10 ]; do procs | awk \'{ print $1 }\' | xargs -r kill -KILL 2>/dev/null; sleep 1; n=$((n + 1)); done; left=$(procs); [ -z "$left" ] || { echo "mumbo-box: the dsh smoke check could not stop: $left" >&2; why=1; }',
    'find $S -xdev 2>/dev/null | sort -T $T > $T/after; comm -13 $T/before $T/after | awk \'k == "" || index($0, k "/") != 1 { print; k = $0 }\' | while IFS= read -r p; do rm -rf -- "$p"; done; while read -r m p; do chmod "$m" "$p"; done < $T/modes',
    'left=$(find $S -xdev 2>/dev/null | sort -T $T | comm -3 $T/before - | head -n 20); [ -z "$left" ] || { echo "mumbo-box: the dsh smoke check could not undo: $left" >&2; why=1; }; find /root -maxdepth 1 ! -type l -printf \'%m %p\\n\' | sort | cmp -s - $T/modes || { echo "mumbo-box: the dsh smoke check could not restore the modes in /root" >&2; why=1; }',
    'rm -rf $T; [ -z "$why" ] && echo "mumbo-box: dsh smoke check passed"',
  ].join('; ')})`
}
/** The first template step: e2b's runCmd joins the steps with `&&` in one shell, so every file the steps create gets at
 *  most 0755 or 0644 unless a step sets its mode, whatever umask E2B's build runs them with. */
export const UMASK_STEP = 'umask 022'
/** GitHub CLI's apt keyring and source (cli.github.com), the same in both templates, each of which makes
 *  /etc/apt/keyrings first. */
export const GH_APT = 'curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list'
/** The person template's step that makes git over https to github.com use gh's sign-in (B48): the system git config,
 *  root's and 0644, so nothing depends on agent's own ~/.gitconfig, which is scratch. It fails the build unless the
 *  file reads back with that one helper, root-owned and 0644. */
export const GH_GITCONFIG_STEP = "git config --system credential.https://github.com.helper '!gh auth git-credential' && chown root:root /etc/gitconfig && chmod 0644 /etc/gitconfig && [ \"$(git config --system --get-all credential.https://github.com.helper)\" = '!gh auth git-credential' ] && [ \"$(stat -c %a:%U:%G /etc/gitconfig)\" = 644:root:root ]"
/** The user's box is their computer: KasmVNC's display and live view, the XFCE desktop and Google Chrome stable from
 *  Google's apt repository (each build installs the current release). The edge's start script runs KasmVNC as the user
 *  `xvnc`, Chrome as the user `browser` and, on an image with the B24 harness, the XFCE session as `xsession` (before it,
 *  as `browser`), and writes /usr/local/bin/google-chrome, the one way to start Chrome; the menu entry and XFCE's web
 *  browser are aimed at it here. python3-venv gives agent venvs, its route for Python packages, since /usr/local is
 *  root's alone (agentInstallScript): the web image has python3 without it, and only boxes need it. git and gh (GitHub's
 *  apt repository, GH_APT) carry the person's own GitHub sign-in (B48, GH_GITCONFIG_STEP). */
export const BOX_STEPS = [
  UMASK_STEP,
  ...(CHROME_SENSITIVE_SYNC ? [maskingGuardStep()] : []),
  `apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates curl && install -d -m 0755 /etc/apt/keyrings && curl -fsSL https://dl.google.com/linux/linux_signing_key.pub -o /etc/apt/keyrings/google-chrome.asc && chmod go+r /etc/apt/keyrings/google-chrome.asc && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.asc] https://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list && ${GH_APT} && apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends xfce4-session xfwm4 xfce4-panel xfdesktop4 thunar xfce4-terminal tango-icon-theme librsvg2-common google-chrome-stable dbus-x11 xdotool wmctrl imagemagick xsel xauth fonts-noto-core fonts-noto-color-emoji fonts-noto-cjk procps ripgrep nftables libcap2-bin acl iproute2 python3-venv git gh && rm -rf /var/lib/apt/lists/*`,
  kasmvncStep(),
  'id browser >/dev/null 2>&1 || useradd -m -s /bin/bash browser',
  // KasmVNC's server runs as its own user, with no home or login, so browser cannot signal it or take its place. Not a
  // system user (`-r`): its uid is 1000 or more, so the system repair takes any system path it owns (edge systemRepair).
  'id xvnc >/dev/null 2>&1 || useradd -U -M -d /nonexistent -s /usr/sbin/nologin xvnc',
  KASMVNC_BIND_STEP,
  // Downloads are shared through the group shared (B24 adds the agent's users): /home/shared is root's, so no member can
  // replace the folder itself. The browser's home stays its own.
  'groupadd -f shared && usermod -aG shared browser && chmod 0700 /home/browser && install -d -m 0755 /home/shared && install -d -o browser -g shared -m 2770 /home/shared/Downloads',
  chromePolicyStep(CHROME_SENSITIVE_SYNC),
  // The stock panels, without the panel's first-start dialog; XFCE's web browser and Chrome's menu entry start the box's Chrome.
  'cp /etc/xdg/xfce4/panel/default.xml /etc/xdg/xfce4/xfconf/xfce-perchannel-xml/xfce4-panel.xml && sed -i "s/^WebBrowser=.*/WebBrowser=google-chrome/" /etc/xdg/xfce4/helpers.rc && install -d /usr/local/share/applications && sed "s#/usr/bin/google-chrome-stable#/usr/local/bin/google-chrome#" /usr/share/applications/google-chrome.desktop > /usr/local/share/applications/google-chrome.desktop',
  GH_GITCONFIG_STEP,
  ...usersSteps(true),
  NFT_SMOKE_STEP,
  dshSmokeStep(true),
]
/** A project box is headless: git, gh (GitHub's apt repository) and openssl for the box-local GitHub proxy's CA, nftables
 *  and acl for the start script, iproute2 for the dsh smoke check's ss and the escape test's network namespace, the
 *  proxy's own user ghproxy (edge startScript; no home or login, and, as xvnc in BOX_STEPS, not a system user), python3-venv
 *  for agent's venvs (as BOX_STEPS), agent containment's users, and the nftables and dsh smoke checks. */
export const PROJECT_STEPS = [
  UMASK_STEP,
  `apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates curl gpg git openssl procps ripgrep nftables acl iproute2 python3-venv && install -d -m 0755 /etc/apt/keyrings && ${GH_APT} && apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends gh && rm -rf /var/lib/apt/lists/*`,
  'id ghproxy >/dev/null 2>&1 || useradd -U -M -d /nonexistent -s /usr/sbin/nologin ghproxy',
  ...usersSteps(false),
  NFT_SMOKE_STEP,
  dshSmokeStep(false),
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
