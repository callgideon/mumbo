# mumbo boxes: production plan

This is the production platform for per-user boxes: E2B across many EC2 machines in our AWS account, with no single host. The trial in DESIGN.md (one E2B Embed host) keeps serving `boxes.mumbo.si` until stage 7 cuts over. Every stage ships with tests and is verified live before the next starts.

## Decisions (founder, 2026-11-08)

- Plain EC2 and a small E2B fork, not EKS. The fork adds DNS service discovery (about 20 lines), offered upstream.
- Self-hosted from the start; data stays in our AWS account; operated by a team of agents, so every operation has a runbook and an alarm.
- Boxes are paused with their memory when idle. Agents get box forks and small sandboxes (stage 8).

## Requirements added 2026-11-09

Each user's box is their personal computer in the cloud. They sign in to their own social and web accounts there and keep their files. A personal assistant agent runs in the box per user. It:
- uses the box's desktop and browser (computer use and browser use), including the user's signed-in accounts, only when the user permits or asks;
- starts, updates and manages the user's running projects by coordinating with a project coordinator agent.

What this changes:
- **Box size.** A desktop and a browser need 4 GiB of guest memory, not 2. A node's 48 GiB hugepage pool holds 12 running boxes; paused boxes cost only S3. E2B's `max_ram_mb` limit is raised to match.
- **Signed-in accounts are the user's secrets.** The browser profile (cookies, sessions) lives on the box disk, is kept across pauses with memory, and is in every backup. Backups move to KMS encryption with a key only the edge role can use. Server keys still never enter a box (R4).
- **Login by the user, in the box's own browser.** One persistent Chromium per box with a fixed profile. The user signs in (2FA included) through a live view of that browser in the web app. The agent attaches to the same browser over CDP (dsh's Playwright or Chrome DevTools MCP browser-use provider). Linux computer use needs a provider: dsh's CUA provider is macOS-only today.
- **Consent per account action.** Acting with a signed-in account (posting, sending, buying) asks the user unless they granted it for that site. Every such action is logged with user, site and action.
- **The assistant must act while the user is away.** A paused box cannot run a scheduled task. The edge wakes a box at its next scheduled time (dsh's schedule package records it), so idle boxes still pause.
- **Projects run in their own sandboxes.** The project coordinator starts, updates and stops project sandboxes (stage 8) that the assistant can see and control. A project never runs inside the box holding the user's accounts.
- **Egress IP.** All boxes leave through 3 shared NAT addresses. Sites may challenge logins from shared datacenter addresses. A per-user dedicated egress address is the upgrade if accounts get flagged.

## Architecture

```mermaid
flowchart LR
  U[Browser] -->|HTTPS| ALB[public ALB<br/>OIDC: Supabase]
  ALB -->|x-amzn-oidc-data| EDGE[edge × 2, ECS<br/>router + model host]
  BOXNAT[box egress via NAT EIPs] -->|llm host, no OIDC| ALB
  EDGE --> R1[(edge Redis)]
  EDGE -->|private NLB :3000| API[e2b api × 2, ECS]
  EDGE -->|private NLB :3002| CP[client-proxy × 2, ECS]
  API --> PG[(RDS Postgres Multi-AZ, PITR)]
  API --> R2[(E2B Redis: MemoryDB)]
  CP --> R2
  API -->|gRPC :5008 mTLS<br/>DNS: orchestrators.boxes.internal| N[sandbox nodes ASG<br/>r8i.2xlarge, 3 AZ]
  CP -->|:5007| N
  N <-->|peer chunks :5008 mTLS| N
  N --> S3T[(S3 templates + snapshots<br/>versioned, KMS bucket keys)]
  EDGE --> S3B[(S3 box backups)]
  ASG[ASG lifecycle hook] --> DR[drain Lambda] --> EDGE
```

## Stages

| # | Stage | Done when |
|---|---|---|
| 1 | **E2B fork:** `dns` discovery provider plus image build to our ECR | Unit test; api lists two node IPs from one DNS name |
| 2 | **Network and data:** VPC 10.20/16 in 3 AZs with NAT per AZ; RDS Postgres Multi-AZ with PITR; MemoryDB for E2B; ElastiCache for the edge; S3 templates bucket (versioned, Bucket Keys); KMS | `terraform plan` clean; RDS restore drill documented |
| 3 | **mTLS:** private CA and certificates for api, client-proxy and orchestrator (Secrets Manager), `required` on gRPC and peers. Code: `prod/tls.tf`, `prod/mtls/`; `prod/mtls/check.sh <fork>` runs the issued certificates through E2B's own mtls package | Handshake refused without a client certificate (check.sh, passing) |
| 4 | **Sandbox nodes:** r8i.2xlarge from stock Ubuntu 24.04 (`prod/nodes/node.sh.tftpl`: hugepages, nbd, IP forwarding before the orchestrator starts, our orchestrator and envd, mTLS files); orchestrator under systemd whose stop marks the node draining and pauses every box (`mumbo-drain`); one multivalue A record per node; ASG with a lifecycle hook the node completes itself. Live, 2026-11-09 | **Passed** (`prod/check/move.mjs`): box paused on node A (snapshot 21 s), resumed on node B in 2.3 s with disk and running processes kept |
| 5 | **Control plane:** api and client-proxy × 2 on Fargate behind an internal NLB (`prod/control.tf`); `setup` one-shot task (migrations, team, API key, limits); rolling deploys with circuit breaker. Images and node binaries from one fork commit (`prod/setup/build.sh`, pinned in `prod/terraform.tfvars`). Live, 2026-11-09 | **Passed:** `mumbo-box` template built (4 GiB) and box commands run through the NLB |
| 6 | **Edge on ECS:** public ALB (ACM, TLS 1.3) → oauth2-proxy (same Supabase client and callback as the trial) → edge on loopback; the `llm.` host → edge model host, which trusts only the ALB-appended X-Forwarded-For entry; edge × 2 with ElastiCache; `BOX_EGRESS_IPS` = NAT EIPs; E2B reached at `api`/`sandbox.boxes.internal`. Live, 2026-11-09 | Browser through the ALB: sign-in, box created and restored from the user's backup, UI loaded. **Cut over 2026-11-09:** `boxes.mumbo.si` and `llm.boxes.mumbo.si` alias the ALB; browser sign-in and a chat running bash passed through production (model calls 200, about 0.5 s) |
| 7 | **Operations:** 18 alarms on SNS `mumbo-boxes-alarms` (`prod/ops.tf`), `RUNBOOK.md` with a section per alarm, operations and drills. Cut `boxes.mumbo.si` over, then `app.mumbo.si`; retire Fargate and the trial | Alarm-delivery and node-replacement drills passed (the first node drill found and fixed a drain bug). Postgres point-in-time restore drill passed. `boxes.mumbo.si` cut over 2026-11-09 (trial edge stopped, trial Terraform no longer owns the records). `app.mumbo.si` and `api.mumbo.si` redirect to boxes (boxes ALB). `app.mumbo.si` as the public host: pending apply ("Public host app.mumbo.si" below). Backup bucket and edge settings moved into prod Terraform; backups encrypt with an edge-only KMS key (first KMS backup 08:27 UTC). Pending, blocked for the agent by the classifier: Fargate removal (PR #15, then `cdk deploy -c env=prod mumbo-prod`) and the trial destroy (`deploy/boxes/destroy-trial.plan`); edge-kill drill (unit-tested) |
| 8 | **Agent sandboxes:** MCP endpoint `/mcp` on the model host (`edge/sandboxes.mjs`): create, list, run, read/write files, kill; `mumbo-child` template (2 vCPU, 2 GiB); per-user cap; each box mounts `dsh-mcp-client` against it with its box token (start script overlay), so no harness change. Live, 2026-11-09 | 10 children created in 0.9 s, a command in each in 1.3 s, the 11th refused (429). In-box agent test after the cutover |
| 9 | **Personal computer.** Done 2026-11-09: `mumbo-box` template with Xvfb, openbox, Chromium (unprivileged `browser` user, profile in backups without caches or locks) and noVNC; live view at `/desktop/` (box port 6080, edge only, traffic token); dsh browser tools attached to the same Chromium over loopback CDP (9222 and 5900 dropped on the box interface); wake-on-schedule (edge records the next dsh task run before pausing, resumes and restarts dsh then). Open: KMS for backups (after the trial is retired, its Terraform owns the bucket); per-site consent and an account-action audit log (verify first whether dsh approvals already gate MCP browser calls); a Linux computer-use provider; a desktop entry in the web UI; dsh scheduler re-checking wall time so a wake needs no restart | Desktop live check passed (processes, user, CDP local only, noVNC 200 with token, 403 without). Wake tested in unit tests and the next-run reader on both storages. In-box browser and sign-in test after the DNS cutover |
| 10 | **Assistant and project coordinator** (design and founder decisions: `ASSISTANT.md`). Done 2026-11-09: shared project boxes (principal `project:<id>`, served at `/p/<id>/` to members only, own masked host, no desktop or browser), membership in the edge store, `project_create`/`project_list`/`project_add_member` tools for people's boxes; boxes never pause (`PAUSE_IDLE=false`). Done: `project_message` (edge relays into the coordinator session over dsh unary RPC). Done: assistant and coordinator roles (edge-owned AGENTS.md via DSH_AGENTS_HOME). Done: home page at `/home`. Next: members as dsh principals (needs a Connection admission seam, ASSISTANT.md), consent enforcement in dsh approvals | Live (`edge/project.e2e.mjs`): project box created, sign-in, page, assets and WebSocket under `/p/<id>/`, non-member 404 |

## Public host app.mumbo.si (B14): pending apply

Founder: "replace boxes -> app". The Terraform and edge on this branch are ready; nothing below is applied yet.

**What the apply changes.**
- `app.mumbo.si` is the public host, `approve.app.mumbo.si` the approve and sign-in page, `p-<id>.app.mumbo.si` project boxes, `llm.app.mumbo.si` new boxes' model host. oauth2-proxy's callback, cookie domain (`.app.mumbo.si`) and whitelist follow; the cookie name stays.
- `boxes.mumbo.si` and `api.mumbo.si` redirect to `app.mumbo.si`, `approve.boxes.mumbo.si` to `approve.app.mumbo.si`, other `*.boxes.mumbo.si` names to `app.mumbo.si/home`. Path kept; query `moved=1&<original query>`, so no target is a URL browsers cached as the old `app.mumbo.si` -> `boxes.mumbo.si` 301 (that would loop). HTTP 302 for now.
- `llm.boxes.mumbo.si` stays served: running boxes have it in their start script.
- Running boxes keep `boxes.mumbo.si` as their E2B masked host. The edge rewrites a same-origin Origin to the box's masked host, so they keep working; their old links redirect.
- Everyone signs in once more: the sign-in cookie's domain changes.

**Gates, in order.**
0. `dev.app.mumbo.si` (the CDK `mumbo-dev` shared server) is moved off `*.app.mumbo.si` or retired, its A, AAAA and ACM validation records are deleted, and `https://dev.app.mumbo.si/**` is removed from Supabase's Redirect URLs. Otherwise it receives the production sign-in cookie and can set `.app.mumbo.si` cookies.
1. Supabase (project `qkvcouccrhyjiarkauyo`):
   - the OAuth client in SSM `/mumbo/boxes/oauth-client-id` gets redirect URI `https://app.mumbo.si/oauth2/callback`; `https://boxes.mumbo.si/oauth2/callback` stays until step 6;
   - Authentication > URL Configuration > Redirect URLs gets `https://approve.app.mumbo.si` and `https://approve.app.mumbo.si/oauth/consent*`; the Site URL stays `https://app.mumbo.si`;
   - probe until it answers 302 to `https://app.mumbo.si/oauth/consent` (today: 400 `invalid redirect_uri`): `curl -s -o /dev/null -w '%{http_code}\n' -G https://qkvcouccrhyjiarkauyo.supabase.co/auth/v1/oauth/authorize --data-urlencode response_type=code --data-urlencode client_id=<id> --data-urlencode redirect_uri=https://app.mumbo.si/oauth2/callback --data-urlencode code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM --data-urlencode code_challenge_method=S256 --data-urlencode 'scope=openid email'`.
2. Revoke the allowed users' Supabase sessions and refresh tokens (they sign in again anyway). SQL editor: `delete from auth.sessions where user_id in (select id from auth.users where email like '%@mumbo.si' or email like '%@cambrialabs.ai');` (refresh tokens go with their session).
3. The edge image exists: `aws ecr describe-images --repository-name mumbo-boxes/edge --image-ids imageTag=<edge_tag>`. `edge_tag` in `prod/terraform.tfvars` must name a commit that contains the Origin rewrite and every edge change on `boxes/production`; if a merge changed it, build and push that commit first ("Ship a new edge", RUNBOOK). An older edge strands every running box (its dsh refuses the `app.mumbo.si` Origin).
4. `terraform apply` in `prod`, at a quiet time. Expected: the certificate and its validation records replaced (create before destroy), the listener's certificate, the `edge` and `old_hosts` rules, two new `old_hosts` rules, A records for `*.app` and `llm.app`, and the task definition. Order: certificate (1–5 minutes, nothing visible), listener, rules, then the rolling deploy (3–5 minutes). Between the rule change and the end of the rollout, `app.mumbo.si` can reach old tasks: sign-in errors or 404 until a reload. The model host and running boxes are not interrupted.
5. Verify the rollout: `aws ecs describe-services --cluster mumbo-boxes-e2b --services edge --query 'services[0].deployments[0].[taskDefinition,rolloutState]'` names the new revision and `COMPLETED`. Then, with GET (`curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n'`):
   - `https://boxes.mumbo.si/x?y=1` -> 302 `https://app.mumbo.si:443/x?moved=1&y=1`; `https://api.mumbo.si/` -> 302 `https://app.mumbo.si:443/?moved=1&` (or `?moved=1`);
   - `https://approve.boxes.mumbo.si/` -> 302 `approve.app.mumbo.si`; `https://p-0123456789abcdef.boxes.mumbo.si/x` -> 302 `https://app.mumbo.si:443/home?moved=1&`;
   - `https://app.mumbo.si/oauth/consent?authorization_id=t` -> 302 `https://approve.app.mumbo.si/oauth/consent?authorization_id=t`;
   - `curl -s -D - -o /dev/null 'https://approve.app.mumbo.si/oauth/consent?authorization_id=t'` -> 200 with `content-security-policy`;
   - `https://llm.app.mumbo.si/edge/healthz` and `https://llm.boxes.mumbo.si/edge/healthz` -> 200;
   - `https://app.mumbo.si/` -> 302 to the Supabase authorize URL with `redirect_uri=https%3A%2F%2Fapp.mumbo.si%2Foauth2%2Fcallback`;
   - from a clean browser: sign in with Google and with an emailed link, open the assistant on a box created before the apply, send a message.
6. After a day without rollback: remove `https://boxes.mumbo.si/oauth2/callback` from the OAuth client. After a week: change the `old_hosts` rules' `status_code` to `HTTP_301` (`prod/edge.tf`) and apply.

**Rollback** (until step 6): swap the values of `local.public_host` and `local.old_host` in `prod/edge.tf` and apply. That keeps both model hosts, every certificate name and DNS record, the edge image (its Origin rewrite serves boxes created under either name) and 302 redirects with the marker, now from `app.mumbo.si` to `boxes.mumbo.si`. B14's redirects are 302, so browsers hold none of them. People sign in again on `boxes.mumbo.si`.

## Review findings carried into the build (design review, 2026-11-08)

- **B1. Redis loss kills running VMs.** E2B treats Redis as the source of truth. Use MemoryDB (durable), not ElastiCache, for E2B, and alarm on orphan kills.
- **B2. Any orchestrator SIGTERM kills every box on that node.** Patch the launcher to drain. Only blue/green node upgrades. Never in-place restarts.
- **B3. Unresumable snapshots.** The edge recreates the box from backup. Done (edge `a2af52b`).
- **M2. mTLS** is required on gRPC and peers. The api's HTTP port stays plaintext behind the private NLB (the edge calls it with the E2B API key). Restrict :5007 to client-proxy. Certificates last a year; an apply in the last 60 days re-issues them, and E2B re-reads them every minute.
- **M3. Backups** run in parallel without the user lock. Done.
- **M4.** Versioned templates bucket and an RDS PITR drill.
- **M5.** Plan 12–16 boxes per node until measured. Keep one warm spare node. Capacity comes from E2B errors.
- Cut for v1: ClickHouse (the api requires a log store, so `LOKI_URL` points at nothing; API reads of sandbox and build logs fail until ClickHouse is added), volumes (`VOLUME_TOKEN_ENABLED=false`), the dashboard, Loki/vector (CloudWatch agent instead), a dedicated build ASG.

## Cost (estimate, us-east-1, on-demand)

About $2–2.5k a month at the minimum footprint: 3 sandbox nodes, control plane, RDS Multi-AZ, MemoryDB, ElastiCache, NAT in 3 AZs, ALB/NLB, logs. Each further r8i.2xlarge node is about $460 a month for 12–16 running boxes. Paused boxes cost only S3.

## Found while building stages 4 and 5

- **DNS discovery must name nodes.** A build records the node it ran on and asks that node for status; with no NodeID every node matched. Nodes are named by address, and each orchestrator's `NODE_ID` is the same address (fork `1619623fc`).
- **MemoryDB needs an ACL username,** which E2B's cluster client could not pass. `REDIS_CLUSTER_URL` now takes `rediss://user:password@host` (fork `644d3c875`).
- **A bare host needs `net.ipv4.ip_forward=1` before the orchestrator starts.** Its sandbox network namespaces copy the value when created; Docker set it on the Embed host.
- **Draining reaches api replicas on their next sync (10 s).** `mumbo-drain` waits 20 s after marking the node, then pauses until the node is empty.
- **`pause()` returns while the snapshot is still being written** (about 20 s for a 4 GiB box). A resume in that window restores in place on the same node.
