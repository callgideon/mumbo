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
    after: "bd96daa382c463073faa1602b1cf67ed55bab7637b0fe6f5799b857c013e1679"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-11-mumbo-report-message-source"
    after: "20678fb82d2bb27b41e7a910f1d03038fc351b6c2821aadca1767019ab3d5660"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-11-mumbo-report-message-source"
    after: "d42bd115b2d7bccdc5f25ebeffde2d02e86ce58a88b87df8a774cab8f73d8b02"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-11-mumbo-report-message-source"
    after: "351a2589afa8ab19a15b4c851b885b31103f339d52a681df82bc1d16d4e783fa"
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
