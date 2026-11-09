# Agent Note: Connection authenticators and mumbo project members

Status: implemented

English | [中文](2026-11-09-connection-authenticators-and-edge-members.zh.md)

## Problem

A mumbo shared project is its own Host behind the mumbo edge, and several people work in it. Connection admission was closed: `admit()` returned the owner's `browserPeer` for a valid browser cookie or an owner API Peer for an API cookie, and nothing else. The edge therefore signed every member in with the box's owner launch token, so the Host recorded every member's message as the owner's, and every member held owner power over settings, credentials, and plugins. The [peer principal decision](2026-10-12-peer-principal-and-remote-access.md) already records non-owner callers on prompts and gates their calls through remote access, but its only non-owner kind, the liveshare `share-viewer`, enters through an in-process relay channel, not HTTP admission.

## Decision

### Authenticator seam in Connection

`ctx.connection.authenticators.register(authenticator)` adds a synchronous `ConnectionAuthenticator`: `(request) => PeerScope | undefined`. [`admit()`](../../../../packages/client/connection/src/rpc-host.ts) applies the Host/Origin fence first, then asks each authenticator in registration order, then checks browser and API credentials. An authenticator answers only for requests that carry its own credential and never refuses one, so a request whose credential is absent or invalid still reaches owner authentication. The registration is an effect of the registering fiber. The authenticator creates its Peers with `createPeer()` and owns them, which keeps the creator-owned principal-to-Peers table of the peer principal decision.

Every admission path uses the same order: the `/api` route, dedicated RPC channels, the Gateway WebSocket upgrade through `admitConnection()`, and the index. `authorizeIndex()` returns the Peer the index renders for; an authenticator's Peer is served without a cookie, so `webserver/index-inject` and the access snapshot render for that principal. `requestRejection()` answers 403 to a non-owner Peer, because the routes that use it (inspector, open-in-app) bypass Gateway access checks, as exact Fetch routes already do.

### The `edge-member` principal

[`@mumbo/edge-member`](../../../../packages/mumbo/edge-member/README.md) declares `edge-member { email }` and registers one authenticator and one remote-access policy. The authenticator verifies `x-mumbo-member: <email>.<expiry>.<mac>`: the email is the lowercased address in unpadded base64url, the expiry is Unix seconds, and the MAC is the unpadded base64url HMAC-SHA256 of the first two fields as sent, under the box's member key, compared in constant time. A header expired, more than 600 seconds ahead, malformed, repeated, or signed with another key is not a member. The edge derives the member key per box as HMAC(edge key, `member:` + box id), so a header minted for one box fails in every other box, and mints a fresh header that expires five minutes ahead on every proxied request, after stripping any header the browser sent. One Peer per member serves every connection of that member, as `browserPeer` serves every owner browser connection.

### Collaborator access

The policy gives every member the same bindings: a `global` role for the Session list, search, control, model catalog, provider lists, commands, and Workspace following; a Workspace role (`workspace/follow`, `session/create`) on every Workspace; and a Session role (page, follow, projections, state, attachments, uploads, prompt, cancel, queue updates, skills, goals, and the Session notifications) on every Session a Workspace lists. `bindings()` reads the Workspace registry on every decision, so a new Session is reachable at once; the plugin calls `remoteAccess.invalidate()` on `session/created` and on Workspace-domain changes so access snapshots follow. No role lists a settings, credentials, plugin, fork, rename, model-selection, or Workspace-administration action, so remote access refuses them by default.

### Threat model

| Actor | Can | Cannot |
|---|---|---|
| Browser of a member | Act as that member through the edge | Present its own `x-mumbo-member`; the edge strips it |
| Holder of a captured header | Act as that member in that box for at most ten minutes | Use it in another box, extend its expiry, or change its email |
| Code inside the box | Read `MUMBO_MEMBER_KEY` and forge member headers | Gain anything: such code already runs with the owner's power in that box |
| Member | Read and prompt every Session the Workspaces list, which runs the box's tools | Change settings, credentials, or plugins, or reach owner-only routes |

Prompting runs the coordinator's tools, so a member directs work in the box. That is the purpose of a project box, which holds no accounts or secrets and runs its work in child sandboxes.

### Owner token and approvals in project boxes

The edge stops handing members the owner launch token for project paths, so members act only as themselves. The Host still accepts the owner cookie; only the edge holds it, for administration. A project box loads [`deploy/mumbo-project.overlay.yml`](../../../../deploy/mumbo-project.overlay.yml), which mounts the plugin and sets the approval policy and every permission preset to `never`. Non-owners cannot answer owner approvals, and no owner sits at a project box's browser, so an `ask` would leave a member's turn waiting indefinitely. Under Full access no command needs escalation, and `never` rejects any other ask at once. Consent for account writes stays in person boxes, where the owner is the user at the browser.

## Alternatives considered

**Keep signing members in as the owner and name them in the message text.** It needs no harness change, but the durable log records the owner as the author, the coordinator cannot tell members apart without parsing text, and every member holds owner power over settings and credentials.

**A liveshare-style relay channel per member.** Liveshare creates viewer Peers on its own channel, but the edge already proxies ordinary HTTP and WebSocket traffic; a relay would duplicate the web client's transport for every project request.

**Admit members inside Gateway or remote access.** Admission produces the Peer that every later check reads, so the Peer has to exist before the Gateway runs; admitting inside the Gateway would leave the index, WebSocket upgrades, and dedicated channels with a different answer than `/api`.

**A kind-wide binding in remote access, such as every Session.** It would avoid enumerating the Workspace list, but it changes the generic decision and snapshot formats for one consumer; enumeration uses the existing exact-resource rules.

**A per-member allowlist or revocation list inside the box.** The edge owns project membership and signs only current members with a short expiry, so the box would hold a copy that can drift; removal takes effect when the last header expires.

**An `ask` policy answered by an edge-side answerer.** It keeps an approval point in project boxes, but no person is there to answer, and a project box holds nothing an approval would protect.

## Consequences

Any plugin can now admit a non-owner HTTP principal without changing Connection, and owner-only routes stay owner-only through one check. Members appear as `principal: { kind: 'edge-member', email }` on their messages, so the coordinator and later guards can tell who asked for what. Members cannot open subagent child-Session transcripts, because child Sessions are not on Workspace lists. A removed member keeps access until the last header the edge minted expires, at most ten minutes. Every member decision scans the Workspace list, which is linear in the number of Sessions in the box.
