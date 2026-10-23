---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-23-mcp-message-source

English | [中文](2026-10-23-mcp-message-source.zh.md)

## Summary

Adds the mcp message source: a user message an allowlisted person sent through the @mumbo/mcp door, carrying the person's handle as principal.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-23-mcp-message-source
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-13-user-rpc-principal"
    after: "32bb18c82053221f1c275ddecc88711f2520a2bfe8bb745fea65ed955b33e353"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "a226c7c957f9eb496a92fb3b132797325468a2a754d41a317e2f985474a81325"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-13-user-rpc-principal"
    after: "d93853442c28d0bd3523c19374449a0ce11fcedf74ca1d89ae13c700f0a9ef98"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "42b59da9feb7097bd2ccb03dc3b689c3036f3a8244409d57a79bb662afd3a141"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing logs contain no such source and remain valid. The source attributes an ordinary user message; readers fall through unknown source kinds and keep the message and its content, so a reader without @mumbo/mcp loads such a log and shows the message as an injected-context row labelled by its kind. Chat labels it mcp:<principal> when principal is a string. Only agent_send writes it, through Agent.followup. No event type or Session header changes.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/mumbo/mcp/tests --coverage: 53 tests passed with 100% coverage of packages/mumbo/mcp/src. pnpm exec vitest run packages/client/ui-chat/tests/event-projection.client.spec.ts packages/client/ui-chat/tests/turn-trigger.client.spec.tsx: 32 tests passed.

<a id="dev-note"></a>
## Dev Note

None.
