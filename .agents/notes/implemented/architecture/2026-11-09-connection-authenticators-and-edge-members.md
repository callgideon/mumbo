# Agent Note: Connection authenticators and mumbo project members

Status: implemented

English | [中文](2026-11-09-connection-authenticators-and-edge-members.zh.md)

## Problem

A mumbo shared project is its own Host behind the mumbo edge, and several people work in it. Connection admission was closed: `admit()` returned the owner's `browserPeer` for a valid browser cookie or an owner API Peer for an API cookie, and nothing else. The edge therefore signed every member in with the box's owner launch token, so the Host recorded every member's message as the owner's, the coordinator learned the author only from a `[from <email>]` prefix the edge wrote into relayed text, and every member held owner power over settings, credentials, and plugins. The [peer principal decision](2026-10-12-peer-principal-and-remote-access.md) already records non-owner callers on prompts and gates their calls through remote access, but its only non-owner kind, the liveshare `share-viewer`, enters through an in-process relay channel, not HTTP admission.

## Decision

### Authenticator seam in Connection

`ctx.connection.authenticators.register(authenticator)` adds a synchronous `ConnectionAuthenticator`: `(request) => PeerScope | undefined`. [`admit()`](../../../../packages/client/connection/src/rpc-host.ts) applies the Host/Origin fence first, then asks each authenticator in registration order, then checks browser and API credentials. An authenticator answers only for requests that carry its own credential and never refuses one, so a request whose credential is absent or invalid still reaches owner authentication; an authenticator that throws is logged and passed over. The registration is an effect of the registering fiber. The authenticator creates its Peers with `createPeer()` and owns them, which keeps the creator-owned principal-to-Peers table of the peer principal decision.

The `/api` route and the Gateway WebSocket upgrade through `admitConnection()` use this order, so a non-owner Peer reaches only the Gateway, which checks remote access, and the exact Fetch routes that declare their access below. Every other route that bypasses the Gateway stays owner-only: exact Fetch routes without `access` and dedicated RPC channels answer a non-owner Peer 403, `requestRejection()` answers it 403 for sibling routes such as inspector and open-in-app, and `authorizeIndex()` still consults only owner credentials, so an existing `if (!authorizeIndex(...))` owner check keeps its meaning. `admitIndex()` is the index admission for any principal: it returns an authenticator's Peer without minting a cookie, else `browserPeer` after `authorizeIndex()`, and frontend-static renders the index, including `webserver/index-inject` and the access snapshot, for the Peer it returns.

<a id="exact-fetch-route-access"></a>
### Exact Fetch route access

An exact Fetch route bypasses the Gateway, so it declares its own non-owner rule: `access: { action, resources }` names one remote-access action and, for each resource kind, the query parameter that carries the resource id; an empty map names `global`. For a non-owner request the [shared Fetch handler](../../../../packages/client/connection/src/rpc-host.ts) requires each listed parameter exactly once with a non-empty value, then asks the one authorizer installed through `ctx.connection.fetch.authorize()`, and runs the route only on true. A route without `access`, a composition without an authorizer, a disposed Peer, a missing, empty, or repeated parameter, and a refusal answer 403; the owner skips the check. The [Gateway](../../../../packages/api/gateway/src/index.ts) installs the authorizer as `remoteAccess.decide({ principal, action, resources })`, without `args`, so conditions answer as for a snapshot and Connection holds no remote-access dependency; remote-access already depends on Connection in its tests, so the reverse import would form a project-reference cycle. Requiring one occurrence keeps the checked id equal to the one the route serves, although routes read the query with `get()` (first value) or `Object.fromEntries` (last value).

Each route takes the narrowest action that describes what it serves. The browser's binary upload `/api/session/uploadFileBinary` stages a receipt under the Session its `sessionId` names, as the encoded Remote `fileUploads/upload` does, so it reuses that action on that Session. The Session log download `/api/session.export` and Markdown copy `/api/session.markdown` take the route-specific actions `sessionLog/export` and `sessionLog/markdown` on the Session they name; the archive also holds every subagent descendant's log and the attachments the logs reference, which `sessionLog/export` on the root covers. Reusing `session/events` would have granted downloads to every existing policy that lists it, including liveshare viewers. `/api/file` reads any absolute path the filesystem provider can read, so its route-specific action `mediaReferences/read` is on `global`: a Session id would scope nothing, as with the [store-scoped image reads](2026-10-23-store-scoped-image-reads.md). Deliverables routes such as change summaries and opening files on the box declare nothing and stay owner-only.

### The `edge-member` principal

[`@mumbo/edge-member`](../../../../packages/mumbo/edge-member/README.md) declares `edge-member { email }` and registers one remote-access policy, one authenticator, and member attribution, in that order. The authenticator verifies `x-mumbo-member: <email>.<expiry>.<mac>`: the email is the lowercased address in unpadded base64url, the expiry is Unix seconds, and the MAC is the unpadded base64url HMAC-SHA256 of the first two fields as sent, under the box's member key, compared in constant time. A header expired, more than 600 seconds ahead, malformed, repeated, or signed with another key is not a member. The edge derives the member key per box as HMAC(edge key, `member:` + box id), so a header minted for one box fails in every other box, and mints a fresh header that expires five minutes ahead on every proxied request, after stripping any header the browser sent.

One Peer serves every connection of a member, as `browserPeer` serves every owner browser connection, and stays live until the latest header seen for that member expires. The plugin then disposes it: the Gateway closes that member's WebSockets and ends their streams, the client reconnects through the edge, and the fresh header creates a new Peer. A header checked once at a WebSocket upgrade therefore cannot keep a removed member connected.

### Collaborator access

The policy gives every member the same bindings: a `global` role for starting a Session, for the Session list, search, control, model catalog, preset and provider lists, commands, and Workspace following, and for the file media references a transcript shows (`mediaReferences/read`); a Workspace role (`workspace/follow`, `session/create`) on every Workspace; and a Session role on every Session a Workspace lists and every live Session, which covers subagent children while they run. The Session role reads and follows the Session and its jobs and workspace files, prompts and cancels it, answers its questions, uploads through `fileUploads/upload` over the Remote or the browser's binary route, downloads its log archive and copies it as Markdown (`sessionLog/export`, `sessionLog/markdown`), receives its notifications, and lists `session/create` so that reusing a listed blank Session, which resolves to both the Workspace and that Session, is allowed. No role lists a settings, credentials, plugin, fork, rename, model-selection, queue-edit, or Workspace-administration action, so remote access refuses them by default; a queue edit keeps the edited message's source and would record one person's text as another's. The bindings are cached and rebuilt after `session/created`, `session/disposed`, or a committed Workspace-domain change, and each rebuild calls `remoteAccess.invalidate()` so access snapshots follow. The Workspace registry emits `domain/changed` before its entity holds the new Session list, so that rebuild waits until the emitting write has settled; otherwise a member's snapshot would miss the Session they just created and the client would offer no composer for it.

### Member attribution

Principals stay out of model requests, so recording `principal` alone does not tell the coordinator who wrote a message. An `agent/pre-step` listener inserts, before each entering message whose principal is `edge-member`, one user-role notice with source `{ kind: 'mumbo-member', form: 'notice' }` and the text `The next message is from project member <email>.` The notice enters the Session log with the message, so the model request stays reconstructable from the log and a resumed Session replays it. The edge's text prefix is no longer needed for messages a member sends through the box's own page.

### Threat model

| Actor | Can | Cannot |
|---|---|---|
| Browser of a member | Act as that member through the edge | Present its own `x-mumbo-member`; the edge strips it |
| Holder of a captured header | Act as that member in that box until the header expires, at most ten minutes | Use it in another box, extend its expiry, or change its email |
| Member, through Remote calls and granted exact routes | Read, follow, prompt, upload to, and export every granted Session; read every file the box's filesystem provider can read through `/api/file` | Call settings, credentials, plugin, or queue-edit methods, or reach other routes outside the Gateway |
| Member, through the agent's tools | Direct the coordinator, whose tools run unconfined under Full access with approval `never` | Be contained: those tools can read `MUMBO_MEMBER_KEY` and the owner's cookie signing record, and so forge other members' headers or an owner cookie |

The access policy separates members from the owner at the Remote API and attributes their messages; it is not a containment boundary against a member who directs the agent to escalate. Members are trusted collaborators until the box runs tools under a separate identity or only in its child sandboxes.

### Owner token and approvals in project boxes

The edge stops handing members the owner launch token for project paths, so members act only as themselves. The Host still accepts the owner cookie; only the edge holds it, for administration. A project box loads [`deploy/mumbo-project.overlay.yml`](../../../../deploy/mumbo-project.overlay.yml), which mounts the plugin and sets the approval policy and every permission preset to `never`. Non-owners cannot answer owner approvals, and no owner sits at a project box's browser, so an `ask` would leave a member's turn waiting indefinitely. Under Full access no command needs escalation, and `never` rejects any other ask at once. Consent for account writes stays in person boxes, where the owner is the user at the browser.

## Alternatives considered

**Keep signing members in as the owner and name them in the message text.** It needs no harness change, but the durable log records the owner as the author, a member's text in the box's own page carries no name, and every member holds owner power over settings and credentials.

**A liveshare-style relay channel per member.** Liveshare creates viewer Peers on its own channel, but the edge already proxies ordinary HTTP and WebSocket traffic; a relay would duplicate the web client's transport for every project request.

**Admit members inside Gateway or remote access.** Admission produces the Peer that every later check reads, so the Peer has to exist before the Gateway runs; admitting inside the Gateway would leave the index and WebSocket upgrades with a different answer than `/api`.

**Change `authorizeIndex()` to return the admitted Peer.** It avoids a second method, but `if (!authorizeIndex(...))` still compiles against a Peer result, so every existing owner check would silently start serving members.

**An Ed25519 edge signature, so the box holds only a public key.** It stops code inside a box from forging other members' headers, but that code can also read the owner's cookie signing record and the Session log, so attribution would still not survive a member who directs the agent to escalate; containment of the tools is the boundary that matters.

**Render the principal inside the model adapters.** It would avoid extra log events, but adapters read only the model-facing source, and a model-visible input that is not its own log event breaks the rule that every model request is reconstructable from the log.

**A kind-wide binding in remote access, such as every Session.** It would avoid enumerating Sessions, but it changes the generic decision and snapshot formats for one consumer; enumeration uses the existing exact-resource rules.

**A per-member allowlist or revocation list inside the box.** The edge owns project membership and signs only current members with a short expiry, so the box would hold a copy that can drift; removal takes effect when the last header expires.

**Connection calls remote access itself.** It needs no authorizer, but Connection would import remote-access, which already depends on Connection, and generic transport would carry the PDP's API.

**Each route decides inside its own `fetch(request, peer)`.** It allows body-derived resources, but every route would repeat the decision and its default, and a route that forgot it would serve every non-owner.

**A resource-reader function per route.** It is more flexible than a parameter map, but each reader would validate its own wire values; the map keeps the one-occurrence and non-empty checks in Connection, and exact routes carry their ids in the query.

**`/api/file` with a required `sessionId`.** It mirrors `session/attachment`, but the Session would constrain no path, every client that builds file URLs and the version redirect would have to carry it, and a grant on `global` matches what the route can read.

**An `ask` policy answered by an edge-side answerer.** It keeps an approval point in project boxes, but no person is there to answer, and a project box holds nothing an approval would protect.

## Consequences

Any plugin can now admit a non-owner HTTP principal without changing Connection, and every route outside the Gateway stays owner-only until it declares access. Members appear as `principal: { kind: 'edge-member', email }` on their messages and the coordinator reads a notice naming each one, at about ten tokens per member message. Members cannot open a finished subagent transcript in the page, because no Workspace lists it, although the log download of a granted Session includes it; they upload, render file references, and download or copy Session logs through the four exact routes the policy grants, and `/api/file` lets their browser read any file the box can read without a Session-log entry. An exact route whose resource travels in its request body cannot declare access. A member's WebSockets reconnect once their header expires, at most every ten minutes. A removed member keeps access until the last header the edge minted expires. Members remain owner-equivalent through the agent's tools until project boxes confine them.
