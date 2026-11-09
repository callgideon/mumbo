---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-09-mumbo-edge-member-principal

English | [中文](2026-11-09-mumbo-edge-member-principal.zh.md)

## Summary

Adds the mumbo edge-member principal, the lowercased email of a project member the mumbo edge signed in, to the user-rpc and retry-rpc message sources of prompts that member submits, and the mumbo-member notice source that names that member before each such message.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-09-mumbo-edge-member-principal
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-05-mcp-message-source"
    after: "12bf9822316484478396044ced9fd85d113028c288b5854dd12e3fe23a6081d5"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-05-mcp-message-source"
    after: "4ff746fb6f467e9b89f92df53476a10c26638d57572ec0f94046fd4cf810d104"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-05-mcp-message-source"
    after: "40dd32765c49c5177ceb86fc8383b4bd19858e3b445cbb4abf5d3820309c25e4"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-05-mcp-message-source"
    after: "2ad95fc11778969450c02aa9d23f1716e820f8ce4bec00d8a00be9f8c85e4e85"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The edge-member variant is written only for a prompt whose Peer the @mumbo/edge-member authenticator admitted; owner prompts still omit principal, so their sources and every existing Session log are unchanged. The principal carries only the kind and the lowercased email the edge signed, never the header, key, or expiry. The kind stays 'user', so a build without the package keeps the message an ordinary user message, and a principal kind a reader does not drive is left to whoever drives it. The mumbo-member source marks a user-role notice, form 'notice' with its one-line summary, that the package inserts before each member message; it enters the request like any other user-role context message, so a reader without the package replays it as ordinary user text and the replayed request matches the logged one. A current reader of an older log finds neither variant and treats those messages as before. The principal is not part of any model request. SESSION_FORMAT_VERSION does not change.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/mumbo/edge-member packages/client/connection: a request carrying a correctly signed x-mumbo-member header reaches session/prompt through the real Loader composition (Web carrier, Connection, Gateway, remote access) as { kind: 'edge-member', email }, while tampered, expired, too-distant, foreign-key, repeated, and missing headers are refused with 401; a real AgentLoop step logs the mumbo-member notice immediately before the member's message and sends both to the model, and an owner-only step logs no notice; 18 edge-member tests and the Connection suite passed.

<a id="dev-note"></a>
## Dev Note

None.
