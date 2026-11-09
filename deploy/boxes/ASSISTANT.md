# mumbo boxes: personal assistant and project coordinator (stage 10 proposal)

Status: design, 2026-11-09; decisions taken (below). Builds on stages 8 (child sandboxes) and 9 (the box as the user's computer).

## What the user gets

- **One assistant per user,** always reachable at `app.mumbo.si`. It knows the user's accounts, files and projects, acts in the user's browser when permitted, and runs scheduled work while the user is away.
- **Projects,** each with its own coordinator agent and its own sandbox. The user asks the assistant ("start a landing page for X", "update the API project", "what's the status of everything?"); the assistant hands the work to the project's coordinator and reports back.

## Decisions (founder, 2026-11-09)

1. Project sandboxes persist: paused with memory when idle, backed up.
2. Several people may work on one project, so the coordinator placement is decided by the analysis below.
3. Account actions: reads are free; writes (post, send, buy, change settings) ask unless allowed for that site and kind.
4. Boxes never pause for now; cost optimization comes later.

## Shared projects: where the coordinator lives

**Requirements.** A project has several members, each with their own assistant and signed-in accounts. The coordinator must be shared and durable, reachable by every member and every member's assistant, attribute each request to its member, and never see any member's accounts or secrets. Losing or pausing one member's box must not stop the project.

| Option | Shared and durable | No member's accounts or secrets | Attribution | Verdict |
|---|---|---|---|---|
| A. In one member's box | No: the project depends on that box; others act through its owner | No: that box holds the owner's signed-in browser | Everyone appears as the owner | Rejected |
| B. In a project box: the same box template, owned by the project, running its own dsh as the coordinator | Yes: its own box, persisted, backed up | Yes: no browser profile, model access through the edge with a project token | The edge names the member on every message it relays | **Recommended** |
| C. A coordinator service inside the edge | Yes | Yes | Yes | Rejected: rebuilds an agent runtime outside dsh |

**Option B, modular:**
- **One box layer for two kinds of owner.** The edge keys boxes by principal, `user:<email>` or `project:<id>`, instead of by email. Create, resume, backup, wake and drain stay one code path; a project box uses the same template with a project overlay (coordinator preset, no browser).
- **Membership lives in the edge store:** project → members (owner or member). Members open `https://p-<id>.app.mumbo.si/` (`https://app.mumbo.si/p/<id>/` redirects there) and reach the project box's dsh directly; non-members get 403.
- **Assistants reach projects through edge tools** on the same MCP endpoint as stage 8: `project_list`, `project_create`, `project_message` and `project_status`. `project_message` relays the request into the coordinator's session. dsh supports this: the remote `session/prompt` call accepts a message for a session, and for a non-owner caller it records the caller as `principal` in the durable message source; `dsh-api-remote-access` grants non-owner principals roles per session (peer principals, `.agents/notes/implemented/architecture/2026-10-12-peer-principal-and-remote-access.md`). So members can be peers of the project's dsh with their own attribution, and the edge relays as the member.
- **Project work runs in project-owned sandboxes** (stage 8 tools scoped to the project), never in a member's box.
- **A member's assistant never gains the project's tools beyond messaging,** and the coordinator never gains a member's browser.

## Roles (single-member view; with option B the coordinator row moves into the project box)


| Role | Runs where | Has | Never has |
|---|---|---|---|
| **Assistant** | One durable dsh session in the user's box, the home session | Browser tools on the user's Chromium (signed-in accounts), schedule tools, a goal per standing task, subagent tools to start and message coordinators, read access to each project's status | Project code execution in the box beyond the user's own files |
| **Coordinator** (one per project) | A durable dsh subagent session in the user's box, started by the assistant (`subagent-spawn-in-process`, so it keeps its session for later messages) | The sandbox tools (stage 8) scoped to its project's sandbox, the team task board for that project, its own goal | Browser tools, the user's accounts, other projects' sandboxes |
| **Project sandbox** | An E2B sandbox outside the box (stage 8), one per project | The project's code, dependencies, running services | Any credential of the user's; anything outside its project |

Why the coordinator lives in the box and the code lives outside: one dsh per user keeps sessions, approvals and history in one place, while the code that installs packages and runs builds never shares a machine with the signed-in browser.

## Flows

1. **Start a project.** The user asks the assistant. The assistant spawns a coordinator subagent named after the project and messages it the brief. The coordinator calls `sandbox_create` with a project tag, sets up the repo, and reports progress to the assistant.
2. **Work on it.** The coordinator plans on its team board, runs commands and edits files in the project sandbox through the sandbox tools, and fans work out to extra short-lived sandboxes for parallel tasks (the 10-per-user cap of stage 8 applies across all projects).
3. **Status.** The assistant asks each coordinator, or reads their boards, and summarizes.
4. **Away from the keyboard.** A scheduled task on the assistant ("every morning, check the deploy and my inbox") wakes the box (stage 9 wake-on-schedule); the assistant does the work and leaves a summary for the next visit.
5. **Acting with an account.** The assistant uses the user's Chromium. Each action that posts, sends, buys or changes account settings asks the user first unless the user allowed that site and action kind; every such action is logged with site, action and outcome.

## What has to be built

| Piece | Where | Notes |
|---|---|---|
| Project sandboxes that persist | edge `sandboxes.mjs` | Today children are killed on timeout and not backed up. Projects need `project` metadata, pause instead of kill (`lifecycle.onTimeout: pause`), resume on use, and backups under `users/<hash>/projects/<id>/`. Short-lived helpers keep today's behavior. |
| Project-scoped sandbox tools | edge MCP | `project_create`, `project_list`, `project_open` (resume and return its id), plus the existing tools accepting a project id; a coordinator is given only its project. |
| Assistant preset | dsh overlay written by the box start script | Composes browser-use, schedule, goal, subagent with the in-process spawn provider, and a system prompt for the assistant role. |
| Coordinator preset | same overlay | Sandbox MCP tools, team board, goal; no browser-use. |
| Consent and audit | dsh approval answerer (in-box plugin) | Per-site, per-action-kind allow list; an audit line per account action. First verify what dsh approvals already ask for MCP browser calls (needs the DNS cutover to test in a real box). |
| Home view | web client | The assistant session first, a projects panel, a link to the desktop live view. |

Order: persistent project sandboxes and project tools (edge only, testable now) → presets (box start script) → consent → home view.

## Spec: project members as dsh principals (harness work, for mumbo-impl)

Today the edge relays a member's message as the project box's owner and names the member in the text. dsh already records a non-owner caller as `principal` on the durable message (`session/prompt`) and gates non-owner calls through `dsh-api-remote-access` ([peer principals note](../../.agents/notes/implemented/architecture/2026-10-12-peer-principal-and-remote-access.md)); its only non-owner kind is the liveshare `share-viewer`. Needed:

0. **Prerequisite, a harness design change:** `dsh-client-connection` admission is closed today. `admit()` (packages/client/connection/src/rpc-host.ts) returns the shared owner `browserPeer` for a valid dsh cookie or an owner API Peer, and nothing else; liveshare creates its `share-viewer` Peers through `connection.createPeer()` on its own relay channel, not on HTTP admission. A non-owner HTTP principal therefore needs a new admission seam in Connection (for example an authenticator registry consulted before cookie auth, each returning a Peer for a principal kind), with its Agent Note, README and real-composition tests.
1. **Principal kind `edge-member { email }`**, admitted through that seam when a request carries an edge-signed identity header (`x-mumbo-member: <email>.<expiry>.<HMAC(edge key)>`); the box gets the verifying key through its start script (it already holds a box token signed with the same edge key, so a separate member key derived per box is preferable). Unsigned, expired or foreign-box headers fall back to ordinary cookie auth, never to a member.
2. **A remote-access policy for `edge-member`** granting the session roles a collaborator needs (list, read, follow, prompt, create) on every session in the project box; no settings, credentials, plugin or workspace-admin actions.
3. **Edge:** for project paths, send the member's signed header on every proxied request and on `project_message`, instead of using the owner cookie; the coordinator then sees `principal: edge-member{email}` on each message.
4. **Tests (harness rules):** a real-composition test booting a test `cordis.yml` with the plugin: signed header admits the member and records `principal` on a prompt; tampered, expired and missing headers do not; the member cannot call a settings method. Edge unit test for header signing.
