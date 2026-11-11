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
    after: "460f3f0936c5f42f9c9a3b815c1ce97d240f2a236385667af0302b82705b0ac0"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-09-superagent-message-source"
    after: "049a02254af90583fcdad89f8ca62bbf89b94c2ae6489f0088b90ae997e26531"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-09-superagent-message-source"
    after: "811b1359ada8b3c51d3aae3c3e432b9e1c5038c8ca2ef0b7760bba2d02d8a147"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-09-superagent-message-source"
    after: "af249ed90428da55ddcf7e03214a8acd22de036cc3b56e8767cada4e5e2cf588"
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
