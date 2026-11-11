---
description: "Consent for the assistant's actions in a person's own signed-in Chromium and on their desktop, with hard-denied pages, for deployments that compose the Playwright MCP browser provider with the approval service."
kind: "package-reference"
---

# @mumbo/browser-consent

## Summary

`@mumbo/browser-consent` enforces "reads are free, writes ask, denied pages never" for the model's browser tools in the person's own signed-in Chromium, and "reads are free, writes ask" for computer use on their desktop. It mounts the Playwright MCP provider itself. A call that names, opens, or finds a page in `deniedUrls` is refused without asking. Current-tab writes on an `allowedSites` origin proceed unless the page shows a password or payment field; other writes and desktop input ask. The Session log records allowed browser writes. While the person has taken over, browser and desktop calls are refused and the connection closed.

## Table of Contents

- [Configuration](#configuration)
- [Denied pages](#denied-pages)
- [Secret inputs](#secret-inputs)
- [Decisions](#decisions)
- [Uploads](#uploads)
- [Computer use](#computer-use)
- [Take over](#take-over)
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
| `browser` | required | Settings of the mounted [Playwright MCP provider](../../experimental/browser-use-playwright-mcp/README.md), such as `mode: attach`, `endpoint`, `outputDir`, and the subprocess `identity` its server runs as. `outputDir` is required: the server's workspace is `uploadStaging`, and the plugin deletes the files of a withheld result only in `outputDir`, so it must be a directory the server's user owns in a root-owned parent. The plugin sets the provider's `fileRoot` to `uploadStaging`, and a configured `fileRoot` fails load. With `identity` the server starts in that identity's home, and the browser mounts only once a subprocess service is mounted: until then this plugin stays loaded without browser tools and logs no error. The subprocess service checks that identity when the browser mounts; a refusal leaves this plugin loaded without browser tools, and Sessions start without them. |
| `deniedUrls` | required | Schemes, such as `chrome:`, and origins, such as `https://accounts.google.com`, that the browser tools never open or read. `[]` denies nothing. |
| `allowedSites` | `[]` | Origins, such as `https://mail.google.com`, where current-tab writes proceed without asking. |
| `approvalTimeoutMs` | `300000` | How long a write waits for the person's answer before it is denied as unanswered. |
| `uploadDirectory` | required | Absolute existing directory, such as `/home/shared/Downloads`, whose files `browser_file_upload` and `browser_drop` may send, each named directly in it. Plugin load fails for a path, or a directory, that does not exist, for a path that is not the directory's real path, and for a directory below one that a user other than root and dsh's own can change; a sticky directory, such as `/tmp`, counts as unchangeable for an entry root or dsh's user owns. |
| `uploadStaging` | required | Absolute existing directory, such as `/var/lib/mumbo/uploads`, where the plugin stages the copy of each file it sends, and the browser server's only file root. It follows the `uploadDirectory` rules, and must also be owned by root or dsh's own user and writable by no other user, or plugin load fails. Give the browser's users read access through a set-group-ID group, such as `root:uploads` mode `2750`. The plugin empties it at load and deletes its own copies when it unloads. |
| `uploadMaxBytes` | `536870912` | Largest file, in bytes, that one upload or drop may send. The staged copies kept together, and the files of one call, stay within four times this. |

`deniedUrls` has no default, so a deployment that omits it fails to load and mounts no browser. A scheme entry is lowercase and ends with its colon; an origin entry is an exact `http:` or `https:` origin without a path, userinfo, default port, or trailing dot. Any other entry fails plugin load, and the error names the form to use when the entry has one, such as `chrome:` for `Chrome:` or `https://accounts.google.com` for `https://accounts.google.com/`. So do entries that would deny nothing intended: `about:`, which names `chrome:` instead, and an origin with a wildcard host such as `https://*.google.com`, which matches no page. A person box denies every non-web scheme and the Google pages that hold passwords, payments, and sign-in:

```yaml
deniedUrls: [chrome:, chrome-untrusted:, chrome-extension:, devtools:, view-source:, file:, https://passwords.google.com, https://pay.google.com, https://payments.google.com, https://myaccount.google.com, https://accounts.google.com]
```

An `allowedSites` entry that is not an exact `http:` or `https:` origin, an `allowedSites` entry that `deniedUrls` also denies, or a `browser.endpoint` that is not a valid URL fails plugin load; for an allowed site the error names the origin to use when the entry has one, such as `https://mail.google.com` for `https://mail.google.com/`. Allowance matching is exact: `https://mail.google.com` does not cover `https://docs.google.com` or `http://mail.google.com`. The generated [configuration catalog](../../../docs/config-catalog.md#mumbobrowser-consent) is the exhaustive source for accepted fields.

<a id="denied-pages"></a>
## Denied pages

A denied page is refused, never asked about, because a question can be approved by reflex. The check runs before and after every call of a tool named `mcp__playwright-mcp__<tool>`, reads included:

- **Before the call**, a `url` argument that names a denied page refuses the call; the browser never receives it. A string that is not a URL is read as Playwright MCP reads it, with `http://` in front when it starts with `localhost` and `https://` otherwise. A write also lists the current tab first, and is refused when that tab is on a denied page or cannot be checked. A `browser_tabs` `select` lists the tabs first and is refused when the tab it selects is on a denied page or is not listed unambiguously, because selecting a tab brings its page to the screen.
- **After the call**, the plugin lists the current tab through the same Session's `browser_tabs` tool and also reads every `- Page URL:` line in the result. When either names a denied page, the result (snapshot, screenshot, text, console, network, or error) is replaced by a refusal. When the tab cannot be checked, because the listing fails, is missing, or stays ambiguous, the result is replaced by an error that names the listing's own failure, such as the refused connection of a browser that is down. Either way the files Playwright MCP linked from the result in its output directory are deleted, so no other tool can read them: by file name in `browser.outputDir` when it is set, otherwise from the `.playwright-mcp` directory under the directory the Session's server started in, which a later Session directory change does not move. This covers a navigation or a click that lands on a denied page and a read while the person has one open. `browser_close` is the one call not checked after, because a listing would reconnect and open a new tab; the close itself was refused before the call when its tab was on a denied page.
- **Logs after a denied page.** Upstream keeps a tab's console messages and requests across navigations that are not its own `browser_navigate`, such as a redirect, a link, or going back. Once any listing or result has shown a denied page in some tab, `browser_console_messages` and `browser_network_requests` are refused for the rest of the Session, before the call.

Tab listings are read from their `### Result` section only, because upstream repeats the tabs under `### Open tabs` as of a later moment. Page titles are not escaped there, so a current-tab line holding `](` more than once is resolved only when it ends with the page URL the call's own result reports, or, before a write, the URL a snapshot reports; otherwise the tab counts as not checkable.

A URL is matched after WHATWG URL parsing, which lowercases the scheme and host, converts an IDN host to punycode, decodes percent-encoded host characters, drops userinfo and the default port, strips surrounding spaces, tabs, and newlines, and reads backslashes as slashes; trailing dots of the host are then ignored. So `HTTPS://Accounts.Google.com.`, `https://accounts.google.com:443/`, and `https://x@accounts.google.com/` all match `https://accounts.google.com`. A scheme entry matches every URL with that scheme. An origin entry matches its exact host and port under both `http:` and `https:`, because Chromium upgrades HSTS hosts such as Google's to `https:` before any request; it does not match subdomains. `view-source:`, `blob:`, and `filesystem:` URLs are denied by their own scheme or by the URL they wrap, so `view-source:https://accounts.google.com/` is denied even without `view-source:` in the list. `about:blank` is never denied: a new tab starts there, and calls on it are decided as on any page. Every other `about:` URL counts as a `chrome:` URL, because Chromium serves `about:<page>` as `chrome://<page>`. A URL that does not parse counts as denied. `data:` and `javascript:` URLs are not in the box list; navigation to them still asks.

`browser_network_request`, which shows one request's headers and bodies, is always refused the same way, by the guard and before any question: request headers carry cookies and form bodies carry passwords. `browser_run_code_unsafe` is refused the same way on every site: it runs model-written code in the Playwright MCP server process rather than the page, and an escape from its sandbox reaches that process. No other tool of the pinned server runs code outside the page; `browser_evaluate` runs a function in the page and asks. `browser_network_requests` lists each request's method, URL, and status only, and stays a read. A call with a `filename` argument is refused too: Playwright would save its output to that path in the working directory, where a withheld result's file deletion does not reach and where it could overwrite a project file without asking. Without `filename`, the output comes back in the result and in Playwright's own output directory.

The refusal names the tool and what denied it, `a <scheme> page` or `a page on <origin>`, never the full URL. A write whose result is withheld after the call still ran; its audit record has outcome `failed`.

<a id="secret-inputs"></a>
## Secret inputs

The repository [patches](../../../patches/playwright-core@1.63.0-alpha-2026-08-31.patch) the `playwright-core` that the pinned Playwright MCP server runs, so a page snapshot, inline or in a file the server writes, shows `••••` in place of an input's or text area's value when any of these holds: the input is `type="password"`; it matches `:autofill` or `:-webkit-autofill`; or its `autocomplete` attribute has a `current-password`, `new-password`, `one-time-code`, or `cc-` token, matched by token and case-insensitively. The mask is fixed, so it reveals neither the value's length nor whether the field is empty. The `:autofill` check is best effort: an unsupported pseudo-class is skipped, and the tests cannot make Chromium autofill. pnpm applies the patch at install, and the install fails when the patch does not apply or when no installed `playwright-core` has its version, so updating `@playwright/mcp` requires re-creating the patch and rerunning the Chromium tests; upstreaming the change to Playwright retires the patch.

Screenshots show a password field as dots, because Chromium draws it so. Revealing it takes the page's own show-password control, a click or hover that asks, on an allowed site too, because the page shows a masked field; reads do not dispatch input to the page. Once the person approves that click, a later screenshot shows the password, although the snapshot still masks a field whose `autocomplete` names a password.

<a id="decisions"></a>
## Decisions

Each browser call that no denial refuses falls into one of three kinds:

| Kind | Upstream tools | Decision |
|---|---|---|
| Read | `browser_snapshot`, `browser_take_screenshot`, `browser_find`, `browser_console_messages`, `browser_network_requests`, `browser_wait_for`, `browser_navigate_back`, `browser_navigate_forward`; `browser_navigate` to an `http:` or `https:` URL; `browser_tabs` `list`, `select`, and `new` without a URL or with a web URL | Passes. |
| Site write | `browser_click`, `browser_type`, `browser_fill_form`, `browser_press_key`, `browser_press_sequentially`, `browser_keydown`, `browser_keyup`, `browser_select_option`, `browser_check`, `browser_uncheck`, `browser_hover`, `browser_drag`, `browser_handle_dialog`, `browser_resize`, `browser_reload`, `browser_close`; `browser_drop` without `paths` | Proceeds when the current tab's origin is allowed and its page shows no masked field; otherwise asks. |
| Always ask | `browser_evaluate`, `browser_file_upload`, `browser_drop` with `paths`, navigation to any other scheme or a scheme-less URL, `browser_tabs` `close`, and every tool not listed here | Asks even on an allowed site. |

Before a site write on an allowed origin, the plugin reads the page's snapshot through the same Session's `browser_snapshot` tool, and asks exactly as on an unlisted site when a field shows the patched snapshot's mask or when the snapshot cannot be read. A click or key press on such a page can reveal a saved password through the page's show-password control, or submit autofilled credentials, which an allowance for the site does not cover. The mask in the snapshot is the single source of the [secret-input rule](#secret-inputs), so this plugin does not repeat it. The read costs one browser call per write on an allowed site; writes elsewhere already ask.

Page script always asks, with the script shown, because a script can read an autofilled password or card number from a form field; `browser_evaluate` is the only page-script tool that runs, and no page-script tool reaches the server process. See [Uploads](#uploads) for `browser_file_upload` and `browser_drop` with `paths`. Before deciding a write, the plugin reads the current tab from Playwright itself by calling the same Session's `browser_tabs` tool with `list`, so the site is the tab the action runs on after redirects, link clicks, and tab switches, not the page the model names. A write on a page that is not a website, such as `about:blank`, asks on `an unidentified page`.

The approval request names the tool and the site, lists the arguments the tool's input schema declares as JSON (typed text, form values, keys, uploaded paths, code to run, URLs, dialog answers), and gives the model's `element` description apart as model-written. Keys the schema does not declare are counted but not shown, because the tool ignores them and the model could otherwise write into the prompt through them; arguments that are not a JSON object are not shown at all. Keys and values are cut at 300 characters with a count of what was cut, arguments past 1,200 characters are counted as not shown, and invisible format characters are percent-encoded, because the Web approval card shows this text as its title. Approving a write approves the whole call, including any argument the prompt cuts or leaves out. A write is denied when the person declines, when no answer arrives within `approvalTimeoutMs`, when no answerer is available, or when the Session's approval policy is `never`; a cancelled request, such as an interrupted turn, cancels the call.

The `tools/pre-execute` listener registers with `prepend`. A guard registered with `ctx.tools.guard()` denies any call that names a denied page and any write that reaches dispatch without a consent this plugin recorded, so another listener that allows a call or asks its own question cannot let it through, and a call without an Agent cannot run a write. The after-call check is the outermost `tools/execute` wrapper when the plugin loads, so wrappers registered after it, `tools/post-execute` policy, and result observers see only the refusal.

<a id="uploads"></a>
## Uploads

`browser_file_upload` and `browser_drop` with `paths` send copies the plugin made, never the files the model names, because the browser reads what it sends after the call returns, when a file the model's shell can change could have become anything:

1. **Directly in the upload directory.** Each entry must be exactly `<uploadDirectory>/<name>`, where `<name>` is one component other than `.` and `..`. Any other entry, a file in a subdirectory or a staged copy included, is refused before anything is opened or asked, with an answer that says to put the file directly in the upload directory and retry. The guard refuses it too.
2. **One open, then `fstat`.** The plugin opens `<uploadDirectory>/<name>` once with `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`, so a symbolic link is refused and a FIFO or device cannot block it, and reads only through that descriptor. Anything but a regular file, and a file whose size passes `uploadMaxBytes`, is refused at once.
3. **A staged copy.** The plugin copies the file to `<uploadStaging>/<nonce>/<name>`, enforcing `uploadMaxBytes` again as the file may grow and computing its SHA-256 as it copies. The nonce directory ends with mode `0750` and the copy with `0440`, both in the group a set-group-ID staging directory gives them. A refused copy leaves nothing behind.
4. **The question.** The approval request adds `Files sent: "<name>" (<size> bytes, SHA-256 <first 12 hex>)` for each file, so the person approves the content that is sent, whatever replaces the original afterwards.
5. **The call.** Once approved, the browser receives the copies' paths in place of the model's, for that dispatch only: the Session log, the audit record, and result observers keep the model's arguments. A declined, unanswered, or cancelled call deletes its copies.

Copies stay until the plugin unloads, because the browser can read a file after the call, when a form is submitted or an upload is sent in chunks. Before staging a file the plugin deletes copies older than 24 hours, then the oldest others while the copies kept and the new one would pass four times `uploadMaxBytes`; a call's own copies are never deleted for each other, and a call whose files alone would pass that total is refused. Staging runs one call at a time. Consent gives the Playwright MCP server `uploadStaging` as its only MCP root, and the server refuses a file outside its root and output directory, so it sends nothing the plugin did not stage.

<a id="computer-use"></a>
## Computer use

The plugin also gates the `computer` tool of [`@deepseek-ai/dsh-computer-use-x11`](../../experimental/computer-use-x11/README.md), which drives the same desktop and Chromium without going through the browser tools. A `screenshot` passes, except while the browser's current tab, as this plugin last read it, is on a denied page: free browser reads can bring such a page to the screen, so the screenshot then asks with the question `Desktop screenshot while the browser's current tab is <what>, which the assistant may not use. Arguments: <arguments>.` Every other action (`click`, `move`, `drag`, `scroll`, `type`, `key`, or an action the plugin does not know) asks the person through the approval service with the question `Computer input on the desktop. Arguments: <arguments>.`, listing the arguments the tool declares as for browser writes. No allowance covers desktop input, so the approval service's `approval/asked` and `approval/decided` records in the Session log are the record of every allowed input. The guard denies input that reaches dispatch without this plugin's recorded consent, and input without an Agent.

While the person has taken the browser over, every action is refused, as [Take over](#take-over) describes.

Computer use lives in this package rather than in a package of its own because it applies the same consent rule to the same signed-in desktop with the same approval flow and guard; a separate package would duplicate that flow and need its own row. The desktop has no URL to check: Chromium's `URLBlocklist` policy keeps the password and payment settings pages closed to computer use.

<a id="take-over"></a>
## Take over

The plugin provides the takeover as the value of its `mumbo-browser-consent` service, typed `BrowserTakeover` in [`src/types.ts`](src/types.ts). The box's owner-only [take-over route](../box-links/README.md#the-browser-tabs-take-over-route) changes it; no model tool does.

- **Taking over.** `takeOver()` starts refusing before it returns: the guard and the `tools/pre-execute` listener refuse every `mcp__playwright-mcp__<tool>` call and every `computer` action, `screenshot` included, before the browser or the desktop receives it, and withdraw an approval question pending for one. Calls already running are stopped: their signal aborts, and each result, finished or failed, is replaced by the stopped-call error, after the files Playwright linked from it are deleted. Once they settle, the plugin calls `browser_close` through each live Session's Playwright MCP server that received a call since its connection last closed. In attach mode upstream then closes its CDP connection and leaves Chromium and its tabs open; the server keeps running without a connection, and its tools stay listed. The promise settles after that. It rejects, naming each failed step, when the record could not be written or a connection did not close; the browser stays taken over, and calling it again retries both steps.
- **The hold.** The service's `hold` says who has the browser: `free`; `taking` from the moment a take over is requested until its step settles, while a connection may still be open; `held` once the step closed every connection; or `unfinished`, with the `failure` of the last take-over step, until a later take over or a hand back succeeds. A failed hand back leaves the hold as it was.
- **The record.** The file `mumbo/browser-takeover` under the DSH home, written atomically with mode `0600`, records the takeover until hand back removes it. At load, a present file, or one that cannot be checked, starts the plugin taken over, so a Host restart never reconnects while the person may be typing; a server starts without a connection, because upstream connects on its first call.
- **Handing back.** `handBack()` removes the record, stops refusing, and lists each live Session's tabs through `browser_tabs`, which reconnects. The person may have left a denied page, such as Google's sign-in, on screen, so the listing updates what the [screenshot check](#computer-use) and the [log refusal](#denied-pages) know; until a listing shows the current tab, a desktop screenshot asks. A take over requested during a hand back wins. A record that cannot be removed rejects the hand back and keeps the browser taken over.

<a id="provider-ownership"></a>
## Provider ownership

The plugin registers its guard and listeners, provides its takeover service, and mounts `@deepseek-ai/dsh-experimental-browser-use-playwright-mcp` as its child with the `browser` settings and that service added to the child's requirements. The provider therefore starts only once the gate is active, and invalid configuration mounts no browser at all; unloading the plugin unloads the provider and removes its browser tools before the guard goes. Whenever another provider holds `browserUse` in place of the child, whether its row loaded before this plugin or took the registration before the child started, the plugin refuses every call to that provider's tools, reads included, decides this on each call, and logs an error naming the provider. It knows the tool prefixes of the Playwright MCP (`mcp__playwright-mcp__`), Chrome DevTools MCP (`mcp__chrome-devtools-mcp__`), and Stagehand (`stagehand_`) providers. A provider with another name already holding `browserUse` at load fails this plugin's load; one that takes it after load is reported as not under consent, because its tools cannot be told apart. While the child holds `browserUse`, no other browser-use provider can register, but a browser reached through a plain MCP server row is outside this plugin. Mount the provider only through this plugin.

<a id="audit-record"></a>
## Audit record

When an allowed browser write's result is final, the plugin appends `browser-consent/write` to the Session: `callId`, the upstream `tool`, `site` when the current tab's origin was read, `grant` (`site` for an allowance, `approval` for a one-shot approval), and `outcome` (`succeeded` or `failed`; `failed` includes a refusal by a later policy and a result withheld after the call). Denied writes leave no record of their own; the approval service's `approval/asked` and `approval/decided` record every question, including its argument summary, and its answer. The [persistence catalog](../../../docs/persistence-catalog.md) owns the exact payload.

<a id="composition"></a>
## Composition

Mount it beside the `browserUse` registry, with `dsh-user-approval`, which the shipped profiles already include. The person box's rows:

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
          outputDir: /root/.mumbo/playwright-output
        uploadDirectory: /home/shared/Downloads
        uploadStaging: /var/lib/mumbo/uploads
        deniedUrls: [chrome:, chrome-untrusted:, chrome-extension:, devtools:, view-source:, file:, https://passwords.google.com, https://pay.google.com, https://payments.google.com, https://myaccount.google.com, https://accounts.google.com]
    - id: computer-use
      name: '@deepseek-ai/dsh-computer-use'
    - id: computer-use-x11
      name: '@deepseek-ai/dsh-computer-use-x11'
      inject: [mumbo-browser-consent]
      config:
        display: ':1'
```

The plugin requires the provider's services, and with `browser.identity` a subprocess service row as well; it reads the approval service on each write. `browser.outputDir` moves the files the Playwright MCP server writes out of the Session's working directory, here to a root-only directory that backups skip. The server runs as a child of the dsh process, started by the MCP client's stdio transport rather than the subprocess service, so it keeps the dsh process's user and can write there. The `inject` line makes the desktop tool wait for this plugin's service, so a consent row that fails to load, or that refuses another browser provider, leaves no ungated desktop tool. [`@mumbo/box-links`](../box-links/README.md) finds the same service and shows Take over and Hand back in the owner's Browser tab.

<a id="model-experience"></a>
## Model Experience

### Denied page

#### What the model sees

A call that names a denied page returns `Error: <tool> did not run: the assistant may not open <what>.`, where `<what>` is `a <scheme> page`, `a page on <origin>`, or `a page whose address cannot be read`. `browser_network_request` returns `Error: browser_network_request did not run: the assistant may not read request headers or bodies, which carry cookies and passwords.`, a call with `filename` returns `Error: <tool> did not run: the assistant may not save browser output to a file; call it without filename to get the result directly.`, an upload or drop of a path not directly in the upload directory returns `Error: <tool> did not run: <path> is not directly in <uploadDirectory>; put the file directly in <uploadDirectory> and retry.`, where `<path>` is the `paths` entry as JSON; one of a name there that cannot be sent returns `Error: <tool> did not run: <path> <why>.`, where `<why>` is `does not exist`, `is a symbolic link, not a regular file`, `is not a regular file`, `is larger than the upload limit of <uploadMaxBytes> bytes`, `could not be opened`, or `could not be copied: <error>`; a call whose files would pass four times `uploadMaxBytes` returns `Error: <tool> did not run: the files of one call may not pass <bytes> bytes in total.`; and an upload or drop whose `paths` is not a list returns `Error: <tool> did not run: paths is not a list of file paths.` A write while the current tab is on one returns `Error: <tool> did not run: the current tab is <what>, which the assistant may not use.`. A call after which the tab is on one returns `Error: <tool> ran, but its result is withheld: the current tab is <what>, which the assistant may not use. Open another page to continue.` in place of the browser's answer. `browser_run_code_unsafe` returns `Error: browser_run_code_unsafe did not run: code may not run in the browser automation process; browser_evaluate runs a function in the page and asks the user first.`; console and request logs after a denied page return `Error: <tool> did not run: a tab in this browser has shown a page the assistant may not use, and console and request logs keep that page's entries.`; a select of a denied tab returns `Error: browser_tabs did not run: that tab is <what>, which the assistant may not use.`; and a call after which the tab cannot be checked returns `Error: <tool>: the browser's current tab could not be checked after the call (<failure>), so its result is withheld.`

#### Token effect

A refusal replaces the browser's result with one short line.

#### KV Cache effect

Append-only. The result follows the Session's existing history like any tool result.

### Denied browser write or desktop input

#### What the model sees

A denied write's tool result replaces the browser's answer with one error line naming the upstream tool and the site, or `an unidentified page`: `Error: The user declined <tool> on <site>.`, `Error: <tool> on <site> got no answer from the user within <seconds> seconds.`, `Error: Approval prompts are disabled in this session, so <tool> on <site> did not run.`, or `Error: <tool> on <site> needs the user's approval, and no approval channel is available.` Denied desktop input uses the same lines with `computer input`, or `the desktop screenshot`, in place of `<tool> on <site>`. A write that reached dispatch without consent returns `Error: <tool> needs the user's consent, which was not given.` (`computer input needs ...` for the desktop), and a cancelled approval returns the tool runtime's `Error: tool call aborted before dispatch`. While another provider holds the browser, every browser call returns `Error: <tool> did not run: browser tools are disabled because this browser was set up without consent checks.` Allowed writes and reads return the browser's ordinary result; the approval question and the audit record are not model context.

#### Token effect

A denial replaces the browser's result with one short line; allowed calls add no tokens.

#### KV Cache effect

Append-only. The result follows the Session's existing history like any tool result.

### Taken over browser

#### What the model sees

While the person has the browser, a browser tool call or a `computer` action returns `Error: <tool> did not run: the person has taken over the browser. Browser and desktop tools stay unavailable until they hand it back.`, where `<tool>` is the upstream tool name or `computer`. A call that was running when the person took over returns `Error: <tool> was stopped because the person took over the browser, so it may or may not have taken effect. Browser and desktop tools stay unavailable until they hand it back.` in place of its result. The tool list and the system prompt stay the same, and taking over or handing back adds no Session event.

#### Token effect

A refusal replaces the call's result with one short line.

#### KV Cache effect

Append-only. The result follows the Session's existing history like any tool result.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Masking covers input values only** — a revealed password, as a screenshot shows it after a show-password click on an allowed site; a select's options, such as a card's expiry month; an accessible name that a page builds from an embedded input's value; and text the page itself renders all pass unmasked, as does a text input that carries no secret type, token, or autofill state. Masking depends on a dependency patch keyed to one `playwright-core` version.
- **Not a security boundary in a box** — the plugin gates the model's browser and desktop tools only. In a box the model also has a root shell in Full access with no per-command ask, so it can reach Chromium's debugging port at `127.0.0.1:9222` directly, for example with `curl` or `playwright-core`, and read the browser profile directory. A takeover does not stop that shell either: it can read the screen through X, open its own debugging connection, or delete the takeover record and restart the Host. Consent becomes a boundary only once the browser runs outside the reach of the dsh user, which is a platform decision.
- **The tab is read around the call, not during it** — a page that navigates itself between the before-listing and a write runs the write on its new origin, and a result whose page the person leaves between the call and the after-listing passes unless the result's own `- Page URL:` line names the denied page. A click inside a cross-origin frame counts as the top-level page's site, and a denied page in a frame of an allowed page is not detected.
- **Uploads come only from directly in the upload directory** — a file in a subdirectory must be moved up first. The plugin reads each file as root, so a file the person keeps there that the model's shell cannot read itself can still be sent once the person approves it; the question names it, its size, and its hash.
- **A staged copy can go before the browser reads it** — copies stay until the plugin unloads or makes room, so a reload, or a later call that needs room while an approved call's form is not yet submitted, deletes a copy the page still needs, and that upload fails.
- **Request URLs are visible** — `browser_network_requests` lists each request's full URL, so a token in a query string, such as an OAuth code, reaches the model.
- **Console and request logs stay refused for the Session** — the refusal after a denied page is not lifted when that tab closes or the browser clears its logs; a new Session starts without it.
- **Console messages can outlive a takeover** — the connection that hand back opens can receive the console messages a page stored while the person had the browser, because Chromium replays them to a new debugging client, so `browser_console_messages` can show them unless a listing showed a denied page.
- **What the person typed stays in the browser after hand back** — the tabs the person used stay open, and `browser_navigate_back` and `browser_navigate_forward`, which are reads, can bring back pages they left, with the values Chromium restores into ordinary text fields. Masking covers password, payment, token, and autofill inputs only, so an email address, a message draft, or a security answer typed during a takeover reaches the model through the next snapshot unless the page is on `deniedUrls`. The held bar tells the person to close those tabs before handing back.
- **A connection that did not close stays open until a retry** — when `browser_close` fails or times out, the server can keep its idle connection, which receives page events while every call is refused; the take-over route reports the failure, and the Browser tab tells the person not to type anything private until a retry succeeds. A browser that is down reports the same failure, because closing a server that has no connection first connects; a retry succeeds once Chromium is back.
- **The desktop screenshot check uses the last tab read** — a page the person opens in the browser themselves, after the plugin's last read, does not make a screenshot ask.
- **Other tabs' titles and URLs are visible** — `browser_tabs` lists every tab's title and URL, including a denied page open in a tab that is not current.
- **Withholding reaches only the result and its linked files** — a screenshot taken on a denied page stays in the attachment store under DSH home, and deleting the console log file that a withheld result links also drops the entries it held from earlier pages.
- **Allowances live in files the model can edit** — `allowedSites`, `deniedUrls`, and the rest of the deployment's configuration, including its MCP server rows, are files the same shell can change, and changing them reloads the plugin; no Client page manages allowances.
- **Only the mounted Playwright MCP provider and the X11 `computer` tool are consented** — the classification follows the pinned `@playwright/mcp` server, and an upstream tool added later asks until it is classified. Another browser-use provider's tools are refused outright or, for an unknown provider that takes `browserUse` after load, left ungated with an error; a browser reached through a plain MCP server row passes ungated. Other computer-use providers' tools are not gated.
- **Navigation is a read** — a `GET` that changes state, such as a one-click unsubscribe link, runs without asking, and a navigation can carry page data to any URL.
- **Allowances are per site, not per kind of action** — an allowed origin permits every site write there, posting and buying included, unless the page shows a masked field.
- **The masked-field check reads the page before the write** — a page that adds a password field between the snapshot and the write runs the write under its allowance, and a masked field anywhere on the page, such as a saved card in a settings form, makes every write there ask.
- **Every desktop input asks** — scrolling and pointer moves ask like clicks, because wheel and hover input reach the page under the pointer.
- **The audit record has no Client renderer** — it is in the Session log and its exports, not in the Chat.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
