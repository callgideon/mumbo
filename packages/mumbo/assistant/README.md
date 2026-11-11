---
description: "Mumbo, a person's always-present assistant Session in their box: created once, first in the sidebar's navigation band, never archived, given its own instructions, and opened when the app starts with no Session open."
kind: "package-reference"
---

# @mumbo/assistant

## Summary

`@mumbo/assistant` keeps one Session called Mumbo in a person's box: the place they dump things, ask for status, and come back to. The Host half creates the Session with the fixed id `mumbo` once, refuses to archive it, and gives every Agent of that Session the deployment's instructions as its own system prompt section. The Client half puts Mumbo first in the sidebar's navigation band, above Plugins, keeps it out of the Workspace lists, and opens it when a page first loads with no Session open. Other Sessions stay ordinary side conversations. Without this plugin's row none of this happens.

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
| `retryDelaysMs` | `[1000, 2000, 5000, 10000, 30000]` | Delays in milliseconds before each retry of a failed ensure; their count bounds the retries, and each must be positive. |

The box edge adds the row with a Loader overlay, as in [`examples/person.overlay.yml`](examples/person.overlay.yml), and writes the instructions there. The generated [configuration catalog](../../../docs/config-catalog.md#mumboassistant) is the exhaustive source for accepted fields.

<a id="behavior"></a>
## Behavior

The Host half needs the Web profile's `sessionController`, `workspaceRegistry`, `agents`, and `storageDomain`. When it starts, it:

1. opens its `mumbo_assistant` storage domain, whose `steps` table records each finished one-time start step; a domain that does not open fails the start;
2. registers a `workspace/archive-veto` listener that refuses `mumbo` with `Mumbo is your always-present assistant and cannot be archived.`, with or without `stopActivity`, so archiving fails before anything is written or stopped and the schedules aimed at Mumbo survive; the Web shows the message as it shows any failed archive;
3. adds Mumbo's prompt section to every Agent of `mumbo` on `agent/created`, and to one already resumed before the plugin started;
4. ensures Mumbo: it resolves `mumbo` through the session controller, and only on `session/not-found` creates it in the Workspace of `workspace` with the deployment's default preset and titles it `Mumbo`;
5. then unarchives Mumbo when it is archived, and unpins it once: a box an earlier version of this plugin started had Mumbo pinned, and the sidebar entry replaces that pin. The `unpinned` step record is written only after the unpin holds, so a failed attempt retries it, and a pin the person sets afterwards stays.

The plugin start returns once the domain is open, and the first ensure runs after it: creating or resuming Mumbo resolves an Agent preset, and the [preset registry](../../preset/agent-preset-registry/README.md) waits for the Host Loader to settle while a preset row waits for a service, which would wait for this start. A successful ensure is logged as `mumbo-assistant: ensured Session 'mumbo'`. A restart resolves the existing Session, so it neither duplicates nor retitles it: a title the person gave Mumbo stays. A failed ensure, such as `session/writer-held` while the previous process still holds Mumbo's log after a restart, or a default preset whose row waits for a missing service, is logged as an error and retried after each delay in `retryDelaysMs`; the veto and the prompt section stay registered throughout, so Mumbo cannot be archived while its ensure is failing. Attempts of one start never overlap. Unloading the plugin cancels a pending retry, and a running attempt starts no write after it; unloading does not wait for that attempt, because its session controller call can wait for the Loader too. `MUMBO_SESSION_ID` is exported for other plugins that name the Session.

The Client half registers a `sidebar.panellist` entry with id `mumbo`, order −10, the label "Mumbo" from its `mumboAssistant` dictionary, the shared sparkle icon, and `session: mumbo`, so the row sits above Plugins in the wide sidebar, the collapsed rail, and the phone drawer, opens the Mumbo Session, is highlighted while Mumbo is on screen, and shows Mumbo's pending approval or question, activity, or unseen completed turn as a status dot ([Session rows](../../client/ui-sidebar/README.md#global-panel-entries)). When the Host list arrives without `mumbo`, for example after the ensure retries end, the row is absent. It also registers `ctx.uiWorkspace.hideSession(mumbo)`, so the Workspace browser lists Mumbo in no group and not in the flat list, while search still finds it. A box without this plugin's row, such as a project box, shows no Mumbo row.

The Client half waits for Workspace navigation's startup restoration (`ctx.uiWorkspace.restoration`). A `saved` restoration reopens the Session the person chose, including a saved New Session, and the plugin leaves it. A `fresh` one, with no saved selection listed, would open a blank Session in the most recent Workspace, and `ctx.uiWorkspace.openSession(mumbo)` supersedes it. The decision is made once each time the Client half starts, which is once per page load unless an HMR rebuild restarts it, and only when the Host listed `mumbo`. It never replaces Mumbo or an open Session that has a turn, so a restarted Client half on a page already in use leaves the person's Session open; later navigation is the person's. Because Mumbo is titled from creation and hidden from the Workspace lists, New Session never reuses it as a Workspace blank ([blank-row rule](../../client/ui-workspace/README.md#use-this-package)).

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
- **Delayed title on a failed rename** — when titling fails after creation, the retry finds the Session and leaves its title to automatic titling.
- **Retries end** — after the last of `retryDelaysMs` the plugin stops ensuring until the next start; the veto and the prompt section remain.
- **No notification** — a finished scheduled turn or an approval asked during one waits in Mumbo for the person's next visit; only an open page shows it, as the sidebar row's status dot.
- **Placeholder icon** — the entry uses the shared sparkle icon until designers approve a Mumbo glyph.
- **A blank Session may remain** — when Mumbo supersedes first-load navigation, the blank Session that navigation prepared in the recent Workspace is kept for later reuse.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The archive veto is the harness extension point recorded in the [archive veto Agent Note](../../../.agents/notes/implemented/architecture/2026-11-10-archive-veto.md).

</details>
