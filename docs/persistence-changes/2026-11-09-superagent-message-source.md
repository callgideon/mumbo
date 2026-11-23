---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-09-superagent-message-source

## Summary

Adds the dsh-superagent message source: a user-role message the @mumbo/superagent runtime delivers to its main Session or an Executor Session, form relay for a Trigger card or report it queues or steers, and form notice with its one-line summary for a notice it injects without starting a turn.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-09-superagent-message-source
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-09-mumbo-edge-member-principal"
    after: "d109121e52f1d1d63e16e01aecb89e64b3cf6fcd36cbfe353115e11f8a181839"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-09-mumbo-edge-member-principal"
    after: "162518e99217e6a9b0ffda6cf05480bc567a81147b540c2c0f2da41d6993f836"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-09-mumbo-edge-member-principal"
    after: "d887c6ef21e7eb0b221446108a42264e718cad7273a3afa26ce8fa6f07a3ae7c"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-09-mumbo-edge-member-principal"
    after: "7586e0ef19b4dc0040545216bcd6c98c42ca4d21f81ac92ba6146a4177a99771"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing logs contain no such source and remain valid. The source attributes an ordinary user-role message whose content is the delivered text; readers fall through unknown source kinds and keep the message and its content, so a reader without @mumbo/superagent loads such a log and shows the message as an injected-context row labelled by its kind, and the replayed request matches the logged one. The form alternatives are the shared ContextFormed alternatives, and the runtime writes only relay and notice. The runtime reads its own kind and the message id, dsh-superagent: followed by the request id, only to resume duplicate suppression after a restart; no other reader depends on the kind. A current reader of an older log finds no such source and treats its messages as before. No event type or Session header changes, and SESSION_FORMAT_VERSION does not change.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/mumbo/superagent/tests/delivery.spec.ts: 15 tests passed, covering delivery once per request id across restored history and pending inboxes. pnpm exec vitest run packages/client/ui-chat/tests/event-projection.client.spec.ts packages/client/ui-chat/tests/turn-trigger.client.spec.tsx: 48 tests passed. pnpm run verify-persistence-changes and pnpm run verify-persistence-catalog passed after recording.

<a id="dev-note"></a>
## Dev Note

None.
