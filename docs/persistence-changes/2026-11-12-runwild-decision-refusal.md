---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-12-runwild-decision-refusal

## Summary

Adds the kind refusal to runwild/decision: a call refused without asking, which @mumbo/mcp's report-turn gate appends when it refuses a call in a report-started turn of a Run Wild Session, with the tool name as target, the call's arguments as JSON, clipped to 2,000 characters, as summary, and the refusal the model received as reason.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-12-runwild-decision-refusal
baseline: false
changes:
  - root: "event:runwild/decision"
    previous: "2026-11-11-runwild-decision"
    after: "7efee6e1b424788e2c8ed0997a4bb2fed23388d184ce18599bbe7a76cc049e08"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Same Session format version: the change only widens the closed kind union of an existing event. The read path checks event types, not payloads, so a reader that predates the kind still loads a log holding a refusal; no runtime state, projection or replay reads the kind, and the Run Wild record and its view read kind as an open string. Existing logs hold no such kind and stay valid.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/mumbo/mcp/tests/report-turns.spec.ts: bash refused under Run Wild in either listener order appends one refusal with the arguments as JSON, every gated tool appends one, a call with long arguments logs a clipped summary, and a delegated child's refusal goes to the child's Session; the keyless mumbo-report-shell Web snapshot replays the refusal in its Session log.

<a id="dev-note"></a>
## Dev Note

None.
