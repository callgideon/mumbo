---
description: "Consent for browser writes in a person's own signed-in Chromium, for deployments that compose the Playwright MCP browser provider with the approval service."
kind: "package-reference"
---

# @mumbo/browser-consent

English | [中文](README.zh.md)

## Summary

`@mumbo/browser-consent` enforces "reads are free, writes ask" for the Playwright MCP browser provider, whose tools act in the person's own Chromium with their signed-in accounts. Navigation and page reads pass. A click, typing, form fill, upload, or similar action on the current tab proceeds without asking only when that tab's origin is in `allowedSites`; every other write asks the person once through the approval service. Each allowed write is recorded in the Session log with its site, tool, and outcome.

## Table of Contents

- [Configuration](#configuration)
- [Decisions](#decisions)
- [Audit record](#audit-record)
- [Composition](#composition)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="configuration"></a>
## Configuration

| Field | Default | Meaning |
|---|---|---|
| `allowedSites` | `[]` | Origins, such as `https://mail.google.com`, where current-tab writes proceed without asking. |

An entry that is not an exact `http:` or `https:` origin, such as one with a path or a trailing slash, fails plugin load. Matching is exact: `https://mail.google.com` does not cover `https://docs.google.com` or `http://mail.google.com`. The generated [configuration catalog](../../../docs/config-catalog.md#mumbobrowser-consent) is the exhaustive source for accepted fields.

<a id="decisions"></a>
## Decisions

The plugin gates every tool named `mcp__playwright-mcp__<tool>` and leaves other tools alone. Each call falls into one of three kinds:

| Kind | Upstream tools | Decision |
|---|---|---|
| Read | `browser_snapshot`, `browser_take_screenshot`, `browser_find`, `browser_console_messages`, `browser_network_requests`, `browser_network_request`, `browser_wait_for`, `browser_navigate_back`; `browser_navigate` to an `http:` or `https:` URL; `browser_tabs` `list`, `select`, and `new` without a URL or with a web URL | Passes. |
| Site write | `browser_click`, `browser_type`, `browser_fill_form`, `browser_press_key`, `browser_select_option`, `browser_hover`, `browser_drag`, `browser_drop`, `browser_file_upload`, `browser_handle_dialog`, `browser_resize`, `browser_close` | Proceeds when the current tab's origin is allowed; otherwise asks. |
| Unbounded | `browser_evaluate`, `browser_run_code_unsafe`, navigation to any other scheme, `browser_tabs` `close`, and every tool not listed here | Always asks. |

Before deciding a write, the plugin reads the current tab from Playwright itself by calling the same Session's `browser_tabs` tool with `list`, so the site is the tab the action runs on, not the page the model names. Upstream does not escape page titles in that listing; a listing that cannot be read without ambiguity, a failed listing, or a non-web page leaves the site unknown, and the write asks. The approval request names the tool, the site, and the model's `element` description, labelled as the assistant's; under the `never` approval policy, or without an approval service, every write that would ask is denied.

A guard registered with `ctx.tools.guard()` denies any write that reaches dispatch without a consent this plugin recorded, so another `tools/pre-execute` listener cannot allow a write, and a call without an Agent cannot run a write. Unloading the plugin removes the guard and its listeners; writes then run without consent.

<a id="audit-record"></a>
## Audit record

When an allowed write's result is final, the plugin appends `browser-consent/write` to the Session: `callId`, the upstream `tool`, `site` when the current tab's origin was read, `grant` (`site` for an allowance, `approval` for a one-shot approval), and `outcome` (`succeeded` or `failed`; `failed` includes a refusal by a later policy). Denied writes leave no record of their own; the approval service's `approval/asked` and `approval/decided` record every question and answer. The [persistence catalog](../../../docs/persistence-catalog.md) owns the exact payload.

<a id="composition"></a>
## Composition

Mount it beside the provider, after `dsh-user-approval`, which the shipped profiles already include:

```yaml
- insert:
    - id: browser-use
      name: '@deepseek-ai/dsh-browser-use'
    - id: browser-use-box-chromium
      name: '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp'
      config:
        mode: attach
        endpoint: http://127.0.0.1:9222
    - id: browser-consent
      name: '@mumbo/browser-consent'
```

The plugin requires only `tools`; it reads the approval service on each write.

<a id="model-experience"></a>
## Model Experience

### Denied browser write

#### What the model sees

A denied write's tool result replaces the browser's answer with one error line naming the upstream tool and the site, or `an unidentified page`: `Error: The user declined <tool> on <site>.`, `Error: The approval request for <tool> on <site> was cancelled.`, or `Error: <tool> on <site> needs the user's approval, and no approval channel is available.` A write that reached dispatch without consent returns `Error: <tool> needs the user's consent, which was not given.` Allowed writes and reads return the browser's ordinary result; the approval question and the audit record are not model context.

#### Token effect

A denial replaces the browser's result with one short line; allowed calls add no tokens.

#### KV Cache effect

Append-only. The result follows the Session's existing history like any tool result.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Only the Playwright MCP provider is gated** — the tool-name prefix and classification follow the pinned `@playwright/mcp` server; another browser provider's tools pass ungated, and an upstream tool added later asks until it is classified.
- **The site is read before the action, not during it** — a page that navigates itself between the listing and the action runs the action on its new origin; a click inside a cross-origin frame counts as the top-level page's site.
- **Navigation is a read** — a `GET` that changes state, such as a one-click unsubscribe link, runs without asking.
- **Allowances are per site, not per kind of action** — an allowed origin permits every site write there, posting and buying included.
- **Allowances live in Config** — changing `allowedSites` reloads the plugin, and anything that can edit the deployment's configuration files can grant itself an allowance; no Client page manages them.
- **The audit record has no Client renderer** — it is in the Session log and its exports, not in the Chat.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
