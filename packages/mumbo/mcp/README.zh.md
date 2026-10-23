---
description: "面向让白名单中的人从自己的 MCP 客户端驱动运行中 Web 主机助手会话的部署，说明经过身份验证的 loopback MCP 服务器。"
kind: "package-reference"
---

# @mumbo/mcp

[English](README.md) | 中文

## 概述

`@mumbo/mcp` 在注入的 `ctx.webServer` 的一条精确 `/mcp` 路由上提供 Model Context Protocol。调用方出示共享的 bearer 密钥，并指明一个白名单中的 principal；每个请求都会得到一个全新的无状态 MCP 服务器，它以 JSON 应答，从不使用流。当某人在另一台机器上的 MCP 客户端经本地 relay 访问主机时，请使用它。密钥验证的是 relay，而不是人。

## 目录

- [配置](#configuration)
- [HTTP 约定](#http-contract)
- [工具](#tools)
- [专用监听器组合](#dedicated-listener-composition)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="configuration"></a>
## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `keyFile` | 必填 | 保存 bearer 密钥的文件；忽略首尾空白。 |
| `allowlist` | 必填 | 可以调用的 principal handle，每个都须匹配 `^[a-z][a-z0-9-]{0,31}$`。 |
| `assistantTitle` | `assistant` | 工具所对话的助手会话的标题。 |
| `assistantCwd` | 必填 | 助手会话的工作区目录。 |
| `irreversibleTools` | `[]` | 只能由浏览器中的人批准的工具名。 |

密钥文件无法读取或为空、白名单条目格式错误时，插件加载失败，且不注册任何路由。密钥只在加载时读取一次。生成的[配置目录](../../../docs/config-catalog.zh.md#mumbomcp)是所有可接受字段的完整来源。

<a id="http-contract"></a>
## HTTP 约定

只服务 `POST`。插件先检查方法，再以恒定时间检查 `authorization: Bearer <key>`，然后检查唯一一个指明白名单 handle 的 `x-mcp-principal` header，这些都在读取 body 之前完成。随后由 MCP 传输检查 `accept`、media type 与 body，并应答 JSON-RPC 消息。`authorization` header 从不到达 MCP 服务器，也不会签发 MCP 会话 id。

| 状态 | 含义 |
|---|---|
| `200` | JSON-RPC 响应，类型为 `application/json`。 |
| `202` | 通知已接受；body 为空。 |
| `400` | body 不是 JSON-RPC 消息。 |
| `401` | 缺少 `authorization`，或它不是 `Bearer <key>`。 |
| `403` | `x-mcp-principal` 缺失、格式错误、重复或不在白名单中。 |
| `405` | 方法不是 `POST`。 |
| `406` | `accept` 没有同时列出 `application/json` 与 `text/event-stream`。 |
| `413` | body 超过 1 MiB。 |
| `415` | media type 不是 `application/json`。 |

<a id="tools"></a>
## 工具

每个工具都以 `x-mcp-principal` 指明的 principal 的身份行事。结果是一个包含 JSON 的文本块。调用方可以处理的失败是一个 `isError` 结果，其文本为 `{"code", "message"}`，`code` 为 `halted`、`needs_person`、`request_id_reused`、`not_found` 或 `invalid` 之一；不符合 schema 的参数应答 `invalid`。来自会话、工具调用或检出目录的文本包裹在 `<untrusted-…>` 标签中，标签名不出现在该文本内；服务器的 instructions 告诉调用方这类文本是数据。

| 工具 | 参数 | 结果 |
|---|---|---|
| `agent_send` | `text`（1 到 32,768 个字符）、`request_id`（`^[A-Za-z0-9_-]{1,64}$`） | `{message_id, after_seq}` |
| `agent_read` | `after_seq`（整数，至少为 0）、`wait_s`（0 到 40，默认 0） | `{messages: [{seq, role, source, text}], next_seq, more}` |
| `needs_you` | 无 | `{asks: [{ask_id, kind, session_id, tool, call_id, arguments, detail, irreversible}]}` |
| `task_reply` | `ask_id`、`request_id`、`decision`（`approve` 或 `reject`）、`answers`（`[{id, selected, custom}]`）、`feedback` | `{ok: true}` |
| `task_status` | 无 | `{assistant_session, halted, projections, children: [{id, label, status}], worktrees}` |
| `task_result` | `branch`（`^[A-Za-z0-9._/-]{1,100}$`，不含 `..`，不以 `-` 开头）、`page`（整数，至少为 0，默认 0） | `{page, pages, diff}` |
| `runs_halt` | `request_id` | `{halted: true, cancelled: {sessions, jobs}, failed: [{job, message}]}` |
| `runs_resume` | `request_id` | `{halted: false}` |

`agent_send` 把文本作为助手会话的一个 follow-up 轮次排队，source 为 `{kind: "mcp", principal}`；`after_seq` 是此前记录的最后一个事件。同一 principal 在 24 小时内重复同一 `request_id` 时返回首次结果且不再发送，使用它的并发调用共享一次发送；参数不同则应答 `request_id_reused`。结果先于文本排队存储，因此主机在两者之间停止时会丢失该消息，而不会发送两次。

`agent_read` 按从旧到新返回 `after_seq` 之后记录的 user 与 assistant 消息，不含没有文本的消息，也不含压缩替换。source 指明某人时 `source` 为 `<kind>:<principal>`，否则为其 kind。没有消息且 `wait_s` 为正数时，它最多等待 `wait_s` 秒以获得下一条带文本的消息，插件卸载时停止等待。一次应答至多包含 64 KiB 已包裹的文本，除非其唯一的消息更长；此时 `next_seq` 位于第一条被留下的消息之前且 `more` 为 `true`，否则它是最后记录的事件且 `more` 为 `false`。

`needs_you` 列出任一会话中所有未决的工具批准（`kind: "tool"`，带 `tool`）、计划评审（`kind: "plan"`）与用户问题（`kind: "question"`）；在会话之外提出的问题没有 `session_id`。`detail` 是提问方给出的原因、计划，或以 JSON 表示的问题。提问方指明调用时，工具请求带有 `call_id`；提问的会话记录了该调用时，还带有 `arguments`，即该调用的原始 JSON 参数。插件在 `approval/request` 与 `user-questions/request` 链中最先应答，并让链的其余部分（例如浏览器）与 `task_reply` 竞速；先应答者决定结果，之后的 `task_reply` 应答 `not_found`。工具或计划请求接受 `decision`；被拒绝的计划选择其另一个选项，并以 `feedback` 作为自由文本。问题请求接受 `answers`，原样传递。回复缺少其请求所需的字段时应答 `invalid`，`irreversibleTools` 中列出的工具应答 `needs_person`；两者都让请求保持未决。被中止的请求会撤回其请求项。未决请求保存在内存中，随插件结束。

`task_status` 报告助手会话 id、暂停标志、以包裹后的 JSON 表示的助手会话 `todos`、`goal`、`plan` 与 `subagentCatalog` projection、其直接子会话（带已包裹的 `label`，已加载时 `status` 为 `idle` 或 `running`，否则为 `unloaded`），以及在 `assistantCwd` 中执行 `git worktree list --porcelain` 的已包裹输出。`task_result` 返回在 `assistantCwd` 中执行 `git diff HEAD...<branch>` 的结果，即该分支自从当前检出的 `HEAD` 分叉以来的改动，按每页 65,536 个字符分页并包裹；`pages` 至少为 1。git 不认识的分支应答 `not_found`，超出最后一页的 page 应答 `invalid`。其他 git 失败以 git 的消息应答。git 以 `core.fsmonitor=false`、`core.hooksPath=/dev/null`、`GIT_NO_LAZY_FETCH=1` 运行，不继承 `GIT_DIR` 等选择变量，`git diff` 另加 `--no-ext-diff`、`--no-textconv` 与 `--submodule=short`，因此检出目录自身的配置不会启动任何程序。

`runs_halt` 先存储暂停状态，然后以 cause `{kind: "hook", reason: "runs_halt"}` 取消每个已加载 Agent 的轮次并保留其排队消息，再终止所有无主或属于已加载会话的运行中后台任务；`cancelled.sessions` 列出原本在运行的会话，`failed` 列出终止时抛错的每个任务，其余任务照常终止。暂停期间，插件在 `agent/pre-step` 链中最先拒绝每个会话提出的每个模型步骤，`agent_send` 应答 `halted`。`runs_resume` 存储暂停结束；它不会重启被取消的轮次。插件再次加载后，暂停在主机重启后仍然有效。两者都接受 `request_id`，与 `agent_send` 一样，重试时返回首次结果。

助手会话就是插件所存 id 对应的会话：首次调用在 `assistantCwd` 工作区中创建它并命名为 `assistantTitle`，之后只有当所存会话已不存在时，调用才会创建新会话。该 id、暂停标志与按 request id 保存的结果位于 `mumbo_mcp` 存储域中；超过 24 小时的结果在加载时清理。卸载时先移除路由，并等待已接受的请求完成，然后才移除闸门与存储域。

<a id="dedicated-listener-composition"></a>
## 专用监听器组合

Web profile 自己的监听器服务 UI。把第二个 `dsh-host-webserver` 和此插件挂载到仅隔离 `webServer` 的 group 内，正如 [`examples/loopback/cordis.yml`](examples/loopback/cordis.yml) 所做；插件仍会继承其他所有服务。该示例读取 `MUMBO_MCP_PORT`（默认 `3092`）、`MUMBO_MCP_KEY_FILE` 与 `MUMBO_MCP_ASSISTANT_CWD`。可将它作为条目列表 include，或把其中的 group 行复制到 profile patch 的 `- insert:` 下。

<a id="model-experience"></a>
## 模型体验

### MCP 消息

#### 模型看到的内容

白名单中的人用 `agent_send` 发送的原样文本，作为助手会话中的一条 user 角色消息，其 source 为 `{kind: "mcp", principal}`。插件不给文本添加任何包装。

#### Token 影响

每次被接受的 `agent_send` 增加一条依赖数据、至多 32,768 个字符的 user 角色消息，它保留在助手会话中，直到压缩将其替换或移除。返回给 MCP 调用方的工具结果从不进入模型请求。

#### KV Cache 影响

仅追加。消息位于会话已有历史之后，因此可复用的请求前缀保持不变。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **密钥验证的是 relay，而不是人**：主机用户的任何能读取密钥文件的进程都可以以任一白名单 principal 的身份调用该路由，包括 `runs_halt` 与 `runs_resume`；白名单限制的是名字，而不是调用方。
- **无 TLS**：监听器必须留在 loopback；远程的人经由 SSH 等经过身份验证的 relay 访问它。
- **轮换密钥需要重新加载**：插件只在加载时读取一次密钥文件。
- **仅 JSON**：没有服务器主动发起的消息、`GET` 流或 MCP 会话。
- **经 MCP 应答的请求会让浏览器卡片保持打开**：链的其余部分不会被取消，因此卡片会保留到其请求结束。
- **被拒绝的步骤会消耗其认领的消息**：暂停期间，唤醒会话的消息会被认领给被闸门拒绝的步骤，`runs_resume` 之后不会再投递；需要重新发送。
- **`agent_read` 读取整个助手日志**：每次读取都取一页直到最新事件的历史，因此其开销随会话增长；`needs_you` 对每个指明调用的工具请求也这样做一次。
- **暂停只在插件已加载时有效**：加载失败（例如密钥文件不可读或为空，或 `mumbo_mcp` 存储域无法打开）时没有闸门，每个会话都会自由执行步骤，直到插件加载。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
