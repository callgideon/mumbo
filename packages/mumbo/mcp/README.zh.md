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

- **密钥验证的是 relay，而不是人**：任何能读取密钥文件的进程都可以充当任一白名单 principal；白名单限制的是名字，而不是调用方。
- **无 TLS**：监听器必须留在 loopback；远程的人经由 SSH 等经过身份验证的 relay 访问它。
- **轮换密钥需要重新加载**：插件只在加载时读取一次密钥文件。
- **仅 JSON**：没有服务器主动发起的消息、`GET` 流或 MCP 会话。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
