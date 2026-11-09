---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-09-browser-consent-write

## Summary

Adds browser-consent/write: the log-only audit record @mumbo/browser-consent appends for each browser write it allowed, with the site, upstream tool, grant, and outcome.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-09-browser-consent-write
baseline: false
changes:
  - root: "event:browser-consent/write"
    previous: null
    after: "2980b9eb6c37399ed3b106cf3165f80e7f527850c682a24df9878f2b29c3c79d"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

A new root in the same Session format version. Existing logs contain no such event and stay valid; readers that predate it refuse a log carrying it, as every required-on-read event does. Only @mumbo/browser-consent appends it, after a Playwright MCP browser write's final result; it is never model-visible, and no runtime state, projection, or replay reads it.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/mumbo/browser-consent --coverage: 7 tests passed with 100% coverage of packages/mumbo/browser-consent/src; the Loader composition test asserts the appended records. DSH_BROWSER_EXECUTABLE=<chromium> pnpm exec vitest run --config vitest.e2e.config.ts packages/mumbo/browser-consent: 1 test passed against the pinned Playwright MCP server and a real Chromium.

<a id="dev-note"></a>
## Dev Note

None.
