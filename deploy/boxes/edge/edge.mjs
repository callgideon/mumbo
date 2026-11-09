// mumbo edge: routes each signed-in user to their own box (an E2B Firecracker VM running `dsh web`),
// proxies the box's model and search calls with the server key, pauses idle boxes and backs them up to S3.
// :8080 is reached only through oauth2-proxy (X-Forwarded-Email is trusted); :8081 serves the model host and
// accepts only box tokens. Design, review fixes and failure handling: deploy/boxes/DESIGN.md.
import { createHash, createHmac, createVerify, timingSafeEqual } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { Readable, pipeline } from 'node:stream'
import { ownersOf } from './projects.mjs'
import { UNITS, atCapacity } from './capacity.mjs'

const env = (name, fallback) => process.env[name] ?? fallback ?? (() => { throw new Error(`edge: set ${name}`) })()
/** A number setting that must be finite and at least `min`; a bad value stops the edge at start. */
const atLeast = (name, min, fallback) => {
  const n = Number(env(name, String(fallback)))
  if (!Number.isFinite(n) || n < min) throw new Error(`edge: ${name} must be a number of at least ${min}`)
  return n
}
const list = (value) => value.toLowerCase().split(',').map(s => s.trim()).filter(Boolean)
/** ALLOWED_EMAILS entries: `address`, `@domain` or the exact-address deny `!local@domain`. A malformed deny entry fails at startup, since it would silently deny nobody. */
const allowList = (value) => {
  const entries = list(value)
  for (const e of entries) if (e.startsWith('!') && !/^![^@\s!]+@[^@\s]+$/.test(e)) throw new Error(`edge: ALLOWED_EMAILS entry ${JSON.stringify(e)} must be !local@domain`)
  return entries
}
const optional = (name) => process.env[name] || undefined
/** Required CI check names (case-sensitive). An empty list would drop the merge gate's CI requirement, so it fails. */
const checkNames = (name, fallback) => {
  const names = env(name, fallback).split(',').map(s => s.trim()).filter(Boolean)
  if (names.length === 0) throw new Error(`edge: ${name} must name at least one check`)
  return names
}
/** A bare lowercase hostname with at least one dot: no scheme, port, path or trailing dot. Anything else fails at start. */
const hostname = (name, fallback) => {
  const value = env(name, fallback)
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value)) throw new Error(`edge: ${name} must be a bare lowercase hostname such as boxes.mumbo.si, not ${JSON.stringify(value)}`)
  return value
}
/** GITHUB_AGENT_ID, the agent's numeric GitHub user id, or undefined; set together with GITHUB_AGENT_LOGIN or fails. */
const agentId = () => {
  const id = optional('GITHUB_AGENT_ID')
  if (!id !== !optional('GITHUB_AGENT_LOGIN')) throw new Error('edge: set GITHUB_AGENT_ID and GITHUB_AGENT_LOGIN together')
  if (id !== undefined && !/^[1-9]\d{0,15}$/.test(id)) throw new Error(`edge: GITHUB_AGENT_ID must be a numeric GitHub user id, not ${JSON.stringify(id)}`)
  return id && Number(id)
}
/** oauth2-proxy's sign-in cookie name when SIGNIN_COOKIE is unset (prod sets it from Terraform signin_cookie_name). It
 *  starts with _oauth2_proxy, so edge images older than SIGNIN_COOKIE, which strip only that prefix, strip it too. */
const SIGNIN_COOKIE = '_oauth2_proxy_mumbo'
/** A cookie name: one or more RFC 9110 token characters. Anything else, the empty string included, fails at start. */
const cookieName = (name, fallback) => {
  const value = env(name, fallback)
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value)) throw new Error(`edge: ${name} must be a cookie name (token characters only), not ${JSON.stringify(value)}`)
  return value
}
/** Comma-separated redirect URIs, each exactly an origin and path (the form the sign-in page compares, consent.js toMumbo):
 *  no query, fragment, default port, uppercase or missing path. None, or any other entry, fails at start. */
const redirectUris = (name) => {
  const uris = env(name).split(',').map(s => s.trim()).filter(Boolean)
  const exact = (v) => { try { const u = new URL(v); return `${u.origin}${u.pathname}` === v } catch { return false } }
  if (uris.length === 0 || !uris.every(exact)) throw new Error(`edge: ${name} must list origin-and-path URIs such as https://boxes.mumbo.si/oauth2/callback, not ${JSON.stringify(env(name))}`)
  return uris
}
export const config = () => ({
  publicHost: env('PUBLIC_HOST'),
  projectDomain: hostname('PROJECT_DOMAIN', 'boxes.mumbo.si'),  // project boxes are served at p-<16 hex>.<this>
  llmHost: env('LLM_HOST'),
  signinCookie: cookieName('SIGNIN_COOKIE', SIGNIN_COOKIE),  // oauth2-proxy's --cookie-name; see isSignin
  template: env('BOX_TEMPLATE', 'mumbo-box'),
  idleMs: Number(env('IDLE_MINUTES', '30')) * 60_000,
  pauseIdle: env('PAUSE_IDLE', 'true') !== 'false',  // false: boxes stay running (founder, 2026-11-09); cost work comes later
  backupEveryMs: Number(env('BACKUP_MINUTES', '10')) * 60_000,
  maxRunningUnits: Number(env('MAX_RUNNING_UNITS', '0')),  // capacity units (capacity.mjs UNITS); 0: no edge-side cap, E2B's own placement errors decide
  pageAfterMs: atLeast('PAGE_AFTER_MS', 1000, 3000),  // a page load waiting longer on a box gets the starting page
  backupConcurrency: Number(env('BACKUP_CONCURRENCY', '8')),
  allowed: allowList(env('ALLOWED_EMAILS', '')),
  egressIps: list(env('BOX_EGRESS_IPS', '')),
  dailyRequests: Number(env('DAILY_MODEL_REQUESTS', '3000')),
  proxy: new URL(env('E2B_SANDBOX_URL', 'http://127.0.0.1:3002')),
  bucket: env('BACKUP_BUCKET'),
  upstream: env('MODEL_UPSTREAM', 'https://api.deepseek.com'),
  childTemplates: list(env('CHILD_TEMPLATES', 'mumbo-child')),
  maxChildren: Number(env('MAX_CHILD_SANDBOXES', '10')),
  // Approvals, GitHub and token budgets. Secrets arrive through the ECS secrets map: the ntfy topic from SSM; the id and
  // private key of the mumbo-bot GitHub App, which the agent writes as and the only identity that merges, from Secrets
  // Manager mumbo-boxes/github-app.
  approveHost: env('APPROVE_HOST', `approve.${env('PUBLIC_HOST')}`),
  approverEmails: list(env('APPROVER_EMAILS', '')),  // who may merge and bind repositories; empty: nobody
  agentLogin: optional('GITHUB_AGENT_LOGIN'),  // the App's bot user, mumbo-bot[bot]
  agentId: agentId(),  // its numeric user id, which approvals match; unset: the approvals poller is off
  requiredChecks: checkNames('REQUIRED_CHECKS', 'static,unit'),
  dailyTokensUser: Number(env('DAILY_TOKENS_USER', '20000000')),
  dailyTokensProject: Number(env('DAILY_TOKENS_PROJECT', '50000000')),
  projectTemplate: env('PROJECT_TEMPLATE', env('BOX_TEMPLATE', 'mumbo-box')),
  auditPrefix: env('AUDIT_PREFIX', 'audit/approvals/'),
  appId: optional('GITHUB_APP_ID'),
  appKey: optional('GITHUB_APP_KEY'),
  ntfyTopic: optional('NTFY_TOPIC'),
  // The sign-in page (authUi) is served only when set; SUPABASE_ANON_KEY, MUMBO_OAUTH_CLIENT_IDS and
  // MUMBO_OAUTH_REDIRECT_URIS (comma-separated, exact) are then required.
  supabaseUrl: optional('SUPABASE_URL'),
  oauthRedirectUris: optional('SUPABASE_URL') ? redirectUris('MUMBO_OAUTH_REDIRECT_URIS') : undefined,
  // The model host's OpenRouter route (OPENROUTER_PATHS): the exact model ids boxes may call, comma-separated; empty turns
  // the route off. OPENROUTER_API_KEY, from Secrets Manager mumbo-boxes/openrouter through the ECS secrets map, is then
  // required. OPENROUTER_ZDR=false allows endpoints that retain prompts; none may train on them (openrouterBody).
  openrouterModels: env('OPENROUTER_MODELS', '').split(',').map(s => s.trim()).filter(Boolean),
  openrouterKey: optional('OPENROUTER_API_KEY'),
  openrouterZdr: env('OPENROUTER_ZDR', 'true') !== 'false',
  // The most input tokens one image is charged when a box drops a response before its usage (openrouterBody
  // inputEstimate), and the charge for an image whose size cannot be read. Qwen-VL's own per-image maximum.
  openrouterImageTokens: atLeast('OPENROUTER_IMAGE_TOKENS', 0, 16384),
})

/** Address or @domain allowlist, lowercased (config()); an empty list admits nobody. The email compares lowercased. An
 *  @domain entry matches that exact domain only: @mumbo.si admits neither x@sub.mumbo.si nor x@evil-mumbo.si. An entry
 *  `!address` denies that exact address before any allow match. */
export const admitted = (allowed, email) => {
  email = email.toLowerCase()
  return !allowed.some(a => a.startsWith('!') && a.slice(1).toLowerCase() === email)
    && allowed.some(a => a === email || (a.startsWith('@') && email.endsWith(a)))
}

// ---- box tokens: HMAC(EDGE_SECRET) over {u: email, b: box id}. A token is honoured only while b is u's live box.
const mac = (key, body) => createHmac('sha256', key).update(body).digest('base64url')
export function signBox(key, email, boxId) {
  const body = Buffer.from(JSON.stringify({ u: email, b: boxId })).toString('base64url')
  return `mbx.${body}.${mac(key, body)}`
}
export function verifyBox(key, token) {
  if (typeof token !== 'string') return undefined
  const [prefix, body, sig, extra] = token.split('.')
  if (prefix !== 'mbx' || !body || !sig || extra !== undefined) return undefined
  const expected = Buffer.from(mac(key, body))
  if (Buffer.byteLength(sig) !== expected.length || !timingSafeEqual(Buffer.from(sig), expected)) return undefined
  try { return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) } catch { return undefined }
}
export const userPrefix = (email) => `users/${createHash('sha256').update(email.toLowerCase()).digest('hex')}`

// ---- per-user daily request budget (budget.mjs, with the token budget).
export { budget } from './budget.mjs'

/**
 * Where a box is served. A user's box is the site root with a desktop; a project box (principal `project:<id>`) is
 * the root of its own origin, p-<id>.<project domain>, so script it serves cannot drive the user's box, and has no
 * desktop: it never holds anyone's signed-in browser.
 */
// ---- project members (dsh @mumbo/edge-member). Each project box gets its own key, HMAC(edge key, "member:" + box id),
// as MUMBO_MEMBER_KEY (unpadded base64url of the 32 bytes); the edge signs x-mumbo-member with it on every request:
// <b64url email>.<expiry s>.<b64url HMAC-SHA256(key, "<b64url email>.<expiry>")>, valid 5 minutes.
export const memberKey = (edgeKey, boxId) => createHmac('sha256', edgeKey).update(`member:${boxId}`).digest()
export function memberHeader(key, email, now = Date.now()) {
  const body = `${Buffer.from(email.toLowerCase()).toString('base64url')}.${Math.floor(now / 1000) + 300}`
  return `${body}.${createHmac('sha256', key).update(body).digest('base64url')}`
}

/** The standing instructions for the box's agents (dsh agent-instructions, user-global chain). Edge-owned and
 *  rewritten on every start; the user's own instructions belong in $DSH_HOME/AGENTS.md. Founder decisions: account
 *  reads are free and writes ask; projects are shared and coordinated in their own box (ASSISTANT.md). */
export function roleInstructions(cfg, principal) {
  const project = principal.startsWith('project:') ? principal.slice('project:'.length) : undefined
  if (project) return [
    '# Project coordinator',
    '',
    `You coordinate the shared mumbo project ${project}. Its members reach you at ${boxSite(cfg, principal).publicUrl} and through their own assistants; a message relayed by an assistant starts with [from <email>].`,
    '',
    '- Keep the project in /root/projects. Run installs, builds, servers and tests in sandboxes (sandbox_* tools), not in this box.',
    '- Plan the work, report progress to the member who asked, and ask them when a decision or an account is needed.',
    '- You have no browser and nobody\'s accounts. When something needs an account, ask the member to have their assistant do it.',
  ].join('\n')
  return [
    '# Personal assistant',
    '',
    `You are the personal assistant of ${principal}, working on their own computer in the cloud (this box). Their files are in /root/projects.`,
    '',
    '- Browser: your browser tools drive the user\'s own Chromium, where they are signed in to their accounts. Reading pages, inboxes and feeds is fine.',
    '- Before anything that writes with one of their accounts (posting, sending, replying, buying, booking, deleting, changing settings), say exactly what you will do and wait for the user to agree, unless they have allowed that kind of action on that site; afterwards, say what you did.',
    `- Never type passwords or one-time codes. If a site needs a sign-in, ask the user to sign in on the desktop at https://${cfg.publicHost}/desktop/.`,
    '- Projects: software and other team work lives in shared projects, each with its own coordinator. Use project_list, project_create, project_add_member and project_message (to give a project\'s coordinator work or ask for status). Do not run project code in this box.',
    '- Sandboxes (sandbox_* tools) are for quick isolated experiments.',
    '- For anything recurring or later, use the schedule tools; the box runs them while the user is away.',
  ].join('\n')
}

/** Exists once a person box has given its first-run welcome, or had sessions before it (DESIGN.md#first-run-welcome). Under
 *  /root/.dsh, so backups carry it with the conversation that holds the welcome. */
export const WELCOMED = '/root/.dsh/welcomed'
/** The first-run welcome (spec section 17a, step 5), added to the person's first prompt in a new box (startScript). */
export function welcomeInstructions(cfg) {
  return [
    'This person\'s computer was just set up, and this is their first message. Before you answer it, greet them once, briefly:',
    '- what you can do now: use the web in their own browser (they sign in to sites on the desktop), work with files, run quick experiments in sandboxes, do recurring or later work on a schedule while they are away, and start projects of their own;',
    '- connecting their accounts comes later;',
    `- their computer's home page is https://${cfg.publicHost}/home.`,
    'Then answer their message.',
  ].join('\n')
}

export function boxSite(cfg, principal) {
  const id = principal.startsWith('project:') ? principal.slice('project:'.length) : undefined
  return id === undefined
    ? { host: cfg.publicHost, publicUrl: `https://${cfg.publicHost}/`, desktop: true }
    : { host: `p-${id}.${cfg.projectDomain}`, publicUrl: `https://p-${id}.${cfg.projectDomain}/`, desktop: false }
}

// ---- inside a box. It never sees a server secret: its DeepSeek key is its own box token, valid only via LLM_HOST.
// memberKeyText: a project box's member key (base64url). boxFiles: { proxy, gh }, the texts of box/github-local-proxy.mjs
// and box/gh as read by main() at start, written into project boxes. panelAdmins: the project owners' emails, for MUMBO_PANEL_ADMINS.
export function startScript(cfg, token, site = boxSite(cfg, ''), role = '', memberKeyText, boxFiles, panelAdmins = []) {
  const llm = `https://${cfg.llmHost}`
  // dsh's OpenRouter route (@deepseek-ai/dsh-llm-pi-ai, the base composition's row llm-pi-ai) through the model host,
  // keyed by the box token. Images leave 8 MiB of OPENROUTER_MAX_BODY for the text.
  const openrouter = cfg.openrouterModels?.length ? { displayName: 'OpenRouter', apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: `${llm}/openrouter/v1`, maxRequestImageBytes: 12 * 1024 * 1024,
    models: cfg.openrouterModels.map(id => ({ id, ...OPENROUTER_BOX_MODELS[id] })) } : undefined
  const b64 = (text) => Buffer.from(text).toString('base64')
  const sq = (text) => `'${text.replaceAll("'", `'\\''`)}'`
  return `#!/bin/sh
# Start dsh web for this box's user. Re-runnable: the router calls it again when dsh is found dead.
set -eu
pkill -f 'apps/cli/src/bin.ts' 2>/dev/null || true
ip=$(hostname -I | cut -d' ' -f1)
mkdir -p /root/projects /root/.dsh /root/.mumbo/agents
# This box's role (edge roleInstructions), read by dsh as the shared agents root's AGENTS.md.
cat > /root/.mumbo/agents/AGENTS.md <<'MD'
${role}
MD
# Child sandboxes over MCP on the model host, authenticated by this box's token (edge sandboxes.mjs).
cat > /root/.mumbo/sandboxes.overlay.yml <<'YML'
- insert:
    - id: mcp-sandboxes
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: sandboxes
        transport: streamable-http
        url: ${llm}/mcp
        headers:
          Authorization: !!js '\`Bearer \${process.env.DEEPSEEK_API_KEY}\`'
${site.desktop ? `    - id: browser-use
      name: '@deepseek-ai/dsh-browser-use'
` : ''}YML
${openrouter ? `# Image-capable models on OpenRouter (edge OPENROUTER_MODELS). A Session keeps the model it starts with.
cat > /root/.mumbo/models.overlay.yml <<'YML'
- id: llm-pi-ai
  config:
    providers: ${JSON.stringify({ openrouter })}
YML
` : ''}${site.desktop ? `# The user's Chromium for dsh's browser tools. With @mumbo/browser-consent in the image, writes on a site ask the
# person first; consent mounts the Playwright MCP provider itself, so the plain provider row is used only without it.
if [ -d /src/packages/mumbo/browser-consent ]; then
cat >> /root/.mumbo/sandboxes.overlay.yml <<'YML'
    - id: browser-consent
      name: '@mumbo/browser-consent'
      config:
        browser:
          mode: attach
          endpoint: http://127.0.0.1:9222
YML
else
cat >> /root/.mumbo/sandboxes.overlay.yml <<'YML'
    - id: browser-use-box-chromium
      name: '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp'
      config:
        mode: attach
        endpoint: http://127.0.0.1:9222
YML
fi
` : ''}# Sidebar links to the edge's home page and desktop (@mumbo/box-links), when the image ships that package.
LINKS_PATCH=
if [ -d /src/packages/mumbo/box-links ]; then
cat > /root/.mumbo/links.overlay.yml <<'YML'
- insert:
    - id: box-links
      name: '@mumbo/box-links'
      config:
        home: https://${cfg.publicHost}/home
${site.desktop ? `        desktop: https://${cfg.publicHost}/desktop/
` : ''}YML
LINKS_PATCH="--patch /root/.mumbo/links.overlay.yml"
fi
${site.desktop ? `# Desktop control on :1 (@deepseek-ai/dsh-computer-use-x11), when the image ships the package and xdotool.
CU_PATCH=
if [ -d /src/packages/experimental/computer-use-x11 ] && command -v xdotool >/dev/null 2>&1; then
cat > /root/.mumbo/computer.overlay.yml <<'YML'
- insert:
    - id: computer-use
      name: '@deepseek-ai/dsh-computer-use'
    - id: computer-use-x11
      name: '@deepseek-ai/dsh-computer-use-x11'
      config:
        display: ':1'
YML
command -v xauth >/dev/null 2>&1 && echo "        xauthority: /run/x11/auth" >> /root/.mumbo/computer.overlay.yml
CU_PATCH="--patch /root/.mumbo/computer.overlay.yml"
fi
` : ''}${site.desktop ? `# First-run welcome (edge welcomeInstructions): until ${WELCOMED} exists, a UserPromptSubmit hook creates it (noclobber,
# so exactly one prompt wins) and adds the welcome to that prompt. dsh reads AGENTS.md into every new session, so the
# role file cannot carry a once-only greeting. A box with any session log under dsh's sessions root has been used (a
# restart, or a restore from a backup taken before the marker existed): it is marked instead of welcomed.
if [ ! -e ${WELCOMED} ] && [ -n "$(find /root/.dsh/sessions -type f 2>/dev/null | head -n 1)" ]; then : > ${WELCOMED}; fi
WELCOME_PATCH=
if [ ! -e ${WELCOMED} ]; then
cat > /root/.mumbo/welcome.json <<'JSON'
${JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: welcomeInstructions(cfg) } })}
JSON
cat > /root/.mumbo/welcome-hooks.json <<'JSON'
${JSON.stringify({ UserPromptSubmit: [{ hooks: [{ type: 'command', command: `(set -C; : > ${WELCOMED}) 2>/dev/null && cat /root/.mumbo/welcome.json || true`, timeout: 10 }] }] })}
JSON
cat > /root/.mumbo/welcome.overlay.yml <<'YML'
- insert:
    - id: first-run-welcome
      name: '@deepseek-ai/dsh-hooks-claude-code'
      config:
        configPath: /root/.mumbo/welcome-hooks.json
YML
WELCOME_PATCH="--patch /root/.mumbo/welcome.overlay.yml"
fi
` : ''}${site.desktop ? `# Desktop: the user's own Chromium (signed-in accounts live in its profile) on a virtual display, as the unprivileged
# user browser; its debugging port stays on loopback for dsh's browser tools; noVNC on :6080 is the live view, which
# only the edge reaches (E2B traffic token). Re-runnable: each part starts only if it is not running.
if id browser >/dev/null 2>&1; then
  # E2B forwards every loopback port to the box address; the browser's debugging port and raw VNC stay box-local.
  for port in 9222 5900; do iptables -C INPUT -p tcp --dport $port ! -i lo -j DROP 2>/dev/null || iptables -I INPUT -p tcp --dport $port ! -i lo -j DROP || true; done
  # X access cookie, so only holders of /run/x11/auth (the browser user and root) can read or drive :1. su keeps the
  # environment, so every X client below inherits XAUTHORITY. Images without xauth run :1 without one, as before.
  XVFB_AUTH=
  if command -v xauth >/dev/null 2>&1; then
    mkdir -p /run/x11
    [ -s /run/x11/auth ] || { xauth -q -f /run/x11/auth add :1 . "$(mcookie)" 2>/dev/null; chown browser /run/x11/auth; chmod 600 /run/x11/auth; }
    export XAUTHORITY=/run/x11/auth
    XVFB_AUTH="-auth /run/x11/auth"
  fi
  export XVFB_AUTH
  pgrep -x Xvfb >/dev/null || { su browser -s /bin/sh -c 'Xvfb :1 $XVFB_AUTH -screen 0 1440x900x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &'; sleep 1; su browser -s /bin/sh -c 'DISPLAY=:1 openbox >/tmp/openbox.log 2>&1 &'; }
  pgrep -f 'remote-debugging-port=9222' >/dev/null || { rm -f /home/browser/profile/Singleton*; su browser -s /bin/sh -c 'DISPLAY=:1 chromium --user-data-dir=/home/browser/profile --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 --no-first-run --no-default-browser-check --password-store=basic --start-maximized >/tmp/chromium.log 2>&1 &'; }
  pgrep -x x11vnc >/dev/null || su browser -s /bin/sh -c 'x11vnc -display :1 -localhost -forever -shared -nopw -rfbport 5900 -quiet >/tmp/x11vnc.log 2>&1 &'
  pgrep -f websockify >/dev/null || nohup websockify --web /usr/share/novnc "$ip:6080" 127.0.0.1:5900 >/tmp/websockify.log 2>&1 &
fi
` : ''}${site.desktop ? '' : `# Project box: a TLS-terminating GitHub proxy on loopback (its own CA, trusted system-wide) aims git and gh at the edge's
# forwarder with this box's token (edge/box/github-local-proxy.mjs); dsh and its children reach GitHub only through it.
mkdir -p /root/.mumbo/ca /root/.mumbo/bin
# One start at a time: the router can re-run this script while a first run is still setting up the CA or the proxy.
(
flock 9
a=$(openssl x509 -noout -pubkey -in /root/.mumbo/ca/ca.crt 2>/dev/null || true)
b=$(openssl pkey -pubout -in /root/.mumbo/ca/ca.key 2>/dev/null || true)
if [ -z "$a" ] || [ "$a" != "$b" ]; then
  pkill -f github-local-proxy.mjs || true
  rm -rf /root/.mumbo/ca/leaf
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj /CN=mumbo-box -keyout /root/.mumbo/ca/ca.key.tmp -out /root/.mumbo/ca/ca.crt.tmp
  chmod 600 /root/.mumbo/ca/ca.key.tmp
  mv /root/.mumbo/ca/ca.key.tmp /root/.mumbo/ca/ca.key
  mv /root/.mumbo/ca/ca.crt.tmp /root/.mumbo/ca/ca.crt
  cp /root/.mumbo/ca/ca.crt /usr/local/share/ca-certificates/mumbo-box.crt
  update-ca-certificates
fi
echo ${b64(boxFiles.proxy)} | base64 -d > /root/.mumbo/bin/github-local-proxy.mjs
echo ${b64(boxFiles.gh)} | base64 -d > /root/.mumbo/bin/gh
chmod 0755 /root/.mumbo/bin/github-local-proxy.mjs /root/.mumbo/bin/gh
pgrep -f github-local-proxy.mjs >/dev/null || PORT=8899 CA_DIR=/root/.mumbo/ca EDGE_GITHUB_URL=${llm}/github BOX_TOKEN=${token} nohup node /root/.mumbo/bin/github-local-proxy.mjs >/root/github-proxy.log 2>&1 9>&- &
up=
for i in $(seq 20); do curl -s -o /dev/null -m 1 http://127.0.0.1:8899/ && up=1 || { [ $? -ne 7 ] && up=1; }; [ -n "$up" ] && break; sleep 0.5; done
[ -n "$up" ] || { echo 'github proxy did not start' >&2; exit 1; }
) 9>/root/.mumbo/ca.lock
`}${memberKeyText ? `# Project box: members sign in with the edge's x-mumbo-member header when the image ships the project overlay
# (@mumbo/edge-member); the marker tells the edge to use it instead of the owner launch token.
PROJECT_PATCH=
if [ -f /src/deploy/mumbo-project.overlay.yml ]; then PROJECT_PATCH="--patch /src/deploy/mumbo-project.overlay.yml"; touch /root/.mumbo/member-auth; else rm -f /root/.mumbo/member-auth; fi
export MUMBO_MEMBER_KEY=${memberKeyText}
` : ''}cd /src
${site.desktop ? '' : `PATH=/root/.mumbo/bin:$PATH NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.mumbo/ca/ca.crt HTTPS_PROXY=http://127.0.0.1:8899 NO_PROXY=127.0.0.1,localhost,${cfg.llmHost} MUMBO_PANEL_ADMINS=${sq(panelAdmins.map(e => e.toLowerCase()).join(','))} \\
`}HOME=/root DSH_HOME=/root/.dsh DSH_AGENTS_HOME=/root/.mumbo/agents DSH_TELEMETRY_DISABLED=1 \\
DEEPSEEK_BASE_URL=${llm}/anthropic DEEPSEEK_SEARCH_BASE_URL=${llm} DEEPSEEK_API_KEY=${token} \\
nohup node --import tsx/esm apps/cli/src/bin.ts --profile web \\
  --patch /src/deploy/mumbo.overlay.yml --patch /src/deploy/mumbo-personal.overlay.yml --patch /root/.mumbo/sandboxes.overlay.yml${openrouter ? ' --patch /root/.mumbo/models.overlay.yml' : ''} $LINKS_PATCH${site.desktop ? ' $CU_PATCH $WELCOME_PATCH' : ''}${memberKeyText ? ' $PROJECT_PATCH' : ''} \\
  --no-open --host "$ip" --port 3080 --public-url ${site.publicUrl} --trusted-host ${cfg.publicHost}${site.host === cfg.publicHost ? '' : ` --trusted-host ${site.host}`} > /root/dsh.log 2>&1 &
`
}
/** Write a `.snap` copy of every *.sqlite and *.db under .dsh and projects (the live files are WAL-mode and cannot be tarred consistently). Files with the SQLite header get VACUUM INTO
 *  and a failure aborts the backup; any other file is copied verbatim. */
const SNAPSHOT_JS = `const { DatabaseSync } = require("node:sqlite"), fs = require("fs"), path = require("path"), Q = String.fromCharCode(39)
const [home, out] = process.argv.slice(1)
for (const d of [".dsh", "projects"]) {
  if (!fs.existsSync(path.join(home, d))) continue
  for (const e of fs.readdirSync(path.join(home, d), { recursive: true, withFileTypes: true })) {
    if (!e.isFile() || !/\\.(sqlite|db)$/.test(e.name)) continue
    const src = path.join(e.parentPath, e.name), dst = path.join(out, path.relative(home, src) + ".snap")
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    const fd = fs.openSync(src, "r"), head = Buffer.alloc(16)
    fs.readSync(fd, head, 0, 16, 0)
    fs.closeSync(fd)
    if (head.toString("latin1") !== "SQLite format 3\\u0000") { fs.copyFileSync(src, dst); continue }
    const db = new DatabaseSync(src)
    db.exec("VACUUM INTO " + Q + dst.replaceAll(Q, Q + Q) + Q)
    db.close()
  }
}`
/** Upload chats, projects and the browser profile (signed-in accounts; caches and locks excluded) to a presigned S3 PUT. Runs inside the box; S3 refuses a streamed (chunked) body,
 *  so the archive goes to a temporary file first. SQLite databases travel as consistent `.snap` copies under root/.mumbo-sqlite. Extraction on restore also stays inside the box.
 *  `root` (default `/`) is the filesystem root, for tests. */
export const backupCommand = (url, root = '/') => {
  const r = root.replace(/\/+$/, ''), snap = `${r}/root/.mumbo-sqlite`
  return `set -e; f=$(mktemp /tmp/mumbo-backup.XXXXXX); trap 'rm -f "$f"; rm -rf '${snap}'' EXIT; rm -rf '${snap}'; node -e '${SNAPSHOT_JS}' '${r}/root' '${snap}'; tar -C '${root}' --exclude=node_modules --exclude='*.sqlite-wal' --exclude='*.sqlite-shm' ${['root/.dsh', 'root/projects'].flatMap((d) => ['*.sqlite', '*.db', '*-wal', '*-shm', '*-journal'].map((p) => `--exclude='${d}/${p}'`)).join(' ')} --exclude='home/browser/profile/Singleton*' --exclude='home/browser/profile/*/Cache' --exclude='home/browser/profile/*/Code Cache' --exclude='home/browser/profile/*/GPUCache' --exclude='home/browser/profile/*/Service Worker/CacheStorage' -czf "$f" $(cd '${root}' && ls -d root/.dsh root/projects root/.mumbo-sqlite home/browser/profile 2>/dev/null); curl -fsS -m 600 -X PUT -H 'content-type: application/gzip' --upload-file "$f" '${url}'; rm -rf '${snap}'`
}
/** Download and unpack a backup, then move each `.snap` back over its database path. Runs before dsh starts. */
export const restoreCommand = (url, root = '/') => {
  const r = root.replace(/\/+$/, ''), snap = `${r}/root/.mumbo-sqlite`
  return `set -e; curl -fsS -m 600 '${url}' | tar -C '${root}' -xzf -; if [ -d '${snap}' ]; then (cd '${snap}' && find . -name '*.snap' -type f) | while IFS= read -r p; do d='${r}/root/'"\${p#./}"; d="\${d%.snap}"; rm -f "$d-wal" "$d-shm" "$d-journal"; mv '${snap}'/"$p" "$d"; done; rm -rf '${snap}'; fi`
}

/** Prints the earliest next run (epoch ms) of the box's active dsh scheduled tasks, or nothing. Reads both storage
 *  backends (JSON file, SQLite table u_schedule_tasks); runs inside the box with its own Node. */
export const NEXT_WAKE_COMMAND = `node -e 'const fs=require("fs"),t=[];try{for(const v of Object.values(JSON.parse(fs.readFileSync("/root/.dsh/storages/schedule.json")).tables?.tasks??{}))t.push(v)}catch{}
try{const{DatabaseSync}=require("node:sqlite");for(const f of fs.readdirSync("/root/.dsh",{recursive:true}).filter(f=>/\\.db$/.test(f))){try{const db=new DatabaseSync("/root/.dsh/"+f,{readOnly:true});for(const r of db.prepare("select value from u_schedule_tasks").all())t.push(JSON.parse(r.value));db.close()}catch{}}}catch{}
const n=t.filter(x=>x.status==="active").map(x=>Date.parse(x.record?.scheduledAt)).filter(Number.isFinite).sort((a,b)=>a-b)[0];if(n)console.log(n)'`

/** Run fn over items with at most `limit` in flight. */
export async function inParallel(items, limit, fn) {
  const out = []
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]) }
  }))
  return out
}

// ---- the router's view of E2B. `e2b` is the SDK module and `store` the shared state (store.mjs); both are injected.
// A box record: { email, launch, traffic, active, extended, backedUp, paused }, plus { creating, first } until creation ends.
export function boxes({ e2b, store, cfg, edgeKey, presignGet, presignPut, boxFiles, log = console.log }) {
  const LOCK_MS = 120_000
  const CREATE_STALE_MS = 15 * 60_000  // longer than a restore (11 min cap) plus dsh start
  const say = (fields) => log(JSON.stringify({ edge: 'box', ...fields }))
  const run = (box, cmd, timeoutMs = 60_000) => box.commands.run(cmd, { timeoutMs }).then(r => r.stdout.trim())
  const timeout = () => cfg.idleMs + 15 * 60_000

  async function all(query) {
    const pager = e2b.Sandbox.list({ query })
    const found = []
    while (pager.hasNext) found.push(...await pager.nextItems())
    return found
  }
  async function find(email) {
    const found = await all({ metadata: { user: email }, state: ['running', 'paused'] })
    if (found.length > 1) say({ level: 'warn', msg: 'user has several boxes; using the oldest', user: email, ids: found.map(b => b.sandboxId) })
    return found.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)))[0]
  }
  async function launchToken(box) {
    for (let i = 0; i < 90; i++) {
      const out = await run(box, "grep -o 'token=[A-Za-z0-9_-]*' /root/dsh.log 2>/dev/null | tail -1 | cut -d= -f2 || true")
      if (out) return out
      await new Promise(r => setTimeout(r, 1000))
    }
    throw Object.assign(new Error('dsh did not start'), { status: 503 })
  }
  const memberAuth = async (box) => (await run(box, 'test -f /root/.mumbo/member-auth && echo yes || true')) === 'yes'
  const dshUp = async (box) => (await run(box, "curl -s -o /dev/null -m 5 -w '%{http_code}' http://$(hostname -I | cut -d' ' -f1):3080/ || true")) !== '000'

  async function create(email) {
    if (await atCapacity(e2b, cfg, UNITS.box)) throw Object.assign(new Error('capacity'), { status: 503, capacity: true })
    // Before the sandbox exists, so its `creating` record follows the create at once (adopt/backup race).
    const restoreUrl = await presignGet(`${userPrefix(email)}/latest.tar.gz`)
    const box = await e2b.Sandbox.create(email.startsWith('project:') ? cfg.projectTemplate : cfg.template, {
      timeoutMs: timeout(), metadata: { user: email },
      lifecycle: { onTimeout: 'pause', autoResume: true },
      network: { allowPublicTraffic: false, maskRequestHost: boxSite(cfg, email).host },
    }).catch((e) => { throw /place sandbox|capacity|too many|concurrent/i.test(e.message) ? Object.assign(e, { capacity: true, status: 503 }) : e })
    // Recorded before the restore: other replicas then neither adopt nor back up a box whose data is half restored.
    // `first`: no backup exists, so this is the person's first set-up (the edge pages say so).
    await store.putBox(box.sandboxId, { email, creating: Date.now(), first: !restoreUrl, active: Date.now(), extended: Date.now(), backedUp: Date.now(), paused: false })
    try {
      await box.files.write('/root/.mumbo/start.sh', startScript(cfg, signBox(edgeKey, email, box.sandboxId), boxSite(cfg, email), roleInstructions(cfg, email),
        email.startsWith('project:') ? memberKey(edgeKey, box.sandboxId).toString('base64url') : undefined, boxFiles,
        email.startsWith('project:') ? await ownersOf(store, email.slice('project:'.length)) : undefined))
      if (restoreUrl) {
        const ok = await run(box, restoreCommand(restoreUrl), 660_000).then(() => true, () => false)
        say({ msg: 'restore', user: email, box: box.sandboxId, ok })
      }
      await run(box, 'chmod +x /root/.mumbo/start.sh && /root/.mumbo/start.sh')
      const now = Date.now()
      await store.putBox(box.sandboxId, { email, launch: await launchToken(box), traffic: box.trafficAccessToken, memberAuth: await memberAuth(box), active: now, extended: now, backedUp: now, paused: false })
      say({ msg: 'created', user: email, box: box.sandboxId })
      return box.sandboxId
    } catch (error) {
      await box.kill().catch(() => {})  // nothing in it yet except the restored backup, which stays in S3
      await store.deleteBox(box.sandboxId)
      throw error
    }
  }

  /** The user's running box: id, dsh launch token and E2B traffic token. Creates, resumes or repairs as needed. */
  /** True while the person has no box and no backup, or their box is still its first creation (edge pages). */
  async function firstSetUp(email) {
    const found = await find(email)
    return found ? (await store.getBox(found.sandboxId))?.first === true : !(await presignGet(`${userPrefix(email)}/latest.tar.gz`))
  }
  async function ensure(email) {
    return store.withLock(`user:${email}`, LOCK_MS, async () => {
      const found = await find(email)   // an API error throws here: never create a second box on a failed lookup
      if (found === undefined) return pick(await create(email))
      const id = found.sandboxId
      const known = await store.getBox(id)
      // Another replica is still creating it (the user lock can expire during a long restore): wait, do not start it.
      if (known?.creating) throw Object.assign(new Error('box is being created'), { status: 503 })
      if (found.state === 'paused' || !known || known.paused || !known.launch) {
        try {
          const box = await e2b.Sandbox.connect(id, { timeoutMs: timeout() })
          if (!(await dshUp(box))) {
            say({ level: 'warn', msg: 'dsh down after resume; restarting', user: email, box: id })
            await run(box, '/root/.mumbo/start.sh')
          }
          const now = Date.now()
          await store.putBox(id, { email, launch: await launchToken(box), traffic: box.trafficAccessToken, memberAuth: await memberAuth(box), active: now, extended: now, backedUp: known?.backedUp ?? 0, paused: false })
        } catch (error) {
          // A snapshot that cannot be resumed (its node died before the upload finished, or dsh never comes back)
          // must not strand the user: drop it and rebuild from the latest S3 backup.
          if (error.capacity || /capacity|place sandbox|rate limit/i.test(error.message)) throw Object.assign(error, { capacity: true })
          say({ level: 'error', msg: 'resume failed; recreating from backup', user: email, box: id, error: error.message })
          await e2b.Sandbox.kill(id).catch(() => {})
          await store.deleteBox(id)
          return pick(await create(email))
        }
      }
      return pick(id)
    })
  }
  const pick = async (id) => {
    const b = await store.getBox(id)
    // A project box whose image runs @mumbo/edge-member: members get a signed header, never the owner launch token.
    const member = b.memberAuth ? (email) => memberHeader(memberKey(edgeKey, id), email) : undefined
    return { id, token: b.launch, traffic: b.traffic, ...(member ? { member } : {}) }
  }

  /** Record activity (a browser request, a WebSocket frame or a model call) and push E2B's own pause timer out. */
  async function touch(id) {
    const b = await store.getBox(id)
    if (!b) return
    const now = Date.now()
    const extend = now - b.extended >= 60_000
    await store.patchBox(id, extend ? { active: now, extended: now } : { active: now })
    if (extend) e2b.Sandbox.setTimeout(id, timeout()).catch(e => say({ level: 'warn', msg: 'timeout extension failed', box: id, error: e.message }))
  }
  /** True when `id` is `email`'s current, running box. Boxes unknown to the store are adopted from E2B. */
  async function owns(email, id) {
    const b = await store.getBox(id)
    if (b) return b.email === email && !b.paused
    const found = await find(email)
    if (found?.sandboxId !== id || found.state !== 'running') return false
    await store.putBox(id, { email, active: Date.now(), extended: 0, backedUp: 0, paused: false })
    return true
  }

  async function backup(id, b) {
    const url = await presignPut(`${userPrefix(b.email)}/latest.tar.gz`)
    const box = await e2b.Sandbox.connect(id, { timeoutMs: timeout() })
    await run(box, backupCommand(url), 660_000)
    await store.patchBox(id, { backedUp: Date.now() })
    say({ msg: 'backup', user: b.email, box: id })
  }
  /** Take over every running box E2B reports, so backups and idle pauses cover boxes no replica has seen. */
  async function adoptRunning(now = Date.now()) {
    for (const r of await all({ state: ['running'] })) {
      const email = r.metadata?.user
      if (!email || await store.getBox(r.sandboxId)) continue
      await store.putBox(r.sandboxId, { email, active: now, extended: 0, backedUp: 0, paused: false })
      say({ msg: 'adopted', user: email, box: r.sandboxId })
    }
  }
  /** One replica at a time (a store lease): back up active boxes every BACKUP_MINUTES; back up and pause idle ones. */
  async function sweep(now = Date.now()) {
    // The lease covers the whole run (released at the end), so replicas never overlap a long sweep.
    if (!(await store.lease('sweep', 15 * 60_000))) return
    try {
      await adoptRunning(now).catch(e => say({ level: 'warn', msg: 'adopt failed', error: e.message }))
      const listed = await store.listBoxes()
      // A create that never finished (its replica died mid-restore) holds only a partial restore: drop it so the
      // next visit restores again from the backup, which no backup of the partial box has overwritten.
      for (const b of listed.filter(x => x.creating && now - x.creating >= CREATE_STALE_MS)) {
        await e2b.Sandbox.kill(b.id).catch(() => {})
        await store.deleteBox(b.id)
        say({ level: 'warn', msg: 'dropped unfinished create', user: b.email, box: b.id })
      }
      const idle = (b) => cfg.pauseIdle !== false && now - b.active >= cfg.idleMs
      const due = listed.filter(b => !b.paused && !b.creating && (idle(b) || now - b.backedUp >= cfg.backupEveryMs))
      // Backups run in parallel (bounded) and take no user lock, so a long upload never blocks that user's visit.
      await inParallel(due, cfg.backupConcurrency ?? 8, b => backup(b.id, b).then(() => true, async (e) => {
        // A box E2B no longer has cannot be backed up again; its last backup stays the user's restore point.
        if (/not found/i.test(e.message)) { await store.deleteBox(b.id); say({ level: 'warn', msg: 'dropped missing box', user: b.email, box: b.id }); return false }
        await store.patchBox(b.id, { backedUp: now - cfg.backupEveryMs + 5 * 60_000 })  // retry in 5 minutes
        say({ level: 'error', msg: 'backup failed', user: b.email, box: b.id, error: e.message })
        return false
      }))
      for (const b of due.filter(idle)) await pauseIdle(b)
      // Never-pause mode: keep E2B's own timer (onTimeout: pause) from pausing a box nobody is using.
      if (cfg.pauseIdle === false) {
        await inParallel(listed.filter(b => !b.paused && !b.creating && now - b.extended >= 5 * 60_000), cfg.backupConcurrency ?? 8,
          b => e2b.Sandbox.setTimeout(b.id, timeout()).then(() => store.patchBox(b.id, { extended: now }), async (e) => {
            // A box E2B no longer has (killed outside the edge) is dropped; the next visit creates it from its backup.
            if (/not found/i.test(e.message)) { await store.deleteBox(b.id); return say({ level: 'warn', msg: 'dropped missing box', user: b.email, box: b.id }) }
            say({ level: 'warn', msg: 'keepalive failed', box: b.id, error: e.message })
          }))
      }
      for (const b of listed.filter(x => x.paused && x.wakeAt && x.wakeAt <= now + 60_000)) await wake(b, now)
    } finally {
      await store.release('sweep').catch(() => {})
    }
  }
  /** Resume a paused box for a scheduled task. dsh restarts: its timers ran on a clock that stood still while the
   *  box was paused, and a fresh start delivers every task already due. The box pauses again once idle. */
  async function wake(b, now) {
    await store.withLock(`user:${b.email}`, LOCK_MS, async () => {
      const box = await e2b.Sandbox.connect(b.id, { timeoutMs: timeout() })
      await run(box, '/root/.mumbo/start.sh')
      await store.patchBox(b.id, { paused: false, wakeAt: undefined, active: now, extended: now, launch: await launchToken(box), traffic: box.trafficAccessToken, memberAuth: await memberAuth(box) })
      say({ msg: 'woke for schedule', user: b.email, box: b.id })
    }).catch(e => say({ level: 'error', msg: 'wake failed', user: b.email, box: b.id, error: e.message }))
  }
  async function pauseIdle(b) {
    await store.withLock(`user:${b.email}`, LOCK_MS, async () => {
      // A paused box cannot run its scheduled tasks, so remember when the next one is due and wake the box then.
      const wakeAt = await e2b.Sandbox.connect(b.id, { timeoutMs: timeout() }).then(box => run(box, NEXT_WAKE_COMMAND, 30_000)).then(Number).catch(() => 0) || undefined
      await e2b.Sandbox.pause(b.id)
      await store.patchBox(b.id, { paused: true, wakeAt })
      say({ msg: 'paused', user: b.email, box: b.id, wakeAt: wakeAt && new Date(wakeAt).toISOString() })
    }).catch(async (e) => {
      // A box E2B no longer has is dropped; anything else is retried next sweep.
      if (/not found/i.test(e.message)) await store.deleteBox(b.id)
      say({ level: 'error', msg: 'pause failed', box: b.id, error: e.message })
    })
  }
  return { ensure, firstSetUp, touch, owns, sweep, adoptRunning, forget: (id) => store.patchBox(id, { launch: undefined }) }
}

// ---- who is asking. Behind oauth2-proxy (trial) the email header is trusted because only it can reach the router;
// behind an ALB with OIDC (production) the ALB's signed token is verified: ES256, key by kid from the regional
// endpoint, signer must be our ALB, not expired.
export function albIdentity({ albArn, region, fetchImpl = fetch, now = () => Date.now() }) {
  const keys = new Map()
  const b64 = (v) => Buffer.from(v.replace(/=+$/, ''), 'base64url')
  return async (token) => {
    if (typeof token !== 'string') return undefined
    const [h, p, sig, extra] = token.split('.')
    if (!h || !p || !sig || extra !== undefined) return undefined
    let header, payload
    try { header = JSON.parse(b64(h)); payload = JSON.parse(b64(p)) } catch { return undefined }
    if (header.alg !== 'ES256' || header.signer !== albArn || typeof header.kid !== 'string' || !/^[0-9a-f-]{36}$/.test(header.kid)) return undefined
    if (typeof header.exp === 'number' && header.exp * 1000 < now()) return undefined
    if (!keys.has(header.kid)) {
      const r = await fetchImpl(`https://public-keys.auth.elb.${region}.amazonaws.com/${header.kid}`)
      if (!r.ok) return undefined
      keys.set(header.kid, await r.text())
    }
    const ok = createVerify('SHA256').update(`${h}.${p}`).verify({ key: keys.get(header.kid), dsaEncoding: 'ieee-p1363' }, b64(sig))
    return ok && typeof payload.email === 'string' ? payload.email.toLowerCase() : undefined
  }
}

// ---- HTTP plumbing
const json = (res, status, value) => res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(value))
/** An edge page; `text` is HTML, so interpolated values go through esc(). A refreshing page reloads every 5 seconds. */
const page = (res, status, text, refresh = true) => res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...(refresh ? { refresh: '5' } : {}) })
  .end(`<!doctype html><meta charset="utf-8">${refresh ? '<meta http-equiv="refresh" content="5">' : ''}<title>mumbo</title><body style="font-family:system-ui;display:grid;place-items:center;min-height:90vh;margin:0"><p>${text}</p>`)
const DROP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'host', 'authorization', 'x-mumbo-member'])

/** Which box port a main-host request goes to: the desktop live view (noVNC, :6080) under /desktop/, otherwise dsh
 *  (:3080). The old project path /p/<id>/… redirects to the project's own origin (boxSite). */
export function boxRoute(url, projectDomain) {
  const p = /^\/p\/([0-9a-f]{16})(\/.*)?$/.exec(url)
  if (p) return { redirect: `https://p-${p[1]}.${projectDomain}${p[2] ?? '/'}` }
  if (url === '/desktop' || url === '/desktop/') return { redirect: '/desktop/vnc.html?autoconnect=1&resize=remote&path=desktop/websockify' }
  if (url.startsWith('/desktop/')) return { port: '6080', path: url.slice('/desktop'.length), base: '' }
  return { port: '3080', path: url, base: '' }
}
/** True when a cookie (`name=value…`, a Cookie pair or a Set-Cookie line) has a sign-in name: the name, the text before
 *  the first `=`, starts with cfg.signinCookie, which covers oauth2-proxy's <name>_0, _1… chunks and its
 *  <name>_<hash>_csrf cookies, or with oauth2-proxy's default name _oauth2_proxy, which browsers signed in before
 *  SIGNIN_COOKIE still hold. */
const isSignin = (cfg, cookie) => [cfg.signinCookie ?? SIGNIN_COOKIE, '_oauth2_proxy'].some(p => cookie.split('=')[0].trim().startsWith(p))
/** Headers for the box: client headers minus hop-by-hop, identity and E2B headers, plus E2B routing for this box only.
 *  The browser's Origin passes unchanged; dsh accepts it only when it equals the box's masked host (boxSite). */
export function boxHeaders(cfg, incoming, target, port = '3080') {
  const out = {}
  for (const [k, v] of Object.entries(incoming)) if (!DROP.has(k) && !k.startsWith('x-forwarded-') && !k.startsWith('e2b-')) out[k] = v
  // The sign-in cookie (oauth2-proxy) never reaches a box: a box that saw it could replay it as the signed-in person.
  // Every box request goes through here: HTTP, WebSocket upgrades and the relay (boxFetcher).
  if (out.cookie !== undefined) {
    const kept = [out.cookie].flat().join(';').split(';').map(c => c.trim()).filter(c => c && !isSignin(cfg, c))
    if (kept.length) out.cookie = kept.join('; '); else delete out.cookie
  }
  out.host = `sandbox.${cfg.publicHost}`
  out['e2b-sandbox-id'] = target.id
  out['e2b-sandbox-port'] = port
  if (target.traffic) out['e2b-traffic-access-token'] = target.traffic
  return out
}
export const esc = (v) => String(v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
/** The invite-only page text; names the domains the allowlist admits to join. */
export const inviteText = (allowed) => {
  const domains = allowed.filter(a => a.startsWith('@'))
  return `mumbo boxes are invite-only for now. This account is not on the list yet.${domains.length ? ` Anyone with an address at ${domains.map(esc).join(' or ')} can join.` : ''}`
}
/** The signed-in person's home: their assistant, their desktop and the shared projects they belong to. Edge-served,
 *  so it loads without starting any box. */
export function homePage(cfg, res, email, projects) {
  const rows = projects.length
    ? projects.map(p => `<li><a href="${esc(boxSite(cfg, `project:${p.id}`).publicUrl)}">${esc(p.name)}</a> <small>${esc(p.members.length)} member${p.members.length === 1 ? '' : 's'}${p.owner === email ? ', yours' : ''}</small></li>`).join('')
    : '<li><small>None yet. Ask your assistant to create one.</small></li>'
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>mumbo</title>
<style>body{font-family:system-ui;max-width:40rem;margin:3rem auto;padding:0 1rem;line-height:1.5}a{color:inherit}h1{font-size:1.4rem}h2{font-size:1rem;margin-top:2rem}ul{padding-left:1.2rem}small{color:#666}</style>
<h1>mumbo</h1><p><small>Signed in as ${esc(email)}</small></p>
<ul><li><a href="/">Your assistant</a></li><li><a href="/desktop/">Your desktop</a> <small>sign in to your accounts here</small></li></ul>
<h2>Projects</h2><ul>${rows}</ul>`)
}
/** One request from the edge itself to a box's dsh through the client-proxy, as a browser on the box's own origin
 *  (`siteHost`, boxSite) would send it. */
export const boxFetcher = (cfg) => (target, siteHost, path, { method = 'GET', headers = {}, body, member } = {}) => new Promise((resolve, reject) => {
  const req = httpRequest({ host: cfg.proxy.hostname, port: cfg.proxy.port, method, path,
    headers: { ...boxHeaders(cfg, { ...headers, origin: `https://${siteHost}`, ...(body ? { 'content-length': Buffer.byteLength(body) } : {}) }, target, '3080'), ...(member ? { 'x-mumbo-member': member } : {}) } }, (r) => {
    const chunks = []
    r.on('data', c => chunks.push(c)).on('end', () => resolve({ status: r.statusCode, setCookie: r.headers['set-cookie'] ?? [], body: Buffer.concat(chunks).toString() }))
  })
  req.setTimeout(60_000, () => req.destroy(new Error('box request timed out')))
  req.on('error', reject)
  req.end(body)
})
/** A Set-Cookie line's cookie name, trimmed: the text before the first `=` of its name=value pair. '' when the pair has
 *  no name or no `=`: a browser stores that cookie nameless and sends its bare value (RFC 6265bis), so the value of
 *  `=_oauth2_proxy_mumbo=V` arrives as a cookie named _oauth2_proxy_mumbo. */
const setCookieName = (line) => {
  const pair = line.split(';')[0]
  return pair.includes('=') ? pair.split('=')[0].trim() : ''
}
/** dsh listens on plain HTTP inside the box, so its cookies lack Secure; the edge adds it and drops any Domain. A box
 *  cookie with a sign-in name (isSignin) or no name is dropped: on the box's host it would shadow the visitor's sign-in. */
export const secureCookies = (cfg, headers) => {
  if (headers['set-cookie'] === undefined) return headers
  // Host-only: a box may not set a cookie for the parent domain, which other boxes and the sign-in share.
  const kept = headers['set-cookie'].filter(v => { const name = setCookieName(v); return name !== '' && !isSignin(cfg, name) }).map(v => v.replace(/;\s*domain=[^;]*/gi, '')).map(v => /;\s*secure/i.test(v) ? v : `${v}; Secure`)
  if (kept.length) headers['set-cookie'] = kept; else delete headers['set-cookie']
  return headers
}
/** No other origin may frame a page from a box: a project page could otherwise show, and clickjack, the visitor's
 *  signed-in desktop. A box's own frame-ancestors and X-Frame-Options are kept; a CSP without frame-ancestors gains ours. */
export const noFraming = (headers) => {
  headers['x-frame-options'] ??= 'SAMEORIGIN'
  const csp = headers['content-security-policy']
  if (csp === undefined) headers['content-security-policy'] = "frame-ancestors 'self'"
  else if (!/(?:^|[;,])\s*frame-ancestors(?:\s|;|,|$)/i.test(csp)) headers['content-security-policy'] = `${csp}; frame-ancestors 'self'`
  return headers
}
/** A browser with no dsh cookie and no token is sent to the token exchange, as nginx did for the shared server. */
export const needsLaunch = (req) => req.method === 'GET' && !/(?:^|;\s*)dsh-auth-/.test(req.headers.cookie ?? '') && !new URL(req.url, 'http://x').searchParams.has('token')
const isNavigation = (req) => req.method === 'GET' && String(req.headers.accept ?? '').includes('text/html')
/** The request's Host, lowercased and without a port. */
const hostOf = (req) => String(req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '')

/**
 * The Supabase sign-in and consent page (Supabase's OAuth authorization path /oauth/consent) and its scripts, for
 * visitors who are not signed in yet: oauth2-proxy skips sign-in for these GETs (prod/edge.tf; skippedSignin). `html` is
 * auth-ui/index.html; its inline script, style and event handler are allowed by hash. config.js carries the Supabase
 * URL and publishable key, and Mumbo's own OAuth client ids and redirect URIs, the only ones the page consents for
 * (consent.js). Returns a handler that answers and returns true for the page and its scripts, false for anything else.
 */
export function authUi({ html, supabaseJs, consentJs, supabaseUrl, anonKey, clientIds, redirectUris }) {
  const hashes = (re) => [...html.matchAll(re)].map(m => `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`).join(' ')
  const csp = [
    "default-src 'none'",
    `script-src 'self' ${hashes(/<script>([\s\S]*?)<\/script>/g)} 'unsafe-hashes' ${hashes(/\son[a-z]+="([^"]*)"/g)}`,
    `style-src ${hashes(/<style>([\s\S]*?)<\/style>/g)}`,
    `connect-src ${new URL(supabaseUrl).origin}`,
    "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
  ].join('; ')
  const js = 'text/javascript; charset=utf-8'
  const files = new Map([
    ['/auth-ui/supabase.js', [js, supabaseJs]],
    ['/auth-ui/config.js', [js, `const MUMBO = ${JSON.stringify({ url: supabaseUrl, anonKey, clientIds, redirectUris })}\n`]],
    ['/auth-ui/consent.js', [js, consentJs]],
  ])
  return (req, res) => {
    const file = req.url.split('?')[0] === '/oauth/consent' ? ['text/html; charset=utf-8', html] : files.get(req.url)
    if (!file) return false
    res.writeHead(200, { 'content-type': file[0], 'cache-control': 'no-store', 'content-security-policy': csp, 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' }).end(file[1])
    return true
  }
}

/** True for a request carrying X-Forwarded-Uri, which neither the ALB nor oauth2-proxy sets. oauth2-proxy skips sign-in
 *  for its skip-auth GETs (prod/edge.tf) and, with --reverse-proxy, for any GET whose client-sent X-Forwarded-Uri matches
 *  one of them, in later versions too. The ALB rule x_forwarded_uri refuses that header and is the hard stop; this check
 *  is defence in depth. oauth2-proxy strips client identity headers on every route and sets X-Forwarded-Email only from a
 *  session, so a request without it is signed out. Who may enter is decided here (admitted()), never by oauth2-proxy flags. */
const skippedSignin = (req) => req.headers['x-forwarded-uri'] !== undefined

/** Signed-in users' traffic. The public host reaches the user's own box and p-<16 hex>.<project domain> a project's
 *  box, for its members only; `approve` (approve-page.mjs) serves cfg.approveHost, an origin no box serves; any other host
 *  answers 404. `signin` (authUi) answers its GETs on the approve host before any identity check; GET /oauth/consent on
 *  the public host, which a box serves, redirects there. A request or upgrade skippedSignin flags gets 400 before all that. */
export function userServer({ cfg, box, verifyAlb, projects, approve, signin, log = console.log }) {
  const identify = async (req) => verifyAlb
    ? (await verifyAlb(req.headers['x-amzn-oidc-data']).catch(() => undefined)) ?? ''
    : String(req.headers['x-forwarded-email'] ?? '').toLowerCase()
  const pending = new Map()  // box key -> the in-flight ensure of this replica
  const SLOW = Symbol('slow')
  const quiet = (p) => { Promise.resolve(p).catch(() => {}) }
  // A project box is the root of its own origin (boxSite): every path on that host, /home included, goes to its dsh.
  // undefined: a host no box serves.
  const routeOf = (host, url) => {
    const label = host.endsWith(`.${cfg.projectDomain}`) ? host.slice(0, -cfg.projectDomain.length - 1) : ''
    const project = /^p-([0-9a-f]{16})$/.exec(label)?.[1]
    if (project) return { project, port: '3080', path: url, base: '' }
    if (host === cfg.publicHost) return boxRoute(url, cfg.projectDomain)
  }
  // An unexpected throw answers 500, or closes the upgrade, instead of leaving it open. The log has the path without the
  // query, which can carry a launch token.
  const failed = (req, e) => log(JSON.stringify({ edge: 'error', host: hostOf(req), path: String(req.url).split('?')[0], error: e.message }))
  const server = createServer((req, res) => onRequest(req, res).catch((e) => {
    failed(req, e)
    if (!res.headersSent) page(res, 500, 'Something went wrong. Reload to try again.', false); else res.destroy()
  }))
  server.on('upgrade', (req, socket, head) => {
    // The server leaves an upgrade's socket without an error listener; a client reset while the handler waits on
    // identity or a box would otherwise throw out of the process.
    socket.on('error', () => socket.destroy())
    onUpgrade(req, socket, head).catch((e) => { failed(req, e); socket.destroy() })
  })
  async function onRequest(req, res) {
    if (skippedSignin(req)) return json(res, 400, { error: 'bad request' })
    // The edge's own pages; a box's response replaces these through noFraming.
    res.setHeader('x-frame-options', 'SAMEORIGIN')
    res.setHeader('content-security-policy', "frame-ancestors 'self'")
    if (req.url === '/edge/healthz') return json(res, 200, { ok: true })
    // The sign-in page holds the visitor's Supabase session, so it lives on the approve host, an origin no box serves.
    if (signin && req.method === 'GET') {
      if (hostOf(req) === cfg.publicHost && req.url.split('?')[0] === '/oauth/consent') return res.writeHead(302, { location: `https://${cfg.approveHost}${req.url}`, 'cache-control': 'no-store' }).end()
      if (hostOf(req) === cfg.approveHost && signin(req, res)) return
    }
    const email = await identify(req)
    if (!email.includes('@')) return json(res, 401, { error: 'not signed in' })
    if (!admitted(cfg.allowed, email)) return page(res, 403, inviteText(cfg.allowed), false)
    const host = hostOf(req)
    if (host === cfg.approveHost && approve) return approve(req, res, email).catch((e) => {
      log(JSON.stringify({ edge: 'error', user: email, host, error: e.message }))
      if (!res.headersSent) page(res, 500, 'The approve page failed. Reload to try again.', false); else res.destroy()
    })
    const to = routeOf(host, req.url)
    if (!to) return page(res, 404, 'Not found.', false)
    if (!to.project && (req.url === '/home' || req.url === '/home/')) return homePage(cfg, res, email, await projects?.list(email) ?? [])
    if (to.redirect) return res.writeHead(302, { location: to.redirect, 'cache-control': 'no-store' }).end()
    // dsh refuses a cross-origin /api request itself; the desktop (websockify) checks no Origin, so anything but a read
    // must come from its own page.
    if (to.port === '6080' && req.method !== 'GET' && req.method !== 'HEAD' && req.headers.origin !== `https://${host}`) return page(res, 403, 'Forbidden.', false)
    if (to.project && !(await projects?.isMember(email, to.project))) return page(res, 403, 'No such project, or you are not one of its members.', false)
    let target
    const key = to.project ? `project:${to.project}` : email
    // The starting page for a person or project box that is not ready; a first set-up (no backup yet) says so.
    const starting = async () => page(res, 503, to.project ? "Starting this project's computer. This page reloads by itself."
      : await box.firstSetUp(email).catch(() => false) ? 'Setting up your computer, about a minute. This page reloads by itself.' : 'Starting your computer. This page reloads by itself.')
    try {
      let p = pending.get(key)
      if (!p) {
        p = box.ensure(key); pending.set(key, p)
        p.then(() => pending.delete(key), (e) => { pending.delete(key); log(JSON.stringify({ edge: 'error', user: email, project: to.project, error: e.message })) })
      }
      // A page load that waits on a box shows the starting page after cfg.pageAfterMs; reloads join the same ensure.
      target = isNavigation(req) ? await Promise.race([p, new Promise(r => setTimeout(r, cfg.pageAfterMs, SLOW).unref())]) : await p
      if (target === SLOW) return await starting()
    } catch (e) {
      return e.capacity ? page(res, 503, 'mumbo is at capacity right now. This page retries every few seconds.') : starting()
    }
    const dsh = to.port === '3080'
    // On a member-capable project box a member is themselves (signed header), never the box owner.
    const member = to.project && target.member ? target.member(email) : undefined
    const launch = `${to.base}/?token=${target.token}`
    if (dsh && !member && needsLaunch(req)) return res.writeHead(302, { location: launch, 'cache-control': 'no-store' }).end()
    quiet(box.touch(target.id))
    const up = httpRequest({ host: cfg.proxy.hostname, port: cfg.proxy.port, method: req.method, path: to.path, headers: { ...boxHeaders(cfg, req.headers, target, to.port), ...(member ? { 'x-mumbo-member': member } : {}) } }, (r) => {
      // A stale cookie (another account on this browser, or a recreated box) gets a fresh exchange instead of a dead end.
      if (dsh && !member && r.statusCode === 401 && isNavigation(req)) { r.resume(); return res.writeHead(302, { location: launch, 'cache-control': 'no-store' }).end() }
      res.writeHead(r.statusCode ?? 502, noFraming(secureCookies(cfg, { ...r.headers })))
      r.pipe(res)
    })
    up.on('error', (e) => { quiet(box.forget(target.id)); if (!res.headersSent) page(res, 502, 'Could not reach your box. Retrying…'); else res.destroy(); log(JSON.stringify({ edge: 'error', user: email, error: e.message })) })
    req.pipe(up)
  }
  async function onUpgrade(req, socket, head) {
    if (skippedSignin(req)) return socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    // As for HTTP, only the public host's and project hosts' WebSockets reach a box; the approve host and unknown hosts
    // are refused. So is an upgrade whose Origin is not this host (browsers always send one): the sign-in cookie covers
    // every subdomain, so a project page could otherwise open the visitor's desktop, whose noVNC checks no Origin.
    const host = hostOf(req)
    const to = routeOf(host, req.url)
    if (!to || req.headers.origin !== `https://${host}`) return socket.destroy()
    const email = await identify(req)
    if (!email.includes('@') || !admitted(cfg.allowed, email)) return socket.destroy()
    try {
      if (to.redirect || (to.project && !(await projects?.isMember(email, to.project)))) return socket.destroy()
      const target = await box.ensure(to.project ? `project:${to.project}` : email)
      quiet(box.touch(target.id))
      const member = to.project && target.member ? target.member(email) : undefined
      const headers = { ...boxHeaders(cfg, req.headers, target, to.port), ...(member ? { 'x-mumbo-member': member } : {}), connection: 'Upgrade', upgrade: req.headers.upgrade ?? 'websocket' }
      const up = httpRequest({ host: cfg.proxy.hostname, port: cfg.proxy.port, method: req.method, path: to.path, headers })
      up.on('upgrade', (r, upSocket, upHead) => {
        const lines = Object.entries(secureCookies(cfg, { ...r.headers })).flatMap(([k, v]) => [v].flat().map(x => `${k}: ${x}`))
        socket.write(`HTTP/1.1 101 Switching Protocols\r\n${lines.join('\r\n')}\r\n\r\n`)
        if (upHead.length) socket.write(upHead)
        if (head.length) upSocket.write(head)
        let last = 0
        socket.on('data', () => { const n = Date.now(); if (n - last > 30_000) { last = n; quiet(box.touch(target.id)) } })
        upSocket.pipe(socket).pipe(upSocket)
        upSocket.on('error', () => socket.destroy()); socket.on('error', () => upSocket.destroy())
      })
      up.on('response', (r) => { socket.end(`HTTP/1.1 ${r.statusCode} ${r.statusMessage}\r\n\r\n`) })
      up.on('error', () => socket.destroy())
      up.end()
    } catch { socket.destroy() }
  }
  return server
}

/** Model and search calls from boxes. Only paths dsh uses are forwarded; the box token is swapped for the server key. */
export const MODEL_PATHS = [/^\/anthropic\//, /^\/models$/, /^\/v1\/tools\//]
/** The OpenRouter route (OpenAI Chat Completions): method and path on the model host -> the fixed upstream URL. Served
 *  while cfg.openrouterModels names a model. */
export const OPENROUTER_PATHS = {
  'POST /openrouter/v1/chat/completions': 'https://openrouter.ai/api/v1/chat/completions',
  'GET /openrouter/v1/models': 'https://openrouter.ai/api/v1/models',
}
/** The only top-level request fields forwarded to OpenRouter: what dsh's pi-ai openai-completions provider sends for
 *  these models (pi-ai 1.3.0 buildParams) and standard sampling fields. Every other field, such as provider, models,
 *  plugins, route, transforms, preset or web_search_options, can change routing or cost and is dropped. */
export const OPENROUTER_FIELDS = ['model', 'messages', 'stream', 'stream_options', 'max_tokens', 'max_completion_tokens', 'temperature', 'top_p',
  'stop', 'seed', 'tools', 'tool_choice', 'parallel_tool_calls', 'response_format', 'reasoning']
/** Request body cap on the OpenRouter route (413 above it); images travel base64 in the JSON. Other model paths have no edge cap. */
export const OPENROUTER_MAX_BODY = 20 * 1024 * 1024
/** Box-side model fields on top of the installed pi-ai catalog, which supplies the rest (context window included); an
 *  allowlisted model without an entry takes the catalog's. */
const OPENROUTER_BOX_MODELS = {
  'qwen/qwen3.8-27b': { input: ['text', 'image'] },
  'qwen/qwen3.5-9b': { input: ['text', 'image'] },
}

/** Message fields forwarded on the OpenRouter route: those pi-ai's convertMessages writes (pi-ai 1.3.0). */
const MESSAGE_FIELDS = ['role', 'content', 'name', 'tool_calls', 'tool_call_id', 'reasoning', 'reasoning_content', 'reasoning_text', 'reasoning_details']
const ROLES = ['system', 'developer', 'user', 'assistant', 'tool']
/** Qwen-VL takes one token per 28x28 pixel patch. */
const PIXELS_PER_IMAGE_TOKEN = 28 * 28

/**
 * Pixel dimensions from the header of a base64 PNG, GIF, WebP or JPEG, or undefined when they cannot be read.
 * @param {string} base64 - image data; only its first 256 KiB are decoded
 * @returns {{ width: number, height: number } | undefined}
 */
export function imageSize(base64) {
  const b = Buffer.from(base64.slice(0, 256 * 1024), 'base64')
  const at = (i, n) => b.toString('latin1', i, i + n)
  if (b.length >= 24 && at(1, 3) === 'PNG') return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
  if (b.length >= 10 && at(0, 4) === 'GIF8') return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) }
  if (b.length >= 30 && at(0, 4) === 'RIFF' && at(8, 4) === 'WEBP') {
    const kind = at(12, 4)
    if (kind === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff }
    if (kind === 'VP8L') { const v = b.readUInt32LE(21); return { width: (v & 0x3fff) + 1, height: ((v >> 14) & 0x3fff) + 1 } }
    if (kind === 'VP8X') return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 }
    return undefined
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    // JPEG: walk the segments to the first start-of-frame marker (C0-CF except C4, C8 and CC).
    for (let i = 2; i + 9 <= b.length && b[i] === 0xff;) {
      const marker = b[i + 1]
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) }
      i += 2 + b.readUInt16BE(i + 2)
    }
  }
  return undefined
}

/**
 * The upstream body for a chat request on the OpenRouter route, or why it is refused (400). `model` must be one of
 * cfg.openrouterModels exactly. Each message keeps only MESSAGE_FIELDS and a known role; its `content` is a string,
 * null, absent, or an array of parts rebuilt from known keys: `{type: "text", text, cache_control?}` with a string
 * `text`, or `{type: "image_url", image_url: {url, detail?}}` with a `data:image/` URL, so the body cap bounds every
 * image and no paid file parser or remote fetch starts. Every tool is a `function` tool, and `tool_choice` is a string
 * or a function choice. Only OPENROUTER_FIELDS are kept; then the edge sets `stream: true` with `stream_options:
 * {include_usage: true}` (the token budget reads the final usage chunk; dsh always streams), `reasoning.exclude: false`
 * when reasoning is set (reasoning is reported, not hidden), and its own `provider`: `data_collection: "deny"`, plus
 * `zdr: true` unless cfg.openrouterZdr is false.
 * @param {object} cfg - config()
 * @param {Buffer} raw - the request body
 * @returns {{ error: string } | { body: string, model: string, inputEstimate: number }} `inputEstimate`, the input charged
 *   when a box drops the response before its usage: ceil(bytes without image data / 3) plus, per image, its pixels /
 *   PIXELS_PER_IMAGE_TOKEN from the image header, at most cfg.openrouterImageTokens (also charged when unreadable).
 */
export function openrouterBody(cfg, raw) {
  let body
  try { body = JSON.parse(raw) } catch { return { error: 'The request body is not JSON.' } }
  const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
  if (!isObject(body)) return { error: 'The request body must be a JSON object.' }
  if (!cfg.openrouterModels.includes(body.model)) return { error: `Model ${JSON.stringify(body.model)} is not offered; use one of ${cfg.openrouterModels.join(', ')}.` }
  if (!Array.isArray(body.messages)) return { error: 'messages must be an array.' }
  const images = []
  const part = (p) => {
    if (p?.type === 'text' && typeof p.text === 'string') return { type: 'text', text: p.text, ...(isObject(p.cache_control) ? { cache_control: { type: 'ephemeral' } } : {}) }
    const url = p?.type === 'image_url' ? p.image_url?.url : undefined
    if (typeof url !== 'string' || !url.startsWith('data:image/')) return undefined
    images.push(url)
    return { type: 'image_url', image_url: { url, ...(['low', 'high', 'auto'].includes(p.image_url.detail) ? { detail: p.image_url.detail } : {}) } }
  }
  const messages = []
  for (const m of body.messages) {
    if (!isObject(m) || !ROLES.includes(m.role)) return { error: `Each message needs a role: one of ${ROLES.join(', ')}.` }
    const out = Object.fromEntries(MESSAGE_FIELDS.filter(f => f in m).map(f => [f, m[f]]))
    if (Array.isArray(m.content)) {
      out.content = m.content.map(part)
      if (out.content.includes(undefined)) return { error: 'Message content parts may only be text with a string text, or image_url with a data:image/ URL.' }
    } else if (!(m.content === undefined || m.content === null || typeof m.content === 'string')) return { error: 'Message content must be a string, null or an array of parts.' }
    messages.push(out)
  }
  if (body.tools !== undefined && !(Array.isArray(body.tools) && body.tools.every(t => t?.type === 'function'))) return { error: 'tools must be an array of function tools.' }
  if (body.tool_choice !== undefined && typeof body.tool_choice !== 'string' && body.tool_choice?.type !== 'function') return { error: 'tool_choice must be a string or a function choice.' }
  const out = Object.fromEntries(OPENROUTER_FIELDS.filter(f => f in body).map(f => [f, body[f]]))
  out.messages = messages
  out.stream = true
  out.stream_options = { include_usage: true }
  if (out.reasoning !== undefined) out.reasoning = { ...(isObject(out.reasoning) ? out.reasoning : {}), exclude: false }
  out.provider = { data_collection: 'deny', ...(cfg.openrouterZdr ? { zdr: true } : {}) }
  const imageTokens = (url) => {
    const size = imageSize(url.slice(url.indexOf(',') + 1))
    return size ? Math.min(cfg.openrouterImageTokens, Math.ceil(size.width * size.height / PIXELS_PER_IMAGE_TOKEN)) : cfg.openrouterImageTokens
  }
  const imageBytes = images.reduce((n, url) => n + url.length, 0)
  return { body: JSON.stringify(out), model: out.model, inputEstimate: Math.ceil(Math.max(0, raw.length - imageBytes) / 3) + images.reduce((n, url) => n + imageTokens(url), 0) }
}

/** A request's body, or null once it passes `cap` bytes (the rest is left unread). Rejects when the client goes away first. */
const readBody = (req, cap) => new Promise((resolve, reject) => {
  if (req.destroyed) return reject(new Error('request aborted'))
  const chunks = []
  let size = 0
  req.on('data', (c) => {
    if (size > cap) return
    if ((size += c.length) > cap) { req.pause(); return resolve(null) }
    chunks.push(c)
  })
  req.on('end', () => resolve(Buffer.concat(chunks)))
  req.on('error', reject)
  req.on('close', () => { if (!req.complete) reject(new Error('request aborted')) })
})

// github (github.mjs), halt (halt.mjs) and tokens (budget.mjs tokenBudget) are optional like mcp: absent, /github/
// answers 404, nothing is halted and tokens are not counted. main() passes all of them.
export function modelServer({ cfg, edgeKey, modelKey, allow, owns, touch, mcp, github, halt, tokens, fetchImpl = fetch, log = console.log }) {
  if (cfg.openrouterModels?.length && !cfg.openrouterKey) throw new Error('edge: OPENROUTER_MODELS needs OPENROUTER_API_KEY')
  return createServer((req, res) => route(req, res).catch((e) => {
    log(JSON.stringify({ edge: 'error', path: req.url?.split('?')[0], error: e.message }))
    if (!res.headersSent) json(res, 502, { error: 'edge error' }); else res.destroy()
  }))
  async function route(req, res) {
    if (req.url === '/edge/healthz') return json(res, 200, { ok: true })
    // The last X-Forwarded-For entry is the one our load balancer appended; earlier entries come from the client.
    const source = String(req.headers['x-forwarded-for'] ?? '').split(',').at(-1).trim()
    if (cfg.egressIps.length > 0 && !cfg.egressIps.includes(source)) return json(res, 403, { error: 'box tokens work only from mumbo boxes' })
    const token = req.headers['x-api-key'] ?? String(req.headers.authorization ?? '').replace(/^Bearer /, '')
    const claim = verifyBox(edgeKey, token)
    if (!claim || !(await owns(claim.u, claim.b))) return json(res, 401, { error: 'invalid box token' })
    const path = new URL(req.url, 'http://x').pathname
    // Child sandboxes (sandboxes.mjs) for the same verified box; they count as activity but not against the model budget.
    if (path === '/mcp' && mcp) { Promise.resolve(touch(claim.b)).catch(() => {}); return mcp(req, res) }
    // GitHub for project boxes; the forwarder applies its own rules and the stop switch.
    if (path.startsWith('/github/') && github) return github(req, res, claim)
    const openrouter = cfg.openrouterModels?.length ? OPENROUTER_PATHS[`${req.method} ${path}`] : undefined
    if (!openrouter && !MODEL_PATHS.some(p => p.test(path))) return json(res, 404, { error: 'not found' })
    const started = Date.now()
    const logCall = (status, model) => log(JSON.stringify({ edge: 'model', user: claim.u, box: claim.b, path, ...(model ? { model } : {}), status, ms: Date.now() - started }))
    const cap = openrouter ? OPENROUTER_MAX_BODY : Infinity
    // Over the cap: answer and close the connection without reading on; a declared length is refused before any check.
    const tooLarge = () => {
      logCall(413)
      res.writeHead(413, { 'content-type': 'application/json', 'cache-control': 'no-store', connection: 'close' })
        .end(JSON.stringify({ error: { type: 'invalid_request_error', message: `Request bodies are limited to ${cap} bytes here.` } }), () => req.destroy())
    }
    if (Number(req.headers['content-length']) > cap) return tooLarge()
    if (halt && await halt.isHalted(claim.u)) return json(res, 503, { type: 'error', error: { type: 'api_error', message: 'Stopped by the founder' } })
    if (!(await allow(claim.u))) return json(res, 429, { type: 'error', error: { type: 'rate_limit_error', message: 'Daily model budget reached for this account.' } })
    if (tokens && !(await tokens.allow(claim.u))) return json(res, 429, { type: 'error', error: { type: 'rate_limit_error', message: `Daily token budget reached for ${claim.u}` } })
    Promise.resolve(touch(claim.b)).catch(() => {})
    const raw = await readBody(req, cap)
    if (raw === null) return tooLarge()
    let url = `${cfg.upstream}${req.url}`, init, forwarded
    if (openrouter) {
      const authorization = `Bearer ${cfg.openrouterKey}`
      if (req.method === 'GET') {
        const listed = await fetchImpl(openrouter, { headers: { authorization }, redirect: 'error' })
        logCall(listed.status)
        if (!listed.ok) return json(res, 502, { error: { type: 'api_error', message: `OpenRouter answered ${listed.status}` } })
        return json(res, 200, { data: ((await listed.json()).data ?? []).filter(m => cfg.openrouterModels.includes(m?.id)) })
      }
      forwarded = openrouterBody(cfg, raw)
      if (forwarded.error) { logCall(400); return json(res, 400, { error: { type: 'invalid_request_error', message: forwarded.error } }) }
      url = openrouter
      const headers = { 'content-type': 'application/json', authorization }
      // pi-ai's session affinity header, so OpenRouter keeps a Session on one provider (prompt cache). Never a box token.
      const session = req.headers['x-session-id']
      if (typeof session === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(session) && !session.startsWith('mbx.') && verifyBox(edgeKey, session) === undefined) headers['x-session-id'] = session
      init = { method: 'POST', headers, body: forwarded.body, redirect: 'error' }
    } else {
      const headers = {}
      for (const name of ['content-type', 'accept', 'anthropic-version', 'anthropic-beta', 'user-agent']) if (req.headers[name] !== undefined) headers[name] = req.headers[name]
      headers['x-api-key'] = modelKey
      headers.authorization = `Bearer ${modelKey}`
      init = { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : raw, redirect: 'error' }
    }
    const upstream = await fetchImpl(url, init)
    logCall(upstream.status, forwarded?.model)
    const out = {}
    for (const [k, v] of upstream.headers) if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'set-cookie'].includes(k)) out[k] = v
    res.writeHead(upstream.status, out)
    if (upstream.body === null) return void res.end()
    // An upstream error is not billed, so it carries no input estimate.
    const body = tokens ? tokens.meter(claim.u, upstream.body, upstream.headers.get('content-type'), upstream.ok ? forwarded?.inputEstimate : 0) : upstream.body
    // pipeline destroys the source when the client closes, so a dropped connection cancels the metered stream.
    pipeline(Readable.fromWeb(body), res, () => {})
  }
}

/** Files main() reads, by name, beside this module: the box/ texts for project boxes and the auth-ui/ sign-in page. */
export const runtimeFiles = () => ({
  proxy: new URL('./box/github-local-proxy.mjs', import.meta.url),
  gh: new URL('./box/gh', import.meta.url),
  html: new URL('./auth-ui/index.html', import.meta.url),
  supabaseJs: new URL('./auth-ui/supabase.js', import.meta.url),
  consentJs: new URL('./auth-ui/consent.js', import.meta.url),
})

/**
 * `node edge.mjs --check`, run by the Dockerfile: rejects unless this directory holds everything main() loads. It imports
 * every top-level .mjs except tests and e2e scripts, then every module those name in a dynamic import (main() loads its
 * own only after start), and reads every runtimeFiles() entry. A dynamic import whose argument is not a string literal
 * cannot be checked, so it fails the check.
 * @returns {Promise<string[]>} the modules imported.
 */
export async function imageCheck() {
  const own = readdirSync(new URL('.', import.meta.url)).filter(f => f.endsWith('.mjs') && !/\.(test|e2e)\.mjs$/.test(f)).map(f => `./${f}`)
  const dynamic = own.flatMap(m => [...readFileSync(new URL(m, import.meta.url), 'utf8').matchAll(/\bimport\(([^)]*)\)/g)].flatMap(([call, arg]) => {
    if (m === './edge.mjs' && arg === 'm') return []  // the loop below, which imports what this scan finds
    const literal = /^\s*(['"`])([^'"`$]+)\1\s*$/.exec(arg)
    if (!literal) throw new Error(`edge: ${m}: ${call} has no string literal argument, so the image check cannot import it`)
    return [literal[2]]
  }))
  const all = [...new Set([...own, ...dynamic])]
  for (const m of all) await import(m)
  for (const u of Object.values(runtimeFiles())) readFileSync(u)
  return all
}

// ---- process wiring: secrets come from SSM / Secrets Manager through the host's instance role.
async function main() {
  const cfg = config()
  const e2b = await import('e2b')
  const { createClient } = await import('redis')
  const { memoryStore, redisStore } = await import('./store.mjs')
  let store = memoryStore()
  if (process.env.REDIS_URL) {
    const client = createClient({ url: process.env.REDIS_URL })
    client.on('error', (e) => console.error('edge: redis', e.message))
    await client.connect()
    store = redisStore(client)
  }
  const { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } = await import('@aws-sdk/client-s3')
  const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner')
  const { SSMClient, GetParameterCommand } = await import('@aws-sdk/client-ssm')
  const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager')
  const region = env('AWS_REGION', 'us-east-1')
  const ssm = new SSMClient({ region })
  const edgeKey = (await ssm.send(new GetParameterCommand({ Name: env('EDGE_SECRET_PARAM', '/mumbo/boxes/edge-secret'), WithDecryption: true }))).Parameter.Value
  const modelKey = (await new SecretsManagerClient({ region }).send(new GetSecretValueCommand({ SecretId: env('MODEL_KEY_SECRET', 'mumbo/prod/deepseek-api-key') }))).SecretString
  const s3 = new S3Client({ region, requestChecksumCalculation: 'WHEN_REQUIRED' })  // presigned for curl, which sends no checksum
  const presignPut = (key) => getSignedUrl(s3, new PutObjectCommand({ Bucket: cfg.bucket, Key: key, ContentType: 'application/gzip' }), { expiresIn: 900 })
  const presignGet = async (key) => {
    try { await s3.send(new HeadObjectCommand({ Bucket: cfg.bucket, Key: key })) } catch (e) { if (e.name === 'NotFound') return undefined; throw e }
    return getSignedUrl(s3, new GetObjectCommand({ Bucket: cfg.bucket, Key: key }), { expiresIn: 900 })
  }
  const files = runtimeFiles()
  const read = (name) => readFileSync(files[name], 'utf8')
  // For project boxes' start script; read here so a missing file stops the edge at start.
  const boxFiles = { proxy: read('proxy'), gh: read('gh') }
  const box = boxes({ e2b, store, cfg, edgeKey, presignGet, presignPut, boxFiles })
  const verifyAlb = process.env.ALB_ARN ? albIdentity({ albArn: env('ALB_ARN'), region }) : undefined
  const listenHost = env('LISTEN_HOST', '127.0.0.1')  // beyond loopback only behind an ALB, where identity is the ALB token
  // The model host authenticates every call by box token and source address, so it may listen beyond loopback.
  const modelHost = env('MODEL_LISTEN_HOST', listenHost)
  setInterval(() => box.sweep().catch(e => console.error('edge: sweep', e.message)), 60_000).unref()
  if (listenHost !== '127.0.0.1' && !verifyAlb) throw new Error('edge: LISTEN_HOST beyond loopback needs ALB_ARN (the email header is only trusted from oauth2-proxy)')
  const { projects: projectStore, projectRelay } = await import('./projects.mjs')
  const proj = projectStore({ store, admitted: (e) => admitted(cfg.allowed, e) })
  const relay = projectRelay({ store, projects: proj, box, boxFetch: boxFetcher(cfg), siteHostOf: (p) => boxSite(cfg, p).host })

  // ---- approvals, stop switch, token budgets and the GitHub forwarder (design sections 5 and 12)
  const { budget, tokenBudget } = await import('./budget.mjs')
  const { haltService } = await import('./halt.mjs')
  const { ntfy } = await import('./notify.mjs')
  const { approvalsService } = await import('./approvals.mjs')
  const { approvePage } = await import('./approve-page.mjs')
  const { githubForwarder } = await import('./github.mjs')
  const now = () => Date.now()
  const halt = haltService({ store })
  const notify = ntfy({ topic: cfg.ntfyTopic, fetchImpl: fetch })
  // Every grant: one log line, then the record in the backup bucket (KMS by bucket default). A failed write rejects.
  const audit = async (record) => {
    const ts = now()
    const key = `${cfg.auditPrefix}${new Date(ts).toISOString().slice(0, 10)}/${record.id}-${ts}.json`
    console.log(JSON.stringify({ edge: 'audit', key, ...record }))
    await s3.send(new PutObjectCommand({ Bucket: cfg.bucket, Key: key, Body: JSON.stringify(record), ContentType: 'application/json' }))
  }
  const csrfKey = createHmac('sha256', edgeKey).update('approve-csrf').digest()
  const app = { appId: cfg.appId, privateKey: cfg.appKey }
  const approvals = approvalsService({ store, github: { app, agentId: cfg.agentId, requiredChecks: cfg.requiredChecks }, notify, audit, fetchImpl: fetch, now, approveHost: cfg.approveHost, approvers: cfg.approverEmails })
  const { installationOf } = await import('./github-app.mjs')
  const approve = approvePage({ approvals, halt, store, csrfKey, host: cfg.approveHost, approvers: cfg.approverEmails, installationOf: installationOf({ ...app, fetchImpl: fetch, now }) })
  const tokens = tokenBudget({ store, limits: { user: cfg.dailyTokensUser, project: cfg.dailyTokensProject }, now })
  const github = githubForwarder({ store, halt, app, fetchImpl: fetch, now })
  // One replica polls GitHub each minute: the 55 s lease lapses before the next tick. Off without GITHUB_AGENT_ID.
  if (cfg.agentId) {
    setInterval(() => store.lease('approvals:poll', 55_000).then(won => won && approvals.poll()).catch(e => console.error('edge: approvals poll', e.message)), 60_000).unref()
  }

  const values = (name) => {
    const v = env(name).split(',').map(s => s.trim()).filter(Boolean)
    if (v.length === 0) throw new Error(`edge: ${name} must name at least one value`)
    return v
  }
  const signin = cfg.supabaseUrl ? authUi({ html: read('html'), supabaseJs: read('supabaseJs'), consentJs: read('consentJs'), supabaseUrl: cfg.supabaseUrl,
    anonKey: env('SUPABASE_ANON_KEY'), clientIds: values('MUMBO_OAUTH_CLIENT_IDS'), redirectUris: cfg.oauthRedirectUris }) : undefined
  userServer({ cfg, box, verifyAlb, projects: proj, approve, signin }).listen(8080, listenHost, () => console.log(`edge: users on ${listenHost}:8080`))
  const { children, mcpServer } = await import('./sandboxes.mjs')
  const mcp = mcpServer({ ops: children({ e2b, cfg }), projects: proj, relay, projectDomain: cfg.projectDomain, claimOf: (info) => verifyBox(edgeKey, String(info?.headers.get('authorization') ?? '').replace(/^Bearer /, '')) })
  modelServer({ cfg, edgeKey, modelKey, allow: budget(store, cfg.dailyRequests), owns: box.owns, touch: box.touch, mcp, github, halt, tokens })
    .listen(8081, modelHost, () => console.log(`edge: model host on ${modelHost}:8081`))
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const run = process.argv[2] === '--check' ? imageCheck().then(m => console.log(`edge: image check passed (${m.length} modules)`)) : main()
  run.catch((e) => { console.error('edge: fatal', e); process.exit(1) })
}
