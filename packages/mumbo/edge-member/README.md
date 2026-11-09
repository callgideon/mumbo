---
description: "Admits mumbo project members from an edge-signed header as non-owner principals that may read, follow, prompt, and create Sessions in a project box."
kind: "package-reference"
---

# @mumbo/edge-member

English | [中文](README.zh.md)

## Summary

`@mumbo/edge-member` lets the people of a mumbo shared project act in the project box as themselves. The mumbo edge signs each proxied request with a member header; this plugin registers a [Connection authenticator](../../client/connection/README.md) that admits a correctly signed request as the `edge-member` principal, and a [remote access](../../api/remote-access/README.md) policy that grants members the Session actions a collaborator needs. A member's prompt is recorded with `principal: { kind: 'edge-member', email }`, and the model reads a notice naming the member before it. The design and threat model are in the [Agent Note](../../../.agents/notes/implemented/architecture/2026-11-09-connection-authenticators-and-edge-members.md).

## Table of Contents

- [Configuration](#configuration)
- [Member header](#member-header)
- [Member access](#member-access)
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

A key that is not unpadded base64url or decodes to fewer than 32 bytes fails plugin load, and no authenticator registers. The plugin requires the `connection`, `remoteAccess`, `workspaceRegistry`, and `sessions` services. The generated [configuration catalog](../../../docs/config-catalog.md#mumboedge-member) is the exhaustive source for accepted fields.

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
| `global` | `session/create`, `session/list`, `session/search`, `session/control`, `session/modelCatalog`, `session/canOpenWorkspacePath`, `agentPresets/list`, `llm/listProviders`, `llm/listConfigurableProviders`, `web/listProviders`, `commands/list`, `workspace/follow` |
| Each Workspace | `workspace/follow`, `session/create` |
| Each Session a Workspace lists, and each live Session | Page, follow, projections, state, events, attachments, jobs (`job/list`), workspace files (`workspaceFiles/list`, `workspaceFiles/changes`), `fileUploads/upload`, `session/prompt`, `session/cancel`, `session/create` for reusing a blank Session, `userQuestions/answer`, `userQuestions/attachWait`, skills, goals, tool results, and the forwarded `api-session/*` notifications |

Live Sessions include subagent children while they run. Remote access refuses every other action, including settings, credentials, plugins, fork, rename, model selection (which also saves the owner's default model), queue edits, and Workspace administration; a queue edit keeps the edited message's source, so it would record one person's text as another's. Exact Fetch routes, dedicated RPC channels, and other routes outside the Gateway answer 403. The plugin rebuilds the bindings and calls `remoteAccess.invalidate()` when a Session is created or disposed, and after a Workspace-domain change has committed, so a member's access snapshot follows both lists; the registry emits the change before its entity holds the new list, so that rebuild runs once the emitting write has settled.

<a id="member-attribution"></a>
## Member attribution

Before each entering message an `edge-member` Peer submitted, an `agent/pre-step` listener inserts one user-role notice with source `{ kind: 'mumbo-member', form: 'notice', summary }`. The notice enters the Session log with the message, so the coordinator model sees who wrote each message and a resumed Session replays the same request. Owner messages and other sources pass unchanged.

<a id="composition"></a>
## Composition

A project box loads [`deploy/mumbo-project.overlay.yml`](../../../deploy/mumbo-project.overlay.yml), which inserts the plugin with `key: !!js process.env.MUMBO_MEMBER_KEY` and sets the approval policy to `never`, so a member's turn never waits for an owner approval. `apps/cli` depends on this package so a `--patch` overlay can name it.

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
- **Finished subagent transcripts are closed to members** — a subagent's child Session is granted only while it is live, because no Workspace lists it.
- **Browser uploads and file previews are owner-only** — the browser uploads through the exact route `/api/session/uploadFileBinary` and previews files through `/api/file`, and exact routes answer 403 to non-owners.
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
