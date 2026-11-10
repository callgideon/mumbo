---
description: "Mumbo, a person's always-present assistant Session in their box: created once, pinned first, never archived, given its own instructions, and opened when the app starts with no Session open."
kind: "package-reference"
---

# @mumbo/assistant

## Summary

`@mumbo/assistant` keeps one Session called Mumbo in a person's box: the place they dump things, ask for status, and come back to. The Host half creates the Session with the fixed id `mumbo` once, pins it so it leads the sidebar, refuses to archive it, and gives every Agent of that Session the deployment's instructions as its own system prompt section. The Client half opens Mumbo when a page first loads with no Session open. Other Sessions stay ordinary side conversations. Without this plugin's row none of this happens.

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
| `instructions` | required | Text of Mumbo's system prompt section, used verbatim; it must contain a non-whitespace character. |
| `workspace` | `/root/projects` | Absolute path of the existing directory whose Workspace a newly created Mumbo joins. |

The box edge adds the row with a Loader overlay, as in [`examples/person.overlay.yml`](examples/person.overlay.yml), and writes the instructions there. The generated [configuration catalog](../../../docs/config-catalog.md#mumboassistant) is the exhaustive source for accepted fields.

<a id="behavior"></a>
## Behavior

The Host half needs the Web profile's `sessionController`, `workspaceRegistry`, and `agents`. When it starts, it:

1. registers a `workspace/archive-veto` listener that refuses `mumbo` with `Mumbo is your always-present assistant and cannot be archived.`, with or without `stopActivity`, so archiving fails before anything is written or stopped and the schedules aimed at Mumbo survive; the Web shows the message as it shows any failed archive;
2. adds Mumbo's prompt section to every Agent of `mumbo` on `agent/created`, and to one already resumed before the plugin started;
3. resolves `mumbo` through the session controller. Only on `session/not-found` does it create it in the Workspace of `workspace` with the deployment's default preset and title it `Mumbo`; any other resolve error fails the plugin start;
4. unarchives Mumbo when it is archived, and pins it when it is not pinned.

The plugin start awaits these steps, and Cordis never overlaps two starts of one plugin instance, so one ensure runs at a time. A restart resolves the existing Session, so it neither duplicates nor retitles it: a title the person gave Mumbo stays. A failure in any step fails the plugin start loudly, and the veto and prompt section are removed with it. `MUMBO_SESSION_ID` is exported for other plugins that name the Session.

The Client half waits until the Session and Workspace lists first settle. Workspace navigation restores the saved selection in that same notification, so a Session the person chose is already open by the next microtask, and the plugin leaves it. When no Session is open, navigation is still preparing a blank Session in the most recent Workspace, and `ctx.uiWorkspace.openSession(mumbo)` supersedes it. The decision is made once per page load and only when the Host listed `mumbo`; later navigation is the person's.

<a id="model-experience"></a>
## Model Experience

### Mumbo's instructions

#### What the model sees

Every model request of the `mumbo` Session carries a system prompt section named `mumbo:assistant` at the deployment persona-suffix position, whose text is the configured `instructions`, uninterpolated. No other Session receives it. The example overlay's text is:

##### Example `instructions`

```markdown
You are Mumbo, this person's assistant, and the Session they come back to.
Keep track of what they asked and what is still pending.
Use schedules for later and recurring work.
When they return, start with what happened while they were away.
```

#### Token effect

Fixed: the configured text adds its own tokens to each request of the `mumbo` Session and nothing to other Sessions.

#### KV Cache effect

Prefix-stable while the instructions stay the same. Changing `instructions` replaces the section in the system prompt of the next request, which invalidates reuse of that request's prefix from the section onwards.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Pre-veto archives keep their losses** — an archive with `stopActivity` made while the plugin was not loaded deleted Mumbo's schedules; the next start unarchives Mumbo but cannot restore them.
- **Delayed title on a failed rename** — when titling fails after creation, the plugin start fails and the next start finds the Session and leaves its title to automatic titling.
- **No notification** — a finished scheduled turn or an approval asked during one waits in Mumbo for the person's next visit.
- **A blank Session may remain** — when Mumbo supersedes first-load navigation, the blank Session that navigation prepared in the recent Workspace is kept for later reuse.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The archive veto is the harness extension point recorded in the [archive veto Agent Note](../../../.agents/notes/implemented/architecture/2026-11-10-archive-veto.md).

</details>
