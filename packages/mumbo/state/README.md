---
description: "The state block that keeps an agent's goal, approved plan, open todos and running work in its context across compactions and restarts, the plan_read tool, and the notice after a restart of what stopped or finished meanwhile."
kind: "package-reference"
---

# @mumbo/state

## Summary

`@mumbo/state` keeps an agent oriented across compactions and restarts. It adds a short state block to the runtime context: the goal and its phase, the approved plan's step headings, open todos, open team tasks, running subagents and background jobs. The block changes only at a compaction, a restart, or a goal phase change, so turns in between re-send nothing. `plan_read` returns the approved plan's full text. At the first step after a restart, one logged notice lists the jobs, workflow runs and subagents that the restart stopped or that finished meanwhile, and a goal that waits for a person.

## Table of Contents

- [The state block](#the-state-block)
- [The approved plan and plan_read](#the-approved-plan-and-plan-read)
- [The resume notice](#the-resume-notice)
- [Composition](#composition)
- [Evaluation](#evaluation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="the-state-block"></a>
## The state block

The plugin `mumbo-state` requires `systemPrompt`, `sessionProjections`, `tools` and `agents`, and reads `goals`, `jobs`, `agentTeams`, `subagents` and `sessionQuery` when the host provides them; a missing service removes its part of the block and of the notice. It registers the runtime context `mumbo:state` at order 300, after the harness's own contexts, with `interpolate: false`, because objectives and todos may contain `{{…}}`. The context is optional, so an agent preset that suppresses runtime context, such as `minimal`, drops it.

The block's sections, in order, each present only when it has content:

| Section | Source | Pointer for what does not fit |
|---|---|---|
| Goal | `goals.get(agent)`: phase, whether its automatic rounds stopped, which a restart or the goal round driver's disarm after a failed, cut-off or cancelled turn causes, rounds, objective, block reason | `get_goal` |
| Plan | The approved plan's title and step headings, from the log | `plan_read` |
| Todo | The items of the last `todo_write` that are not `completed`, labelled with the turn that wrote them | your last `todo_write` |
| Team tasks | `agentTeams.listTasks(agent)` with status `pending` or `in_progress`, while Team mode is on | `team_task_list` |
| Subagents running | Direct children in the `subagentCatalog` projection whose Agent is running | `list_agents` |
| Background jobs | `jobs.list(session)` with status `running` or `stopping`; a background workflow run is a `workflow` job | `job_list` |

`maxChars` (default 1600, at least 400) caps the whole text. Lines are added in order while the text plus a 160-character reserve fits; the first item that does not fit becomes `… N more (<pointer>)`, and a section whose heading does not fit is named in a final `Not shown:` line. Each item line, the block reason and the plan title are put on one line and clipped to 140 UTF-16 code units, the objective to 300, never inside a surrogate pair. A Session with nothing to show contributes no section. The text holds no clock times.

The host-only Session projection `mumboState` counts boundaries: a `compaction/end` without `error`, every `session/end-seed`, and every `goal/change` except an `edit`. The block renders on the first request after the count moves, and in this process every later request of that Session reuses the text, including each retry's context refresh. Live reads, such as the goal's activation, team tasks, running children and jobs, happen only in that render. A compaction moves the count during the step's `agent/pre-step`, after the step's first assembly, and the loop admits the re-rendered text through its context refresh before the request, replacing the earlier candidate. Todo edits and goal edits between boundaries reach the model as its own recent `todo_write` and goal tool calls, not as a new block.

<a id="the-approved-plan-and-plan-read"></a>
## The approved plan and plan_read

The projection folds plan mode's own records; no event is added. An `exit_plan_mode` call presents a plan. A successful result followed by `plan/mode {active: false}` before the turn ends is an approval, which plan mode appends at the next step of the same turn; Run Wild's approval takes the same path. A failed result means the person kept planning. A successful result followed by the end of the turn is a dismissed review, also when the person turns plan mode off afterwards. The latest approval replaces an earlier plan.

The title is the plan's first `# ` heading. Steps are its `##` and `###` headings in order, or, without any, its column-0 list items (`1.`, `1)`, `-`, `*`).

`plan_read` takes no arguments and returns `Approved in turn N.`, a blank line, and the plan's markdown. It is offered only in a Session that holds an approved plan, so the tool list changes once, when the first plan is approved. It reads the log only, needs no approval, and may run beside other calls; its card is titled `Read approved plan`. In a turn a project's report started, `@mumbo/mcp`'s gate lets it run unasked, Run Wild included ([report-started turns](../mcp/README.md#report-started-turns)).

<a id="the-resume-notice"></a>
## The resume notice

A `session/end-seed` without `inherited` records the restart: its seq, the time of the last message logged before it, and the time the run it ended began, which is the end-seed before it, when the Session was last loaded, or else the Session's first event. A fork's inherited end-seed records no restart and drops the copied jobs and runs, which the fork does not own. The plugin's `agent/pre-step` listener lets the rest of the chain decide first; for a step it admits, at the first step after a restart, it compares what the log says ran with what runs now and adds at most one `user/message` with source `{kind: 'mumbo-resume', form: 'notice', summary}`. The loop logs it in that step, and the logged notice marks the restart checked, so no later step repeats it. With nothing to report, nothing is logged, and the step's assistant message marks the restart checked instead, so no later step compares again, also after a plugin reload. The listener also remembers that check for the Session in this process, so when the step's request fails before any reply, as during a provider outage, the next step does not compare again; a plugin reload before any reply forgets it. A restart that a Session ran past before the plugin was mounted is checked by its first assistant message the same way, so the first notice after mounting covers only the latest restart. A rejected or aborted step, including one aborted while it reads a child's log, leaves the restart recorded for the next step, and a step that already carries a notice, which an outer listener such as the goal round driver put back in the inbox unlogged, gets no second one.

| Item | Reported when | Line |
|---|---|---|
| Background job other than a workflow run, registered before the restart | It has no settlement, or its settlement's cause is `teardown`, as a graceful shutdown records | Stopped by the restart, output not kept |
| Same | It settled after the last step before the restart began, so no step claimed its notice | Finished after the last step began, with its status and detail, output not kept |
| Workflow run started before the restart | It has no `run-end` | Stopped by the restart, with the count of its agents that were running |
| Same | It ended after the last step before the restart began | Finished, with its stop reason, after the last step began |
| Direct `one-shot` or `continuable` child that is not loaded, read through `sessionQuery.observeSession` | Its last turn is open, ended `interrupted`, or was aborted because its Agent was disposed, and its last event falls in the run the restart ended: at or after that run began and no later than the restart's end-seed. A child idle since before that run belongs to an earlier restart, which is checked, or to none, and one whose log moved after the end-seed was not stopped by this restart | Stopped mid-task by the restart; a continuable child adds `Use send_message to <name> to continue it.` |
| Same | Its last turn ended `completed` after this Session's last message | Finished while this Session was not loaded, with its last assistant text clipped to 400 characters |
| Same | Its last turn ended otherwise, a person's cancel included, after this Session's last message | Ended, with the reason |
| Goal | It is `active` and disarmed | Still active, but its automatic rounds are stopped: a person must resume it with `/goal resume` |

A child whose log cannot be read is left out, with a warning in the host log. The notice's `summary` counts the items, such as `Restart: 1 stopped, 1 finished, goal needs a person.` `@mumbo/mcp`'s `needs_you` lists the same stopped goal in `stopped_goals` for every loaded Session. The notice declares a context form, so `@mumbo/mcp`'s report-turn gate does not read it as the message that opened a turn.

The source kind is a declared persistence type, acknowledged in [`docs/persistence-changes/2026-11-12-mumbo-resume-message-source.md`](../../../docs/persistence-changes/2026-11-12-mumbo-resume-message-source.md). Readers fall through unknown source kinds, so an image without this package shows the notice as an injected-context row.

<a id="composition"></a>
## Composition

A project box inserts the row from [`deploy/mumbo-project.overlay.yml`](../../../deploy/mumbo-project.overlay.yml) in its Host plane, so the coordinator's main Session, its Executor Sessions and their subagents all get the block, `plan_read` and the notice. A person's box loads [`examples/person.overlay.yml`](examples/person.overlay.yml), which inserts the same row, as a `--patch` overlay after `deploy/mumbo.overlay.yml`. The root manifest lists this private package as a development dependency, so a Host started from the repository resolves it by name. No shipped profile or bundle mounts it.

What the block can show depends on what a Session's agent preset mounts. The Web `standard`, `cordis` and `ptc` presets mount goals, todos and plan mode; the superagent worker preset mounts todos only, and the router preset none of the three; `minimal` suppresses runtime context. A Session without `todo_write` or plan mode never logs their records, so its block has no such section, whatever the step's tool list.

<a id="evaluation"></a>
## Evaluation

Two keyless snapshots replay the real `dsh --profile sdk` runtime with the package inserted. [`mumbo-state`](../../../snapshots/sdk/mumbo-state/) approves a plan and writes todos, compacts, then reads the plan with `plan_read`: the block is logged once, after the compaction, and every later request carries that text. [`mumbo-resume`](../../../snapshots/sdk/mumbo-resume/) starts a background job, restarts the runtime, and resumes: one notice names the stopped job at the first step, and the block is logged once, after the restart.

The live eval in [`eval/`](eval/) measures whether the block and the notice help a DeepSeek model, and runs only on demand, never in CI: `pnpm --filter @mumbo/state run eval`. It reads `DEEPSEEK_API_KEY`, and `DEEPSEEK_BASE_URL` when set, from the environment or the repository's root `.env`, and stops before any run without a key. It spends API quota and runs the model's commands with full access in a temporary copy of [`eval/fixture/`](eval/fixture/), a small project with twelve failing tests and a two-minute background check. Each run plans with `/plan`, then the arms differ: `control` mounts the package and forces nothing, `k-on` compacts after turn 1 and restarts after turn 2 with the package, and `k-off` does the same without it. `K_EVAL_RUNS` (default 3), `K_EVAL_ARMS` (default `control,k-on,k-off`), `K_EVAL_MODEL` (default the `sdk` profile's model, which a box also uses) and `K_EVAL_MAX_TURNS` (default 8) set its size. After each boundary it counts repeated reads among the next ten tool calls and the steps until the first change; after the restart also calls on the stopped job and a rerun of the check. It writes each run's events, Session files and a `summary.json` under `eval/results/` (ignored by git) and prints medians per arm and the `k-on` deltas.

<a id="model-experience"></a>
## Model Experience

### State block

#### What the model sees

The block is the `mumbo:state` section of the loop's runtime-context snapshot, a user-role message that the loop logs before the request that carries it, with the sections above. It starts with the line below.

##### Verbatim first line

```markdown
Mumbo state at the last compaction, restart or goal change. Changes after that point are in the conversation that follows.
```

#### Token effect

Up to `maxChars` characters, about 400 tokens at the default, re-sent at most once per boundary as part of the whole runtime-context snapshot, which the loop re-sends when any of its sections changes. Nothing is added while the count stays the same.

#### KV Cache effect

Append-only. The snapshot is appended after the existing history, so the cached prefix stays reusable; a compaction already starts a new request series, and a restart or a goal phase change appends one snapshot.

### plan_read

#### What the model sees

The tool, offered once a plan is approved, with the description `Read the full text of the latest approved plan. Use it when the step headings in the runtime context are not enough.` and no parameters; its result is `Approved in turn <N>.`, a blank line, and the plan.

#### Token effect

About 30 tokens of schema in every request once a plan is approved, and the plan's length for each call, retained until compaction.

#### KV Cache effect

The tool list changes once per Session, when the first plan is approved, which re-sends the request's tool declarations; each call's result is appended.

### Resume notice

#### What the model sees

One user-role message at the first step after a restart that has something to report: `This Session was restarted. What changed while it was down:` followed by one `- ` line per item in the table above.

#### Token effect

About 25 tokens plus about 25 per item, once per restart, retained until compaction.

#### KV Cache effect

Append-only: the notice is appended after the restored history in the step that carries it.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Person boxes do not mount it yet** — the box edge's start-script patch that loads `examples/person.overlay.yml` on person boxes ships separately on `boxes/production`; until it lands, only project boxes mount the package.
- **A plugin reload renders between boundaries** — reloading the plugin, such as after a configuration change, empties the per-process memo, so the next request renders the block anew; the rendered text is still logged.
- **A disarm without a goal change is not a boundary** — `goals.disarm()` is process-local and unlogged, so after a disarm without a restart, such as the goal round driver's after a failed, cut-off or cancelled turn, the block can say the goal runs until the next boundary.
- **A crash can hide a job's end** — the projection drops a settled job at the next step, which it takes to have claimed the settlement's notice; from then on the resume notice does not report the job. Two windows leave that notice waiting in memory instead, and a crash there loses it: a job that settles during a step's own pre-step, after that step claimed its inbox, reaches only the next step; and any message queued for the next turn while no turn can start, such as during a manual compaction, waits, since each turn claims one queued message, so a settlement's notice queued behind a person's message or another notice waits for a later turn.
- **Some approvals are not recorded** — an approval whose turn is cancelled before its next step, and an approval in a Session that already left plan mode, append no `plan/mode` record, so the plan is not kept.
- **An SDK server restart can hide a stopped child** — the SDK server's own shutdown, which an SDK client's `close()` requests, cancels running descendants with cause `parent` before it disposes the roots, so a running child's turn ends `aborted` with reason `parent`. The notice reads that as an ordinary end: it reports the child as ended (aborted), without the `send_message` hint, only when the end comes after this Session's last message, and omits it otherwise. A host stopped by a signal, as a box's Web host is, disposes the whole host, which ends the child's turn with reason `disposed`, reported as stopped.
- **The notice reads direct children only** — grandchildren are not compared, and a continuable child that finished before this Session went down but whose result never reached it is not reported.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
