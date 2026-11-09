---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-09-superagent-message-source

English | [中文](2026-11-09-superagent-message-source.zh.md)

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
    after: "c04c341f9be056ec931e297ca2a6b8fd0af2af5044a9f9e47d17898717a5213c"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-09-mumbo-edge-member-principal"
    after: "8365a54d8790bb4bed42f90c2ef0e8878bd15d71710411a1dea6068f0d194437"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-09-mumbo-edge-member-principal"
    after: "26b91610009e78fbae68506f52d06b2af95df1257019d257caf1a708f745cdd2"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-09-mumbo-edge-member-principal"
    after: "e37b05a1ae468930cff046161f29a8a5e5d504779119ea00b88e5853eca8a307"
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
