// Build the `mumbo-box` E2B template from a shipped mumbo web image in ECR. dsh is not left running here: the edge
// starts it per user with that user's box token (edge/edge.mjs startScript); the build only checks that it starts
// (dshSmokeStep).
// Usage (needs the edge/node_modules e2b SDK and E2B_API_URL / E2B_SANDBOX_URL / E2B_API_KEY):
//   ECR_PASSWORD=$(aws ecr get-login-password --region us-east-1) node template.mjs (inside the edge image, or from deploy/boxes/edge) <ecr image uri>
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Sandbox, Template } from 'e2b'
import { PORTS, PORTS_MARKER, OLD_PORTS, ENVD_PORT, MUMBO_MCP_PORT, startScript, boxSite, signBox, memberKey, mumboMcpKey, mcpPrincipal, roleInstructions } from './edge.mjs'
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
 *  writes the same values at each start, so a template that keeps them runs no box differently. dsh runs as root, which
 *  the firewall refuses only envd, and NFT_SMOKE_STEP covers that kind of rule. Without the desktop, computer use's row
 *  does not activate and dsh warns.
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
 *  and rows, and requires dsh's line `dsh web: http…?token=` in /root/dsh.log within DSH_SMOKE_SECONDS. Then it lists the
 *  TCP listeners as root (`ss -ltnpeH`; `-e` prints a socket's uid, except root's) and fails on any whose user is not
 *  agent and whose port is neither in the output chain's reset set (envd, dsh, the live view, the door, 5900 to 5999,
 *  9222) nor in LISTENER_ALLOWLIST. On a failure it prints the reason and the tails of start.sh's output, /root/dsh.log
 *  and dsh's start-up audit (/root/.dsh/logs/startup-*.log). Either way it then kills every process of that session and
 *  of the containment users, removes every path that appeared under SMOKE_SCAN, restores the modes of /root and its
 *  entries (the layout sets them at every start), and fails unless no such process is left and SMOKE_SCAN and those
 *  modes read as before. dsh runs at a box's own paths (HOME /root, DSH_HOME /root/.dsh, its log /root/dsh.log), which
 *  the rows and the layout name, so the step refuses a template that already has /root/.dsh, /root/.mumbo, /root/dsh.log,
 *  /root/projects or /root/work. What stays: mcpserver's supplementary groups set to none (`usermod -G ''`), as
 *  usersSteps left them, and smokeStartScript's sysctls, which every box's start script sets to the same values. A template without the marker runs dsh on OLD_PORTS, as its boxes would; an image without
 *  serverIdentity runs it as root without the rows. No text of the step matches start.sh's
 *  `pkill -f 'apps/cli/src/bin.ts'`, which would kill the step. A subshell, as NFT_SMOKE_STEP.
 *  @param {boolean} person a person box (mumbo-box), not a project box
 *  @returns {string} the shell step */
export const dshSmokeStep = (person) => {
  const open = [ENVD_PORT, '$DSH_PORT', '$LIVE_PORT', MUMBO_MCP_PORT, '5900-5999', '9222', ...LISTENER_ALLOWLIST.map(l => l.port)].join(' ')
  // One line per listener whose user is not agent (ss -e prints no uid for root) and whose port is not in `open`.
  const listeners = `awk -v a="$(id -u agent)" -v open="${open}" '{ p = $4; sub(/.*:/, "", p); u = 0; for (i = 5; i <= NF; i++) if ($i ~ /^uid:/) u = substr($i, 5); if ((u "") == a) next; n = split(open, o, " "); for (i = 1; i <= n; i++) { split(o[i], r, "-"); if (p + 0 >= r[1] + 0 && p + 0 <= (r[2] == "" ? r[1] : r[2]) + 0) next } print }'`
  return `(${[
    'export LC_ALL=C; echo "mumbo-box: dsh smoke check: start dsh as a box does, with dummy values"',
    'for p in /root/.dsh /root/.mumbo /root/dsh.log /root/projects /root/work; do [ ! -e "$p" ] || { echo "mumbo-box: the dsh smoke check needs a template without $p, which a box\'s start script makes" >&2; exit 1; }; done',
    `DSH_PORT=${OLD_PORTS.dsh} LIVE_PORT=${OLD_PORTS.live}; [ ! -e ${PORTS_MARKER} ] || read -r DSH_PORT LIVE_PORT < ${PORTS_MARKER}`,
    `S='${SMOKE_SCAN}'; T=$(mktemp -d /run/mumbo-smoke.XXXXXX) || exit 1`,
    'find $S -xdev 2>/dev/null | sort -T $T > $T/before; find /root -maxdepth 1 ! -type l -printf \'%m %p\\n\' | sort > $T/modes',
    `echo ${Buffer.from(smokeStartScript(person)).toString('base64')} | base64 -d > $T/start.sh`,
    'why=; setsid -w sh -c \'echo $$ > "$1"; exec sh "$2"\' - $T/sid $T/start.sh </dev/null >$T/start.log 2>&1 || why="start.sh failed (status $?)"',
    'sid=$(cat $T/sid 2>/dev/null); case $sid in \'\'|0|*[!0-9]*) sid=; [ -n "$why" ] || why=\'start.sh wrote no session id\';; esac',
    `n=0; while [ -z "$why" ] && ! grep -qs 'dsh web: http[^ ]*[?]token=' /root/dsh.log; do if ! pgrep -s "$sid" -f 'apps/cli/src/bin[.]ts' >/dev/null; then why='dsh exited before its start line'; elif [ $n -ge ${DSH_SMOKE_SECONDS} ]; then why='dsh printed no start line within ${DSH_SMOKE_SECONDS} s'; else sleep 1; n=$((n + 1)); fi; done`,
    `[ -n "$why" ] || { L=$(ss -ltnpeH) || why='ss could not list the TCP listeners'; }; [ -n "$why" ] || { bad=$(printf '%s\\n' "$L" | ${listeners}); [ -z "$bad" ] || why="agent may connect to these listeners of other users, outside the output chain's reset set and LISTENER_ALLOWLIST (template.mjs): $bad"; }`,
    '[ -z "$why" ] || { echo "mumbo-box: the dsh smoke check failed: $why"; echo "--- start.sh"; tail -n 20 $T/start.log; echo "--- /root/dsh.log"; tail -n 60 /root/dsh.log; for f in /root/.dsh/logs/startup-*.log; do [ ! -e "$f" ] || { echo "--- $f"; tail -n 60 "$f"; }; done; } >&2',
    `U=$(for u in ${containmentUsers(person).join(' ')}; do id -u $u 2>/dev/null; done | tr '\\n' ' '); procs() { ps -e -o sid=,uid=,stat=,pid=,args= | awk -v s="$sid" -v u=" $U" '$3 !~ /^Z/ && ($1 == s || index(u, " " $2 " "))'; }`,
    'n=0; while [ -n "$(procs)" ] && [ $n -lt 10 ]; do procs | awk \'{ print $4 }\' | xargs -r kill -KILL 2>/dev/null; sleep 1; n=$((n + 1)); done; left=$(procs); [ -z "$left" ] || { echo "mumbo-box: the dsh smoke check could not stop: $left" >&2; why=1; }',
    'find $S -xdev 2>/dev/null | sort -T $T > $T/after; comm -13 $T/before $T/after | awk \'k == "" || index($0, k "/") != 1 { print; k = $0 }\' | while IFS= read -r p; do rm -rf -- "$p"; done; while read -r m p; do chmod "$m" "$p"; done < $T/modes',
    'left=$(find $S -xdev 2>/dev/null | sort -T $T | comm -3 $T/before - | head -n 20); [ -z "$left" ] || { echo "mumbo-box: the dsh smoke check could not undo: $left" >&2; why=1; }; find /root -maxdepth 1 ! -type l -printf \'%m %p\\n\' | sort | cmp -s - $T/modes || { echo "mumbo-box: the dsh smoke check could not restore the modes in /root" >&2; why=1; }',
    'rm -rf $T; [ -z "$why" ] && echo "mumbo-box: dsh smoke check passed"',
  ].join('; ')})`
}
/** The user's box is their computer: KasmVNC's display and live view, the XFCE desktop and Google Chrome stable from
 *  Google's apt repository (each build installs the current release). The edge's start script runs KasmVNC as the user
 *  `xvnc`, Chrome as the user `browser` and, on an image with the B24 harness, the XFCE session as `xsession` (before it,
 *  as `browser`), and writes /usr/local/bin/google-chrome, the one way to start Chrome; the menu entry and XFCE's web
 *  browser are aimed at it here. */
export const BOX_STEPS = [
  ...(CHROME_SENSITIVE_SYNC ? [maskingGuardStep()] : []),
  'apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates curl && install -d -m 0755 /etc/apt/keyrings && curl -fsSL https://dl.google.com/linux/linux_signing_key.pub -o /etc/apt/keyrings/google-chrome.asc && chmod go+r /etc/apt/keyrings/google-chrome.asc && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.asc] https://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list && apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends xfce4-session xfwm4 xfce4-panel xfdesktop4 thunar xfce4-terminal tango-icon-theme librsvg2-common google-chrome-stable dbus-x11 xdotool wmctrl imagemagick xsel xauth fonts-noto-core fonts-noto-color-emoji fonts-noto-cjk procps ripgrep nftables libcap2-bin acl iproute2 && rm -rf /var/lib/apt/lists/*',
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
  NFT_SMOKE_STEP,
  dshSmokeStep(true),
]
/** A project box is headless: git, gh (GitHub's apt repository) and openssl for the box-local GitHub proxy's CA, nftables
 *  and acl for the start script, iproute2 for the dsh smoke check's ss and the escape test's network namespace, the
 *  proxy's own system user ghproxy (edge startScript), agent containment's users, and the nftables and dsh smoke checks. */
export const PROJECT_STEPS = [
  'apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates curl gpg git openssl procps ripgrep nftables acl iproute2 && install -d -m 0755 /etc/apt/keyrings && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list && apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends gh && rm -rf /var/lib/apt/lists/*',
  'id ghproxy >/dev/null 2>&1 || useradd -r -U -M -d /nonexistent -s /usr/sbin/nologin ghproxy',
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
