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

- **The key authenticates the relay, not the person** — any process that can read the key file can act as any allowlisted principal; the allowlist limits names, not callers.
- **No TLS** — the listener must stay on loopback; remote people reach it through an authenticated relay such as SSH.
- **Key rotation needs a reload** — the plugin reads the key file once at load.
- **JSON only** — there are no server-initiated messages, `GET` streams, or MCP sessions.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
