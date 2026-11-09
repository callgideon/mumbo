# Handoff to mumbo-impl: the dsh changes the per-user box platform still needs

From the boxes session, 2026-11-09. The infrastructure (stages 4–10 in `PRODUCTION.md`) is live in AWS account 641134885443; the remaining work is in dsh itself. Read `PRODUCTION.md` (stage table), `ASSISTANT.md` (assistant and shared-project design, founder decisions) and `RUNBOOK.md` first. Branch with all of this: `boxes/production` (not merged yet).

## What exists (do not rebuild)

- **Boxes:** each signed-in user gets an E2B Firecracker VM running `dsh web` (template `mumbo-box`: the `mumbo-web-prod` image plus Xvfb, openbox, Chromium as user `browser`, noVNC). Boxes never pause for now (founder decision). Code: `deploy/boxes/edge/edge.mjs` (router, model host, box lifecycle), `store.mjs`, `sandboxes.mjs` (child sandboxes over MCP), `projects.mjs` (shared projects, relay).
- **The box start script** (`startScript` in `edge.mjs`) runs dsh with `--patch /src/deploy/mumbo.overlay.yml --patch /src/deploy/mumbo-personal.overlay.yml --patch /root/.mumbo/sandboxes.overlay.yml` (the last one is written by the script: `dsh-mcp-client` against `https://llm.app.mumbo.si/mcp`, or `llm.boxes.mumbo.si` in boxes created before the public host moved to `app.mumbo.si`, and in person boxes `dsh-browser-use` with the playwright-mcp provider in `attach` mode on `http://127.0.0.1:9222`). The role instructions are an edge-owned `AGENTS.md` under `DSH_AGENTS_HOME=/root/.mumbo/agents`.
- **Shared projects:** a project is its own box (principal `project:<id>`, served at `/p/<id>/`, own masked host `p-<id>.app.mumbo.si`). The edge relays a member's message into the coordinator session over dsh's unary RPC: `POST api/session/prompt` with `{ type: 'client-request', rpcId, method, payload: { args: { request } } }`, after signing in with the box's launch token. The member is named in the message text (`[from <email>] …`).
- **PR #14** (`fix/schedule-wall-clock-recheck`): dsh's scheduler re-reads wall time every 60 s so a task due while a box was paused fires within a minute of waking. Open, awaiting the founder's review.

## How a dsh change reaches the boxes

dsh changes land through a PR to `main` (prod); the founder merges and deploys. The box template is built from the `mumbo-web-prod` ECR image (`b366240c09` today) with `deploy/boxes/edge/template.mjs <image> mumbo-box 4096`; a user gets a new template when their box is next created. Rebuilding the template needs tunnels into the private E2B (below). Never deploy unmerged code to prod.

## Testing against the live platform

- `deploy/boxes/prod/check/tunnel.sh up|down`: SSM port forwards through a sandbox node to E2B (api `localhost:13000`, client-proxy `localhost:13002`) with a temporary security-group rule; always run `down` afterwards. Env for the E2B SDK: `E2B_API_URL=http://localhost:13000 E2B_SANDBOX_URL=http://localhost:13002 E2B_API_KEY=$(aws secretsmanager get-secret-value --secret-id mumbo-boxes/e2b --query SecretString --output text | jq -r .TEAM_API_KEY)`.
- `deploy/boxes/edge/project.e2e.mjs`: a local edge against real E2B: project box, sign-in, page, WebSocket, relay, role. A copy of it is the fastest way to try a dsh change inside a real box (create a box from a template built with your image).
- Browser tests go through the public name, `https://app.mumbo.si`; boxes reach the model through `llm.app.mumbo.si`.

## The work

### 1. Project members as dsh principals (spec: `ASSISTANT.md`, "Spec: project members as dsh principals")

The coordinator should see who said what, and members should act in the project box as themselves. `dsh-client-connection` admission is closed today: `admit()` (`packages/client/connection/src/rpc-host.ts`) returns the shared owner `browserPeer` for a valid cookie or an owner API Peer, nothing else. Needed: an admission seam in Connection for additional authenticators (each returns a Peer for a principal kind), a principal kind `edge-member { email }` admitted from an edge-signed header, a `dsh-api-remote-access` policy granting members session roles (list, read, follow, prompt, create; no settings, credentials or plugins), and real-composition tests (signed header admits and is recorded as `principal` on a prompt; tampered, expired and missing headers do not; no settings access). This is a harness design change: write the Agent Note. The edge side (sending the signed header on `/p/<id>/` requests and in `project_message`, and the box getting the verifying key) is small; ask the boxes session or do it in `edge.mjs`.

### 2. Consent for account writes (founder: reads free, writes ask)

Today the assistant's role text tells it to ask before writing with an account; nothing enforces it. First verify, in a real box, whether dsh's approval policy (`approval: ask` in `deploy/mumbo.overlay.yml`) already asks for the playwright-mcp browser tools. If it does not, enforce "reads free, writes ask" in an approval answerer or permission rule for browser tools: navigation, reading and snapshots pass; clicks, typing, form submission and uploads on a site ask unless the user allowed that site; every allowed write is logged (site, action, outcome) where the user can see it.

### 3. Linux computer use

dsh's computer-use provider is macOS-only (`packages/experimental/cua-macos`). Boxes have an X display (`DISPLAY=:1`, Xvfb 1440×900, openbox) with the user's Chromium; a Linux provider (screenshots and input on `:1`, for example via `xdotool` and `import`/`scrot`, which the template can install) lets the assistant operate desktop apps, not only the browser. Lower priority than 1 and 2.

### 4. A web-app link to the home page and desktop

The edge serves `https://app.mumbo.si/home` (assistant, desktop, projects) and `/desktop/` (live view). A small entry in the dsh web UI (for example in the sidebar, only when served behind the mumbo edge) would make them reachable from the app.

## Rules carried over

- Commits: `LEFTHOOK=0 git commit`, ending with the `Co-Authored-By` and `Claude-Session` lines for your own session; PR bodies follow the `dsh-pr-description` skill (Issues are disabled in this fork, so state that in Motivation) and end with the Claude Code line and your session URL.
- No force push, no reset of `main`, `dev` or `master`. Secrets stay in SSM or Secrets Manager; never print them.
- No DeepSeek contact except `api.deepseek.com` for inference, and that is temporary.
- The founder merges PRs and deploys `mumbo-web-prod`; the auto-mode classifier blocks those for agents. Terraform and image pushes for `deploy/boxes/prod` the agent runs itself.
