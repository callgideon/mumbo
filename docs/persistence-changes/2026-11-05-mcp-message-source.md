---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-05-mcp-message-source

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
id: 2026-11-05-mcp-message-source
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-19-cua-input-notices"
    after: "e357a8bfad6fdeb0ce3effa1efd65c28a6a00523973d0927751baa15a32ab79b"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-19-cua-input-notices"
    after: "1c767a5b76e084df1b0c6fba556f956fb2ddd94b740c3a9c4e37f003d325921a"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-19-cua-input-notices"
    after: "998d11ebf99f2f0eaa7e78060fdee67e884eeecac710cb72c48de21f147c7c48"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-19-cua-input-notices"
    after: "b2feaf7d2671df7132717a990cec141c76766f60da4fcb48daadf697f63d17d1"
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
