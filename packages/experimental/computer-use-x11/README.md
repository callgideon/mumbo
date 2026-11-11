---
description: "Let the model see and operate a Linux X11 desktop through one computer tool backed by xdotool, ImageMagick import and xsel."
kind: "package-reference"
---

# @deepseek-ai/dsh-computer-use-x11

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
| `identity` | provider default | Subprocess identity that runs every command and whose `PATH` finds the executables, such as a user that alone may read the X authority file |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-computer-use-x11) lists the accepted fields.

### Activation and failures

Loading resolves the three executables and runs `xdotool getdisplaygeometry` against the display. A missing program fails activation with its installation command and configuration field; an unreachable display fails with the X error and asks for the server, `display` or `xauthority` to be corrected. The provider then registers as `x11`; a second computer-use provider fails activation. Unload removes the tool, aborts running commands, waits for them, releases held keys and mouse buttons, and releases the registration.

Start the X server with an authorization cookie and set `xauthority` to that file, so only processes that can read it can watch or drive the display. For example, create the cookie with `xauth -f /run/x11/auth add :1 . "$(mcookie)"`, start `Xvfb :1 -auth /run/x11/auth -nolisten tcp`, give the X session's own clients `XAUTHORITY=/run/x11/auth`, and keep the file readable by the DSH user and the session user only. As a fallback, an X server started without `-auth` accepts every local client without a cookie; any local process can then read or drive that display.

### Calls and results

A screenshot requires an Agent-owned call, an attachment store and a model route declaring image input; it fails before capture otherwise. Its value contains the image dimensions the model receives and the stored attachment reference. Input actions return `{"dispatched":true}`: the X server received the input, and the effect is unverified. Command failures, timeouts, oversized output and key names that `xdotool` skipped become tool errors.

`key` accepts a closed set of names: common aliases such as `enter`, `esc`, `ctrl` and `win`, named keysyms such as `Return`, `Page_Up`, `KP_Enter` and `XF86AudioMute`, `F1` to `F24`, `U<hex>` code points and single printable characters. Any other name fails before `xdotool` starts, because `xdotool key` runs an argument that names one of its commands, such as `exec`, as a chained command. ASCII text goes to `xdotool type --delay <ms> -- <text>` as the final argument, so it is typed literally and nothing follows it. Before every `xdotool` start, the whole argument list must parse as the commands this provider sends (`getdisplaygeometry`, `mousemove`, `mousedown`, `mouseup`, `keydown`, `keyup`, `click --repeat`, `key`, `type`), with decimal numbers, buttons 1 to 7, and key names from the closed set; any other list fails with `computer-use-x11 refused xdotool arguments: <reason>` and starts nothing.

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

After an input action fails, is cancelled or times out, and once at unload, the provider releases both sides of ctrl, shift, alt and super, AltGr (`ISO_Level3_Shift`) and mouse buttons 1 to 7 with one `xdotool keyup … mouseup …` command, because a terminated command can stop between a press and its release. A failure of this release is logged as a warning and does not replace the original error.

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
- **Typed text is a process argument** — while `xdotool type` runs, its text is readable in `/proc/<pid>/cmdline` by every user of the host unless `/proc` is mounted with `hidepid`.
- **Shared desktop** — the provider does not reserve the display for a Session. Other Sessions, the user's own viewer and applications can change it between calls, and keyboard input goes to whichever window has focus.
- **Clipboard replacement** — typing non-ASCII text replaces the CLIPBOARD and PRIMARY selections, and applications without shift+Insert paste do not receive it.
- **Cancellation and partial input** — a cancelled, timed-out or failed command can have delivered part of its input. Held modifiers and buttons are released afterwards, but when the release command itself cannot run, for example because the display is gone, keys and buttons can stay pressed and only a warning is logged. The release does not cover the final non-modifier key of a chord, which a command killed between its press and release leaves held, or a Caps_Lock or Num_Lock press, which leaves the lock toggled. Observe with a screenshot before retrying.
- **Screen geometry** — mapping uses the screen size at the latest screenshot; resizing the X screen afterwards maps coordinates incorrectly until the next screenshot.
- **No approval gate** — input actions run without asking the user, so a deployment policy that writes must ask is not enforced for computer use; deployments that require approval compose a tool policy.
- **Unauthenticated displays** — with the no-cookie fallback, any local process can read or drive the display; the provider cannot detect or prevent that.
- **Experimental release** — the action set and results have no stability promise.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Run the real-display test with `xvfb`, `xdotool`, `imagemagick` and `xsel` installed and Playwright's Chromium downloaded; it self-skips and names the missing programs otherwise:

```sh
node node_modules/vitest/vitest.mjs run --config vitest.e2e.config.ts packages/experimental/computer-use-x11/tests/xvfb.e2e.ts
```

Mumbo box readiness: the box model route currently declares no image input, because `llm-deepseek` defaults `inputModalities` to text only, so screenshots are refused until the deployment selects an image-capable route. Input actions do not ask the user, so the box's writes-ask policy does not cover computer use.

</details>
