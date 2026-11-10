---
description: "Profile layer that runs a proactive coding agent for one GitHub repository: it watches GitHub and optionally Feishu, turns authorized requests into Tickets, and works each Ticket in its own Session."
kind: "package-bundle"
---

# @mumbo/superagent

## Summary

`@mumbo/superagent` is a profile layer that runs a proactive coding agent for one GitHub repository. Its main Session reads requests from GitHub and, optionally, Feishu, admits them under a Policy, and turns each authorized request into a Ticket that an Executor Session works in its own directory. The Superagent sidebar panel shows what needs a person. The package is a pinned copy of the upstream `dsh-superagent` prototype; [UPSTREAM.md](UPSTREAM.md) logs every change to it.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [In Mumbo](#in-mumbo)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### Install into a profile

The package is private and resolves only inside this repository, whose root manifest lists it as a development dependency. From the checkout, add the layer to a profile and remove it with the profile CLI:

```sh
pnpm dsh plugin --profile <name> add ./packages/mumbo/superagent
pnpm dsh plugin --profile <name> remove @mumbo/superagent
```

The layer inserts its rows without configuration. The profile must give the `dsh-superagent` row an absolute `stateDir`, or the plugin refuses to start; [examples/profile.cordis.patch.yml](examples/profile.cordis.patch.yml) is a profile patch to copy. Until the repository and the agent account are set, the runtime waits for setup, and the panel's Overview names what is missing.

### What you get

| Row id | Plugin | Adds |
|---|---|---|
| `dsh-superagent` | `@mumbo/superagent` | The runtime, its main Session and Executor Sessions, the Superagent panel, the management API under `/orchestrator/api/`, and the relay Source with its route `/orchestrator/relay` |
| `dsh-superagent-github` | `@mumbo/superagent/github-watch` | The GitHub Source: notifications (repository Issues, pull requests and comments for a GitHub App), subscribed Issues and pull requests, and CI changes |
| `dsh-superagent-feishu` | `@mumbo/superagent/feishu-watch` | The Feishu Source; disabled until the profile enables it |
| `dsh-superagent-worker-preset` | `@deepseek-ai/dsh-agent-preset` | The `dsh-superagent-worker` agent preset of every Executor Session |
| `dsh-superagent-router-preset` | `@deepseek-ai/dsh-agent-preset` | The `dsh-superagent-router` agent preset of the main Session |

The `dsh-superagent` row accepts these fields:

| Field | Default | Meaning |
|---|---|---|
| `stateDir` | required | Absolute directory for the database, the lock, the worker command shims, the agent's git configuration and, by default, the Ticket directories |
| `promptMaxChars` | `100000` | Largest saved prompt configuration, in characters, from 1,000 to 1,000,000 |
| `admissionContextMaxPages` | `10` | Pages of Thread context one assessment may read, from 1 to 100 |
| `admissionContextTimeoutMs` | `15000` | Time limit of one context read during an assessment, from 1 to 90,000 milliseconds |
| `panelAdmins` | `[]` | Lowercased emails of the `edge-member` principals admitted to the panel's views and the management API besides the owner, matched exactly; an entry that is not one lowercased address fails at load |
| `githubApp` | unset | `{ login, userId }` of the GitHub App bot the agent acts as: `login` is `<slug>[bot]` and `userId` the bot user's numeric id, from `gh api 'users/<slug>[bot]' --jq .id`, not the App ID. Unset, the agent CLI is signed in to a user account |

`promptMaxChars`, `admissionContextMaxPages` and `admissionContextTimeoutMs` apply without a restart; a change to `stateDir`, `panelAdmins` or `githubApp` remounts the plugin. The repository, the accounts, the Policy, the execution settings and the prompts are panel settings stored in the state database, not plugin configuration; [006 Deployment](docs/006-deployment.md) describes each one and the management API.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[cordis.patch.yml](cordis.patch.yml) inserts the three plugin rows and the two preset rows. The Feishu row is `disabled: true`. Both presets run their shell with a 5-second foreground limit, so a long command moves to a background job and a person's message reaches the Session at its next step.

| Path | Owns |
|---|---|
| `src/index.ts` | The `dsh-superagent` plugin entry and its configuration |
| `src/app/runtime.ts` | The composition root and the `orchestrator` service through which Source plugins reach the runtime |
| `src/core/`, `src/policy.ts`, `src/admission.ts` | The domain model: Triggers, Threads, Evals, Tickets and the Policy gate |
| `src/app/sessions.ts`, `src/executor/` | The main Session, the Executor Sessions and their presets, tools and skills |
| `src/sources/` | The GitHub, Feishu and relay Sources |
| `src/client/` | The Superagent panel |
| `prompts/`, `skills/` | The default prompt parts and the two Source skills |

All state lives in `<stateDir>/orchestrator.sqlite`. [007 Architecture](docs/007-architecture.md) maps every class, module, table and model-facing interface.

</details>

-----

<a id="in-mumbo"></a>
## In Mumbo

This package is a copy of [`dsh-superagent-prototype`](https://github.com/deepseek-ai/dsh-superagent-prototype), MIT licensed, pinned at the commit [UPSTREAM.md](UPSTREAM.md) names. UPSTREAM.md logs every change to the copy and every path outside it that exists for the copy. The plugin row names are `@mumbo/...`; the row ids and the preset ids keep their upstream names.

Mumbo project boxes load the package through `deploy/mumbo-project.overlay.yml`, which puts `stateDir` under the DSH home, sets `panelAdmins` from `MUMBO_PANEL_ADMINS`, and sets `githubApp` from `MUMBO_GITHUB_APP_LOGIN` and `MUMBO_GITHUB_APP_USER_ID` when either is set, so a pair with one missing fails at load. In Mumbo the package differs from upstream in these behaviors:

- **Settings, Policy and prompts change only in the panel.** The model has no tool that changes them: `orchestrator_settings_save`, `orchestrator_policy_sync` and `orchestrator_prompts_save` are removed, and the main Session has 11 application tools.
- **The panel admits through DSH authentication.** The panel and `/orchestrator/api/*` are served on any bind address. Each request goes through DSH Connection admission, which also applies its Host and Origin checks, and then passes only for the owner or an `edge-member` principal whose lowercased email `panelAdmins` lists exactly, so the empty default admits only the owner. A Peer whose signal has aborted, such as an expired member Peer, is refused. Other requests get 401 or 403, and a request without `x-orchestrator-request: 1` gets 403. A listed member reads every view and saves Sources, Policy, Execution and prompts through `/orchestrator/api/`; the Deployment page's machine settings are DSH configuration, which only the owner can edit. Panel access grants no merge or approval power.
- **Only allowed senders reach a Ticket.** A Trigger reaches a Ticket as an Input, by subscription or by attach, only when it comes from a person on the Source's allowed list, a bot on the Source's bot list, or GitHub CI: source `github`, an empty actor id and `meta.ci`. Every other message, including Feishu system, anonymous and app messages, is withheld for Eval and resumes no ended Ticket.
- **English only.** The panel, the Source labels and hints, and the preset names (`dsh-superagent worker`, `dsh-superagent router`) are English, and the panel registers only an English dictionary, so a DSH interface in another language shows the panel in English.
- **The agent can be a GitHub App's bot.** With `githubApp` set, setup takes the agent's login and its commit email `<userId>+<login>@users.noreply.github.com` from it instead of reading `/user`, which an installation token cannot read. Setup still reads the repository through the agent CLI and refuses only reported read-only access, because an installation token reports no permissions. The GitHub Source reads no notifications. Every round it reads the repository's new Issues and pull requests, comments and review comments, whatever the receive switches. It keeps what a switch receives, a new Issue or pull request whose body mentions the agent, a comment that mentions it, and a comment on a Thread a Ticket subscribes to while that Thread is polled or when the comment is new; the rest becomes no Trigger. A mention added by editing a body is not read, as for a user account. People mention the bot `<slug>[bot]` as `@<slug>`. Each Issue or pull request it receives, and each mention in a comment, starts its Thread's read position, so the replies posted before the Ticket subscribes are read once it does. Any other comment without a mention, an allowed sender's included, becomes no Trigger: on a Thread without a Ticket the Policy would ignore it, and on a Thread whose Tickets are no longer polled only a new comment is received, not an edit of an older one; once a new comment makes such a Thread polled again, its poll reads everything since polling stopped, including edits and reviews. The agent's own open pull request is read when GitHub lists it, so it binds to the Ticket on its branch, and until a Ticket subscribes to it, its Thread is read from the pull request's creation. The pull requests of open Tickets, subscribed Threads and the default branch's CI are polled as for a user account.
- **No mention inside code or an HTML comment.** In both modes a mention inside a fenced code block, an inline code span or an HTML comment does not address the agent, as on GitHub, where it is not rendered as a mention; a quoted mention does. These are found close to CommonMark: line endings are normalized, a code span ends at a blank line or at a line that starts a heading, quote or list item, and an unclosed HTML comment hides the rest of the text only when it starts a line; a mention in an indented code block still counts.
- **Project members relay messages.** The main plugin entry also registers the `relay` Source and mounts `POST /orchestrator/relay`, where the mumbo edge posts a project member's message as that member (`x-mumbo-member`). DSH Connection admission must admit the request as a live `edge-member` Peer; anything else gets 401 or 403. A member's own browser on the project origin is also admitted as that member, and so is any process in the box that signs the header (Known Limitations). The JSON body is `{ id, kind, text, hops, thread? }`: `id` and `thread` are 1 to 128 characters of `A-Za-z0-9._:-`, `kind` is `request` or `context`, `text` is 1 to 20,000 characters after trimming, and `hops` lists 1 to 8 `{ node, id }` nodes of the relay path, starting with `{ node: 'member', id: <the admitted member> }`. The message becomes a Trigger from the member as a person, on the Thread `relay:<member>/<thread, or id>`, with the hops in its `meta` and in the Thread's facts. The Source's Policy part has the switch `allMembers` beside its allowed list, on by default, also while no part is stored: every member DSH admits then counts as on the list. Off, only the members on the list do, and the Policy refuses any other member (`not_a_member`), as for any Source; switching it off withdraws the authority of the Mandates of members off the list, as removing them from the list would. No other Source kind accepts `allMembers`. A request addresses the agent (`direct`), so an allowed member makes an explicit request; context does not, so the admission table's one `relay` row decides it, and it is an inferred candidate at most. The id is the member's idempotency key: a retry with the same text, kind and conversation answers `duplicate`, and other content under the same id gets 409 `id_reused`. The other answers are 400 `invalid_request` with the fields in `issues` (`hops.0` for another first hop), 405 for another method, 409 `relay_off` while the Source is switched off, 413 for a body over 256 KiB, and `waiting: 'setup'` on a stored message while setup waits. A message whose `thread` names an earlier message's conversation joins its Thread, so it reaches the Tickets that Thread started. Each Trigger carries a Channel to the member, but the Source has no Channel adapter yet.
- **Executors never merge.** An Executor does not merge, enable auto-merge or approve a pull request. It posts one pull request comment whose first line is the marker `<!-- mumbo-review sha=<40 lowercase hex> verdict=<pass|fail> -->` and whose second line is the automated-agent disclosure line. The box edge merges through its own approval flow and treats the marker as a claim.

The upstream README is [docs/upstream-readme.md](docs/upstream-readme.md). It, [SETUP.md](SETUP.md) and the numbered documents in `docs/` are upstream prose: they describe a standalone installation with a global `dsh` and `scripts/dsh-superagent`, which this copy does not include. This section supersedes them where `docs/003-execution.md`, `docs/004-prompts.md`, `docs/006-deployment.md` and `SETUP.md` describe prompt-driven auto-merge, where `docs/006-deployment.md`, `SETUP.md` and the `http.ts` and `http.spec.ts` rows of `docs/007-architecture.md` describe a loopback-only panel and management API without authentication, where `docs/001-domain.md` and `docs/002-authorization.md` deliver every message on a subscribed Thread to its Tickets with no check of who sent it, where `docs/006-deployment.md` says a GitHub App cannot be the agent, where `docs/001-domain.md` (the GitHub Source row), `docs/003-execution.md`, `docs/006-deployment.md` and the `github.ts` row of `docs/007-architecture.md` say GitHub requests and missed reads arrive through notifications, which a GitHub App does not read, and where the upstream documents describe the three removed tools.

-----

<a id="further-exploration"></a>
## Further Exploration

- [mumbo package group](../README.md) — the other mumbo adapters.
- [000 Philosophy](docs/000-philosophy.md) through [008 Cookbook](docs/008-cookbook.md) — the upstream documents, read in order.
- [Agent presets](../../preset/agent-preset/README.md) — the row type of the two presets.

-----

<a id="model-experience"></a>
## Model Experience

### Role system prompt

#### What the model sees

The main Session and each Executor Session receive one composed role prompt: `runtime/shared`, the role part, the team sections `Communication`, `Ticket scope` and `Delivery requirements`, `runtime/subscriptions`, `runtime/replies`, `runtime/dispatch` for the main Session or `runtime/work` for an Executor, `runtime/admission` for the main Session, the role's handoff part, `runtime/environment` with the execution environment variables and, for the main Session only, `runtime/policy` with one line per enabled rule. The default text of each part is in `prompts/` and `prompts/team/`; a part the team's saved prompt revision overrides reads the team's text instead. Executor Sessions also read the coding prompt and `AGENTS.md` through their preset's `persona` and `agent-instructions` rows. With no enabled rule, the Policy section is:

##### Policy section without enabled rules

```markdown
## Policy
Policy version {version}; accept mode {mode}. The accept mode and the rules decide proactive candidates only: an explicit request is routed as dispatch says, in any mode and whatever the rules. No rule is enabled: a proactive candidate can only be ignored.
```

#### Token effect

With the default text, the composed prompt is about 40,000 characters for the main Session and 32,000 for an Executor before the environment and Policy sections; each enabled rule adds one line. `promptMaxChars` bounds a saved prompt configuration, overrides included. The prompt is part of every model request of the Session.

#### KV Cache effect

Prefix-stable while the prompt revision, the execution environment and the Policy stay unchanged. Every model request reads the latest prompt revision, so a prompt save invalidates reuse from its first changed part; a Policy change rewrites only `runtime/policy`, which follows every other part.

### Application tools

#### What the model sees

The main Session gets 11 tools: `orchestrator_read`, `orchestrator_route`, `orchestrator_ticket_retry`, `orchestrator_ticket_request_status`, `orchestrator_ticket_note`, `orchestrator_trigger_requeue`, `orchestrator_eval`, `orchestrator_eval_read`, `orchestrator_eval_decide`, `orchestrator_reply` and `orchestrator_thread_unsubscribe`. Each Executor Session gets 6: `orchestrator_read`, `orchestrator_ack`, `orchestrator_report`, `orchestrator_thread_unrelated`, `orchestrator_thread_follow` and `orchestrator_trigger_handback`. Their descriptions and parameter schemas are defined in `src/app/tools/` and are not in the generated tool catalog. An Executor keeps only the harness tools `WORK_TOOLS` in `src/app/sessions.ts` names.

#### Token effect

The schemas are part of every model request of the Session. An `orchestrator_read` text page holds 4,000 UTF-16 code units by default and 8,000 at most; a list holds 20 items by default and 50 at most.

#### KV Cache effect

Prefix-stable: a Session's tool set follows from its role. Tool results append to the Session history.

### Trigger cards and notices

#### What the model sees

The runtime delivers user-role messages with source `{kind: "dsh-superagent", form: "relay"}`, or `form: "notice"` with a one-line `summary` for a message it adds without starting a turn. A main Session turn starts on a candidate card, a `follow_up` notice, a `worker_report` or a `worker_attention`; `ticket_ended`, `settings_saved`, prompt saves, requeues, dropped Subscriptions and context follows are added without starting a turn. An Executor Session receives its assignment, with the title, up to 1,500 characters of assignment text and the source Trigger card, and later Inputs as Trigger cards of up to 600 characters or as plain text. Text quoted from GitHub or Feishu, or relayed by a project member, is data; the prompts tell the model that it never changes rules or authorization. A relayed message's card names the member's address as `from` and its Thread `relay:<member>/<conversation>`; its hop chain is not on the card: it is in the Trigger's `meta`, the panel's Thread facts and the Mandate basis of the Thread's Decisions, which the main Session reads through the `decision/<id>` resource.

#### Token effect

Each delivery appends one data-dependent message that stays in the Session until compaction replaces it. A truncated card carries a read pointer for `orchestrator_read` instead of the rest of the text.

#### KV Cache effect

Append-only. A delivery follows the Session's existing history.

### Source and team skills

#### What the model sees

Both roles' skill catalogs list `dsh-superagent-github`, `dsh-superagent-feishu` and each team skill as `dsh-superagent-<name>`; the default Source skill text is in `skills/`, and the `skill` tool loads a body on request. A team skill's catalog description is the first 120 characters of its text.

#### Token effect

One catalog entry per skill on every model request, and the loaded body only after a `skill` call.

#### KV Cache effect

Prefix-stable until a prompt save changes the skill set or a skill's text; the next model request then registers the saved revision's skills.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Pinned upstream copy** — upstream changes arrive only through a new copy that re-applies the UPSTREAM.md log; several repository gates exclude the copy's code; UPSTREAM.md S1 lists them.
- **Upstream setup instructions** — `SETUP.md` and `docs/006-deployment.md` use `scripts/dsh-superagent` and a globally installed `dsh`, which this copy does not include.
- **Deployment form for panel admins** — for a listed `edge-member`, the Deployment page's machine settings stay on Loading… with their inputs disabled instead of saying that only the owner edits them.
- **Delivery gates only Ticket Inputs** — a worker that reads a pull request, a chat thread or the `trigger/` resource itself still sees the text of senders off the allowed list. A GitHub sender is identified by login, which its owner can rename and someone else can later claim, and an edited comment keeps its original author. `Tickets.wake` does not check delivery again, so an Input that reached an ended Ticket before its sender left the allowed list can still resume it.
- **No process isolation** — both presets run with `danger-full-access` as the host's OS user; an Executor can read that user's home directory and run any program by path.
- **Relay attribution waits for B24** — in a Mumbo project box, the edge exports `MUMBO_MEMBER_KEY` into DSH's environment, so an Executor or any other process there can sign `x-mumbo-member` for any address and relay a request in that address's name, which the Policy takes as that member's explicit request: with `allMembers` on, the default, for any address, and otherwise for an address on the allowed list. An Executor prompted by a sender off the allowed list can therefore make one. Rely on a relayed message's member only after task B24 removes the key from the agents' environment.
- **State grows without bound** — nothing deletes old Triggers, Decisions, ended Tickets, outbox receipts or saved settings and prompt versions.
- **Relay replies are dropped** — the relay Source has no Channel adapter yet, so an acknowledgement, answer or result on a relay Thread settles as dropped (`channelGone`) instead of reaching the member; replies through the edge are planned (B36).
- **Relayed messages wait for setup** — the relay Source stores a member's message at once, but, as for every Source, nothing is evaluated until setup has the GitHub repository and the agent account; the route answers `waiting: 'setup'` meanwhile.
- **github.com only** — GitHub Enterprise Server is not supported.
- **GitHub App mode needs an installation token** — with `githubApp`, the agent CLI's requests must carry an installation token for the repository, such as through the Mumbo edge's GitHub forwarder; the package mints no token itself.
- **Review bodies without a subscription** — in GitHub App mode, a pull request review body that mentions the agent on a pull request no Ticket subscribes to is not received, because GitHub has no repository-wide list of reviews, and neither are that review's inline comments unless one mentions the agent; ask with a mention in a comment instead.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
