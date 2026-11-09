---
description: "Consent for browser writes in a person's own signed-in Chromium, for deployments that compose the Playwright MCP browser provider with the approval service."
kind: "package-reference"
---

# @mumbo/browser-consent

## Summary

`@mumbo/browser-consent` enforces "reads are free, writes ask" for the model's browser tools in the person's own signed-in Chromium. It mounts the Playwright MCP browser provider itself, so those tools exist only while consent is loaded with a valid configuration. Navigation and page reads pass. A click, typing, form fill, or similar action on the current tab proceeds without asking only when that tab's origin is in `allowedSites`; every other write asks the person once through the approval service, showing its arguments. Each allowed write is recorded in the Session log with its site, tool, and outcome.

## Table of Contents

- [Configuration](#configuration)
- [Decisions](#decisions)
- [Provider ownership](#provider-ownership)
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
| `browser` | required | Settings of the mounted [Playwright MCP provider](../../experimental/browser-use-playwright-mcp/README.md), such as `mode: attach` and `endpoint`. |
| `allowedSites` | `[]` | Origins, such as `https://mail.google.com`, where current-tab writes proceed without asking. |
| `approvalTimeoutMs` | `300000` | How long a write waits for the person's answer before it is denied as unanswered. |

An `allowedSites` entry that is not an exact `http:` or `https:` origin, or a `browser.endpoint` that is not a valid URL, fails plugin load; for an allowed site the error names the origin to use when the entry has one, such as `https://mail.google.com` for `https://mail.google.com/`. Matching is exact: `https://mail.google.com` does not cover `https://docs.google.com` or `http://mail.google.com`. The generated [configuration catalog](../../../docs/config-catalog.md#mumbobrowser-consent) is the exhaustive source for accepted fields.

<a id="decisions"></a>
## Decisions

The plugin gates every tool named `mcp__playwright-mcp__<tool>` and leaves other tools alone. Each call falls into one of three kinds:

| Kind | Upstream tools | Decision |
|---|---|---|
| Read | `browser_snapshot`, `browser_take_screenshot`, `browser_find`, `browser_console_messages`, `browser_network_requests`, `browser_network_request`, `browser_wait_for`, `browser_navigate_back`, `browser_navigate_forward`; `browser_navigate` to an `http:` or `https:` URL; `browser_tabs` `list`, `select`, and `new` without a URL or with a web URL | Passes. |
| Site write | `browser_click`, `browser_type`, `browser_fill_form`, `browser_press_key`, `browser_press_sequentially`, `browser_keydown`, `browser_keyup`, `browser_select_option`, `browser_check`, `browser_uncheck`, `browser_hover`, `browser_drag`, `browser_handle_dialog`, `browser_resize`, `browser_reload`, `browser_close`; `browser_drop` without `paths` | Proceeds when the current tab's origin is allowed; otherwise asks. |
| Always ask | `browser_evaluate`, `browser_run_code_unsafe`, `browser_file_upload`, `browser_drop` with `paths`, navigation to any other scheme or a scheme-less URL, `browser_tabs` `close`, and every tool not listed here | Asks even on an allowed site. |

Before deciding a write, the plugin reads the current tab from Playwright itself by calling the same Session's `browser_tabs` tool with `list`, so the site is the tab the action runs on after redirects, link clicks, and tab switches, not the page the model names. Upstream does not escape page titles in that listing; a listing that cannot be read without ambiguity, a failed listing, or a non-web page leaves the site unknown, and the write asks.

The approval request names the tool and the site, lists the arguments the tool's input schema declares as JSON (typed text, form values, keys, uploaded paths, code to run, URLs, dialog answers), and gives the model's `element` description apart as model-written. Keys the schema does not declare are counted but not shown, because the tool ignores them and the model could otherwise write into the prompt through them; arguments that are not a JSON object are not shown at all. Keys and values are cut at 300 characters with a count of what was cut, arguments past 1,200 characters are counted as not shown, and invisible format characters are percent-encoded, because the Web approval card shows this text as its title. Approving a write approves the whole call, including any argument the prompt cuts or leaves out. A write is denied when the person declines, when no answer arrives within `approvalTimeoutMs`, when no answerer is available, or when the Session's approval policy is `never`; a cancelled request, such as an interrupted turn, cancels the call.

The `tools/pre-execute` listener registers with `prepend`. A guard registered with `ctx.tools.guard()` denies any write that reaches dispatch without a consent this plugin recorded, so another listener that allows a write or asks its own question cannot let it through, and a call without an Agent cannot run a write.

<a id="provider-ownership"></a>
## Provider ownership

The plugin registers its guard and listeners, provides a service, and mounts `@deepseek-ai/dsh-experimental-browser-use-playwright-mcp` as its child with the `browser` settings and that service added to the child's requirements. The provider therefore starts only once the gate is active, and invalid configuration mounts no browser at all; unloading the plugin unloads the provider and removes its browser tools before the guard goes. Whenever another provider holds `browserUse` in place of the child, whether its row loaded before this plugin or took the registration before the child started, the plugin refuses every call to that provider's tools, reads included, decides this on each call, and logs an error naming the provider. It knows the tool prefixes of the Playwright MCP (`mcp__playwright-mcp__`), Chrome DevTools MCP (`mcp__chrome-devtools-mcp__`), and Stagehand (`stagehand_`) providers. A provider with another name already holding `browserUse` at load fails this plugin's load; one that takes it after load is reported as not under consent, because its tools cannot be told apart. While the child holds `browserUse`, no other browser-use provider can register, but a browser reached through a plain MCP server row is outside this plugin. Mount the provider only through this plugin.

<a id="audit-record"></a>
## Audit record

When an allowed write's result is final, the plugin appends `browser-consent/write` to the Session: `callId`, the upstream `tool`, `site` when the current tab's origin was read, `grant` (`site` for an allowance, `approval` for a one-shot approval), and `outcome` (`succeeded` or `failed`; `failed` includes a refusal by a later policy). Denied writes leave no record of their own; the approval service's `approval/asked` and `approval/decided` record every question, including its argument summary, and its answer. The [persistence catalog](../../../docs/persistence-catalog.md) owns the exact payload.

<a id="composition"></a>
## Composition

Mount it beside the `browserUse` registry, with `dsh-user-approval`, which the shipped profiles already include:

```yaml
- insert:
    - id: browser-use
      name: '@deepseek-ai/dsh-browser-use'
    - id: browser-consent
      name: '@mumbo/browser-consent'
      config:
        browser:
          mode: attach
          endpoint: http://127.0.0.1:9222
```

The plugin requires the provider's services; it reads the approval service on each write.

<a id="model-experience"></a>
## Model Experience

### Denied browser write

#### What the model sees

A denied write's tool result replaces the browser's answer with one error line naming the upstream tool and the site, or `an unidentified page`: `Error: The user declined <tool> on <site>.`, `Error: <tool> on <site> got no answer from the user within <seconds> seconds.`, `Error: Approval prompts are disabled in this session, so <tool> on <site> did not run.`, or `Error: <tool> on <site> needs the user's approval, and no approval channel is available.` A write that reached dispatch without consent returns `Error: <tool> needs the user's consent, which was not given.`, and a cancelled approval returns the tool runtime's `Error: tool call aborted before dispatch`. While another provider holds the browser, every browser call returns `Error: <tool> did not run: browser tools are disabled because this browser was set up without consent checks.` Allowed writes and reads return the browser's ordinary result; the approval question and the audit record are not model context.

#### Token effect

A denial replaces the browser's result with one short line; allowed calls add no tokens.

#### KV Cache effect

Append-only. The result follows the Session's existing history like any tool result.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Not a security boundary in a box** — the plugin gates the model's browser tools only. In a box the model also has a root shell in Full access with no per-command ask, so it can reach Chromium's debugging port at `127.0.0.1:9222` directly, for example with `curl` or `playwright-core`, and read the browser profile directory. Consent becomes a boundary only once the browser runs outside the reach of the dsh user, which is a platform decision.
- **Allowances live in files the model can edit** — `allowedSites` and the rest of the deployment's configuration, including its MCP server rows, are files the same shell can change, and changing `allowedSites` reloads the plugin; no Client page manages allowances.
- **Only the mounted Playwright MCP provider is consented** — the classification follows the pinned `@playwright/mcp` server, and an upstream tool added later asks until it is classified. Another browser-use provider's tools are refused outright or, for an unknown provider that takes `browserUse` after load, left ungated with an error; a browser reached through a plain MCP server row passes ungated.
- **The site is read before the action, not during it** — a page that navigates itself between the listing and the action runs the action on its new origin; a click inside a cross-origin frame counts as the top-level page's site.
- **Navigation is a read** — a `GET` that changes state, such as a one-click unsubscribe link, runs without asking, and a navigation can carry page data to any URL.
- **Allowances are per site, not per kind of action** — an allowed origin permits every site write there, posting and buying included.
- **The audit record has no Client renderer** — it is in the Session log and its exports, not in the Chat.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
