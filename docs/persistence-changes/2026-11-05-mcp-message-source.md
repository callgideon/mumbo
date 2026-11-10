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
    previous: "2026-10-27-retry-control-input"
    after: "ac9cd191a7434ef0964ce1598f0881b4b2c8beabea02a7df6cacabde017d1162"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-27-retry-control-input"
    after: "94ced8dbc80cd7d35eb508b5b2784c87f94b1900594d5ae2242685f860f53509"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-27-retry-control-input"
    after: "8e938d968d77d8bd97c62ab9c16113518d2f0d43c946059855cdd6887d757002"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-27-retry-control-input"
    after: "349ba8a544d17196a4d447994432d2ab71df1539e4b37d985f03f424594c5d03"
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
