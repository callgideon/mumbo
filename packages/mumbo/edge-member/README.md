---
description: "Admits mumbo project members from an edge-signed header as non-owner principals that may read, follow, prompt, and create Sessions in a project box."
kind: "package-reference"
---

# @mumbo/edge-member

English | [中文](README.zh.md)

## Summary

`@mumbo/edge-member` lets the people of a mumbo shared project act in the project box as themselves. The mumbo edge signs each proxied request with a member header; this plugin registers a [Connection authenticator](../../client/connection/README.md) that admits a correctly signed request as the `edge-member` principal, and a [remote access](../../api/remote-access/README.md) policy that grants members the Session actions a collaborator needs. A member's prompt is recorded with `principal: { kind: 'edge-member', email }`. The design and threat model are in the [Agent Note](../../../.agents/notes/implemented/architecture/2026-11-09-connection-authenticators-and-edge-members.md).

## Table of Contents

- [Configuration](#configuration)
- [Member header](#member-header)
- [Member access](#member-access)
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

A key that is not unpadded base64url or decodes to fewer than 32 bytes fails plugin load, and no authenticator registers. The plugin requires the `connection`, `remoteAccess`, and `workspaceRegistry` services. The generated [configuration catalog](../../../docs/config-catalog.md#mumboedge-member) is the exhaustive source for accepted fields.

<a id="member-header"></a>
## Member header

The edge sends `x-mumbo-member: <email>.<expiry>.<mac>` on every request it proxies to a project box, including WebSocket upgrades and the index page, after removing any `x-mumbo-member` header the browser sent.

| Field | Content |
|---|---|
| `email` | The member's lowercased address, UTF-8, in unpadded base64url. |
| `expiry` | Unix time in whole seconds; the edge signs five minutes ahead. |
| `mac` | HMAC-SHA256 of `<email>.<expiry>` exactly as sent, under the member key, in unpadded base64url. |

The edge derives the member key per box as HMAC-SHA256(edge key, `member:` + box id) and passes it to the box as `MUMBO_MEMBER_KEY`. The plugin compares the MAC in constant time and admits the request only when the expiry is not past and at most 600 seconds ahead and the address is one lowercased email without whitespace or control characters. A missing, repeated, malformed, expired, or wrongly signed header admits no member; the request continues to the owner's cookie authentication and is refused with 401 when it carries no owner credential. `signMemberHeader()` and `verifyMemberHeader()` are exported for the edge's tests and for local checks.

<a id="member-access"></a>
## Member access

Every member holds the same grants, read from the Workspace registry on each decision:

| Resource | Actions |
|---|---|
| `global` | `session/list`, `session/search`, `session/control`, `session/modelCatalog`, `llm/listProviders`, `llm/listConfigurableProviders`, `commands/list`, `workspace/follow` |
| Each Workspace | `workspace/follow`, `session/create` |
| Each Session a Workspace lists | Page, follow, projections, state, events, attachments, uploads, `session/prompt`, `session/cancel`, `session/updateQueue`, skills, goals, tool results, and the forwarded `api-session/*` notifications |

Remote access refuses every other action, including settings, credentials, plugins, fork, rename, model selection, and Workspace administration. Owner-only routes outside the Gateway answer 403. The plugin calls `remoteAccess.invalidate()` when a Session is created or the Workspace domain changes, so a member's access snapshot follows the Workspace list.

<a id="composition"></a>
## Composition

A project box loads [`deploy/mumbo-project.overlay.yml`](../../../deploy/mumbo-project.overlay.yml), which inserts the plugin with `key: !!js process.env.MUMBO_MEMBER_KEY` and sets the approval policy to `never`, so a member's turn never waits for an owner approval. `apps/cli` depends on this package so a `--patch` overlay can name it.

<a id="model-experience"></a>
## Model Experience

None, as this package admits callers and decides their Remote access, and the `principal` recorded on a member's message stays out of model requests.

#### KV Cache effect

No direct effect.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Subagent transcripts are closed to members** — a subagent's child Session is not on any Workspace list, so `session/page` and `session/follow` for a subagent address are refused for members.
- **Removal is not immediate** — the box holds no member list; a member the edge removes keeps access until the last header minted for that member expires, at most ten minutes later.
- **No per-member differences** — every member holds the same grants; roles such as read-only members need a member attribute in the signed header.
- **Each decision scans the Workspace list** — the cost of a member's call grows linearly with the number of Sessions in the box.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
