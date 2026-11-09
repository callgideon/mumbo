# Mumbo personal assistant: node network and assistant brain (design v2)

Date: 2026-11-09, revision 2.1 (revision 2 plus the founder's answers to its open decisions). Covers parts **A** (the network of nodes) and **B** (the assistant's brain). Part **C** (the founder's accounts in the box: WhatsApp, email, browser, consent) and part **D** (teammates' assistants, phone number, the assistant's own WhatsApp number) get their own designs later.

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
  - **When.** Acceptable while the founder is every project's only member (M1). It must land before part C trusts account writes and before a second person joins any project (part D).
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
    - comments;
    - opening, updating and marking pull requests ready;
    - pushes only to `agent/*` branches.
  - **Refused:** every merge endpoint, including the GraphQL `mergePullRequest` and auto-merge; approvals; ref deletion outside `agent/*`; repository settings; and the contents API.
  - **Workflow files.** Changes under `.github/workflows` are refused by GitHub itself, because the agent token has no `workflow` scope. Other `.github/` files are flagged as protected at approval time.
  - **Token type.** The agent token is a classic token with `repo` and `notifications` scopes. Superagent's GitHub Source reads notifications, which fine-grained tokens cannot.
  - Superagent's GitHub Source runs through the same proxy.
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
- **Phone** uses the same Web client below 768px, with the sidebar as a drawer.

## 16. Data and privacy **[my call; flagged]**

| Data | Seen by |
|---|---|
| The founder's dumps, briefs, admin documents, co-founder context | Mumbo's node model: DeepSeek API through the edge **[founder]** |
| Project code and diffs | The node model, and the founder's own Claude Code sessions that take Tickets (Anthropic) |
| Voice | The box only (transcribed locally) |
| Signed-in accounts and the browser | The founder's box only; never a project box or a worker |

- Each node's model is set in config, so admin or finance Tickets can move to another provider without a design change.
- Backups are not encrypted with KMS until stage 9's open item on that closes.

## 17. Quality and observability **[my call]**

- The metrics in section 1 are collected from M1 on.
- **Filing evaluation.** Label 30–50 of the founder's real dumps with the right project, and rerun them on every change to the router prompt.
- New Sources start in superagent's observe mode until their decisions look right.
- Recorded-session snapshots for each node preset (repository rule).
- A health line in the digest across all nodes: stale Tickets, failed workers, budget used, last backup.

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

## 19. Non-goals of this design

- **Part C:** WhatsApp and email Sources, the box browser and computer use, consent for account actions (ASSISTANT.md decision 3), and sending as the founder, including superagent's Outbox approval gate.
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
- **Bind the approval item's file list to the head SHA** through `compare/{base}...{sha}` (B2's noted race).
- **Trim the `mumbo-bot` App's permissions:** remove actions and workflows write. The edge already mints narrower tokens.
- **Move the agent onto the `mumbo-bot` App**, so no machine accounts remain. This needs superagent's GitHub Source to work without `/user` and notifications.

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

**Before public launch** (checklist) **[founder]**
- Branch rules on `main`, `dev` and `master` (section 9).
- KMS encryption for backups.
- Per-site consent and an audit log for account actions (part C).
- A decision on Claude workers in sandboxes (section 8.1).
