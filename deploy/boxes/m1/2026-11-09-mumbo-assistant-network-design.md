# Mumbo personal assistant: node network and assistant brain (design v2)

Date: 2026-11-09, revision 2.1 (revision 2 plus the founder's answers to its open decisions). Updated 2026-11-10 with the north star (section 1), the person's computer (section 17b) and regions (section 17c). Covers parts **A** (the network of nodes) and **B** (the assistant's brain). Part **C** (the founder's accounts in the box: WhatsApp, email, browser, consent) and part **D** (teammates' assistants, phone number, the assistant's own WhatsApp number) get their own designs later.

Marks: **[founder]** = decided by the founder. **[my call]** = decided by the designer; the founder may overturn it. Unmarked = context or a requirement that follows from the above.

This revision follows a critical review (`mumbo-design-review.html`). The review checked v1 against four things: the superagent source, this repository, the box plan on `origin/boxes/production`, and jumbo. This revision also aligns with the stage 10 decisions in `deploy/boxes/ASSISTANT.md`, written on 2026-11-09 after v1.

## Founder's answers (revision 2.1) **[founder]**

- **Claude workers inside sandboxes are not built for now.** The platform comes first: workers run on mumbo's own model.
  - Claude subscriptions are used in one way: the founder's own Claude Code sessions, signed in by the founder, join as external workers through the door. Mumbo never holds a Claude token.
- **jumbo is dead.** Mumbo takes over: copy its key model and tool names into the edge, with no runtime dependency on jumbo.
- **Branch rules on `callgideon/mumbo` wait until public launch.** Until then the edge GitHub proxy is the enforcement (section 9).

## What changed from v1

- **Coordinators run in their own project box**, each with its own dsh process (ASSISTANT.md option B). They are no longer extra instances inside the founder's box.
  - This drops v1's multi-instance and process-wide-environment changes to superagent.
  - It also keeps project code away from the signed-in browser, which stage 9 already put in the founder's box.
- **The edge enforces approvals, outside every box.** A box can request an approval but never grant one.
  - v1's "only the founder in the Web client" could not be enforced: any process in the box can drive the box's dsh and superagent's local API.
- **Merge approvals bind to an exact head commit.** The edge computes the low-risk rule from facts it can check itself.
  - v1's rule depended on GitHub review approvals, which never exist in this setup.
- **New sections:** trust boundaries and untrusted input; liveness and recovery; budgets and a "Stop everything" switch; the self-upgrade path; data classes; quality metrics.
- **The MCP door moves to the edge.** Today nothing outside can reach a box with a bearer key.
  - Its verbs map onto tool names that already exist, and answers come back by long-poll.
- **M1 runs on production boxes** (`boxes.mumbo.si`). They already have 4 GiB boxes, child sandboxes, the desktop and wake-on-schedule.
  - Milestones are cut smaller, and budgets and the stop switch land before workers fan out.
- **Superagent's Outbox approval gate moves to part C.** Nothing in M1–M6 sends as the founder.

## 1. Intent

The founder runs several projects in parallel and loses context between them. The product is a personal AI assistant that the founder only feeds raw context and asks for updates. It runs every project through a hierarchy of agents and comes back only when a decision or approval is needed. **[founder]**

Hierarchy **[founder]**: founder → personal assistant → project coordinators → (task coordinators when a project needs them) → worker agents.

The founder is the first and design-target user. Their current projects **[founder]**:
- **mumbo:** this repository. Goal: make it build itself, driven by many Claude accounts.
- **whiteboard:** the company mono-repo, with Scion-based source control for parallel agents.
- **bitlane:** model inference. For example, a customer wants a Gemma 4 endpoint, and B300 procurement is blocked on the co-founder.
- **openinfrx:** the open kernel challenge. It competes with bitlane for compute.
- **admin:** incorporation, invoices and compliance work, buried in email.

### North star: one OS **[founder: 2026-11-10]**

> "mumbo would replace comet / local browser / local ai tools and coding agents / everything - it would be one OS - with local native performance - always on / running on cloud"

What this means for the design **[my call on the wording; founder on the direction]**:
- **Mumbo is the person's one OS.** Their browser, their AI assistant and their coding agents live in one place.
- **The cloud box is the always-on source of truth.** It keeps working while the person's laptop sleeps: Mumbo, schedules, the box's browser and project work all run there.
- **The desktop app is the native-performance front end.**
  - It uses local compute wherever that improves the feel, with state kept in step with the box: a local browser engine, and local rendering of the client.
  - The box's own Chrome stays the browser the assistant automates.
- **The browser must feel native.** A streamed remote desktop can be made smooth (section 17b) but never native, so native feel comes from the desktop app's local browser.

Milestones toward it. These run alongside M1–M6 and don't widen M1:

| Step | Contents | Done when |
|---|---|---|
| **N1** the person's computer (sections 17b, 17c) | Mumbo, the always-present assistant session; a smooth, complete desktop with Google Chrome; Browser and Desktop tabs in the app; the box in the person's region | The founder works from India in Mumbo and their box's Chrome and calls it smooth |
| **N2** desktop app as the client | `apps/desktop` connects to the person's box as its host (signed in through the edge) instead of running dsh locally. Its Browser tab is a local browser engine (the app's own Chromium, which its stock Browser tab already uses on the desktop), kept in step with the box's Chrome | Everyday browsing in the desktop app is as fast as a local browser, and the assistant still works in the box's Chrome while the laptop sleeps |
| **N3** coding agents in one place | Local Claude Code and Codex sessions attach to mumbo through the MCP door (M3); agents that run in the box follow section 8.1 | A local Claude Code session takes a Mumbo Ticket and reports back into Mumbo |
| **N4** handoff | Open work moves between the laptop and the box: when the laptop sleeps, Mumbo and the box's Chrome carry on; when it wakes, the app shows what happened (the digest, M4) | The founder closes the laptop mid-task and finds the task done on reopening |

What can be kept in step between the local browser and the box's Chrome is being researched (2026-11-10): Chrome Sync, cookies, Device Bound Session Credentials, and WhatsApp linked devices. So is the fastest VM instance type and guest OS. N2's design waits for that research; N1 does not.

### Success **[founder]**

1. The founder rarely has to look into any project.
2. The founder always has a clear view of how work is progressing.
3. Logistics are handled; the founder sees only approvals.

### How success is measured **[my call]**

| Measure | Wanted | Source |
|---|---|---|
| Founder visits to project sessions per week | Falling | Edge access log |
| Approvals per day; median wait | Few; minutes | Edge approval store |
| Dumps filed to the wrong project | Fewer than 1 in 10 | Assistant log ("wrong project" taps) |
| Time from idea to merged PR | Falling | Ticket records |
| Merged PRs later reverted | Fewer than 1 in 20 | GitHub |
| Tickets past their clock; missed deadlines | Zero | Ticket records |
| Model and compute spend per day, per node | Within budget | Edge ledger |

These are collected from M1 on.

### Anti-goals (a failure even if it technically works)

- The founder checks projects "just to be sure" because updates are unreliable. **[my call]**
- The approval queue becomes a dreaded second inbox. **[my call]**
- Something falls through the cracks unnoticed, such as a missed filing or a forgotten follow-up. **[my call]**
- Spend runs away overnight, or the assistant has no budget left in the morning. **[my call]**
- Anything is sent as the founder without approval. **[founder]**
- A new visual language that differs from the existing dsh Web client. **[founder]**
- Everyday browsing in mumbo feels slower than in the person's own local browser. **[founder: "local native performance"]**

## 2. Principles and constraints

- **Everything is a plugin** inside dsh. Where something cannot be a plugin, first analyze the minimum harness extension that would let it be one, and add only that. **[founder]**
  - The edge (`deploy/boxes/edge`, mumbo's router service) is infrastructure, not dsh.
  - This design adds to the edge only what a box cannot be trusted with: approval authority, tokens, budgets, and the external door. **[my call]**
- **The UI stays consistent with the existing dsh Web client:** its tokens, components and patterns (`packages/client/ui-theme`, `ui-primitives`, `ui-sidebar`, `ui-workspace`, `ui-approval`, and the TaskManagerPage layout from `ui-schedule`). **[founder]**
- **Repository rules in `AGENTS.md` apply.** Notably: model-visible ⟺ logged; registrations are effects; misconfiguration fails loud; snapshots for user-visible changes; docs with every change.
- **Mumbo standing rules apply:**
  - the only DeepSeek contact is `api.deepseek.com` for inference, and only for now;
  - no secret enters a box (the edge proxies model calls);
  - new code passes `scripts/mumbo-egress-check.ts`.
- **Deployment target:** production boxes on self-hosted E2B (`boxes.mumbo.si`; PRODUCTION.md stages 1–9 are live), with stage 10 following ASSISTANT.md. The trial host stays for experiments.

### Trust boundaries **[my call]**

- **Authority is enforced in only two places: the edge, and GitHub's branch rules.**
  - For approval purposes, everything inside a box or sandbox counts as possibly compromised: dsh, superagent, the model and workers. Agent-run code and model-read content both live there.
  - Evidence: dsh's launch token sits in `/root/dsh.log`, superagent's local API only checks request headers, and shell tools run as root.
- **The founder's box** holds the signed-in browser (stage 9). No project code runs there.
  - **Consent for account writes must be enforced outside the agent's reach (part C requirement).**
    - Today the assistant has a root shell, so it can drive Chromium's CDP port (127.0.0.1:9222) directly, and "writes ask" is advisory.
    - Direction: the agent's shell runs as a non-root user with no route to CDP. Chromium and the browser-use MCP run as their own user. An owner-match firewall rule admits only that MCP process to CDP, and the MCP process enforces consent.
- **A project box** holds one project's code and a project token. It holds no person's accounts or secrets.
  - It is served on its own origin, `p-<id>.boxes.mumbo.si`, never under the founder's origin. Otherwise script it serves could drive the founder's box.
  - Every WebSocket upgrade must carry the Origin of its own host.
  - **Before a project can have a second person** (the B12 gate), two things must be true:
    - agent containment (below);
    - project boxes served on a separate registrable domain, so they cannot toss same-site cookies onto `boxes.mumbo.si`. The project domain is a config value (`PROJECT_DOMAIN`).
      - This also covers cookies that a box's own page script plants through `document.cookie` (for example a sign-in-named cookie on its own host), which the edge cannot filter. A `__Host-`-prefixed per-host sign-in cookie is the alternative, if a separate domain is not taken.
- **Approvals and repository grants belong to the founder.** Only emails in `APPROVER_EMAILS` may grant or bind a repository to a project. A repository belongs to at most one project, so ownership of a self-service project never reaches the organization-wide App.
- **CI must not trust the code it runs.**
  - Agent branches run in CI, so the repository's default workflow permissions are read-only, with `permissions: contents: read` and `persist-credentials: false`.
  - Required checks count only when GitHub Actions itself created them.
  - Every node id passed to a GitHub mutation must resolve to one of the project's repositories.
- **Agent containment inside every box** **[my call]**.
  - **What it requires.** The agent's shell and file tools run as a non-root user that cannot:
    - read the box's credentials: the box token, `MUMBO_MEMBER_KEY`, the dsh launch token in `/root/dsh.log`, the local CA key;
    - reach Chromium's CDP port.
  - **Who holds the credentials.** Only root-owned processes: the dsh server, MCP clients, and the box-local GitHub proxy.
  - **Why.**
    - Today the agent is root. Anyone who can ask it to run a command (a project member, or injected content) can read those credentials.
    - All boxes share the node NAT IPs, so a stolen box token works from any mumbo box. For example, a member could act as `project:<id>` from their own box, with its budget, sandbox tools and `project_message`.
  - **When.** Now: task B24 (section 17b). The founder's box syncs saved passwords and payment cards (2026-11-10), which root can read from disk. It is required before part C trusts account writes, and before a second person joins any project (part D).
  - **Options to evaluate.**
    - dsh's own sandbox (bubblewrap/Landlock). It was unavailable on Fargate but may work inside a Firecracker VM, and it covers file tools too.
    - A shell provider that switches user. This alone leaves the file tools, which run in the dsh process, unconfined.
  - **Binding the box token to the sandbox's identity**, instead of the shared NAT IPs, was considered. Every credential a box could present to prove its identity sits inside the box, so binding adds nothing without containment. Do containment first. Then expire box tokens and have a root process refresh them.
- **Content from anyone not on a node's allowlist is data,** never instructions and never an explicit request. Examples: a stranger's GitHub comment, a fetched web page, a forwarded message.

## 3. Architecture at a glance

| Piece | Runs where | Engine | Talks to |
|---|---|---|---|
| Assistant | The founder's box (one per user), as the home session | dsh assistant preset (ASSISTANT.md); a superagent instance from M4 | The founder (chat); project boxes through edge tools |
| Project coordinator | Its own project box (`project:<id>`: same template, project overlay, no browser) | superagent (router plus Tickets) in that box's own dsh | The assistant and members through edge relay; GitHub through the edge proxy |
| Workers | Inside the project box (dsh Executor, on mumbo's model). External workers through the door from M3 (the founder's own Claude Code sessions) | superagent Executors | The project repository through the edge GitHub proxy |
| Edge | Mumbo's AWS account (exists) | Node service and Postgres | Everything. Holds tokens, approvals, budgets and the door |

**Nodes are linked through edge relays.** **[my call]**
- **Down:** `project_message` delivers a message into a coordinator's session as the calling member. This uses dsh `session/prompt` with peer principals (ASSISTANT.md).
- **Up:** the coordinator reports back with an edge tool that relays into the member's assistant.
- **On the coordinator side,** a small superagent Source kind turns relayed messages into Triggers.
- This replaces v1's in-process "node Source" with the mechanism stage 10 already chose. It also covers projects shared with teammates later (part D) at no extra cost, because project boxes already have members.

## 4. Autonomy and approvals **[founder]**

| Action | Rule |
|---|---|
| Planning, coding, agents reviewing each other, running tests | Fully automatic (inside project boxes and sandboxes) |
| Reading the founder's chats and email (part C) | Automatic, to gather context |
| Anything sent **as the founder** (WhatsApp, email, X, LinkedIn, Slack) | Drafted freely; **one tap** to send (part C) |
| Merging a pull request | **One tap**, after agent review and CI pass |
| Deploying to production | **One tap** (from M5, section 13) |
| Spending money, deleting things, raising a budget | **One tap** **[my call]** |
| Creating a new project and its coordinator | Automatic; ask only when unsure **[founder]**. Giving a project access to a repository it never had is one tap **[my call]** |

**Approvals and asks** **[my call]**:
- An **approval** grants authority: merge, deploy, send as the founder, spend, delete, give access to a new repository, or raise a budget. Approvals exist only at the edge (section 5).
- An **ask** is a question that blocks a Ticket ("which API version?").
  - Asks are answered in chat or through the door. Answering one grants nothing beyond the Ticket's existing scope.
  - `@mumbo/mcp`'s `task_reply` keeps answering asks and in-turn tool prompts (`once` or `reject`, never `always`), and never answers approvals.

For mumbo's own development the founder only dumps ideas and asks for updates; there is no code review by the founder. **[founder]**

**"Deploying to production"** means changing what serves users: the edge, box templates and production Terraform. **[my call]**
- Until the self-upgrade path (section 13) exists, deploys stay with the founder's interactive sessions under the standing rule.
- There is no deploy approval before M5.

## 5. Approval enforcement at the edge **[my call]**

- **Request.** A coordinator or the assistant files an approval request with an edge tool. The request names the kind, the target, and the exact object:
  - for a merge, `{repo, PR, head SHA}`;
  - for a message (part C), the exact text and recipient.
- **Facts the edge checks itself.** For a merge: required checks green on that SHA, the number of changed lines, the paths touched, and whether a review Report for that SHA is attached.
  - The review Report and the summary come from the box. The edge shows them labelled as the agent's claim.
- **Low-risk rule.** The edge computes it, and every version of the rule is recorded. All four must hold:
  - required checks green on the head SHA;
  - a review Report for the head SHA;
  - fewer than 200 changed lines;
  - no protected path touched.
  - **Protected paths are never low-risk:** `.github/`, `deploy/`, the edge, the egress check, approval, policy and intake code, the superagent copy, package manifests and lockfiles.
  - "Approve all low-risk" approves only the items the page showed, at the commits it showed, that still pass this rule on the edge. Items whose head moved are skipped and reported.
- **Grant.** Only the founder can grant, signed in through the edge's OIDC sign-in.
  - The approval page lives on a **separate origin that no box serves**, `approve.boxes.mumbo.si`, so script served from a box cannot click it.
    - The sign-in proxy's cookie covers `.boxes.mumbo.si`, so one sign-in serves both hosts.
    - Every POST must carry `Origin: https://approve.boxes.mumbo.si` and a CSRF token.
  - The page follows the dsh tokens and component look, and the dsh client links to it.
- **Act.** The edge performs the action itself.
  - It merges with the merge-bot token and the `sha=` precondition.
  - If the head has moved, the approval goes back to the queue with the new SHA.
- **Durable and audited.** Open approvals live in the edge store (Valkey). If they are lost, the poller rebuilds them from GitHub, where every open, ready PR by the agent account is pending.
  - Each grant is written to S3 (`audit/approvals/…`) and to the edge log, with who, when and the exact object. **[my call: no new database]**
- **Notify.** The edge sends a push to the founder's phone for new approvals and for asks that block work.
  - M1 uses ntfy: the edge posts to a secret topic, and the founder subscribes in the ntfy app. Web Push can replace it later. **[my call]**
- **Stop everything.** The same page has one switch.
  - While it is on, the edge refuses model calls and GitHub writes for all of the founder's boxes and projects. Running work stops at its next call.
  - GitHub reads (fetches and GraphQL queries) still pass, so a stopped project can still be inspected.
  - `@mumbo/mcp`'s `runs_halt` remains the equivalent inside a box.
- **Recovery.** The approval page also works when a box is down. It shows box health and the last backup, and, once section 13 exists, offers "restore previous template".

## 6. Foundation: DeepSeek's superagent prototype **[founder]**

The design builds on `github.com/deepseek-ai/dsh-superagent-prototype` (MIT; research code; analyzed at commit `8c32a9d`).
- It is a dsh bundle: a router Session, an Executor Session per Ticket, Sources as plugins, one SQLite store, stored-then-done effects, and a panel.
- Its domain: Source, Trigger, Thread, Eval, Policy, Mandate, Ticket, Assignment, Executor, Subscription, Channel/Outbox and Attention.
- Its docs `000`–`008` are required reading for the builder.

**Enabled by default** **[founder]**: in the project overlay that every project box loads (a `- insert:` row). The founder's box gets it together with the assistant in M4.

**Where it runs** **[my call]**: one instance per dsh process and one process per box. This is what upstream's own deployment guide prescribes: a dedicated profile, because it changes the process-wide PATH and git settings (`docs/006-deployment.md`). The founder's decision of one instance per node holds; v1's in-process multi-instance plan is dropped.

**Packaging** **[my call]**:
- Bring it in as a pinned copy, with the upstream SHA and a log of local modifications (the same discipline as `vendor/README.md`).
- Unmodified upstream files are exempt from the coverage and style gates. Its own test suite runs in CI.
- Every local modification is logged and covered by mumbo tests. Where possible, a modification is a hook that calls into a mumbo package, so the logic itself sits under every gate.
- **Port step:** its dependencies move to this repository's workspace versions. Today it pins `@deepseek-ai/dsh-* ^0.2.1-alpha.2`, Cordis `4.0.5-alpha.1` and Schemastery `3.18.5-alpha.1`; the repository is at 0.2.2-rc.1 with Cordis 4.1.0. The APIs it uses still exist by name.

### Changes required inside the copy

| # | Change | Why | When |
|---|---|---|---|
| 1 | Serve the panel and API through dsh's authenticated web server, with the allowed host configurable. Today it refuses to start unless dsh binds 127.0.0.1 | Boxes serve dsh on the box IP (`dsh web --host $ip`), so it cannot start there. Its local API is protected only by header checks | M1 |
| 2 | Deliver messages on subscribed Threads to Tickets, and let them resume work, only from allowlisted identities. Everything else goes through the Eval gate as an implicit candidate, wrapped as untrusted data | Today any message on a subscribed Thread, a stranger's included, reaches a worker that runs with full access. The repository is public | M1 |
| 3 | Only a person, in the panel, can change Policy, eval mode, prompts and panel-only settings (prepare command, CLIs). Remove the router's tools that edit them | The router reads untrusted candidates and can currently rewrite its own Policy | M1 |
| 4 | Remove the merge step from worker prompts (`prompts/team/delivery.md`). A ready PR becomes an edge approval request (section 5) | Today the worker model turns on auto-merge itself with a merge CLI, and no code checks it | M1 |
| 5 | Make the Executor port pluggable | Runtime constructs `DshExecutor` directly and calls methods outside the port. Needed for external workers that take a Ticket through the door (M3) and for the assistant delegating to project boxes (M4) | M3 |
| 6 | Run the environment setup (PATH shims, worker gitconfig) only when a local Executor is configured | The assistant instance in the founder's box runs no local workers, and must not change the environment of the founder's own sessions | M4 |

**Dropped from v1:**
- In-process multi-instance support.
- Scoping the environment per Executor. This would need a dsh harness change, because `dsh-shell-env` allows only `DSH_*` keys.
- The Outbox approval gate. It moves to part C, which designs it properly. Today its waiting path (`Later`) retries every 5 seconds forever and blocks everything queued behind it in the conversation, and a draft cannot be edited under the same id.

**The project overlay needs no approval override.** Superagent pins `danger-full-access`, under which bash asks only when a command requests a wider sandbox, and delegated children pin `never`. So `mumbo.overlay.yml`'s `approval: ask` never stops a worker. The project box itself is the confinement. **[my call]**

## 7. Nodes

| Node | Count | Notes |
|---|---|---|
| Assistant | One per user | Lives in the founder's box, as the home session. Owns cross-project concerns: filing, the digest, waiting on people, compute conflicts, and admin. Admin is Tickets on the assistant **[my call]** |
| Project coordinator | One per project | Lives in its project box. The assistant creates it on its own and asks when unsure **[founder]**. Keeps the living brief and owns the project's Sources |
| Task coordinator | None for now | Deferred. Superagent's Tickets and Executors already give each work item its own routing. Add this layer only when a project shows the need **[my call]** |

The nodes' routers run on **mumbo's own model** through the edge **[founder]**. The model can be swapped per node.

### Creating a project **[my call]**

- A project is created from a fixed template. The project overlay, the superagent config, the Sources and the prepare commands all come from the template, never from model text.
- The assistant fills in only the name, goal, members and repositories.
- Giving the project a repository it has not had before, or creating a new one, is an approval.
- This stops an injected dump from creating a node with a hostile prepare command.

### Who a request comes from **[my call]**

- **The hop chain.** Every relayed message carries the person who first asked and each node it passed through. The edge stamps this, as dsh peer principals.
- **When a request is explicit.** Only when the person who first asked is on the receiving node's allowlist. Requests the assistant derives from fetched pages or forwarded messages arrive as implicit.
- **Door callers.** A caller holding the founder's key acts as the founder only within that key's scopes (section 10).

### Living brief **[my call]**

- **Contents.** Each coordinator keeps a brief: current state, decisions, open questions, who does what, and what it waits on.
- **Size.** Capped at one screen, about 600 words.
- **Updates.** The coordinator rewrites it after each Ticket closes.
- **Who reads it.** It goes into every request of that coordinator and of its Executors.
- **Logged.** It is a superagent prompt section, which dsh logs as `system/message`, so it is reconstructable from the session log.
- **Founder access.** The founder can open any brief.

### Cross-project facts and shared resources **[my call]** (M4)

- Coordinators state resource needs in their Reports to the assistant, for example "B300, 8 GPUs, from Nov 12".
- The assistant keeps a resource list in its brief and raises any overlap as one decision.
- Facts a coordinator marks as relevant to another project are relayed by the assistant.

## 8. Workers

1. **Inside the project box** (M1). Superagent's `DshExecutor` runs Executor Sessions whose tools act in the project box. At most 2 run at once for mumbo; this is configurable.
   - The mumbo project box needs a larger template than the 2 vCPU / 4 GiB user box. This repository's CI runs only static and unit checks and still takes 21–32 minutes.
   - Start at 4 vCPU / 8 GiB or more; the builder measures. **[my call]**
2. **Claude Code in child sandboxes: deferred** (section 8.1).
3. **External workers through the door** (M3). This is how the founder's Claude subscriptions do mumbo work: a Claude Code session the founder opened and signed in to claims a Ticket with `task_claim` and gets a lease. **[founder]**
   - The lease lasts 10 minutes and is renewed by any call on that Ticket.
   - The worker reports with `task_report` and `task_result`.
   - When a lease expires, the Ticket goes back to the queue.

**Fencing** **[my call]**: each Assignment gets its own short-lived edge token for GitHub and model calls. When an Assignment is replaced, its token is revoked, so a stale worker cannot push.

**Record per Ticket** (from jumbo's "Mumbo builds Mumbo" design):
- the model for each attempt, and the number of attempts;
- failed reviews, with reasons;
- cost, wall time and sandbox time;
- asks answered;
- the PR and its CI result;
- whether a failure was the platform's or the model's.

**Done** means an independent reviewer's verdict on the exact head SHA, plus required checks green on that SHA.
- The reviewer is a separate Ticket in a fresh session.
- After a second failed review, rerun as a new session, on a stronger model when one is available. Never change a running session's model (from jumbo).

### 8.1 Claude workers in sandboxes: deferred **[founder]**

Not built now. The platform comes first. When this comes back, start from these findings:
- `claude setup-token` issues a one-year token limited to inference, meant for scripts and CI.
- The token would stay at the edge: Claude Code's `ANTHROPIC_BASE_URL` would point at an edge route that injects it.
- **Policy risk.** According to a February 2026 report, Anthropic's consumer terms say subscription login tokens may be used only in Claude Code and Claude.ai, and bar automated access except through API keys or explicit permission. Rotating many subscriptions to get past usage limits adds further risk. API keys held at the edge are the approved path.
- The account-manager plugin (`cux` as the reference) belongs to this future design.

## 9. GitHub **[founder: the defaults]**

- **One shared agent account** for all coordinators. It must be a machine user: superagent's GitHub Source needs `/user` and push permission, which an App installation token lacks.
  - Its token lives at the edge **[founder]**.
  - The token is fine-grained: this set of repositories only, read/write on contents and pull requests, **no Workflows permission** (so it cannot change `.github/workflows`), and no admin. **[my call]**
- **Edge GitHub proxy** **[my call on mechanism]**:
  - **Two halves**, because the edge's load balancer cannot carry HTTPS `CONNECT`:
    - **In the project box:** a small local proxy that all HTTPS traffic in the box goes through (`HTTPS_PROXY`). It tunnels non-GitHub hosts untouched. It intercepts GitHub hosts using a certificate authority generated in the box, which the box alone trusts, and forwards each request to the edge's GitHub forwarder with the box token.
    - **On the edge:** a GitHub forwarder at `llm.boxes.mumbo.si/github/<host>/<path>`. It checks the box token, swaps in the agent account's token, and allows only listed operations.
  - URLs stay `github.com`, so `gh`, git and superagent work unchanged. Superagent does not support GitHub Enterprise hosts (its `docs/006-deployment.md`).
  - **Allowed operations:**
    - reads on the project's repositories;
    - new comments and reactions;
    - opening pull requests from a branch: `POST /pulls` takes only `title`, `body`, `head`, `base`, `draft` and `maintainer_can_modify`, so the agent cannot turn a person's issue into its own pull request (`issue`);
    - edits and state changes only to what the agent wrote: a comment (REST `PATCH …/comments/{id}`, GraphQL `updateIssueComment`), or a pull request's edit, close, ready, draft or reviewer request (REST `PATCH /pulls/{n}` and `POST /pulls/{n}/requested_reviewers`; GraphQL `updatePullRequest`, `markPullRequestReadyForReview`, `convertPullRequestToDraft` and `requestReviews`), when its author is the agent's own App identity, matched by numeric id. The edge reads the author with the agent token before forwarding, and anything else gets 403. Superagent re-reads an edited comment as a new message from its original author, so an edit to someone else's comment would forge that person's authority, such as the founder's;
    - pushes only to `agent/*` branches.
  - **Refused:** every merge endpoint, including the GraphQL `mergePullRequest` and auto-merge; approvals; ref deletion outside `agent/*`; repository settings; and the contents API.
  - **Workflow files.** Changes under `.github/workflows` are refused by GitHub itself, because the agent token has no `workflow` scope. Other `.github/` files are flagged as protected at approval time.
  - **Token type.** The agent token is a classic token with `repo` and `notifications` scopes. Superagent's GitHub Source reads notifications, which fine-grained tokens cannot.
  - Superagent's GitHub Source runs through the same proxy.
- **The agent is the `mumbo-bot` App too** **[founder: 2026-11-09, "re-use or take over the mumbo-bot"; this replaces the machine account]**. Design **[my call]**:
  - **Tokens.**
    - The edge forwarder mints an App installation token per project, limited to `repositories: <the project's bound repos>` and `permissions: { contents: write, pull_requests: write, issues: write, checks: read, statuses: read }`. It caches each token until 5 minutes before expiry. No box ever holds one.
    - Because the token never names `workflows`, workflow files stay unwritable.
    - GitHub itself now limits each project to its own repos, so node-id scoping stays as a second defence.
  - **App permissions (founder, in the App settings):**
    - add Issues read/write, Checks read and Commit statuses read;
    - remove Actions write and Workflows write;
    - then approve the updated permissions on the organization's installation.
  - **Superagent's GitHub Source, App mode (UPSTREAM S7):**
    - It takes its identity from config (`mumbo-bot[bot]` and the bot's numeric user id), not from `/user`.
    - Commits use `<bot id>+mumbo-bot[bot]@users.noreply.github.com`.
    - It doesn't poll notifications (App tokens can't). It polls the repository streams it already has (new issues, new PRs, comments, reviews) plus check runs.
    - To keep strangers on a public repo from costing an Eval each, a comment becomes a Trigger only when at least one holds:
      - it is on a Thread a Ticket subscribes to;
      - it mentions `@mumbo-bot` (or `@mumbo-bot[bot]`) outside code and HTML comments, where GitHub renders it.
      - Everything else is filtered at the Source scope, before Eval. An allowlisted sender's unaddressed comment needs no third rule: Policy refuses it anyway while comments are not observed (`receivable = addressed || observed`), as it does for a user account.
    - **Known gap until webhooks:** a review body that mentions the bot on a pull request no Ticket follows is not received, because GitHub has no repository-wide list of reviews. Webhooks (below) close it with `pull_request_review` events.
  - **Identity checks.** The approval poller's author filter and the review-marker author are `mumbo-bot[bot]`, matched by numeric id.
  - **Merges** still use a separate single-repo token minted per merge. The author and the merger are now the same App, so the founder's tap stays the only merge gate.
- **Merge bot.** The existing `mumbo-bot` GitHub App (id 5295930, installed on the `callgideon` organization) **[founder]**.
  - Its credentials are in Secrets Manager `mumbo-boxes/github-app`, and only the edge's approval service reads them.
  - For each merge, the edge mints a token limited to the one repository, with contents and pull requests write only. It merges, then revokes the token.
  - Merges show as `mumbo-bot[bot]`.
  - The agent stays a machine user for now. Moving it onto the App needs superagent's GitHub Source to work without `/user` and notifications.
- **Until public launch, the edge proxy is the only enforcement** **[founder: branch rules wait]**.
  - The agent token never leaves the edge, so agents can push only what the proxy allows. Before merging, the edge checks CI on the SHA itself (section 5).
  - What is not covered until launch: a direct push to `main` by any other credential, such as a person's own or the upstream-sync token.
- **Branch rules at public launch** (section 21 checklist):
  - Protect `main`, `dev` and `master`.
  - Merging into `main` requires a PR, the required checks `static` and `unit` from `mumbo-ci`, and the merge bot as the only account allowed to merge.
  - `master` keeps the upstream-sync push; that sync token is exempt.
- **Add the egress check to PR CI** (M1). Today it runs only in the image build.
- **Webhooks.** GitHub calls the edge, which wakes the project box and nudges its GitHub Source; polling stays as the fallback. This is needed from M1 if the project box pauses.

## 10. The MCP door

Every node can be driven by a higher agent or an external AI. **[founder]**

- **Where.** On the edge's MCP endpoint, which stage 8 already uses to serve sandbox tools with the box token.
  - External callers cannot reach a box today: oauth2-proxy has no bearer pass-through, and the router strips `Authorization`.
  - The door adds routes on the edge that accept bearer keys and resume the target box when needed. **[my call]**
- **Keys** **[founder: jumbo is dead; mumbo takes over]**. The edge mints and verifies its own keys in its Postgres database, with no runtime dependency on jumbo. jumbo's key model is copied from its code (`core/db/key_format.py`, `core/db/common.py`, `modules/mcp/server.py`):
  - format: `mumbo_pat_` + 32 base62 characters + a 6-character CRC32 checksum; stored as a SHA-256 hash;
  - scopes `read`, `prompt` and `workspace`; optional expiry; revocation;
  - only a person's own keys work; assistant and session keys are refused; only a person, signed in at the edge, can mint keys;
  - the error codes callers see: `invalid_api_key`, `key_revoked`, `key_expired`, `insufficient_scope`, `user_key_required`;
  - new here: each key lists which projects it may reach.
  - The founder's Claude Code `mumbo` entry moves to the new door, with a new key.
- **Verbs mapped to tools.** Names are reused from jumbo, `@mumbo/mcp` and ASSISTANT.md.

| Verb | Tool(s) | Scope | Notes |
|---|---|---|---|
| Status | `project_status`, `task_status`, `needs_you` | read | Read-only: the brief, Tickets and their stages, and what waits on the founder |
| Send context | `project_message` (kind `context`), or `agent_send` to the assistant | prompt | Arrives as an implicit Trigger: context, never a work request |
| Ask | `agent_send`, then `agent_read` | prompt | `agent_read` long-polls for up to 40 s with a cursor (as in jumbo and `@mumbo/mcp`), inside CloudFront's 60 s origin timeout |
| Answer an ask | `task_reply` | prompt | Asks only, never approvals |
| Create task | `task_start` | workspace | Explicit only within the key's projects |
| Take task | `task_claim`, `task_report`, `task_result` | workspace | Lease and fencing as in section 8 |
| Stop | `task_stop` | workspace | Stops one Ticket. "Stop everything" is only for a person (section 5) |

- **No approvals through the door.** **[my call]**
- Every call is logged with its key id and is visible to the node above.
- Context sent by the founder's own Claude agents to a project is a primary use, not an edge case. **[founder]**

## 11. Liveness, recovery and backups **[my call]**

- **Staying awake.**
  - User boxes never pause for now (ASSISTANT.md decision 4).
  - Project boxes pause with memory kept when idle (decision 1). "Idle" must also mean no Ticket queued or working and no worker child running. The project box sends a busy heartbeat to the edge, because today's activity signal (proxied requests and model calls) misses long builds and test runs.
- **Waking.**
  - A project box wakes on a relayed message, a door call, a GitHub webhook, or its next scheduled time.
  - Every timer a node needs (digest, deadlines, polls) is a dsh `schedule` task, because the edge's wake reader only sees those.
  - Merge the wall-clock recheck fix (`origin/fix/schedule-wall-clock-recheck`), so timers don't fire late by the length of a pause.
- **Restarts are normal:** a scheduled wake restarts dsh.
  - Superagent interrupts running Assignments and restarts them with a recovery note.
  - External workers keep their lease if they renew it; otherwise their Ticket goes back to the queue (section 8).
  - Fencing stops duplicate workers.
- **Backups.**
  - The edge's 10-minute tar skips SQLite WAL files, so superagent's and dsh's databases can come back stale or torn. Before each tar, snapshot every SQLite file with the backup API or `VACUUM INTO`.
  - Leave out git checkouts that are already pushed, and re-clone them on restore. A mumbo checkout is about 413 MB.
- **Replayed effects.** A restore can replay superagent effects, such as comments and PR updates. Outward actions that matter are idempotent at the edge:
  - merges, because they are bound to a SHA;
  - sends in part C, which will need edge-side message ids.
- **Every Ticket has an owner and a clock** (from jumbo).
  - On timeout, the owner is flagged first, then the parent, then the founder.
  - A parent Ticket cannot close while a child is open.
  - An instruction stays open until it is acknowledged.

## 12. Budgets **[my call]**

- **Ledger.** The edge counts tokens per principal per day in its store (Valkey), reading usage from the model's streamed responses.
  - Today it counts 3000 requests per principal per day there.
  - A store failover resets the day's counts. That is accepted for M1.
- **Daily caps** per user and per project. The assistant keeps a reserved share, so a runaway project cannot leave it mute in the morning.
- **Per-Ticket caps** in superagent's config: turns, wall time, pushes, and CI retries (3).
  - Starting values from jumbo: $10, 4 hours and 400 turns per worker session.
- **No timer-driven model calls** except the listed schedule tasks.
  - Per-node caps on wakes and model calls per hour.
  - A stall rule: no progress in N hours flags the Ticket.
- **Overnight anomaly.** Spend over twice the trailing daily average pauses the project and notifies the founder.

## 13. Self-upgrade path (M5) **[my call]**

**Today a merge to `main` changes nothing that is running.** An image, a template and a box re-creation must follow, and all three are manual: CodeBuild is started by hand, templates are rebuilt with `template.mjs`, and boxes are re-created by hand.

For mumbo to build itself:
1. A merge to `main` starts CodeBuild through a webhook, which builds an image.
2. The template is rebuilt from that image.
3. The edge files a deploy approval for each box: project boxes first, the founder's box last.
4. On approval, the edge:
   - takes a SQLite-safe backup;
   - re-creates the box on the new template;
   - runs a health check: dsh is up, the assistant or coordinator answers, and the approval page can reach the box.
5. If the health check fails, the edge re-creates the box on the previous template and restores the pre-upgrade backup. Migrations only go forward, so rolling back means restoring.

The founder's interactive Claude sessions ("way 1") remain the recovery path when a box cannot heal itself.

## 14. The assistant's brain (part B)

### Capture **[founder]**

The founder dumps screenshots, links, half-formed thoughts and voice notes, mostly on the go from the phone. In v1 the channel is chat with the assistant in the dsh Web client on the phone. WhatsApp to a dedicated assistant number comes later (part D).

- **Voice.** Enable the experimental voice bundle. **[my call]**
  - It runs SenseVoice locally, so audio never leaves the box. The microphone inserts text into the draft.
  - Voice-note files, such as forwarded recordings, need an upload path and a converter. That is part C.
- **Images** go through `ctx.attachments`. **Links** are read with `web_fetch`, and the fetched text is untrusted data.
- **Filing** **[founder: on its own, ask when unsure]**:
  - The assistant decides which project a dump belongs to and relays it with `project_message` (kind `context`).
  - It says where it filed it in one line and offers a "wrong project" correction.
  - A correction re-files the dump and withdraws any Ticket it created.
- **Chat Source** (from M4). Every message from the founder is also recorded as a Trigger on the assistant's superagent instance, so it can be routed, subscribed and audited. The founder still sees one conversation, the home session; the router stays behind it. **[my call]**

### Waiting on people and deadlines **[my call]** (M4)

- A **deadline Source** turns time into Triggers, such as "co-founder hasn't replied about the B300 in 3 days" or "invoice due Nov 15".
- Each row records who, what, since when or the due date, and the owning node. Each row is also a dsh schedule task, so it can wake the box.
- Until part C can read WhatsApp and email, the founder or the owning coordinator's own Sources answer "has X replied?".
- A nudge is a draft shown to the founder, who sends it by hand until part C provides channels that send as the founder.

### Updates and digest

- **"How's everything?"** returns one line per project with a green, yellow or red state, then only what needs the founder. **[my call]**
  - The state is computed, not reported by the coordinator.
  - Red: a Ticket is past its clock, or a deadline was missed.
  - Yellow: waiting on a person for more than 2 days, or more than 80% of the budget used.
- **A morning digest,** scheduled on the assistant, at a configurable time. **[my call: one digest a day]**
- **Cross-project conflicts** are raised as one decision (section 7).

## 15. UI **[founder: consistent with dsh; my call on layout]**

Reference mockups (sample data): `mumbo-mockups-v2.html`.

- **M1 needs no new client UI.**
  - The founder talks to the mumbo coordinator at `/p/mumbo/` (ASSISTANT.md), which covers "message a coordinator directly" **[founder]**.
  - The founder approves on the edge approval page.
- **M4 adds to the sidebar:**
  - an *Overview* row (TaskManagerPage layout): Needs you; Projects (state, goal, what each waits on, worker count, "Open brief"); Waiting on people; Due;
  - an *Approvals* row with a count. It lists the approvals the edge holds (read with the box token). Each tap opens the edge approval sheet.
  - The Assistant is pinned on top, and sessions are grouped by project.
- **Assistant chat** is the existing chat, with tool rows such as "File context · bitlane".
- **Superagent's panel** stays available in each project box for detailed supervision.
  - Only the project's owners can open it. They arrive as edge members, and the box lists them in `panelAdmins` from the project's owner list; the list is empty, and so closed, by default.
  - The panel can change settings and Policy, but never merge or approve.
  - Panel access equals shell access in the box: the Execution settings hold the prepare command the box runs, and the GitHub Source holds the CLI path the workers call. So `panelAdmins` only ever lists people already trusted with the box, which are the project's owners.
  - The Execution prepare command checks out the ticket branch as `agent/<ticket>`, because the edge accepts pushes only to `agent/*` and lists only `agent/*` heads for approval. The GitHub Source CLI is `/root/.mumbo/bin/gh`.
- **Phone** uses the same Web client below 768px, with the sidebar as a drawer.

## 16. Data and privacy **[my call; flagged]**

| Data | Seen by |
|---|---|
| The founder's dumps, briefs, admin documents, co-founder context | Mumbo's node model: DeepSeek API through the edge **[founder]** |
| Project code and diffs | The node model, and the founder's own Claude Code sessions that take Tickets (Anthropic) |
| Voice | The box only (transcribed locally) |
| Signed-in accounts and the browser | The founder's box only; never a project box or a worker |

- Each node's model is set in config, so admin or finance Tickets can move to another provider without a design change.
- **Image-capable models** **[founder: 2026-11-09]**: Qwen (`qwen/qwen3.8-27b`, `qwen/qwen3.5-9b`) through OpenRouter, behind the edge, with the server key held there and the models allowlisted. Screenshots of the founder's signed-in desktop are among the most sensitive data here, so:
  - **Retention.** Every OpenRouter request sets `provider: { data_collection: "deny" }`, and the edge enforces it. Prefer zero-data-retention endpoints. **[my call]**
  - **A session's model never changes mid-session.**
  - **Computer use** runs in a subagent whose model is the image-capable one. The DeepSeek session delegates "do X on the desktop or in the browser" and receives text back, so screenshots never reach DeepSeek, which can't read them anyway.
  - **Images the founder drops in chat** go through a `look` tool on the image model, which returns a description and any text in the image as a logged tool result.
  - **Fallback.** If dsh can't do either yet, a session the user starts on Qwen is the fallback. Automatic per-turn routing between models is not wanted. **[my call]**
- Backups are not encrypted with KMS until stage 9's open item on that closes.

## 17. Quality and observability **[my call]**

- The metrics in section 1 are collected from M1 on.
- **Filing evaluation.** Label 30–50 of the founder's real dumps with the right project, and rerun them on every change to the router prompt.
- New Sources start in superagent's observe mode until their decisions look right.
- Recorded-session snapshots for each node preset (repository rule).
- A health line in the digest across all nodes: stale Tickets, failed workers, budget used, last backup.

## 17a. Accounts and sign-up **[founder: 2026-11-09]**

**Hosts** **[founder: "replace boxes -> app"]**:
- `app.mumbo.si` is the primary host, with `approve.app.mumbo.si` and `p-<id>.app.mumbo.si`.
- `boxes.mumbo.si` and `api.mumbo.si` answer `301` to `app.mumbo.si`.
- The model host stays `llm.boxes.mumbo.si` for boxes already running, alongside `llm.app.mumbo.si`.
- Project boxes are still under the same registrable domain (`mumbo.si`), so the separate-domain gate before multi-person projects still applies.

**Sign-in cookie domain.** No host that the edge does not serve may exist under the sign-in cookie's domain, because every such host would receive the sign-in cookie. This applies to dev servers too. **[my call]**

**Sign-in consent page.** The Supabase OAuth server's authorization page is served by the edge, on an origin no box serves.
- Supabase's client on that page uses the PKCE flow only. Tokens in a URL fragment never become a session, which would otherwise allow login CSRF.
- It completes the sign-in automatically only for Mumbo's own client id(s), which are configured.
- It refuses any other client, so an OAuth client registered later in Supabase can't obtain the founder's consent silently.
- It shows "Continue with Google" and "Email me a sign-in link".

**Who.** The founder is `hi@mumbo.si`, the only approver (`APPROVER_EMAILS`). Anyone with a **verified** `@mumbo.si` or `@cambrialabs.ai` email may sign up, and each person gets their own box automatically. **[founder]**

**Flow:**
1. **Sign-in page.** A signed-out visit to `boxes.mumbo.si` reaches the Supabase sign-in page, with two choices: "Continue with Google" and "Email me a sign-in link". The first sign-in creates the account, so there is no separate sign-up form and there are no passwords. **[my call]**
2. **Verified emails only.**
   - Google verifies its own accounts. An email link is verified by the click.
   - oauth2-proxy refuses tokens without `email_verified`. It is never run with `--insecure-oidc-allow-unverified-email`.
3. **Domain check.** The edge admits by domain: `ALLOWED_EMAILS` gains `@mumbo.si` and `@cambrialabs.ai`, matched as a suffix including the `@`.
   - Anyone else sees the invite-only page, which names the domains that can join.
4. **First visit.** The edge creates the person's box (the existing `ensure()`). The page says "Setting up your computer, about a minute" on first creation and "Starting your computer" on later starts, and refreshes itself.
5. **First open.** The assistant greets the person once. It says what it can do now and that connecting accounts and projects comes later, and links the box's home page.
6. **What each account gets:**
   - one box (2 vCPU / 4 GiB) with a desktop and browser;
   - backups every 10 minutes;
   - a daily model budget (`DAILY_TOKENS_USER`);
   - up to 10 child sandboxes;
   - the assistant.
   - People may create projects. Repository grants and merge approvals stay with the founder until the multi-user design (part D), and projects stay owner-only (B12).

**Isolation.** Other users are colleagues, each in their own VM. The edge routes every person only to their own box, so one person's box never serves pages to another person.

**Capacity** **[my call]**:
- A node holds 12 boxes, and boxes never pause, so each account holds a box permanently.
- The edge sets `MAX_RUNNING_UNITS` to 2 × (12 × nodes − 2), counting a box (4 GiB) as 2 units and a child sandbox (2 GiB) as 1 unit. When it is full, newcomers see the capacity page, and the operator adds nodes (the node group allows up to 10).
- Scaling automatically on box count comes later.

**Leaving.** A runbook command deletes a person's box and backups. An account disabled in Google Workspace can no longer sign in.

**Acceptance:**
- a new `@cambrialabs.ai` account signs in with Google, gets a ready box, and the assistant's welcome appears;
- a new `@mumbo.si` account does the same by email link;
- an email account that never clicked its confirmation link is refused;
- a `gmail.com` account gets the invite-only page;
- with the cap reached, the next newcomer gets the capacity page.

## 17b. The person's computer (N1) **[founder: 2026-11-10; my call on the how]**

The founder asked for three things on 2026-11-10:
- a dedicated assistant called Mumbo;
- a desktop that is smooth and complete;
- Browser and Desktop tabs in the app.

The region is section 17c. All of these build on stage 9 (the box as the person's computer) and on ASSISTANT.md's home session and home view. They apply to person boxes only; project boxes are unchanged.

### Mumbo, the always-present assistant

**What the person sees.**
- One Session called **Mumbo**, pinned at the top of the sidebar, in every person's box.
- Opening the app with no Session selected opens Mumbo, on the phone too.
- It is the place to dump things, ask for status and come back to.
- Other chats remain for side work.

**What exists in dsh** (origin/main, 2026-11-10):
- `ctx.sessionController.create({ sessionId, workspaceId, agentPreset })` creates a root Session. It takes a stable id the caller picks.
- `resolveAgent(id)` finds one. Create only on `session/not-found`, because `create` with the id of a Session that has started makes a new random one instead.
- `rename` sets a title that automatic titling never overwrites.
- `workspaceRegistry.pinSession` / `unarchiveSession` pin and unarchive a Session.
- `agent/created` with `agent.ctx.systemPrompt.section(...)` gives one Session its own instructions on every create and resume.
- Superagent's main Session (`src/app/sessions.ts`) and `@mumbo/mcp`'s assistant Session (`src/assistant.ts`) already follow this pattern.
- What doesn't exist:
  - per-Session metadata;
  - a client route that opens a Session from the URL;
  - a fixed entry above the Session list;
  - any way to stop a Session being archived.

**Design** **[my call]**:
- **A plugin, `@mumbo/assistant`** (`packages/mumbo/assistant`, Host and Client halves), loaded by a person-box overlay row that the edge's start script writes, as for `@mumbo/box-links`. No other part of dsh changes, except the archive guard below.
- **Host, at start:**
  - resolve the Session `mumbo`, a fixed id the edge and other plugins can name;
  - if it is not found, create it in the Workspace of the person's files (`/root/projects`) with the deployment's default preset, and title it `Mumbo`;
  - unarchive it if it is archived, and pin it if it isn't pinned;
  - one ensure runs at a time.
  - The person may rename it; the plugin titles it only when it creates it.
- **Its own instructions** come from a system prompt section added on `agent/created` for this Session only. The text is the plugin's `instructions` config, which the edge writes as it writes `roleInstructions` today. In summary:
  - you are Mumbo, this person's assistant, and the Session they come back to;
  - keep track of what they asked and what is pending;
  - use schedules for later and recurring work;
  - when they return, start with what happened while they were away.
  - The box-wide rules in the shared `AGENTS.md` still apply, because every Session reads them.
  - Because the preset is locked after a Session's first turn, Mumbo stays on the default preset. What makes it Mumbo is this section, so later changes reach the existing Session without recreating it.
- **Client:**
  - on first load, if no Session is open, open `mumbo` with `ctx.uiWorkspace.openSession`;
  - never take over a Session the person chose.
  - Pinning alone puts it first in the sidebar, so it needs no new sidebar slot.
- **Archive guard, a small harness addition.**
  - Archiving through the Web's "stop and archive" passes `stopActivity`, which also deletes every schedule aimed at the Session. An accidental archive would silently drop Mumbo's standing tasks.
  - Add one veto point that `workspaceRegistry.archiveSession` checks before anything else, with or without `stopActivity`. The plugin refuses `mumbo`, and the Web shows the refusal as it shows any failed archive.
  - Its Agent Note, README and tests come with it (repository rules).
  - Until it lands, the start-time unarchive repairs an archive at the next restart, but the deleted schedules stay deleted.

**"Always running"** means three things:
- **Always reachable.** The Session lives in the box's dsh process, not in a browser, and boxes never pause (ASSISTANT.md decision 4).
- **Acts on its own.** It runs schedules the person or Mumbo created (`schedule_create` with this Session as the target), and these run with no browser open. From M2, project reports relayed up from coordinators are delivered into `mumbo`. From M3, the MCP door's "assistant" means `mumbo`, so `@mumbo/mcp`'s `assistantTitle` Session is replaced by it when both are composed.
- **Tells the person.**
  - Today a finished scheduled turn waits in the Session for the next visit.
  - An approval asked during a scheduled turn waits for a browser, which matters most.
  - **Next, after B17:** the edge forwards a box's "notify" call (on the same model-host endpoint as the sandbox tools, with the box token) to that person's own ntfy topic, which the person sets up from the home page. Mumbo uses it when it needs an answer or has finished something the person asked for. **[founder: yes, 2026-11-10; my call on the mechanism]**

**How it relates to what exists:**
- **Welcome:** unchanged (section 17a). The welcome attaches to the person's first prompt in any Session; since the app opens on Mumbo, it normally appears there.
- **Superagent:** not loaded in person boxes today. In M4 the assistant's superagent instance works behind Mumbo: its router Session is not the chat, and Mumbo's log stays the person's record. How Mumbo hands dumps to it is M4's design.
- **Per-person preset (ASSISTANT.md):** Mumbo's section plus the box overlay's rows (browser, computer use, sandboxes, schedules) are the assistant preset. No separate preset is built.
- **Other chats:** side conversations with the same tools and box rules. Project reports, relayed messages and standing schedules go to Mumbo only.

**Acceptance:**
- a new box has Mumbo pinned first, and the app opens on it;
- a restart neither duplicates it nor changes its title;
- an unpinned Mumbo is pinned again at the next start;
- archiving it is refused, and its schedules survive the attempt;
- a schedule Mumbo created runs with no browser open, and its result is in Mumbo on the next visit;
- recorded-session snapshots cover Mumbo's system prompt section (repository rule).

### A smooth, complete desktop

**Today** (`edge.mjs` start script, desktop block; `template.mjs`):
- **Rendering and streaming.** Xvfb draws a 1440×900×24 screen in memory, and x11vnc finds changes by comparing it repeatedly. noVNC shows it through websockify, the edge and the ALB. Chromium renders in software on 2 vCPU. The founder reports heavy lag.
- **No desktop.** Only openbox runs: there is no taskbar, file manager or desktop. A minimized window can't be brought back, so the screen goes blank.

**Wanted:**
- **Smooth.** Typing echoes and scrolling follows within the network round trip plus a frame or two.
- **Complete.** A taskbar with the open windows and a launcher, a file manager, a terminal and the browser. Minimizing or closing anything never leaves the person stranded.

**Design** **[my call; the research ranks the streaming stack]**:
- **A display server that streams only what was drawn.**
  - Replace Xvfb + x11vnc + websockify + noVNC with one X server that has the VNC server built in, so nothing polls.
  - **Provisional choice: KasmVNC**, a TigerVNC fork with its own web client and WebP/JPEG encoding that lowers quality during fast motion. It also encodes across threads and copies text both ways.
  - It is served on the same port and the same `/desktop/` path. KasmVNC's own login is off: the edge stays the only gate, raw ports stay loopback-only, and the edge's Origin checks apply unchanged.
  - Depth stays 24 bits, which Chrome needs. The screen follows the viewer's size, so a phone gets a phone-sized desktop.
  - WebRTC stacks (Selkies) are in only if the research shows VNC can't meet the acceptance below. They need a UDP or TURN path that the ALB doesn't carry, plus video encoding on the box's CPU.
- **XFCE** as the desktop, run as the `browser` user as openbox is today:
  - the xfwm4 window manager with compositing off, since compositing makes the VNC server send more;
  - the panel with a window list and launcher;
  - the Thunar file manager and the XFCE terminal.
  - Lighter alternatives save about 100 MB but don't look like a normal desktop.
- **The browser is always there.**
  - Chrome runs under a loop that restarts it within 5 seconds if it exits. The assistant's browser tools depend on it, and on a real desktop the person can now close it.
  - It reopens the previous tabs (`RestoreOnStartup`).
- **Files.**
  - Chrome downloads to `/home/browser/Downloads`. The assistant reads downloads there and puts files the person wants to upload in the same folder; one line in `roleInstructions` says so.
  - Backups cover all of `/home/browser` except caches, not only the profile. So a restore or a move (section 17c) keeps downloads and desktop settings.
- **Size.**
  - Measure on the founder's box before and after: frame rate, box CPU and node CPU.
  - If Chrome or the encoder is CPU-bound at 2 vCPU, person boxes get 4 vCPU.
  - A node (r8i.2xlarge, 8 vCPU) already holds up to 12 boxes, so vCPUs are shared. More vCPUs raise a box's burst, not the node's total, and node CPU is the real limit (section 20).
  - Chrome flags for software rendering follow the research and the measurement.

**Acceptance**, from the founder's location after the move to India (section 17c), on a laptop and on a phone:
- scrolling a LinkedIn feed in the desktop shows at least 20 frames a second in the viewer's statistics, and the box's CPU stays below 80%;
- typing in WhatsApp Web echoes without a visible delay;
- minimizing every window leaves the taskbar, and each window comes back from it;
- closing Chrome brings it back within 5 seconds with its tabs, and the assistant's browser tools work again;
- text copies both ways between the person's device and the desktop;
- the founder calls it smooth.

### Browser and Desktop tabs

**What exists in dsh:**
- The right panel holds tab kinds. A plugin registers one with `ctx.sidebarRightTabs.register` and puts its body in the `sidebar.right.pane.tab` slot. Its guide card has an order: Files 10, Terminal 20, the stock Browser 30.
- Below 768px the panel goes full-screen.
- The stock Browser tab (`ui-sidebar-browser`) works differently by platform:
  - on the Web, it is an iframe that refuses the app's own origin, and most sites refuse to be framed;
  - in the desktop app, it uses the app's own Chromium (a webview).
- dsh sets no CSP on the app page.
- The desktop live view is served at `/desktop/` on the app's own origin, behind the edge's `frame-ancestors 'self'` and Origin checks.

**Design** **[my call]**:
- **Two tab kinds, `box-browser` (title "Browser") and `box-desktop` (title "Desktop"),** added to `@mumbo/box-links`.
  - That package already carries the box's desktop URL into the page, and its README becomes "box links and views".
  - Their guide cards follow Terminal: Browser 30, Desktop 35.
  - On person boxes on the Web, the person overlay drops the stock iframe Browser, which can't open most sites. The desktop app keeps it.
- **Desktop** is an iframe of the configured `desktop` URL.
  - It is the same origin as the app, so `frame-ancestors 'self'` and the Origin checks hold unchanged, and no CSP change is needed.
  - It has no `sandbox` attribute, which would add nothing for a same-origin page.
- **Browser** is the same live view with Chrome in front.
  - Each time the tab is shown, one owner-only Host call brings Chrome's window to the front, maximized on display `:1`, and starts Chrome if it isn't running. `xdotool` is already in the image for computer use.
  - So "Browser" is the desktop showing your browser.
  - Rejected: a CDP screencast of the page. It shows no tabs, address bar, sign-in pop-ups, permission prompts or file pickers, and it needs the client to reach CDP, which agent containment is taking away. It would also carry every keystroke, passwords included, as CDP input.
  - Rejected: cropping the stream to one window. No VNC server here does that.
- **Hidden tabs disconnect** (no `keepMounted`). Two hidden live views would each keep an encoder busy. Showing a tab reconnects in about a second.
- **Ready for the local browser (N2).**
  - `box-browser` registers in the `builtin` band. When the desktop app registers its own local-browser body for the same kind in the `extension` band, the right panel uses that one and falls back to the live view when it unregisters.
  - Nothing else in the product names the live view, so N2 needs no change here.
- **Google Chrome replaces Debian's Chromium** **[my call; follows the founder's ask]**.
  - Google turned Sync off for Chromium builds, so a profile that syncs with the person's Google account needs Google Chrome stable, from Google's apt repository (amd64; nodes are x86_64).
  - **The existing profile directory is kept.** Chrome opens a Chromium profile last used by a version no newer than itself. Otherwise the box starts a fresh profile and keeps the old directory aside.
  - The debugging port stays on loopback with the box's own `--user-data-dir`. Chrome 136 and later honour the port only with a non-default profile directory, which this is.
  - **Updates.** Chrome updates with each template build. Rebuild the template at least every two weeks for Chrome security releases (RUNBOOK).
  - **Policies** in a root-owned `/etc/opt/chrome/policies/managed/mumbo.json`: `RestoreOnStartup: 1`, `DefaultBrowserSettingEnabled: false`, `MetricsReportingEnabled: false`, plus the password rule below.
- **Chrome syncs everything, passwords and payment cards included** **[founder: 2026-11-10, "Everything", relayed by mumbo after the risk was explained]**.
  - **What this exposes until containment (B24) lands:**
    - The agent's shell runs as root, without asking (the box's Full-access mode, `deploy/mumbo.overlay.yml`).
    - Chrome on Linux without a keyring (`--password-store=basic`) encrypts saved passwords and cards (`Login Data`, `Web Data`) with a fixed, public key.
    - So the agent, and anyone who can steer it with injected instructions, can read every synced password and card from disk with no prompt. So can anyone with the backups.
    - A keyring doesn't help while the agent is root, and a URL denylist doesn't protect the files.
  - **Containment is the fix and is pulled forward (B24, below).**
  - **Until then, the browser-level denials (B25)** stop the easy paths: the browser tools and computer use opening the password and payment pages, or reading a page while it shows them.
  - **Informed founder decision** **[founder: 2026-11-10, "Sync everything anyway"]**.
    - The founder was told plainly that the agent, or anyone steering it, and the backups could read every password and card, and that blocking Chrome's pages doesn't stop it.
    - So the `passwords` and `payments` sync types are on now, not gated on B24.
    - The designer's recommendation was to wait for B24's escape tests.
  - Chrome Sync never carries sign-ins (cookies) in either direction. The person signs in to each site once in the box, and the profile, with its cookies, is in every backup.
- **Signing in.**
  - The person signs in on the desktop.
  - For WhatsApp from a phone, use "Link with phone number" (a code), because the phone showing the desktop can't scan its own screen.
- **Rules unchanged:**
  - the assistant never types passwords or one-time codes;
  - `@mumbo/browser-consent` asks before writes;
  - the profile is backed up;
  - the edge's framing and Origin checks hold.

**Acceptance:**
- on a laptop and a phone, Browser opens with Chrome in front, and Desktop shows the whole desktop;
- both work in the phone's full-screen panel;
- the person signs in to Google in Chrome, and everything syncs, passwords and cards included once the founder turns those on;
- WhatsApp Web is linked by phone-number code and LinkedIn is signed in. Both stay signed in after a box restart and after a restore from backup;
- a project host can't frame the desktop (the edge's existing test);
- the stock iframe Browser is absent on person boxes on the Web.

### Protecting the synced passwords **[my call]**

The box's Chrome now holds the founder's saved passwords and cards. Two layers protect them.
- **Containment (B24)** is what keeps them from the agent; it is section 2's agent containment, pulled forward.
- **The browser-level denials (B25)** close the easy paths meanwhile, and stay afterwards as a second layer.

**B24, agent containment.** The agent's processes and file tools stop being root.
- **An `agent` user.** These run as `agent`:
  - the shell commands, terminals and code runtimes (PTC) that dsh starts on the model's behalf;
  - jobs and language servers;
  - the shells of subagents.
- **Their environment** is an explicit list. It never holds the box token (`DEEPSEEK_API_KEY`), `MUMBO_MEMBER_KEY` or a launch token.
  - **Harness addition:** a "run as" user and environment on the subprocess seam that these share. Node's `spawn` takes `uid` and `gid` natively.
  - The person's own Terminal tab runs as `agent` too, because the agent can drive terminals.
- **The model's file tools** (read, write, edit, search, list) work only under an allowlist: the workspace (`/root/projects`), `/tmp` and `agent`'s home.
  - They resolve real paths first, so a symlink can't lead out.
  - **Harness addition:** a readable-roots allowlist for the model's file tools. dsh's sandbox limits writes only, never reads.
  - An allowlist, not a denylist, because the tools run in the root dsh process and could otherwise read `/proc/<pid>/environ` of root processes.
  - The person's Files panel is unchanged.
- **Box permissions** (edge start script):
  - `/root` is `0711`. `/root/projects` belongs to `agent`, so Session working directories don't change.
  - `/root/.dsh`, `/root/.mumbo` and `/root/dsh.log` are root-only.
  - `/home/browser` is `0700` for `browser`, and the Chrome policy file is root-owned.
  - The X authority file stays `0600` for `browser`.
  - There is no `sudo`.
- **Network** (iptables owner match): `agent` can't connect to:
  - the debugging port (`9222`);
  - the VNC ports;
  - E2B's in-box agent `envd` (`49983`), which runs commands as root;
  - dsh's own port.
  - In project boxes it still reaches the local GitHub proxy (`8899`).
- **Cost to the person.** Installing system software (`apt`) needs root, so the agent and the Terminal tab can't. Project work already runs in sandboxes. Anything the person's box needs comes through the template or the operator.
- **Escape tests**, run in a real box as `agent`, each of which must fail:
  - read `Login Data`, or anything else under `/home/browser`, with the shell and with the file tools;
  - read `/proc/<dsh pid>/environ` and `/root/dsh.log`;
  - connect to `9222`, `envd`, the VNC port, or the X display;
  - write the Chrome policy file, or anything under `/root/.mumbo`;
  - become root.
- **Also project boxes.** This satisfies section 2's requirement for project boxes before a second member (B12).

**B25, browser-level denials** (`@mumbo/browser-consent` and Chrome policy):
- **Hard deny, not ask.** An asked question can be approved by reflex. The denied URLs:
  - every non-web scheme: `chrome:`, `chrome-untrusted:`, `chrome-extension:` (which also covers password-manager extensions), `devtools:`, `view-source:`, `file:`;
  - the origins `https://passwords.google.com`, `https://pay.google.com`, `https://payments.google.com`, `https://myaccount.google.com` and `https://accounts.google.com`. Signing in is the person's job.
  - The list is config, and the edge writes these defaults.
- **The check runs before and after every browser tool call.** A call whose target, or whose tab after the call, is on a denied URL is refused, and its result (snapshot, screenshot, text) is replaced by the refusal. This covers a navigation, or a click that lands there, and a read while the person has that page open.
- **Page script always asks,** as today: `browser_evaluate` and `browser_run_code_unsafe` ask even on allowed sites, with the script shown. A script can read an autofilled password or card number from a form field.
  - Add a test that the page snapshot shows a filled password field masked.
- **Chrome's `URLBlocklist`** blocks the internal pages for everyone in the box's Chrome, the person included, because computer use drives Chrome without going through browser-consent:
  - `chrome://password-manager`, `chrome://settings/passwords`, `chrome://settings/payments`, `chrome://settings/autofill`, `chrome://settings/addresses`;
  - `chrome://sync-internals`, `chrome://autofill-internals`, `chrome://password-manager-internals`.
  - The person manages passwords and cards on their own devices; they sync.
- **Computer use follows "reads are free, writes ask"** (ASSISTANT.md decision 3), as browser tools already do.
  - Screenshots pass; clicks, typing and key presses ask.
  - This also stops the agent clicking a site's "show password" button and screenshotting it.

**What remains after both:** dsh itself runs as root. So a flaw in dsh, or in a plugin running in the dsh process, reaches everything. The backups hold the profile (KMS-encrypted in S3), so anyone with access to the AWS account can read the passwords.

### Tasks (B16 onward)

| Task | Owner | Contents | Depends on |
|---|---|---|---|
| **B16** | mumbo-impl (done, approved) | Project boxes get `MUMBO_GITHUB_APP_LOGIN` and `MUMBO_GITHUB_APP_USER_ID` (superagent App mode, UPSTREAM S7) | #27 |
| **B17** | mumbo-impl | `@mumbo/assistant`: the Mumbo Session (ensure, title, pin, unarchive, its prompt section, opening it on first load), the harness archive guard, and the person-box overlay row with `instructions` in the edge start script. Tests: the acceptance above, a real-composition test, snapshots | — |
| **B18** | mumbo-impl | Desktop and Chrome, edge and template: XFCE; Google Chrome with the policy file and profile kept; the restart loop; Downloads; backups of `/home/browser` without caches; the `roleInstructions` line. Measure before and after on the founder's box. Rollback is the previous template | — |
| **B19** | mumbo-impl | The streaming stack: KasmVNC, or the research's pick, in place of Xvfb, x11vnc, websockify and noVNC at the same `/desktop/` path. Then the vCPU decision from the measurement | B18, research |
| **B20** | mumbo-impl | `box-browser` and `box-desktop` in `@mumbo/box-links`, with the owner-only Chrome-to-front call; the person overlay drops the stock Web Browser tab. Works with today's noVNC and B19's stack alike | — |
| **B21** | mumbo-impl | Edge, by region (section 17c) | R6 |
| **B22** | mumbo-impl | Edge, moving between regions (section 17c) | B21 |
| **B23** **[founder: yes, 2026-11-10]** | mumbo-impl | Mumbo's push: a per-person ntfy topic set up from the home page, and a box "notify" call through the edge | B17 |
| **B24** | mumbo-impl | Agent containment (above): the `agent` user and its environment through a harness "run as" on the subprocess seam; the file tools' readable-roots allowlist; box permissions and the iptables rules; the escape tests in a real box. Agent Notes, READMEs and tests per the repository rules | — (start now) |
| **B25** | mumbo-impl | Browser-level denials (above): hard-denied URLs before and after every browser tool call in `@mumbo/browser-consent`; Chrome's `URLBlocklist`; computer use asking for writes | — (start now) |

B17, B18, B20, B24 and B25 can run in parallel. B18 and B19 both change the template and the start script's desktop block, so they run in that order. B18 and B24 both touch the start script's desktop block too; B24 rebases on B18. Every sync type, passwords and payments included, is on from B18 (the founder's informed decision); B24 and B25 are the most urgent tasks in this list.

## 17c. Regions: the box near the person (N1) **[founder: 2026-11-10; my call on the how]**

The founder is in India, and their box must run in `ap-south-1` (Mumbai). The region is a setting per person, and a person can move between regions. Today everything is one stack in `us-east-1`: the edge and ALB, E2B control (API and client proxy on ECS, Postgres, MemoryDB), the edge's Valkey store, the nodes and the backup bucket. r8i nodes offer nested virtualization in all three `ap-south-1` zones (checked 2026-11-10).

**What has to be near the person:** the desktop stream and the app's WebSocket, both of which cross the edge. Model calls (seconds each), GitHub and approvals are not latency-sensitive.

**Design** **[my call]**:
- **Cells.** A cell is one region's VPC, E2B control, nodes, templates bucket, backup bucket and NAT addresses. There is one cell per region, and the first new one is `ap-south-1`.
- **An edge in every cell region, one shared state.**
  - The same edge image runs as an ECS service behind its own ALB in each region.
  - Every edge can serve every person: it routes each request to the cell of that person's (or project's) box, across regions if needed (inter-region VPC peering).
  - **Rejected: one global edge.** An Indian person's desktop stream would cross the ocean twice for a box in Mumbai.
  - **Rejected: separate stacks per region with their own host names.** They break the single sign-in host and the same-origin Desktop tab.
- **DNS.** Route 53 latency-based records point `app.mumbo.si`, `*.app.mumbo.si` and `llm.app.mumbo.si` at every regional ALB, with health checks, so each person reaches the nearest edge. `llm.boxes.mumbo.si` stays in `us-east-1` only. Global Accelerator isn't needed while latency records do the job.
- **State.**
  - The edge's Valkey store stays single, in `us-east-1`. The Mumbai edge reaches it over peering, so a store round trip costs about 190 ms from there.
  - The desktop stream and the app's WebSocket pay that only when connecting. Measure a page load from India; if store round trips add more than 300 ms, add a 30-second per-replica cache of box placement. If the cache isn't enough, the next step is a Valkey Global Datastore with reads in each region.
  - The edge's sweeps (backups, idle, wake) stay one lease holder for all regions. It drives each cell's E2B API.
- **Where the region lives: the edge store,** on the person's record and on each box and project record. Not Supabase:
  - user metadata is writable by the person through Supabase's API;
  - the region must change atomically with the box record during a move;
  - the edge already keeps all placement in its store.
  - Records without a region are in `us-east-1`.
- **A newcomer's region** is the region of the edge that served their first sign-in, which is the nearest region with a cell, through latency DNS.
- **Backups.** Each cell has its own bucket and KMS key, and a box backs up into its own region's bucket, keeping the 10-minute uploads in-region.
  - No cross-region replication: disaster recovery across regions isn't a goal yet.
  - A move copies the latest backup once.
  - Offboarding deletes a person's backups in every region.
- **Model host and egress.** Each edge's model host calls DeepSeek and OpenRouter itself, under the same budget ledger (shared store).
  - `BOX_EGRESS_IPS` becomes the union of every cell's NAT addresses.
  - The rules don't change: only `api.deepseek.com` among DeepSeek's hosts, and OpenRouter's `data_collection: deny`.
- **Child sandboxes** run in their owner's cell. A move kills the person's children, which are short-lived.
- **Project boxes** have a region too. It defaults to the creator's region at creation, and existing projects stay in `us-east-1`. They aren't latency-sensitive (chat, no desktop) and sit near GitHub. Only the operator moves them, with the same flow, since members may live in different regions.
- **Capacity** is per cell: `MAX_RUNNING_UNITS` follows that cell's node count. A full cell shows the capacity page; it doesn't spill a person into a distant region.
- **Sign-in.** Each edge's oauth2-proxy uses the same client and cookie secret, so a sign-in on one edge is valid on every edge. Supabase is global.

**Moving between regions** reuses the RUNBOOK's "move a box" (back up, then restore elsewhere), automated with a rollback:
1. **Start.** The person starts the move on the home page ("Your computer is in US East (Virginia). Move to India (Mumbai)"). They confirm after reading what a move loses: running terminals and servers, an agent turn in progress, and software installed outside the saved folders. The operator can start one with a RUNBOOK command, including for a project box. One move per principal runs at a time.
2. **Mark.** The edge marks the principal as moving. Pages say "Moving your computer to India (Mumbai). This page reloads by itself", and WebSocket upgrades are refused.
3. **Stop and back up.** Stop dsh and Chrome in the source box so nothing writes, then take a final backup into the source bucket.
4. **Copy.** Copy that backup to the target bucket server-side, re-encrypted with the target key.
5. **Restore.** Create the box in the target cell from the copied backup (the existing `ensure` restore path), and check that dsh answers.
6. **Switch.** Write the new region and box record, then kill the source box and the person's children. Sessions, schedules, files and Chrome sign-ins come along, because they are what the backup holds.
7. **Failure** at any step before the switch puts the person back on the source box: dsh and Chrome are started again, the target box is killed, and the person is told. The source bucket keeps its backups until they expire.

**Terraform, one module per region** (mumbo builds these):

| Task | Contents | Done when |
|---|---|---|
| **R1** | Split `deploy/boxes/prod` into a `modules/cell` and a `modules/edge`, and instantiate both for `us-east-1` with `moved` blocks. Parameterize every hard-coded region: the provider, the S3 endpoint service name and the node launch template. Per-cell private names, such as `api.<region>.boxes.internal` and `orchestrators.<region>.boxes.internal`; `us-east-1` keeps today's names | `terraform plan` for `us-east-1` shows no changes |
| **R2** | Shared resources at the root: the public zone's records, the edge's Valkey store (still `us-east-1`), and the edge secrets every region reads (oauth2-proxy client and cookie secret, GitHub App, OpenRouter, each cell's E2B key) through replicas or full-ARN cross-region reads | No changes in plan; the secrets are readable from `ap-south-1` |
| **R3** | The `ap-south-1` cell: VPC `10.21.0.0/16`, clear of 10.11/16, 10.12/16 and 10.20/16; E2B control; nodes with `node_count = 1` (12 boxes); templates and backup buckets with KMS; NAT. Its fixed monthly cost goes to the founder before apply | Its API answers on its private name |
| **R4** | Peering between `us-east-1` and `ap-south-1`, with routes, security groups and the private zone associated with both VPCs. Both edges reach both cells' API and client proxy, and the store. mTLS certificates for the new cell from the same CA | An edge task in each region reaches both cells |
| **R5** | E2B on the new cell: `setup/build.sh` into its templates bucket; the `mumbo-box`, `mumbo-child` and `mumbo-project` templates built on its API; the stage 4 move check on its nodes | `check/move.mjs` passes in `ap-south-1` |
| **R6** | The `ap-south-1` edge: an ECS service, an ALB and an ACM certificate for every edge name, and both edges' cell configuration (B21). Not yet in DNS: tested with `curl --resolve` | The founder signs in through the Mumbai ALB with `--resolve` |
| **R7** | Latency records and health checks for the edge names, pointing at both ALBs. **The switch is the founder's go**, because DNS changes are theirs. Rollback is removing the Mumbai records | From India, `app.mumbo.si` resolves to the Mumbai ALB |
| **R8** | Move the founder's box (B22) and run the acceptance | Below |

**Edge tasks:**
- **B21, the edge by region:**
  - a cell configuration per region: API and client-proxy URLs, the E2B key, backup bucket and key, `MAX_RUNNING_UNITS`, NAT addresses; plus `EDGE_REGION`;
  - a region on person, box and project records;
  - every E2B and S3 call uses the record's cell, and capacity is per cell;
  - the model host accepts every cell's addresses;
  - newcomers get `EDGE_REGION`, and children follow their owner;
  - tests for each. Measure store latency from Mumbai, and add the placement cache only if it is needed.
- **B22, moving between regions:**
  - the flow above, with its pages and the home-page control;
  - the RUNBOOK command, which also works for project boxes;
  - offboarding across every region.
  - Tests: a move, a target-restore failure that leaves the person on the source box, a visit and a WebSocket during a move, and a second move refused while one runs.

**Acceptance (first milestone: the founder's box in Mumbai):**
- **The move.** The founder's box runs in the `ap-south-1` cell, moved from `us-east-1` with Sessions, schedules, files and Chrome sign-ins intact.
- **Routing.**
  - From India, `app.mumbo.si` is served by the Mumbai edge, and the TCP round trip to its ALB is under 60 ms.
  - A person in the US still reaches a `us-east-1` box through the `us-east-1` edge.
  - The founder reaches the mumbo project box (`us-east-1`) through the Mumbai edge.
- **Services from the Mumbai box.** Model calls, budgets, approvals, the GitHub forwarder and child sandboxes (created in Mumbai) all work.
- **Moves.** A move back to `us-east-1` and again to Mumbai works. A forced failure leaves the founder on their source box.
- **Backups.** The Mumbai box's backups land in the Mumbai bucket.

## 18. Milestones **[founder: A, then B, then C; my call on the cut]**

| Milestone | Contents | Done when |
|---|---|---|
| **M1** one project, a safe loop | The mumbo project box (already live: project principal, persistence, `/p/<id>/`), plus a larger project template with `gh`. The superagent copy ported with changes 1–4 and enabled in the project overlay. The agent account and the two-half GitHub proxy. The edge approval service with ntfy push and "Stop everything". Daily token caps per principal. SQLite-safe backups. The egress check in PR CI. (Per-Ticket caps and the overnight anomaly pause move to M3. The busy heartbeat is not needed while boxes never pause.) | The founder asks the mumbo coordinator for a change from the phone → a worker opens a PR → checks green and a review Report on the head SHA → push → one tap → the merge bot merges that SHA. **Also:** a worker's attempts to merge, push to `main`, edit `.github/`, approve through any box API, or change Policy are all refused |
| **M2** assistant link | The assistant preset (ASSISTANT.md); `project_message` and `project_status` with attribution; filing; reports from coordinator to assistant | v1's M1: a dump in the assistant chat → the mumbo coordinator → a PR → a one-tap merge |
| **M3** workforce (part A) | The door on the edge, with mumbo's own keys and the verbs table. The pluggable Executor port, with an external-worker Executor (leases). Fencing. The budget ledger per node | The founder's own Claude Code session claims a mumbo Ticket through the door and opens a PR that reaches the one-tap merge. Another Claude session files context into a project and gets an answer through `agent_read` |
| **M4** brain (part B) | The assistant's superagent instance (changes 5–6), with Chat and deadline Sources and an Executor that hands work to project boxes. Briefs; the digest; Overview and Approvals in the dsh client; the voice bundle; shared resources | A week passes in which the founder learns project status only from the digest and "how's everything" |
| **M5** self-upgrade | Section 13; deploy approvals | A merged PR reaches the mumbo project box after one tap, and a deliberately broken build rolls back on its own |
| **M6** all projects | Coordinators for bitlane, openinfrx and whiteboard; admin Tickets on the assistant | Each project has a brief and a line in the digest |

Then the part C design (accounts in the box), then D.

The person's-computer track (N1: sections 17b and 17c, tasks B17–B23 and R1–R8) runs alongside these milestones. It doesn't change their contents or their order. **[founder: 2026-11-10, "don't widen M1"]**

## 19. Non-goals of this design

- **Part C:** WhatsApp and email Sources (the assistant reading them), consent for account actions beyond `@mumbo/browser-consent` (ASSISTANT.md decision 3), and sending as the founder, including superagent's Outbox approval gate. The box's desktop and browser themselves, and the person signing in there, are N1 (section 17b).
- **Part D:** teammates' assistants, phone calls, and the assistant's own number.
- Deploy approvals before M5, and task coordinators.
- Productizing for users other than the founder. Nothing should assume a single user per deployment beyond one assistant per box.

## 20. Left to the builder

- Package locations and names; the project template's contents; how the brief is stored.
- Refinements to the low-risk rule (versioned); the push mechanism; details of the GitHub proxy.
- Box and child sizes, after measuring.
- Test design per `docs/testing.md`; documentation and upgrade guides per the repository rules.
- Lower priority, for M6: which Sources bitlane, openinfrx and whiteboard need. whiteboard uses Scion and may need its own Source kind.

### Follow-ups after M1 (found in implementation review)

- **Move Mumbo-authored security code in the superagent copy under the coverage gate.** Today the whole copy is excluded. Move the panel admission rule (S2) and `Policy.delivers` (S3) into `src/mumbo/*.ts`, and narrow the exclusion to leave `src/mumbo/**` covered.
- **Match GitHub identities by numeric user id, not login,** in superagent's Policy allowlist and in the edge's agent-author and review-marker checks. A renamed or recycled login could otherwise match.
- **Don't credit an edit to the comment's author.** Superagent reads an edited comment, including an old one edited to add `@mumbo-bot`, as a message from its author. Anyone with write access to a repository can edit anyone's comment there, so a write collaborator could forge the founder's authority. Today the only write holders are the founder and the agent, and the edge (B15) stops the agent editing others' comments. **Before anyone else gets write access to a project's repository,** superagent ignores a comment whose GraphQL `editor` is not its author, or credits it to the editor.
- **Bind the approval item's file list to the head SHA** through `compare/{base}...{sha}` (B2's noted race).
- **Trim the `mumbo-bot` App's permissions:** remove actions and workflows write. The edge already mints narrower tokens.
- **Move the agent onto the `mumbo-bot` App**, so no machine accounts remain. This needs superagent's GitHub Source to work without `/user` and notifications.
- **Limit the superagent panel's hover styles to devices that hover.** Wrap every `:hover` rule in the copy's `src/client/client.css` in `@media (hover: hover)`, so a tap on a phone does not leave a row highlighted. Log it in UPSTREAM.md, and let the repository's hover spec scan the copy. The copy's other theme differences stay excluded: corner shape, hairline borders and elevated scroll rebinding. The panel already uses dsh's color tokens, and it is an owners-only supervision page.

### Deferred to their own research or design

- Claude workers in sandboxes and the account-manager plugin: subscription logins, usage and rotation, with `cux` as the reference (section 8.1).
- Part C, including edge-side message ids for sends and voice-note files.
- Part D.

## 21. Risks and open decisions

**Risks**
- **Before launch, `main` takes direct pushes** from any credential other than the agent's. Mitigation: the agent token lives only at the edge; branch rules go on at launch.
- **Superagent is research code** that DeepSeek says differs from their internal version.
  - Budget a review pass, port it to the current dsh, and keep the copy mergeable with upstream.
- **One router per node multiplies model calls.** Mitigation: the edge ledger and caps (section 12).
- **DeepSeek sees business data** (section 16).
- **Two designs for stage 10 can drift:** this one and ASSISTANT.md. After approval, fold this design into `deploy/boxes/ASSISTANT.md` as one document.
- **WhatsApp Web automation can get the account banned** (part C).
- **The box's Chrome holds the founder's saved passwords and payment cards** **[founder's choice, 2026-11-10]**.
  - Until B24 lands, the root agent, and anyone steering it, can read them from disk, and the backups carry them.
  - The founder accepted this, informed (section 17b). Mitigation: B24 is pulled forward and runs first, and B25's denials close the browser paths.
- **Google may refuse to sign in** a browser with remote debugging on, or one on a datacenter address.
  - Mitigation: the person signs in on the desktop and handles Google's checks.
  - If Google still refuses, Chrome is restarted once without the debugging port for the sign-in, then with it again. B18's acceptance tests this first.
- **Google Chrome's terms.** Installing Chrome in boxes for the company's own people is ordinary use. Offering it to customers needs a review before productizing.
- **A region costs a fixed amount each month** (E2B control, NAT, the ALB, a minimum of one node) whether or not anyone uses it. R3 states the amount before apply.
- **One edge store for all regions** adds a cross-region round trip to the Mumbai edge's store reads (section 17c). Measured in B21; the cache and the Global Datastore are the next steps.

**Before public launch** (checklist) **[founder]**
- Branch rules on `main`, `dev` and `master` (section 9).
- KMS encryption for backups.
- Per-site consent and an audit log for account actions (part C).
- A decision on Claude workers in sandboxes (section 8.1).
