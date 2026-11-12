---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-12-mumbo-resume-message-source

## Summary

Adds the mumbo-resume message source: the user-role notice @mumbo/state logs at the first step after a Session restart, naming the background jobs, workflow runs and subagents the restart stopped or that finished meanwhile, and a goal that waits for a person. It declares the notice context form with its one-line summary.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-12-mumbo-resume-message-source
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-11-mumbo-report-message-source"
    after: "cbc55234946ff1c1bbfd3ecc5ca6693ea43fdbc5a52e39d140fb893a57b52101"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-11-mumbo-report-message-source"
    after: "1bd0efa8ba71f72807c40cde096d850a7d763e9aa5620b867d48a323721895aa"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-11-mumbo-report-message-source"
    after: "455cbe98b3a8e5024fc8a7fbd80a450407395b4c355a61f76f58e6775ebf7ce5"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-11-mumbo-report-message-source"
    after: "5d43415dabe040132520f6263d384342e3c0c4165ba14f6b5d00d6699783a168"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing logs contain no such source and remain valid. The source attributes an ordinary user-role message whose content is the notice text; readers fall through unknown source kinds and keep the message and its content, so a reader without @mumbo/state loads such a log, shows the message as an injected-context row, and the replayed request matches the logged one. Only @mumbo/state's agent/pre-step listener writes it, through the step's admitted messages; its own host-only mumboState projection reads it to clear the recorded restart, and @mumbo/mcp's report-turn gate reads its context form, which names no turn origin. A current reader of an older log finds no such source and treats its messages as before. No event type or Session header changes, and SESSION_FORMAT_VERSION does not change.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/mumbo/state packages/mumbo/mcp/tests/report-turns.spec.ts: the notice is logged once in the first step after a crash or a graceful stop, never in a later step, joins no rejected or aborted step, and leaves a report-started turn report-started and a person's turn person-started; packages/mumbo/state/src at 100% coverage.

<a id="dev-note"></a>
## Dev Note

None.
