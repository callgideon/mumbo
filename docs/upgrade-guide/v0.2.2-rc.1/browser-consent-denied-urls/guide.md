---
kind: upgrade-guide
description: "The `@mumbo/browser-consent` row now requires a `deniedUrls` list, and a row without it fails to load and mounts no browser."
---

# `@mumbo/browser-consent` requires `deniedUrls`

## Change

[`@mumbo/browser-consent`](../../../../packages/mumbo/browser-consent/README.md#configuration) has a required `deniedUrls` field: schemes, such as `chrome:`, and origins, such as `https://accounts.google.com`, that the browser tools never open or read. A call that names a denied page, or after which the current tab is on one, is refused without asking, and its result is replaced. Every browser call's result, reads included, is also replaced by an error when the current tab cannot be checked after the call, and a browser write while it cannot be checked is refused instead of asked about. `browser_run_code_unsafe`, `browser_network_request`, and any call with a `filename` argument are always refused; `browser_console_messages` and `browser_network_requests` are refused for the rest of a Session once a tab has shown a denied page. Writes on an `allowedSites` origin ask when the page shows a password or payment field. The plugin also asks before every `computer` tool input, and before a screenshot while the browser shows a denied page.

A deployment whose `browser-consent` row has no `deniedUrls` fails plugin load, and its browser tools disappear. Affected: deployments that compose `@mumbo/browser-consent`, such as a person box's overlay.

## Migration

1. Add `deniedUrls` to the `browser-consent` row's `config`. A person box writes:

   ```yaml
   deniedUrls: [chrome:, chrome-untrusted:, chrome-extension:, devtools:, view-source:, file:, https://passwords.google.com, https://pay.google.com, https://payments.google.com, https://myaccount.google.com, https://accounts.google.com]
   ```

   Write `deniedUrls: []` to deny nothing.
2. Remove from `allowedSites` any origin that `deniedUrls` denies; the plugin refuses to load with both.
3. If the deployment mounts `@deepseek-ai/dsh-computer-use-x11`, add `inject: [mumbo-browser-consent]` to its row, so the desktop tool starts only once consent is active.
4. Confirm the migration: start the deployment, check the log has no `mumbo-browser-consent` load error, and ask the assistant to open `chrome://settings`; the browser tool answers `Error: browser_navigate did not run: the assistant may not open a chrome: page.`
