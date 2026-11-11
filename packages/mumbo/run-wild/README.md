---
description: "Run Wild, the permission preset in which the assistant decides tool approvals, plan reviews and questions itself instead of asking the person, and logs each decision."
kind: "package-reference"
---

# @mumbo/run-wild

## Summary

`@mumbo/run-wild` gives a person's box a mode in which Mumbo never waits for the person. Run Wild is a Permissions selector entry with Full access's sandbox and approval knobs; the recorded preset name tells them apart. In a Session whose root is in Run Wild, a tool call that asks for approval runs, a plan review is approved, and a question gets a reply telling the model to decide from context and the person's rules. Each decision appends a `runwild/decision` record to the Session log. Browser consent still asks the person.

## Table of Contents

- [The preset](#the-preset)
- [Decisions](#decisions)
- [Delegated children](#delegated-children)
- [Audit record](#audit-record)
- [Composition](#composition)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="the-preset"></a>
## The preset

[`deploy/mumbo.overlay.yml`](../../../deploy/mumbo.overlay.yml) lists `run-wild: { sandbox: danger-full-access, approval: ask }` as the last `permission` preset when the environment sets `MUMBO_RUN_WILD`. The box start script sets it whenever it mounts this package, so the selector never offers Run Wild on a box that cannot honor it. The entry stays last because a Session without a recorded preset derives the first configured match, which is Full access.

- **Switching.** The person picks Run Wild in the composer's Permissions selector or the `/permission` popup, which first shows one explanation of what Mumbo will now do without asking; typing `/permission run-wild` switches without it. The switch appends `permission/preset { preset: 'run-wild' }`; from Full access it appends no knob event, because the bundles are equal. No model tool changes the preset.
- **New Sessions.** `defaultPreset` is `MUMBO_NEW_SESSION_PRESET`, or `danger-full-access` when it is unset. With `run-wild`, every new root Session, including one a schedule creates, starts in Run Wild. `MUMBO_NEW_SESSION_PRESET=run-wild` without `MUMBO_RUN_WILD` names a preset the table does not list, so the `permission` row fails to load.
- **Reading it.** `RUN_WILD_PRESET` is the preset name. `inRunWild(ctx, agent)` reports whether an Agent's live root Session is in Run Wild, and it throws for a delegated child whose root is no longer live.

<a id="decisions"></a>
## Decisions

The plugin requires `permissionPresets` and registers two prepended listeners. It registers no `approval/request` listener.

| Ask | Source | In Run Wild |
|---|---|---|
| Tool approval | A `tools/pre-execute` policy returns `ask`, such as a PreToolUse hook | Becomes `allow`; the call still passes every tool guard. This includes a tool `@mumbo/mcp` lists as irreversible, whose approval never reaches `approval/request` |
| Plan review | A question with a `plan-review` intent, from `exit_plan_mode` | Answered with the intent's `approve` label |
| Approval card | A question with an `approval` intent, such as application access | Answered once with the intent's `approve` label, never `always` |
| Question | A question without an intent, from `ask_user_question` | Answered with `selected: []` and the reply as `custom` |

Answers are synchronous, so the browser shows no card and no `needs_you` listing finds the question waiting. A Session in any other preset, and a question asked without an Agent, reach the next answerer unchanged. Asks that a plugin raises through the approval service itself, such as `@mumbo/browser-consent`'s browser writes, still reach the person.

<a id="delegated-children"></a>
## Delegated children

A delegated child, such as a `subagent` call, a fork, a workflow child or a team member, follows its root Session at the time it asks: `inRunWild` resolves the root through `subagents.rootOf`. Switching the root out of Run Wild reaches its running children at once. A child keeps its own approval policy `never`, so a tool approval it raises runs in Run Wild and is rejected otherwise; a child cannot ask questions. A Session forked by the person copies the `permission/preset` record and stays in Run Wild.

<a id="audit-record"></a>
## Audit record

Each decision appends `runwild/decision { kind, target, summary, reason }` to the asking Agent's Session, inside the turn of the tool call that asked.

| Field | Content |
|---|---|
| `kind` | `approval`, `plan-review`, or `question` |
| `target` | The tool name; the plan's `exit_plan_mode` call id; the approval card's subject; or the question id |
| `summary` | The approval reason, or the tool name without one; the question and its detail, which for a plan review is the plan |
| `reason` | Why Run Wild decided it; for a question, the reply the model received |

The record is log-only and never model-visible. It is a same-version Session format addition, acknowledged in [`docs/persistence-changes/2026-11-11-runwild-decision.md`](../../../docs/persistence-changes/2026-11-11-runwild-decision.md): an image built before this package refuses to open a Session that holds one, so rolling a box back to such an image after Run Wild has decided anything in a Session, `mumbo` included, leaves that Session unreadable.

<a id="composition"></a>
## Composition

A person's box loads [`examples/person.overlay.yml`](examples/person.overlay.yml) after `deploy/mumbo.overlay.yml`; it only inserts the plugin row. The box edge mounts it on desktop sites when the image contains the package, and its start script then exports `MUMBO_RUN_WILD=1`, plus `MUMBO_NEW_SESSION_PRESET=run-wild` for an owner who asked for it. Project boxes do not mount it. The root manifest lists this private package as a development dependency, so a Host started from the repository resolves it by name from a `--patch` overlay.

<a id="model-experience"></a>
## Model Experience

### Questions in Run Wild

#### What the model sees

The `ask_user_question` result answers each question with `"selected": []` and the reply below as `"custom"`. A plan review returns `exit_plan_mode`'s ordinary approved result, an approval card returns its caller's granted result, and a tool approval returns the tool's own result. The `runwild/decision` record stays out of model requests.

##### Verbatim reply

```markdown
Run Wild: decide from context and the person's rules, state your assumption in one line, and continue.
```

#### Token effect

About 25 tokens for each question answered, retained in the Session until compaction replaces or removes it. Plan reviews, approval cards and tool approvals add nothing beyond the results the person's approval would have produced.

#### KV Cache effect

Append-only. Each answer is an ordinary tool result after the Session's existing history, so the reusable request prefix stays intact.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Settings cannot change the new-session default on a person box** — `deploy/mumbo.overlay.yml` is a `--patch` overlay that replaces the whole `permission` row config, so Settings › General › Permission refuses to save, for every preset. The default comes from `MUMBO_NEW_SESSION_PRESET`, which the edge writes at box creation; the person switches an existing Session, such as `mumbo`, in its selector.
- **Browser and desktop writes still ask** — `@mumbo/browser-consent` asks through the approval service inside its own policy, which Run Wild does not answer, so secret-field pages, report-started turns, and per-site limits keep their current behavior until browser consent decides Run Wild itself.
- **The model is not told about the mode** — switching between Full access and Run Wild changes no knob, so the model receives no notice; Run Wild instructions keyed on the recorded preset are deferred.
- **No view of the record yet** — the transcript shows an answered question with no "decided for you" marker, and nothing lists `runwild/decision` records across Sessions, sends a push, or counts them in the digest.
- **External subagent providers do not inherit Run Wild** — codex, Claude Code and ACP children use their own configured permission mode.
- **Rollback refuses Sessions that hold the record** — see [Audit record](#audit-record).

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
