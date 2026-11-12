---
description: "The state block that keeps an agent's goal, approved plan, open todos and running work in its context across compactions and restarts, the plan_read tool, the notice after a restart of what stopped or finished meanwhile, and the goal stall check."
kind: "package-reference"
---

# @mumbo/state

## Summary

`@mumbo/state` keeps an agent oriented across compactions and restarts. Its runtime-context block shows the goal and its phase, the approved plan's steps, open todos and team tasks, and running subagents and jobs, and changes only at a compaction, a restart or a goal phase change. `plan_read` returns the approved plan. After a restart, one logged notice lists the work the restart stopped or that finished meanwhile, and a goal that waits for a person. With `stallCheck` on, a goal round after two rounds without a visible change asks whether the goal is done, looping or progressing.

## Table of Contents

- [The state block](#the-state-block)
- [The approved plan and plan_read](#the-approved-plan-and-plan-read)
- [The resume notice](#the-resume-notice)
- [The goal stall check](#the-goal-stall-check)
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
| Same | Its last turn ended `completed` after this Session's last message | Finished after this Session's last activity, with its last assistant text clipped to 400 characters |
| Same | Its last turn ended otherwise, a person's cancel included, after this Session's last message | Ended, with the reason, after this Session's last activity |
| Goal | It is `active` and disarmed | Still active, but its automatic rounds are stopped: a person must resume it with `/goal resume` |

A child that ended while this Session was loaded but idle usually woke it, and that turn logged the child's own notice as a message, so the child ended before this Session's last message and is not reported. It is reported when no message was logged after it ended, as when the restart came before the wake turn logged the notice, or when this Session was closing and the notice was queued without a wake; that notice, when still queued in this Session's inbox, reaches the model as well. A child whose log cannot be read is left out, with a warning in the host log. Each comparison writes one `info` line to the host log, never to the Session log or the model's context: `mumbo-state: resume reconcile` followed by the fields `session`, `children` (the direct children in the catalog), `read` (the child logs read, failed reads included) and `ms` (how long the comparison took). The notice's `summary` counts the items, such as `Restart: 1 stopped, 1 finished, goal needs a person.` `@mumbo/mcp`'s `needs_you` lists the same stopped goal in `stopped_goals` for every loaded Session. The notice declares a context form, so `@mumbo/mcp`'s report-turn gate does not read it as the message that opened a turn.

The source kind is a declared persistence type, acknowledged in [`docs/persistence-changes/2026-11-12-mumbo-resume-message-source.md`](../../../docs/persistence-changes/2026-11-12-mumbo-resume-message-source.md). Readers fall through unknown source kinds, so an image without this package shows the notice as an injected-context row.

<a id="the-goal-stall-check"></a>
## The goal stall check

`stallCheck` (default `false`) turns the check on, and `stallRounds` (default 2, at least 2) sets how many closed rounds in a row must have changed nothing. With the check on, the plugin registers the host-only Session projection `mumboRounds` (`stateVersion` 1) and a second `agent/pre-step` listener; with it off, it registers neither. Both box overlays leave it off.

A round runs from a `user/message` whose source is `{kind: 'goal', round > 0}` to the next one; a person's turn in between counts toward the earlier round. Every `goal/change`, an edit included, ends the open round and the round before it and resets the streak. The projection keeps the open round and the one before it. For each round it folds:

| Fact | Events |
|---|---|
| Calls by call key: the tool name and its arguments parsed as JSON, without null fields, `description` and `justification`, with keys sorted by code unit; arguments that are not a JSON object are keyed by their trimmed text | `tool/call`, and each `tool/ptc-dispatch`, whose arguments are already parsed |
| The last successful result of each call key: the first 16 hex characters of the SHA-256 of its text blocks; and whether a result of the key failed | `tool/result` and `tool/ptc-dispatch`, by `isError` |
| Calls and failed calls | Every `tool/result`, a result that session repair added for an unlogged call included, and every `tool/ptc-dispatch` |
| Todo items newly completed: `completed` in the round's latest list and not in the latest list before the round started, matched by exact content | `todo/write` |

A round changed something when one of these happened in it:

- A file write succeeded through `write`, `edit`, `apply_patch`, or `str_replace_editor` with a command other than `view`, and no write with the same call key succeeded earlier in this round or the round before. A successful retry of a failed write is a change; writing the same content again is not.
- A call key that already had a result in this round or the round before returned a successful result whose text differs from the last successful result of that key in each of those rounds. A failed result has no text to match, so a call that failed before and now succeeds is a change. A shell command, job read, page or MCP call that runs again with new output is a change. A key's first result is not, so exploring is not progress, and the same failing command with the same output is not. `get_goal` never counts, because its result carries the round count.
- A todo item was newly completed.

At a goal round's step, the listener, registered with `prepend` so it runs before the goal round driver's listener, first lets the rest of the chain decide. For an admitted step, it closes the open round as the fold will when the round's message is logged; when that round and the rounds before it give a streak of at least `stallRounds`, it appends a `<goal_progress_check>` text block to the round's message, which keeps its id and source. The loop logs that message as the round's `user/message`, so the questions are in the log and resume replays them. The block repeats at every round while the streak lasts; a round that changes something, or any goal change, resets it. The check never blocks, pauses or edits a goal: its last line points to the goal tool's existing `blocked` rule, which `@deepseek-ai/dsh-tool-goal` enforces with its own round threshold.

<a id="composition"></a>
## Composition

A project box inserts the row from [`deploy/mumbo-project.overlay.yml`](../../../deploy/mumbo-project.overlay.yml) in its Host plane, so the coordinator's main Session, its Executor Sessions and their subagents all get the block, `plan_read` and the notice. A person's box loads [`examples/person.overlay.yml`](examples/person.overlay.yml), which inserts the same row, as a `--patch` overlay after `deploy/mumbo.overlay.yml`. The root manifest lists this private package as a development dependency, so a Host started from the repository resolves it by name. No shipped profile or bundle mounts it.

What the block can show depends on what a Session's agent preset mounts. The Web `standard`, `cordis` and `ptc` presets mount goals, todos and plan mode; the superagent worker preset mounts todos only, and the router preset none of the three; `minimal` suppresses runtime context. A Session without `todo_write` or plan mode never logs their records, so its block has no such section, whatever the step's tool list.

<a id="evaluation"></a>
## Evaluation

Two keyless snapshots replay the real `dsh --profile sdk` runtime with the package inserted. [`mumbo-state`](../../../snapshots/sdk/mumbo-state/) approves a plan and writes todos, compacts, then reads the plan with `plan_read`: the block is logged once, after the compaction, and every later request carries that text. [`mumbo-resume`](../../../snapshots/sdk/mumbo-resume/) starts a background job, restarts the runtime, and resumes: one notice names the stopped job at the first step, and the block is logged once, after the restart. [`mumbo-goal-stall`](../../../snapshots/sdk/mumbo-goal-stall/) turns the stall check on and runs two goals: one writes a file, stalls one round and completes in round 3 without questions; the other repeats a failing `cat`, a failed `read` and the same todo list for two rounds, gets the questions in round 3, answers them and reports the goal blocked.

The live eval in [`eval/`](eval/) measures whether the block and the notice help a DeepSeek model, and runs only on demand, never in CI: `pnpm --filter @mumbo/state run eval`. It reads `DEEPSEEK_API_KEY`, and `DEEPSEEK_BASE_URL` when set, from the environment or the repository's root `.env`, and stops before any run without a key. It spends API quota and runs the model's commands with full access in a temporary copy of [`eval/fixture/`](eval/fixture/), a small project with twelve failing tests and a two-minute background check. Each run plans with `/plan`, then the arms differ: `control` mounts the package and forces nothing, `k-on` compacts after turn 1 and restarts after turn 2 with the package, and `k-off` does the same without it. `K_EVAL_RUNS` (default 3), `K_EVAL_ARMS` (default `control,k-on,k-off`), `K_EVAL_MODEL` (default the `sdk` profile's model, which a box also uses) and `K_EVAL_MAX_TURNS` (default 8) set its size. After each boundary it counts repeated reads among the next ten tool calls and the steps until the first change; after the restart also calls on the stopped job and a rerun of the check. It writes each run's events, Session files and a `summary.json` under `eval/results/` (ignored by git) and prints medians per arm and the `k-on` deltas.

The K3 eval measures whether the stall check helps, also on demand only: `pnpm --filter @mumbo/state run eval:k3`, with the same key and the same costs. Both arms mount [`examples/person.overlay.yml`](examples/person.overlay.yml); `k3-on` also sets `stallCheck: true`. Each run starts one goal with `/goal` in a fresh workspace and returns when its rounds stop. The `stuck` task ([`eval/fixture-k3/stuck/`](eval/fixture-k3/stuck/)) asks for `node check.mjs` to pass when the signing key it needs is absent and the operator issues it; the right ending is a reported block. The check prints one line without timings, so rerunning it unchanged changes nothing the stall check can see. The `progress` task is the K eval's inventory project as a goal. The `shell-only` task ([`eval/fixture-k3/shell-only/`](eval/fixture-k3/shell-only/)) applies four migrations through a two-minute background script and forbids file edits, so its progress is shell work. `K3_EVAL_RUNS` (default 5), `K3_EVAL_ARMS` (default `k3-on,k3-off`), `K3_EVAL_TASKS` (default `stuck,progress,shell-only`), `K3_EVAL_MAX_ROUNDS` (the goal's round cap, default 10) and `K_EVAL_MODEL` set its size. Each run reports its admitted rounds, how the goal ended, the logged questions, the first stalled round (in `k3-off`, the first round the check would have asked in), the rounds from there to the end, stalled rounds, repeated calls and tool errors from the check's own fold, whether `stuck` changed its check or made it pass, whether `progress` passed its tests, whether `shell-only` ended before all four migrations or reported a block, requests, tokens and wall time. It writes them under `eval/results/k3-<time>/` and prints every run, then medians per task and arm and the `k3-on` deltas. Box overlays turn the check on only when no `k3-on` run of `shell-only` ends prematurely and the median `questionsShown` of the `k3-on` runs of `progress` is 0.

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

One user-role message at the first step after a restart that has something to report: `This Session was restarted. Changes it may not have been told about:` followed by one `- ` line per item in the table above.

#### Token effect

About 25 tokens plus about 25 per item, once per restart, retained until compaction.

#### KV Cache effect

Append-only: the notice is appended after the restored history in the step that carries it.

### Goal progress questions

#### What the model sees

With `stallCheck` on, a second text block in a goal round's message, after `</goal_round>`, when the rounds before it changed nothing the check sees. The evidence line names the streak, the last two rounds' tool calls, how many repeat an earlier call with the most repeated one (`most often`, or `for example` on a tie, path first and clipped to 80 characters), and how many failed; a part without a count is left out, and without calls it reads `you made no tool call`. After three or more stalled rounds, `In those two rounds` reads `In the last two of them`.

##### Verbatim block, as goal B's third round in the snapshot has it

```markdown
<goal_progress_check>
The last 2 rounds of this goal (1 to 2) showed no progress that this check can see. In those two rounds you made 6 tool calls, 3 of them repeating an earlier call (for example bash {"command":"cat config/token.txt"}, 2 times), and 2 failed.
Before you continue, answer these in your reply:
1. Done? If the whole objective is achieved, gather the evidence and mark the goal complete.
2. Looping? Name any call or approach you keep repeating, and stop repeating it.
3. Progressing? If you made progress this check cannot see, such as shell commands, browser or MCP work, or work by subagents, say what changed and continue.
4. What next? Name the one step that moves the objective forward, and take it.
If one condition outside your control has stopped progress in each of these rounds, follow the goal policy for blocked: call update_goal with action blocked and name that condition in blocked_reason.
</goal_progress_check>
```

#### Token effect

About 250 tokens in each round message that carries it, retained until compaction; nothing while rounds change something or the check is off.

#### KV Cache effect

Append-only: the block is part of the round's own message, which already starts a new request series, so the cached prefix stays reusable.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Person boxes do not mount it yet** — the box edge's start-script patch that loads `examples/person.overlay.yml` on person boxes ships separately on `boxes/production`; until it lands, only project boxes mount the package.
- **A plugin reload renders between boundaries** — reloading the plugin, such as after a configuration change, empties the per-process memo, so the next request renders the block anew; the rendered text is still logged.
- **A disarm without a goal change is not a boundary** — `goals.disarm()` is process-local and unlogged, so after a disarm without a restart, such as the goal round driver's after a failed, cut-off or cancelled turn, the block can say the goal runs until the next boundary.
- **A graceful stop can hide a job's end** — the projection drops a settled job at the next step, which it takes to have claimed the settlement's notice; from then on the resume notice does not report the job. Two windows leave that notice queued in the Agent's inbox instead: a job that settles during a step's own pre-step, after that step claimed its inbox, reaches only the next step; and each turn claims one queued message, so a settlement's notice queued behind a person's message or another notice, as while a manual compaction keeps a turn from starting, waits for a later turn. The inbox is logged, so after a crash the reloaded Session still delivers the notice. A graceful stop, such as a signal to a box's Web host, disposes the Agent, which discards its queued messages, so neither the job's notice nor the resume notice reports the job's end.
- **Some approvals are not recorded** — an approval whose turn is cancelled before its next step, and an approval in a Session that already left plan mode, append no `plan/mode` record, so the plan is not kept.
- **An SDK server restart can hide a stopped child** — the SDK server's own shutdown, which an SDK client's `close()` requests, cancels running descendants with cause `parent` before it disposes the roots, so a running child's turn ends `aborted` with reason `parent`. The notice reads that as an ordinary end: it reports the child as ended (aborted), without the `send_message` hint, only when the end comes after this Session's last message, and omits it otherwise. A host stopped by a signal, as a box's Web host is, disposes the whole host, which ends the child's turn with reason `disposed`, reported as stopped.
- **Each comparison reads every child's whole log** — the subagent catalog records no end time or status, so a comparison reads the full log of every direct `one-shot` or `continuable` child that is not loaded, also one that ended long before; the `mumbo-state: resume reconcile` host line reports how many and how long.
- **The notice reads direct children only** — grandchildren are not compared, and a continuable child that finished before this Session went down but whose result never reached it is not reported.
- **The stall check is off on boxes** — work that leaves no file-tool write, no completed todo and no repeated call with new output, such as a new shell command, browser, MCP or computer-use work, a subagent's or team's work, or a wait for a background job, reads as no change; that is much of a person's assistant's work, and from round 3 such a goal is asked whether it is done and pointed at `blocked`. Delegated work is not counted. Box overlays turn the check on only after the [K3 eval](#evaluation) passes its gate on the `shell-only` and `progress` tasks.
- **Changed output can be noise** — a repeated call whose output holds a time, a duration, a fresh id or a spill file path counts as a change each time, so a loop over such a call never stalls; a repeated `node --test`, whose report holds durations, is one.
- **Each round keeps one output per call** — a call's new result is compared with its last successful result in this round and in the round before, not with every earlier one, so output that alternates within a round counts as a change. The window is the open round and the one before, so a write that recurs only every other round counts as a change each time.
- **The stall check measures activity, not correctness** — marking a todo item completed, or writing a progress file with new content each round, resets the streak; a reworded or removed and re-added item counts as newly completed.
- **Call keys drop free text** — calls that differ only in `description`, `justification` or null fields count as one key, and a `run_code` counts once plus once per sub-call.
- **The streak restarts after any goal change** — a person's resume after a restart, or an edit, resets it, so a goal that stalled before gets two more rounds before the questions.
- **The shown block and the fold can differ** — the listener computes the block before the round's message is logged, and events another producer appends in between can change the streak the fold records; the logged block is what the model saw.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
