---
description: "Sidebar links from a box's Web page to the box home page and desktop live view, for deployments served behind the mumbo box edge."
kind: "package-reference"
---

# @mumbo/box-links

## Summary

`@mumbo/box-links` adds a Home link and, when configured, a Desktop link at the foot of the Web sidebar, above the account menu. Home opens the box home page with the person's assistant, desktop, and shared projects; Desktop opens the live view of the box's desktop. Both open in a new tab, so the conversation, its draft, and the page's connection stay open. Without this plugin's row the sidebar shows neither link.

## Table of Contents

- [Configuration](#configuration)
- [Behavior](#behavior)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="configuration"></a>
## Configuration

| Field | Default | Meaning |
|---|---|---|
| `home` | required | Absolute HTTP(S) URL of the box home page. |
| `desktop` | omitted | Absolute HTTP(S) URL of the desktop live view; omit it for a box without a desktop, such as a project box. |

Each URL must have a scheme, a host, and a path; any other value fails plugin load. The box edge adds the row with a Loader overlay, as in [`examples/person.overlay.yml`](examples/person.overlay.yml) and [`examples/project.overlay.yml`](examples/project.overlay.yml). The generated [configuration catalog](../../../docs/config-catalog.md#mumbobox-links) is the exhaustive source for accepted fields.

<a id="behavior"></a>
## Behavior

The Host half puts the validated links in every page's bootstrap through `webserver/index-inject`, for whichever Peer the page speaks for. The Client half validates them again and registers one `sidebar.footer.action` occupant: icon and label rows in the wide sidebar, icon-only rows with a tooltip in the rail. Labels come from the `boxLinks` locale namespace in every Client locale. The links are plain navigation: they call no Remote and need no access grant, so a page that speaks for a non-owner principal shows them too. A page loaded before the row started carries no links until it reloads.

<a id="model-experience"></a>
## Model Experience

None, as the links are browser navigation that registers no tool, prompt section, or Session event.

#### KV Cache effect

No model request prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No house or monitor glyph** — Home uses the shared layers icon and Desktop the globe icon until designers approve dedicated glyphs.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
