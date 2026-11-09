---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-09-mumbo-edge-member-principal

English | [中文](2026-11-09-mumbo-edge-member-principal.zh.md)

## Summary

Adds the mumbo edge-member principal, the lowercased email of a project member the mumbo edge signed in, to the user-rpc message source of prompts that member submits.

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
    after: "94d82fab378cb081d77a8603c795f13469649a1aeae093f58ac21472f5c471da"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-05-mcp-message-source"
    after: "fa865b9afe18915d90a67483e71691057fda0a04ff06ba2a5cf5a18f80471e5c"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-05-mcp-message-source"
    after: "a3c6fcc2bd58a457b862b4cd7b2dc43b1d32a011c80bab76a041a4c080d077c1"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-05-mcp-message-source"
    after: "6013b34796c91846aaf7213719093beff90a701f787aa5f7e4b6db968d3bc02a"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The edge-member variant is written only for a prompt whose Peer the @mumbo/edge-member authenticator admitted; owner prompts still omit principal, so their sources and every existing Session log are unchanged. The value carries only the kind and the lowercased email the edge signed, never the header, key, or expiry. The kind stays 'user', so a build without the package keeps the message an ordinary user message, and a principal kind a reader does not drive is left to whoever drives it. A current reader of an older log finds no edge-member principal and treats those prompts as before. The field is not part of any model request. SESSION_FORMAT_VERSION does not change.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/mumbo/edge-member packages/client/connection: a request carrying a correctly signed x-mumbo-member header reaches session/prompt through the real Loader composition (Web carrier, Connection, Gateway, remote access) as { kind: 'edge-member', email }, while tampered, expired, too-distant, foreign-key, and missing headers are refused with 401; 9 edge-member tests and the Connection suite passed.

<a id="dev-note"></a>
## Dev Note

None.
