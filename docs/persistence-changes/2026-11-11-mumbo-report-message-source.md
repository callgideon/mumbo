---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-11-mumbo-report-message-source

## Summary

Adds the report message source: a user-role message in which the @mumbo/mcp door logs a project's report that the mumbo edge relayed from the project's coordinator to a member, carrying the project id and no principal.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-11-mumbo-report-message-source
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-09-superagent-message-source"
    after: "1fb2851147546fda5469e194f4cbc22a365212bc67743b25437409a18c0e7ab3"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-09-superagent-message-source"
    after: "a6e60a5d49b90f45dafa963ae09d6afb4fbd2f4c26d8ddc4fcdc0b6b4d0fb5bd"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-09-superagent-message-source"
    after: "8818bace1293b732ebd14b16ba67ebb5fe2870114a744208cf145f7fe97e8a4d"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-09-superagent-message-source"
    after: "cb1225ecba7ed1fbb802a03d2b40be5d97d573e08e13f2f21db75b7bb9f5af32"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing logs contain no such source and remain valid. The source attributes an ordinary user-role message whose content is the relayed text; readers fall through unknown source kinds and keep the message and its content, so a reader without @mumbo/mcp loads such a log and shows the message as an injected-context row labelled report, and the replayed request matches the logged one. Only agent_send writes it, through Agent.followup, on a request the edge marks with x-mumbo-report-project. agent_read lists it as report:<project>; no other reader depends on the kind. A current reader of an older log finds no such source and treats its messages as before. No event type or Session header changes, and SESSION_FORMAT_VERSION does not change.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/mumbo/mcp apps/cli/tests/mumbo-plugins-resolve.spec.ts: 133 tests passed, covering a report logged as sent with source report and listed by agent_read as report:<project>, a send without the header still from the principal, and malformed or combined headers and an unlisted principal refused; packages/mumbo/mcp/src at 100% coverage. pnpm run verify-persistence-changes and pnpm run verify-persistence-catalog passed after recording.

<a id="dev-note"></a>
## Dev Note

None.
