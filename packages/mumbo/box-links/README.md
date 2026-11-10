---
description: "Box links and views: sidebar links from a box's Web page to the box home page and desktop live view, and the right-panel Desktop and Browser tabs that show that live view, for deployments served behind the mumbo box edge."
kind: "package-reference"
---

# @mumbo/box-links

## Summary

`@mumbo/box-links` adds box links and views to a box's Web page. At the foot of the Web sidebar, above the account menu, it shows a Home link and, when configured, a Desktop link; both open in a new tab, so the conversation, its draft, and the page's connection stay open. In the right panel it adds a Desktop tab, which shows the desktop live view, and, when configured, a Browser tab: the same live view with the desktop's Chrome brought to the front by an owner-only Host call. Without this plugin's row the page shows none of them.

## Table of Contents

- [Configuration](#configuration)
- [Links](#links)
- [Desktop and Browser tabs](#desktop-and-browser-tabs)
- [The Browser tab's Host call](#the-browser-tabs-host-call)
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

A desktop app's local browser takes the Browser tab over by registering kind `box-browser` in the `extension` band with its own id and body: the right panel then renders that body for every `box-browser` tab and falls back to the live view when the registration leaves. Using the guide entry id `open` keeps the person's guide pin choice across the takeover. Nothing else in the product names the live view.

<a id="the-browser-tabs-host-call"></a>
## The Browser tab's Host call

With `browser`, the Host half registers the exact Connection route `POST /api/box-links.browser-front` once the `connection` and `subprocess` services are present. The route declares no `access`, so Connection answers every non-owner Peer, such as a project member's `edge-member` Peer, 403 before the route runs; an owner request passes Connection's Host and Origin checks and browser authentication like every `/api` request. The call never starts Chrome. It runs these commands through the subprocess service, with `DISPLAY` and `XAUTHORITY` from the configuration:

1. `wmctrl -x -a <windowClass>` activates the first window in the window manager's client list whose WM_CLASS matches. Activation goes through EWMH, so the window manager restores a minimized window and switches to its workspace. Exit 1 without a diagnostic means no window matches; the call then tries again every 250 ms, which covers the seconds in which the desktop's restart loop brings a closed Chrome back.
2. `wmctrl -x -r <windowClass> -b add,maximized_vert,maximized_horz` maximizes that window.

`timeoutMs` bounds the whole call. Calls run one at a time. The route answers 204 once both commands succeeded, or 500 with plain text that is also logged as a warning: `Chrome did not start within <timeoutMs> ms: no window of class "<windowClass>" on <display>` when no window matched in time, and otherwise the failed command with its diagnostic, such as `wmctrl -x -a failed (exit 1): Cannot open display.`. Unloading the plugin aborts the running command and waits for it.

The desktop the edge starts must meet these conditions:

- The desktop keeps Chrome running itself, restarting it after it exits, and starts no second Chrome while one runs.
- Its window manager supports EWMH (`_NET_CLIENT_LIST`, `_NET_ACTIVE_WINDOW`, `_NET_WM_STATE`), as xfwm4 and openbox do; without one, wmctrl reports `Cannot get client list properties` and the call fails at once.
- `wmctrl` is on the Host's `PATH`, and the Host can read the `xauthority` file.

<a id="model-experience"></a>
## Model Experience

None, as the links and tabs are browser navigation and views, and the Host call registers no tool, prompt section, or Session event.

#### KV Cache effect

No model request prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No house or monitor glyph** — Home uses the shared layers icon and Desktop the globe icon, and the Desktop guide card draws the guide's placeholder, until designers approve dedicated glyphs.
- **The oldest Chrome window comes forward** — wmctrl activates the first matching window in the window manager's client list, the one mapped first, not the one the person used last.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
