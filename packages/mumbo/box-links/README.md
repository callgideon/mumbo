---
description: "Box links and views: sidebar links from a box's Web page to the box home page and desktop live view, and the right-panel Desktop and Browser tabs that show that live view, for deployments served behind the mumbo box edge."
kind: "package-reference"
---

# @mumbo/box-links

## Summary

`@mumbo/box-links` adds box links and views to a box's Web page: a Home link and, when configured, a Desktop link at the foot of the Web sidebar, both opening in a new tab; a right-panel Desktop tab showing the desktop live view; and, when configured, a Browser tab showing the same view with Chrome brought to the front by an owner-only Host call. With [browser consent](../browser-consent/README.md) loaded, the owner's Browser tab offers Take over and Hand back, to keep the assistant out while the person signs in. Without this plugin's row the page shows none of them.

## Table of Contents

- [Configuration](#configuration)
- [Links](#links)
- [Desktop and Browser tabs](#desktop-and-browser-tabs)
- [The Browser tab's Host call](#the-browser-tabs-host-call)
- [The Browser tab's take-over route](#the-browser-tabs-take-over-route)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="configuration"></a>
## Configuration

| Field | Default | Meaning |
|---|---|---|
| `home` | required | Absolute HTTP(S) URL of the box home page. |
| `desktop` | omitted | Absolute HTTP(S) URL of the desktop live view; omit it for a box without a desktop, such as a project box. With it, the page shows the Desktop link and the Desktop tab. |
| `browser` | omitted | How the Browser tab brings the desktop's Chrome window to the front; omit it, or leave the YAML key without a value, for a box without the Browser tab. `browser: {}` enables it with every default. It requires `desktop`; without one the plugin fails to load. |

The `browser` object:

| Field | Default | Meaning |
|---|---|---|
| `display` | `:1` | X display Chrome runs on, passed as `DISPLAY` to every command. |
| `xauthority` | omitted | Absolute X authority file passed as `XAUTHORITY`; omission removes an inherited `XAUTHORITY`. Set it when the display uses an X cookie. |
| `windowClass` | `chrom` | Text a Chrome window's WM_CLASS contains, compared without regard to case: wmctrl's own `-x` matching against `res_name.res_class` as `wmctrl -lx` prints it. Chrome started with `--user-data-dir` names its windows `google-chrome (<profile>).Google-chrome`, and Debian's Chromium `chromium (<profile>).Chromium`; the default matches both and no other window of the box desktop. |
| `wmctrl` | `wmctrl` | wmctrl executable: an absolute path or a name looked up on `PATH`. |
| `timeoutMs` | `15000` | Milliseconds the call waits, from its start, for a Chrome window to exist, activate, and maximize. |

Each URL must have a scheme, a host, and a path; any other value, and any `browser` field outside its pattern, fails plugin load. The box edge adds the row with a Loader overlay, as in [`examples/person.overlay.yml`](examples/person.overlay.yml) and [`examples/project.overlay.yml`](examples/project.overlay.yml). The generated [configuration catalog](../../../docs/config-catalog.md#mumbobox-links) is the exhaustive source for accepted fields.

<a id="links"></a>
## Links

The Host half puts the links in every page's bootstrap through `webserver/index-inject`, for whichever Peer the page speaks for; the `browser` object itself never reaches a page. The Client half validates the links again and registers one `sidebar.footer.action` occupant: icon and label rows in the wide sidebar, icon-only rows with a tooltip in the rail. Copy comes from the `boxLinks` locale namespace in every Client locale. The links are plain navigation: they call no Remote and need no access grant, so a page that speaks for a non-owner principal shows them too. A page loaded before the row started carries no links until it reloads.

<a id="desktop-and-browser-tabs"></a>
## Desktop and Browser tabs

With `desktop`, the Client half registers two right-panel tab kinds through `ctx.sidebarRightTabs`, both in the `builtin` band, each with one guide card whose entry id is `open`:

| Kind | Title | Guide order | Registered when |
|---|---|---|---|
| `box-browser` | Browser | 30 | the bootstrap carries `browser: true`, which the Host puts only in the owner's page and only with `browser` configured |
| `box-desktop` | Desktop | 35 | `desktop` is configured |

Both bodies are an iframe of the `desktop` URL, without a `sandbox` attribute: the live view is served on the app's own origin, so the edge's `frame-ancestors 'self'` and Origin checks apply unchanged and a sandbox would add nothing. Neither kind is `keepMounted`, and the body draws the iframe only while the tab shows, so opening another tab in its pane, collapsing the panel, or switching Session drops the frame and its stream; showing the tab again reconnects. The iframe fills the pane, including the full-screen panel below 768px.

Each time a Browser tab shows, its body makes one [Host call](#the-browser-tabs-host-call) to bring Chrome to the front. A failed call shows its diagnostic and a Try again button above the live view, which stays usable.

When the bootstrap also carries `takeover: true`, which the Host puts only in the owner's page and only while browser consent's service is loaded, the Browser tab reads who has the browser through the [take-over route](#the-browser-tabs-take-over-route) each time it shows, and draws a bar above the live view:

| State | Bar | Action |
|---|---|---|
| The assistant has the browser | `Mumbo can use this browser. Take over to sign in or type something private.` | Take over |
| A take over is still closing the assistant's browser connections | A warning that taking over has not finished, saying not to type anything private yet | Try again, which takes over again and answers once the earlier take over finished, and Hand back |
| The person has it, with no assistant connection open | `You have the browser. Mumbo can't see or use it until you hand it back. Before you do, close any tab you typed something private in.` | Hand back |
| A take over did not finish | A warning naming the failure and saying not to type anything private yet | Try again, which takes over again, and Hand back |

The state comes from browser consent's [hold](../browser-consent/README.md#take-over), so a reload, a second device, or a reloaded plugin reads the same state. While a change runs, the bar's buttons are disabled and the pressed one reads `Taking over…` or `Handing back…`. A failed hand back shows its failure above the bar, which stays on the person's state, including the warning of a take over that did not finish; a read that gets no state shows why with a Try again button. The Desktop tab shows the same live view without the bar: Take over belongs to the Browser tab, and the takeover holds whichever tab the person types in.

A desktop app's local browser takes the Browser tab over by registering kind `box-browser` in the `extension` band with its own id and body: the right panel then renders that body for every `box-browser` tab and falls back to the live view when the registration leaves. Using the guide entry id `open` keeps the person's guide pin choice across the takeover. Nothing else in the product names the live view.

<a id="the-browser-tabs-host-call"></a>
## The Browser tab's Host call

With `browser`, the Host half registers the exact Connection route `POST /api/box-links.browser-front` once the `connection` and `subprocess` services are present. The route declares no `access`, so Connection answers every non-owner Peer, such as a project member's `edge-member` Peer, 403 before the route runs; an owner request passes Connection's Host and Origin checks and browser authentication like every `/api` request. The call never starts Chrome. It runs these commands through the subprocess service, with `DISPLAY` and `XAUTHORITY` from the configuration:

1. `wmctrl -x -a <windowClass>` activates the first window in the window manager's client list whose WM_CLASS matches. Activation goes through EWMH, so the window manager restores a minimized window and switches to its workspace. Exit 1 without a diagnostic means no window matches; the call then tries again every 250 ms, which covers the seconds in which the desktop's restart loop brings a closed Chrome back.
2. `wmctrl -x -r <windowClass> -b add,maximized_vert,maximized_horz` maximizes that window.

`timeoutMs` bounds the whole call. Calls run one at a time. The route answers 204 once both commands succeeded, or 500 with plain text that is also logged as a warning:

- `Chrome did not start within <timeoutMs> ms: no window of class "<windowClass>" on <display>` when every attempt found no matching window until the deadline;
- `wmctrl <arguments> did not finish within <timeoutMs> ms on <display>` when the deadline stopped a command that was still running, or came before the next one, such as with a hung X server or window manager;
- the failed command with its diagnostic otherwise, such as `wmctrl -x -a failed (exit 1): Cannot open display.`.

The Browser tab aborts its request when it hides, and the Host then aborts the call, so a hidden tab's call neither brings Chrome forward later nor holds the queue. Unloading the plugin removes the route, aborts the running command, and waits for it.

The desktop the edge starts must meet these conditions:

- The desktop keeps Chrome running itself, restarting it after it exits, and starts no second Chrome while one runs.
- Its window manager supports EWMH (`_NET_CLIENT_LIST`, `_NET_ACTIVE_WINDOW`, `_NET_WM_STATE`), as xfwm4 and openbox do; without one, wmctrl reports `Cannot get client list properties` and the call fails at once.
- `wmctrl` is on the Host's `PATH`, and the Host can read the `xauthority` file.

<a id="the-browser-tabs-take-over-route"></a>
## The Browser tab's take-over route

With `browser`, while the `connection` service and browser consent's `mumbo-browser-consent` service are present, the Host half registers the exact Connection route `/api/box-links.browser-takeover`. Like the Chrome call it declares no `access`, so Connection answers every non-owner Peer 403 before the route runs.

- `GET` answers 200 with JSON `{ "hold": { "kind": "free" | "taking" | "held" | "unfinished" } }`, the consent service's [hold](../browser-consent/README.md#take-over); `unfinished` adds the take over's `failure` inside `hold`.
- `POST` with the JSON body `{ "takenOver": true }` takes the browser over and with `false` hands it back, through the consent service. It answers once the change finished: 200 with the state, or 500 with the state and the change's `failure` text beside `hold`, which is also logged as a warning. The hold is `held` only after the assistant's browser connections are closed, so the bar says the person has the browser only once that holds.
- Any other body answers 400 with plain text.

The Browser tab does not abort a change when it hides, and the Host finishes it either way. Unloading the plugin or browser consent removes the route.

<a id="model-experience"></a>
## Model Experience

None, as the links and tabs are browser navigation and views, and the Host routes register no tool, prompt section, or Session event. What the model sees while the person has taken the browser over is browser consent's [refusal](../browser-consent/README.md#taken-over-browser).

#### KV Cache effect

No model request prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No house or monitor glyph** — Home uses the shared layers icon and Desktop the globe icon, and the Desktop guide card draws the guide's placeholder, until designers approve dedicated glyphs.
- **The bar shows the state as of its last read** — the Browser tab reads who has the browser when it shows and after its own changes, so a change made from another device appears when the tab shows again.
- **The oldest Chrome window comes forward** — wmctrl activates the first matching window in the window manager's client list, the one mapped first, not the one the person used last.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
