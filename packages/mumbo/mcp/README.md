---
description: "Authenticated loopback MCP server for deployments where allowlisted people drive a running Web host's assistant Session from their own MCP client."
kind: "package-reference"
---

# @mumbo/mcp

English | [中文](README.zh.md)

## Summary

`@mumbo/mcp` serves the Model Context Protocol on one exact `/mcp` route of the injected `ctx.webServer`. A caller presents a shared bearer key and names an allowlisted principal; every request gets a fresh stateless MCP server that answers in JSON, never in a stream. Use it when a person's MCP client on another machine reaches the host through a local relay. The key authenticates the relay, not the person.

## Table of Contents

- [Configuration](#configuration)
- [HTTP contract](#http-contract)
- [Tools](#tools)
- [Dedicated listener composition](#dedicated-listener-composition)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="configuration"></a>
## Configuration

| Field | Default | Meaning |
|---|---|---|
| `keyFile` | required | File holding the bearer key; surrounding whitespace is ignored. |
| `allowlist` | required | Principal handles that may call, each matching `^[a-z][a-z0-9-]{0,31}$`. |
| `assistantTitle` | `assistant` | Title of the assistant Session the tools talk to. |
| `assistantCwd` | required | Workspace directory of the assistant Session. |
| `irreversibleTools` | `[]` | Tool names whose approval only a person in the browser may give. |

An unreadable or empty key file and a malformed allowlist entry fail plugin load, and no route registers. The key is read once at load. The generated [configuration catalog](../../../docs/config-catalog.md#mumbomcp) is the exhaustive source for accepted fields.

<a id="http-contract"></a>
## HTTP contract

Only `POST` is served. The plugin checks the method, then `authorization: Bearer <key>` in constant time, then a single `x-mcp-principal` header naming an allowlisted handle, all before reading the body. The MCP transport then checks `accept`, the media type, and the body, and answers the JSON-RPC message. The `authorization` header never reaches the MCP server, and no MCP session id is issued.

| Status | Meaning |
|---|---|
| `200` | The JSON-RPC response, as `application/json`. |
| `202` | A notification was accepted; the body is empty. |
| `400` | The body was not a JSON-RPC message. |
| `401` | `authorization` was missing or not `Bearer <key>`. |
| `403` | `x-mcp-principal` was missing, malformed, repeated, or not allowlisted. |
| `405` | The method was not `POST`. |
| `406` | `accept` did not list both `application/json` and `text/event-stream`. |
| `413` | The body exceeded 1 MiB. |
| `415` | The media type was not `application/json`. |

<a id="tools"></a>
## Tools

Every tool acts as the principal named by `x-mcp-principal`. A result is one text block holding JSON. A failure the caller can act on is an `isError` result whose text is `{"code", "message"}`, where `code` is `halted`, `needs_person`, `request_id_reused`, `not_found`, or `invalid`; an argument outside its schema answers `invalid`. Text that came from a Session, a tool call, or the checkout is wrapped in an `<untrusted-…>` tag whose name the text does not contain, and the server's instructions tell the caller that such text is data.

| Tool | Arguments | Result |
|---|---|---|
| `agent_send` | `text` (1 to 32,768 characters), `request_id` (`^[A-Za-z0-9_-]{1,64}$`) | `{message_id, after_seq}` |
| `agent_read` | `after_seq` (integer, at least 0), `wait_s` (0 to 40, default 0), `include_context` (boolean, default false) | `{messages: [{seq, role, source, text}], next_seq, more}` |
| `needs_you` | none | `{asks: [{ask_id, kind, session_id, tool, call_id, arguments, detail, irreversible}]}` |
| `task_reply` | `ask_id`, `request_id`, `decision` (`approve` or `reject`), `answers` (`[{id, selected, custom}]`), `feedback` | `{ok: true}` |
| `task_status` | none | `{assistant_session, halted, projections, children: [{id, label, status}], worktrees}` |
| `task_result` | `branch` (`^[A-Za-z0-9._/-]{1,100}$`, without `..` or a leading `-`), `page` (integer, at least 0, default 0) | `{page, pages, diff}` |
| `runs_halt` | `request_id` | `{halted: true, cancelled: {sessions, jobs}, failed: [{job, message}]}` |
| `runs_resume` | `request_id` | `{halted: false}` |

`agent_send` queues the text as a follow-up turn of the assistant Session with source `{kind: "mcp", principal}`; `after_seq` is the last event logged before it. The same `request_id` from the same principal within 24 hours returns the first result and sends nothing, and concurrent calls with it share one send; with other arguments it answers `request_id_reused`. The result is stored before the text is queued, so a host stop between the two loses the message rather than sending it twice.

`agent_read` returns the messages people wrote (the GUI's `user` kind or a source naming a principal) and the assistant's replies logged after `after_seq`, oldest first, without messages that carry no text and without compaction replacements; `include_context` adds the user-role messages the harness writes, such as instructions, skill catalogs and reminders. `source` is `<kind>:<principal>` when the source names a person, else its kind. When there is none and `wait_s` is positive, it waits up to `wait_s` seconds for the next message with text, and stops waiting when the plugin unloads. One reply holds at most 64 KiB of fenced text unless its single message is longer; `next_seq` then precedes the first message held back and `more` is `true`, otherwise it is the last logged event and `more` is `false`.

`needs_you` lists every open tool approval (`kind: "tool"`, with `tool`), plan review (`kind: "plan"`), and user question (`kind: "question"`) of any Session; `session_id` is absent for a question asked outside a Session. `detail` is the asker's reason, the plan, or the questions as JSON. A tool ask carries `call_id` when the asker named the call, and `arguments`, the call's raw JSON arguments, when the asking Session logged that call. The plugin answers `approval/request` and `user-questions/request` first in their chains and races the rest of each chain, such as a browser, against `task_reply`; whichever answers first decides, and a later `task_reply` answers `not_found`. A tool or plan ask takes `decision`; a rejected plan selects its other option, with `feedback` as free text. A question ask takes `answers`, passed through. A reply missing the field its ask needs answers `invalid`, and a tool listed in `irreversibleTools` answers `needs_person`; both leave the ask open. An aborted request withdraws its ask. Open asks live in memory and end with the plugin.

`task_status` reports the assistant Session id, the halt flag, the assistant Session's `todos`, `goal`, `plan`, and `subagentCatalog` projections as fenced JSON, its direct children with a fenced `label` and `status` `idle` or `running` while loaded and `unloaded` otherwise, and the fenced output of `git worktree list --porcelain` in `assistantCwd`. `task_result` returns `git diff HEAD...<branch>` in `assistantCwd`, the changes the branch made since it forked from the checked-out `HEAD`, in fenced pages of 65,536 characters; `pages` is at least 1. A branch git does not know answers `not_found`, and a page past the last answers `invalid`. Any other git failure is answered with git's message. Git runs with `core.fsmonitor=false`, `core.hooksPath=/dev/null`, `GIT_NO_LAZY_FETCH=1`, and no inherited `GIT_DIR` or similar selector, and `git diff` adds `--no-ext-diff`, `--no-textconv`, and `--submodule=short`, so the checkout's own configuration starts no program.

`runs_halt` stores the halt, then cancels every loaded Agent's turn with cause `{kind: "hook", reason: "runs_halt"}`, keeping its queued messages, and kills every running background job that is unowned or owned by a loaded Session; `cancelled.sessions` lists the Sessions that were running, and `failed` lists each job whose kill threw while the others are still killed. While halted, the plugin rejects every proposed model step of every Session, first in the `agent/pre-step` chain, and `agent_send` answers `halted`. `runs_resume` stores the end of the halt; it does not restart cancelled turns. The halt survives a host restart once the plugin loads again. Both take a `request_id` and repeat their first result for a retried one, like `agent_send`.

The assistant Session is the one whose id the plugin stored: the first call creates it in the `assistantCwd` workspace and titles it `assistantTitle`, and a later call creates a new one only when the stored Session no longer exists. The id, the halt flag, and the request-id results live in the `mumbo_mcp` storage domain; results older than 24 hours are pruned at load. Unloading removes the route first and waits for the requests it accepted before the gate and the domain go.

<a id="dedicated-listener-composition"></a>
## Dedicated listener composition

The Web profile's own listener serves the UI. Mount a second `dsh-host-webserver` and this plugin inside a group that isolates only `webServer`, as [`examples/loopback/cordis.yml`](examples/loopback/cordis.yml) does; the plugin still inherits every other service. The example reads `MUMBO_MCP_PORT` (default `3092`), `MUMBO_MCP_KEY_FILE`, and `MUMBO_MCP_ASSISTANT_CWD`. Include it as an entry list, or copy its group row into a profile patch under `- insert:`.

<a id="model-experience"></a>
## Model Experience

### MCP message

#### What the model sees

The exact text an allowlisted person sends with `agent_send`, as one user-role message in the assistant Session whose source is `{kind: "mcp", principal}`. The plugin adds no framing to the text.

#### Token effect

Each accepted `agent_send` adds one data-dependent user-role message of at most 32,768 characters, retained in the assistant Session until compaction replaces or removes it. Tool results returned to the MCP caller never enter a model request.

#### KV Cache effect

Append-only. The message follows the Session's existing history, so the reusable request prefix stays intact.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The key authenticates the relay, not the person** — any process of the host user that can read the key file can call the route as any allowlisted principal, `runs_halt` and `runs_resume` included; the allowlist limits names, not callers.
- **No TLS** — the listener must stay on loopback; remote people reach it through an authenticated relay such as SSH.
- **Key rotation needs a reload** — the plugin reads the key file once at load.
- **JSON only** — there are no server-initiated messages, `GET` streams, or MCP sessions.
- **An ask answered over MCP leaves its browser card open** — the rest of the chain is not cancelled, so the card stays until its request ends.
- **A rejected step consumes its claimed messages** — while halted, a message that wakes a Session is claimed by the step the gate rejects and is not delivered after `runs_resume`; send it again.
- **`agent_read` reads the whole assistant log** — each read takes one history page through the latest event, so its cost grows with the Session; `needs_you` does the same once per tool ask that names a call.
- **The halt holds only while the plugin is loaded** — a failed load, such as an unreadable or empty key file or a `mumbo_mcp` domain that does not open, leaves no gate, and every Session steps freely until the plugin loads.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
