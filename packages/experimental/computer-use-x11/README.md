---
description: "Let the model see and operate a Linux X11 desktop through one computer tool backed by xdotool, ImageMagick import and xsel."
kind: "package-reference"
---

# @deepseek-ai/dsh-computer-use-x11

English | [中文](README.zh.md)

## Summary

Operate desktop applications on a Linux X11 display, such as an Xvfb virtual screen, with screenshots, pointer input and keyboard input. One `computer` tool captures the whole display with ImageMagick `import`, sends input with `xdotool`, and pastes non-ASCII text through `xsel`. Screenshots reach image-capable models through durable attachments, and coordinates map from the delivered image back to screen pixels. This experimental package is an explicit composition choice; the host installs the three programs.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Install the programs on the machine that runs DSH (Debian or Ubuntu: `apt-get install xdotool imagemagick xsel`), start the X server, and add these rows to a composition that already provides tools, subprocesses, an attachment store and an image-capable model route:

```yaml
- name: '@deepseek-ai/dsh-computer-use'
- name: '@deepseek-ai/dsh-computer-use-x11'
  config:
    display: ':1'
```

| Field | Default | Meaning |
|---|---|---|
| `display` | required | X display passed as `DISPLAY` to every command |
| `xauthority` | none | Absolute X authority file passed as `XAUTHORITY`; omission removes an inherited `XAUTHORITY` |
| `xdotoolPath`, `importPath`, `xselPath` | `xdotool`, `import`, `xsel` | Absolute paths or names looked up on the subprocess provider's `PATH` |
| `timeoutMs` | `10000` | Deadline for each command; typing adds `typeDelayMs` per character |
| `graceMs` | `1000` | Exit allowance after a cancelled or timed-out command is terminated |
| `maxScreenshotBytes` | `33554432` | Largest PNG accepted from one capture |
| `typeDelayMs` | `12` | Delay between typed characters |
| `dragSteps` | `10` | Pointer movements between the start and end of a drag |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-computer-use-x11) lists the accepted fields.

### Activation and failures

Loading resolves the three executables and runs `xdotool getdisplaygeometry` against the display. A missing program fails activation with its installation command and configuration field; an unreachable display fails with the X error and asks for the server, `display` or `xauthority` to be corrected. The provider then registers as `x11`; a second computer-use provider fails activation. Unload removes the tool, aborts running commands, waits for them, and releases the registration.

An X server started without `-auth`, such as `Xvfb :1 -nolisten tcp`, accepts local clients without a cookie, so DSH can run as a different user from the X session. Otherwise set `xauthority` to a cookie file that the DSH user can read.

### Calls and results

A screenshot requires an Agent-owned call, an attachment store and a model route declaring image input; it fails before capture otherwise. Its value contains the image dimensions the model receives and the stored attachment reference. Input actions return `{"dispatched":true}`: the X server received the input, and the effect is unverified. Command failures, timeouts, oversized output and key names that `xdotool` skipped become tool errors.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

| File | Role |
|---|---|
| [src/index.ts](src/index.ts) | Configuration, startup checks, tool schema, coordinate mapping, command construction and bounded execution |
| [src/keys.ts](src/keys.ts) | Translation of model-written key chords to X keysym names |

Every command runs through `ctx.subprocess` with an explicit `DISPLAY` and `XAUTHORITY`, its own deadline, the caller's cancellation and the provider lifetime. Standard output is read up to `maxScreenshotBytes` for captures and 64 KiB otherwise; exceeding the bound terminates the command. Standard error keeps a 64 KiB tail for diagnostics.

Each Agent keeps its latest screenshot geometry: the image size from the attachment store's request version for the calling model route, and the captured screen size. A pointer coordinate must fall inside that image and maps to the center of its screen region. Pointer actions before the first screenshot fail.

`xdotool` types printable ASCII, newline and tab directly. Chromium-based applications drop or substitute characters that `xdotool` types by remapping a spare keycode, so text containing any other character is written to the CLIPBOARD and PRIMARY selections with `xsel` and pasted with shift+Insert. The `xsel` process keeps serving the selection until another client takes it over.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Computer-use service](../../computer-use/computer-use/README.md) — exclusive named registration.
- [Computer use](../../../docs/subsystems/computer-use.md) — provider choices and shared-desktop limits.
- [Attachment store](../../attachment/attachment/README.md) — durable images and model-request versions.

-----

<a id="model-experience"></a>
## Model Experience

### Computer tool

#### What the model sees

One `computer` tool with an `action` enum (`screenshot`, `click`, `move`, `drag`, `scroll`, `type`, `key`) and optional `x`, `y`, `toX`, `toY`, `button`, `count`, `modifiers`, `deltaX`, `deltaY`, `text` and `keys` parameters. Its description below names the configured display in place of `<display>`. A screenshot result shows `Screenshot of X display <display>, <width>x<height> px; coordinates use these pixels.` beside the image, input results show `{"dispatched":true}`, and errors name the rejected parameter, the missing screenshot or the failed command.

##### Tool description

```markdown
Operate the Linux desktop on X display <display>. Take a screenshot before using coordinates and after each action to verify it: actions report dispatch, not success. x, y, toX and toY are pixels in the latest screenshot. Actions: screenshot; click (x, y, optional button, count, modifiers); move (x, y; hovers); drag (from x, y to toX, toY, optional button, modifiers); scroll (x, y, deltaX and deltaY in wheel clicks, positive scrolls right and down); type (literal text including newlines; text containing non-ASCII characters is pasted with shift+Insert, replacing the clipboard and primary selection); key (keys: chords such as ctrl+l, ctrl+shift+t, alt+F4 or Return, separated by spaces for a sequence; use ctrl, not cmd). Keyboard input goes to the focused window; click a window to focus it. Start GUI programs from the shell with DISPLAY=<display> so they appear on this desktop.
```

#### Token effect

The tool definition adds a fixed number of tokens to every request while the provider is mounted. Each screenshot adds one image at the size the model route requests; other results add a short line.

#### KV Cache effect

The definition preserves its request prefix while the display setting is unchanged. Results append to Session history. Changing `display` or mounting and removing the provider changes the tool definition and can reduce prefix reuse.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No accessibility tree or window list** — the model works from screenshots; it cannot read element text, list windows or raise a window except by clicking or pressing keys.
- **Shared desktop** — the provider does not reserve the display for a Session. Other Sessions, the user's own viewer and applications can change it between calls, and keyboard input goes to whichever window has focus.
- **Clipboard replacement** — typing non-ASCII text replaces the CLIPBOARD and PRIMARY selections, and applications without shift+Insert paste do not receive it.
- **Cancellation and partial input** — a cancelled, timed-out or failed command can have delivered part of its input; modifiers held for a click or drag can stay pressed if `xdotool` is killed mid-sequence. Observe with a screenshot before retrying.
- **Screen geometry** — mapping uses the screen size at the latest screenshot; resizing the X screen afterwards maps coordinates incorrectly until the next screenshot.
- **No approval gate** — input actions run without a per-call approval; deployments that require one compose a tool policy.
- **Experimental release** — the action set and results have no stability promise.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Run the real-display test with `xvfb`, `xdotool`, `imagemagick` and `xsel` installed and Playwright's Chromium downloaded; it self-skips and names the missing programs otherwise:

```sh
node node_modules/vitest/vitest.mjs run --config vitest.e2e.config.ts packages/experimental/computer-use-x11/tests/xvfb.e2e.ts
```

</details>
