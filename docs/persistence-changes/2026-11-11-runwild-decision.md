---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-11-runwild-decision

## Summary

Adds runwild/decision: the log-only audit record @mumbo/run-wild appends for each ask it decided instead of the person in a Run Wild Session, with the closed kind union approval, plan-review or question, the target, the ask's text, and the reason.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-11-runwild-decision
baseline: false
changes:
  - root: "event:runwild/decision"
    previous: null
    after: "1dab61b35564c8ba58b6343d7bc66e3ca4ddbaa00c42e317e4f4c12a8e06c36a"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

A new root in the same Session format version, with a closed kind union; added kinds need their own record. Existing logs contain no such event and stay valid. Readers that predate it refuse a log carrying it, as every required-on-read event does, so rolling a box back to an image without it leaves each Session in which Run Wild decided something, mumbo included, unreadable; that consequence is accepted and stated in the package README. Only @mumbo/run-wild appends it, inside the turn of the tool call that asked; it is never model-visible, and no runtime state, projection, or replay reads it.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/mumbo/run-wild --coverage: 14 tests passed with 100% coverage of packages/mumbo/run-wild/src; the Loader composition test asserts the appended records after a turn that runs exit_plan_mode, ask_user_question and a tool whose policy asks.

<a id="dev-note"></a>
## Dev Note

None.
