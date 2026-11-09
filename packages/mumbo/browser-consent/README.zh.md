---
description: "面向把 Playwright MCP 浏览器提供方与审批服务组合在一起的部署，说明在本人已登录的 Chromium 中进行浏览器写操作的同意机制。"
kind: "package-reference"
---

# @mumbo/browser-consent

[English](README.md) | 中文

## 概述

`@mumbo/browser-consent` 为 Playwright MCP 浏览器提供方落实“读取免问，写入需问”。该提供方的工具在本人的 Chromium 中、以其已登录的账号操作。导航和页面读取直接放行。点击、输入、填写表单、上传等作用于当前标签页的操作，只有当该标签页的源（origin）在 `allowedSites` 中时才无需询问；其余写操作都会通过审批服务询问本人一次。每次被允许的写操作都会连同站点、工具和结果记入会话日志。

## 目录

- [配置](#configuration)
- [判定](#decisions)
- [审计记录](#audit-record)
- [组合](#composition)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="configuration"></a>
## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `allowedSites` | `[]` | 当前标签页写操作无需询问的源，例如 `https://mail.google.com`。 |

条目若不是精确的 `http:` 或 `https:` 源（例如带路径或末尾斜杠），插件加载失败。匹配是精确的：`https://mail.google.com` 不覆盖 `https://docs.google.com`，也不覆盖 `http://mail.google.com`。生成的[配置目录](../../../docs/config-catalog.zh.md#mumbobrowser-consent)是所有可接受字段的完整来源。

<a id="decisions"></a>
## 判定

插件把关所有名为 `mcp__playwright-mcp__<tool>` 的工具，其他工具不受影响。每次调用归入以下三类之一：

| 类别 | 上游工具 | 判定 |
|---|---|---|
| 读取 | `browser_snapshot`、`browser_take_screenshot`、`browser_find`、`browser_console_messages`、`browser_network_requests`、`browser_network_request`、`browser_wait_for`、`browser_navigate_back`；导航到 `http:` 或 `https:` URL 的 `browser_navigate`；`browser_tabs` 的 `list`、`select`，以及不带 URL 或带网页 URL 的 `new` | 放行。 |
| 站点写操作 | `browser_click`、`browser_type`、`browser_fill_form`、`browser_press_key`、`browser_select_option`、`browser_hover`、`browser_drag`、`browser_drop`、`browser_file_upload`、`browser_handle_dialog`、`browser_resize`、`browser_close` | 当前标签页的源已被允许时执行，否则询问。 |
| 无界操作 | `browser_evaluate`、`browser_run_code_unsafe`、导航到其他协议、`browser_tabs` 的 `close`，以及此处未列出的所有工具 | 总是询问。 |

在判定写操作之前，插件通过以 `list` 调用同一会话的 `browser_tabs` 工具，从 Playwright 本身读取当前标签页，因此站点是操作实际作用的标签页，而不是模型所说的页面。上游在该列表中不转义页面标题；无法无歧义读取的列表、失败的列表或非网页页面都会使站点未知，写操作随之询问。审批请求会写明工具、站点，以及标注为助手所述的模型 `element` 描述；在 `never` 审批策略下，或没有审批服务时，所有本应询问的写操作都会被拒绝。

一个通过 `ctx.tools.guard()` 注册的守卫会拒绝任何未经本插件记录同意就到达分发阶段的写操作，因此其他 `tools/pre-execute` 监听器无法放行写操作，没有 Agent 的调用也无法执行写操作。卸载插件会移除该守卫及其监听器；此后写操作将不经同意直接执行。

<a id="audit-record"></a>
## 审计记录

被允许的写操作结果确定后，插件向会话追加 `browser-consent/write`：`callId`、上游 `tool`、读到当前标签页的源时的 `site`、`grant`（站点许可为 `site`，一次性审批为 `approval`），以及 `outcome`（`succeeded` 或 `failed`；`failed` 包括被后续策略拒绝）。被拒绝的写操作本身不留记录；审批服务的 `approval/asked` 和 `approval/decided` 会记录每个问题和回答。确切载荷以[持久化目录](../../../docs/persistence-catalog.zh.md)为准。

<a id="composition"></a>
## 组合

将其挂载在提供方旁边，并位于 `dsh-user-approval` 之后；随附的 profile 已包含后者：

```yaml
- insert:
    - id: browser-use
      name: '@deepseek-ai/dsh-browser-use'
    - id: browser-use-box-chromium
      name: '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp'
      config:
        mode: attach
        endpoint: http://127.0.0.1:9222
    - id: browser-consent
      name: '@mumbo/browser-consent'
```

插件只依赖 `tools`；它在每次写操作时读取审批服务。

<a id="model-experience"></a>
## 模型体验

### 被拒绝的浏览器写操作

#### 模型看到的内容

被拒绝的写操作的工具结果会以一行错误取代浏览器的回答，其中写明上游工具和站点（或 `an unidentified page`）：`Error: The user declined <tool> on <site>.`、`Error: The approval request for <tool> on <site> was cancelled.` 或 `Error: <tool> on <site> needs the user's approval, and no approval channel is available.`。未经同意就到达分发阶段的写操作返回 `Error: <tool> needs the user's consent, which was not given.`。被允许的写操作和读取返回浏览器的普通结果；审批问题和审计记录都不是模型上下文。

#### Token 影响

拒绝会用一行短文本取代浏览器的结果；被允许的调用不增加 token。

#### KV Cache 影响

仅追加。结果与其他工具结果一样跟在会话已有历史之后。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **只把关 Playwright MCP 提供方** — 工具名前缀和分类遵循固定版本的 `@playwright/mcp` 服务器；其他浏览器提供方的工具不受把关，上游日后新增的工具在被分类之前总是询问。
- **站点在操作之前读取，而非操作期间** — 页面若在列表读取与操作之间自行导航，操作会作用于其新的源；跨源 frame 内的点击按顶层页面的站点计。
- **导航算作读取** — 会改变状态的 `GET`（例如一键退订链接）无需询问即会执行。
- **许可按站点而非按操作种类** — 被允许的源上的所有站点写操作都被允许，包括发帖和购买。
- **许可保存在 Config 中** — 修改 `allowedSites` 会重新加载插件，任何能编辑部署配置文件的程序都能给自己授予许可；没有 Client 页面管理它们。
- **审计记录没有 Client 渲染器** — 它存在于会话日志及其导出中，而不在 Chat 中。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
