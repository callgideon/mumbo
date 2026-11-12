---
description: "Admits mumbo project members from an edge-signed header as non-owner principals that may read, follow, prompt, and create Sessions in a project box."
kind: "package-reference"
---

# @mumbo/edge-member

## Summary

`@mumbo/edge-member` lets the people of a mumbo shared project act in the project box as themselves. The mumbo edge signs each proxied request with a member header; this plugin registers a [Connection authenticator](../../client/connection/README.md) that admits a correctly signed request as the `edge-member` principal, and a [remote access](../../api/remote-access/README.md) policy that grants members the Session actions a collaborator needs. A member's prompt is recorded with `principal: { kind: 'edge-member', email }`, the model reads a notice naming the member before it, and the Web page shows the member's address above it. The design and threat model are in the [Agent Note](../../../.agents/notes/implemented/architecture/2026-11-09-connection-authenticators-and-edge-members.md).

## Table of Contents

- [Configuration](#configuration)
- [Member header](#member-header)
- [Member access](#member-access)
- [Project Workspace](#project-workspace)
- [Member attribution](#member-attribution)
- [Composition](#composition)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="configuration"></a>
## Configuration

| Field | Default | Meaning |
|---|---|---|
| `key` | required | This box's member key in unpadded base64url, at least 32 bytes. |
| `workspace` | required | Canonical path of the project Workspace, the only Workspace members follow and start Sessions in. |

A key that is not unpadded base64url or decodes to fewer than 32 bytes fails plugin load, and no authenticator registers; so does a failure to list the stored Sessions. The plugin requires the `connection`, `remoteAccess`, `workspaceRegistry`, `sessions`, and `sessionPersistence` services. `workspace` is compared with each Workspace's stored path exactly, so it must be the realpath of the directory, as the [project Workspace](#project-workspace) row's `workspace` is. The generated [configuration catalog](../../../docs/config-catalog.md#mumboedge-member) is the exhaustive source for accepted fields.

<a id="member-header"></a>
## Member header

The edge sends `x-mumbo-member: <email>.<expiry>.<mac>` on every request it proxies to a project box, including WebSocket upgrades and the index page, after removing any `x-mumbo-member` header the browser sent.

| Field | Content |
|---|---|
| `email` | The member's lowercased address, UTF-8, in unpadded base64url. |
| `expiry` | Unix time in whole seconds; the edge signs five minutes ahead. |
| `mac` | HMAC-SHA256 of `<email>.<expiry>` exactly as sent, under the member key, in unpadded base64url. |

The edge derives the member key per box as HMAC-SHA256(edge key, `member:` + box id) and passes it to the box as `MUMBO_MEMBER_KEY`. The plugin compares the MAC in constant time and admits the request only when the expiry is not past and at most 600 seconds ahead and the address is one lowercased email without whitespace or control characters. A missing, repeated, malformed, expired, or wrongly signed header admits no member; the request continues to the owner's cookie authentication and is refused with 401 when it carries no owner credential.

One Peer serves every connection of a member and stays live until the latest header seen for that member expires. The plugin then disposes it, which closes that member's WebSockets and ends their streams; the client reconnects through the edge, whose fresh header creates a new Peer. A removed member therefore loses every connection within ten minutes. `signMemberHeader()` and `verifyMemberHeader()` are exported for the edge's tests and for local checks.

<a id="member-access"></a>
## Member access

Every member holds the same grants, exported as `MEMBER_GLOBAL_ROLE`, `MEMBER_WORKSPACE_ROLE`, and `MEMBER_SESSION_ROLE`:

| Resource | Actions |
|---|---|
| `global` | `session/list`, `session/search`, `session/control`, `session/modelCatalog`, `session/canOpenWorkspacePath`, `agentPresets/list`, `llm/listProviders`, `llm/listConfigurableProviders`, `web/listProviders`, `commands/list`, `workspace/follow` |
| The project Workspace | `workspace/follow`, `session/create` |
| Each stored Session, each Session a Workspace lists, and each live Session | Page, follow, projections, state, events, attachments, jobs (`job/list`), workspace files (`workspaceFiles/list`, `workspaceFiles/changes`), `fileUploads/upload`, `fileUploads/uploadBinary`, `sessionLog/export`, `sessionLog/markdown`, `session/prompt`, `session/cancel`, `session/create` for reusing a blank Session in a create that names a `workspaceId`, `userQuestions/answer`, `userQuestions/attachWait`, skills, goals, tool results, and the forwarded `api-session/*` notifications |

Stored Sessions are those Session persistence lists when the plugin loads and every Session created after it, so a Session with no Workspace, such as one started under Ungrouped, and a finished subagent child stay reachable after they stop. Members see other Workspaces only through the Sessions they list, which appear under Ungrouped, and cannot start a Session in them. A member's `session/create` with no `workspaceId` is refused with `remote-access/denied`: one that names no Session either is decided on the global resource, which grants members no `session/create`, and one that names a Session is decided on that Session, whose binding refuses it with reason `workspace-required`, because the Host would start a new Session with no Workspace in that Session's directory once it is no longer a reusable blank. Members start Sessions through the project Workspace's `session/create`, and reuse a blank Session in a create that also names the project Workspace. The Web client's New Session controls ask for the grant where New Session would start, so a member sees them once the project Workspace is listed ([ui-workspace](../../client/ui-workspace/README.md#understand-the-implementation)). Remote access refuses every other action, including settings, credentials, plugins, fork, rename, model selection (which also saves the owner's default model), queue edits, and Workspace administration; a queue edit keeps the edited message's source, so it would record one person's text as another's. Of the exact Fetch routes outside the Gateway, members reach three, each on the Session its `sessionId` query names: the browser's binary upload `/api/session/uploadFileBinary` through `fileUploads/uploadBinary`, and the Session log download `/api/session.export` and Markdown copy `/api/session.markdown` through `sessionLog/export` and `sessionLog/markdown`. Every other exact route, including file media references `/api/file`, change summaries, and opening files on the box, dedicated RPC channels, and other routes outside the Gateway answer 403, except a route that admits Peers itself through `connection.admit` and checks their principal: `@mumbo/superagent` serves its management API `/orchestrator/api/`, settings and prompt saves included, to the members its `panelAdmins` configuration lists, and its relay route `/orchestrator/relay`, which turns a member's posted message into a Superagent Trigger from that member, to every member. The plugin rebuilds the bindings and calls `remoteAccess.invalidate()` when a Session is created or disposed, and after a Workspace-domain change has committed, so a member's access snapshot follows both lists; the registry emits the change before its entity holds the new list, so that rebuild runs once the emitting write has settled.

<a id="project-workspace"></a>
## Project Workspace

The `@mumbo/edge-member/project-workspace` sub-export is a separate function plugin, `mumbo-project-workspace`, that registers its `workspace` directory as a Workspace while the Host starts, so a member's first page opens a blank Session there instead of asking for a default Workspace that members may not create.

| Field | Default | Meaning |
|---|---|---|
| `workspace` | required | Existing directory registered as the project Workspace, in a canonical absolute spelling; the same value as the member plugin's `workspace`. |

- **At start.** Its load awaits `workspaceRegistry.create(workspace)`, which matches the canonical path, so a box that already has the Workspace gets no write and keeps its id and title, and a store marked `initialized` with no Workspace gets one. The Loader settles, and the Web carrier prints its URL line, only after the create; the edge proxies to the box only after reading that line, so a member's page never loads before the Workspace exists.
- **After a deletion.** When the project Workspace's own record is deleted, the plugin calls `create` again; the registry queues it behind the deletion, and a present Workspace returns with no write. Deleting another Workspace, or the registry deleting the record of a create it rolls back, starts no create, so a failing store write ends in one logged error instead of a loop. A failure is logged at error, and the Workspace stays absent until the next start. Remove the row to retire the Workspace.
- **Failure.** A relative, missing, or non-directory path fails this entry at load; the member plugin and every other entry keep running, and members are still admitted.

The create runs in-process as the Host; no member role grants `workspace/create`, `workspace/initializeDefault`, or `workspace/delete`.

<a id="member-attribution"></a>
## Member attribution

Before each entering message an `edge-member` Peer submitted, an `agent/pre-step` listener inserts one user-role notice with source `{ kind: 'mumbo-member', form: 'notice', summary }`. The notice enters the Session log with the message, so the coordinator model sees who wrote each message and a resumed Session replays the same request. Owner messages and other sources pass unchanged.

The package's browser half shows the member's address above each user message a member sent, on the owner's page and on every member's page, through Chat's `conversation.chat.user.before` seat; owner messages and other principal kinds show no line. The notice renders like every other context notice: a collapsed context-injection row in the member's turn that names its source and summary.

<a id="composition"></a>
## Composition

A project box loads [`deploy/mumbo-project.overlay.yml`](../../../deploy/mumbo-project.overlay.yml), which inserts the plugin with `key: !!js process.env.MUMBO_MEMBER_KEY`, then the project Workspace row; both rows set `workspace: !!js process.env.HOME + '/projects'`, the directory the edge creates and backs up on every box. The overlay sets the approval policy to `never`, so a member's turn never waits for an owner approval. The root manifest lists this private package as a development dependency, so a Host started from the repository resolves it by name from a `--patch` overlay; the published `@deepseek-ai/dsh` package does not depend on it.

<a id="model-experience"></a>
## Model Experience

### Member attribution notice

#### What the model sees

One user-role message immediately before each message a project member sent, where `<email>` is the member's lowercased address; the `principal` recorded on the member's own message stays out of model requests.

##### Verbatim text

```markdown
The next message is from project member <email>.
```

#### Token effect

About 10 tokens plus the address for each member message, retained in the Session until compaction replaces or removes it. Owner messages add nothing.

#### KV Cache effect

Append-only. The notice enters with the message it precedes, after the Session's existing history, so the reusable request prefix stays intact.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Members direct code that runs with the box's power** — a member's prompt runs the coordinator's tools; under Full access with approval `never`, those tools can read the member key and the owner's cookie signing record inside the box. The access policy keeps members off settings, credentials, and plugin calls and attributes their messages, but it does not contain a member who directs the agent to escalate. Treat members as trusted collaborators until the box runs tools under a separate identity.
- **Media references do not render for members** — `/api/file` reads any file the box can read, including `/root/.mumbo/start.sh`, the owner launch token in the dsh log, and every Session log, so no member role grants its `hostFiles/readAny`. It opens to members once the route can confine a non-owner to one Session's workspace root, which needs the missing seam: `ConnectionFetchRoute.fetch` receives no Peer.
- **A Session another process stores is bound only after a restart** — the stored list is read once at load and extended by Sessions this Host creates; a Session a separate process writes with no Workspace stays closed to members until the next start.
- **Deliverables routes are owner-only** — change summaries, comparisons, and opening declared or changed files (`/api/changes.*`, `/api/present.*`) answer 403 to members.
- **Steering messages and continuations show no author line** — Chat renders the message-source seat only on user rows that open a turn. A member message admitted while a turn runs, and a member's content-less continuation (a `retry` source, which Chat shows as its continuation receipt), therefore show no address; the notice row in that turn still names the member.
- **Answers carry no member** — `userQuestions/answer` records no principal, so the model cannot tell which member answered a question.
- **Removal is not immediate** — the box holds no member list; a member the edge removes keeps access until the last header minted for that member expires, at most ten minutes later.
- **No clock-skew allowance** — the box refuses a header whose expiry is past or more than 600 seconds ahead by its own clock, so the box and edge clocks must agree within five minutes.
- **No per-member differences** — every member holds the same grants; roles such as read-only members need a member attribute in the signed header.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
