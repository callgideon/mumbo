---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-10-working-directory-chooser

## Summary

Adds the optional chooser field to working-directory/change, written as 'host' when the person or the harness chose the directory.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-10-working-directory-chooser
baseline: false
changes:
  - root: "event:working-directory/change"
    previous: "2026-09-13-working-directory"
    after: "fd2f723414cbeb231552cb531b9180a06efbe412fe40b005e3813db74398a23d"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing records remain valid: an event without chooser reads as the model's choice, which is the confining default, so under model roots a directory of unknown origin outside the roots returns to the original project through a logged change, as before this field existed; without model roots the field changes nothing. Older readers ignore the field: every reader of this event (the working-directory projection, client-ui-forge's panel and worktree views, snapshot checks) reads only cwd, and no reader validates the event body strictly. Writers add the field only to directories the person or the harness set; model changes, recovery, and the first recorded directory keep the old body.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/session/working-directory packages/subagent/subagent: the working-directory suite reads an event without chooser as the model's choice and returns to the original project, keeps a host-set directory outside the roots across a Session restored from its log, and the subagent suite keeps a host-chosen and an inherited host directory after the child's first request.

<a id="dev-note"></a>
## Dev Note

None.
