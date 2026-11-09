---
description: "面向把 Playwright MCP 浏览器提供方与审批服务组合在一起的部署，说明在本人已登录的 Chromium 中进行浏览器写操作的同意机制。"
kind: "package-reference"
---

# @mumbo/browser-consent

[English](README.md) | 中文

## 概述

`@mumbo/browser-consent` 为模型在本人已登录的 Chromium 中使用的浏览器工具落实“读取免问，写入需问”。它自行挂载 Playwright MCP 浏览器提供方，因此这些工具只在同意插件以有效配置加载时存在。导航和页面读取直接放行。点击、输入、填写表单等作用于当前标签页的操作，只有当该标签页的源（origin）在 `allowedSites` 中时才无需询问；其余写操作都会通过审批服务询问本人一次，并展示其参数。每次被允许的写操作都会连同站点、工具和结果记入会话日志。

## 目录

- [配置](#configuration)
- [判定](#decisions)
- [提供方归属](#provider-ownership)
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
| `browser` | 必填 | 被挂载的 [Playwright MCP 提供方](../../experimental/browser-use-playwright-mcp/README.zh.md)的设置，例如 `mode: attach` 和 `endpoint`。 |
| `allowedSites` | `[]` | 当前标签页写操作无需询问的源，例如 `https://mail.google.com`。 |
| `approvalTimeoutMs` | `300000` | 写操作等待本人回答的时长，超时即作为无人回答而拒绝。 |

`allowedSites` 条目若不是精确的 `http:` 或 `https:` 源，插件加载失败；条目含有源时，错误会写明应使用的源，例如 `https://mail.google.com/` 应改为 `https://mail.google.com`。匹配是精确的：`https://mail.google.com` 不覆盖 `https://docs.google.com`，也不覆盖 `http://mail.google.com`。生成的[配置目录](../../../docs/config-catalog.zh.md#mumbobrowser-consent)是所有可接受字段的完整来源。

<a id="decisions"></a>
## 判定

插件把关所有名为 `mcp__playwright-mcp__<tool>` 的工具，其他工具不受影响。每次调用归入以下三类之一：

| 类别 | 上游工具 | 判定 |
|---|---|---|
| 读取 | `browser_snapshot`、`browser_take_screenshot`、`browser_find`、`browser_console_messages`、`browser_network_requests`、`browser_network_request`、`browser_wait_for`、`browser_navigate_back`、`browser_navigate_forward`；导航到 `http:` 或 `https:` URL 的 `browser_navigate`；`browser_tabs` 的 `list`、`select`，以及不带 URL 或带网页 URL 的 `new` | 放行。 |
| 站点写操作 | `browser_click`、`browser_type`、`browser_fill_form`、`browser_press_key`、`browser_press_sequentially`、`browser_keydown`、`browser_keyup`、`browser_select_option`、`browser_check`、`browser_uncheck`、`browser_hover`、`browser_drag`、`browser_handle_dialog`、`browser_resize`、`browser_reload`、`browser_close`；不带 `paths` 的 `browser_drop` | 当前标签页的源已被允许时执行，否则询问。 |
| 总是询问 | `browser_evaluate`、`browser_run_code_unsafe`、`browser_file_upload`、带 `paths` 的 `browser_drop`、导航到其他协议或无协议的 URL、`browser_tabs` 的 `close`，以及此处未列出的所有工具 | 即使在被允许的站点上也询问。 |

在判定写操作之前，插件通过以 `list` 调用同一会话的 `browser_tabs` 工具，从 Playwright 本身读取当前标签页，因此站点是经过重定向、链接点击和标签页切换之后操作实际作用的标签页，而不是模型所说的页面。上游在该列表中不转义页面标题；无法无歧义读取的列表、失败的列表或非网页页面都会使站点未知，写操作随之询问。

审批请求会写明工具和站点，以 JSON 列出每个参数（输入的文本、表单值、按键、上传的路径、要运行的代码、URL、对话框回答），并把模型的 `element` 描述单独标注为模型撰写。每个值截断到 300 个字符，整个列表截断到 1,200 个字符，不可见的格式字符会进行百分号编码，因为 Web 审批卡片把这段文字显示为标题。本人拒绝、`approvalTimeoutMs` 内无人回答、没有可用的回答方，或会话的审批策略为 `never` 时，写操作被拒绝；被取消的请求（例如被中断的回合）会取消该调用。

`tools/pre-execute` 监听器以 `prepend` 注册。一个通过 `ctx.tools.guard()` 注册的守卫会拒绝任何未经本插件记录同意就到达分发阶段的写操作，因此其他放行写操作或自行提问的监听器都无法让它通过，没有 Agent 的调用也无法执行写操作。

<a id="provider-ownership"></a>
## 提供方归属

插件注册守卫和监听器，提供一个服务，并以 `browser` 设置把 `@deepseek-ai/dsh-experimental-browser-use-playwright-mcp` 挂载为自己的子插件，同时把该服务加入子插件的依赖。因此提供方只在把关生效后启动，配置无效时根本不会挂载浏览器；卸载插件时会先卸载提供方、移除其浏览器工具，然后才移除守卫。若已有其他提供方占用 `browserUse`，插件加载失败；子插件占用之后，其他 `browserUse` 提供方都无法注册。只通过本插件挂载该提供方：单独列出的提供方行不受其控制。

<a id="audit-record"></a>
## 审计记录

被允许的写操作结果确定后，插件向会话追加 `browser-consent/write`：`callId`、上游 `tool`、读到当前标签页的源时的 `site`、`grant`（站点许可为 `site`，一次性审批为 `approval`），以及 `outcome`（`succeeded` 或 `failed`；`failed` 包括被后续策略拒绝）。被拒绝的写操作本身不留记录；审批服务的 `approval/asked` 和 `approval/decided` 会记录每个问题（包括其参数摘要）及其回答。确切载荷以[持久化目录](../../../docs/persistence-catalog.zh.md)为准。

<a id="composition"></a>
## 组合

将其挂载在 `browserUse` 注册表旁边，并与 `dsh-user-approval` 一起使用；随附的 profile 已包含后者：

```yaml
- insert:
    - id: browser-use
      name: '@deepseek-ai/dsh-browser-use'
    - id: browser-consent
      name: '@mumbo/browser-consent'
      config:
        browser:
          mode: attach
          endpoint: http://127.0.0.1:9222
```

插件依赖提供方所需的服务；它在每次写操作时读取审批服务。

<a id="model-experience"></a>
## 模型体验

### 被拒绝的浏览器写操作

#### 模型看到的内容

被拒绝的写操作的工具结果会以一行错误取代浏览器的回答，其中写明上游工具和站点（或 `an unidentified page`）：`Error: The user declined <tool> on <site>.`、`Error: <tool> on <site> got no answer from the user within <seconds> seconds.`、`Error: Approval prompts are disabled in this session, so <tool> on <site> did not run.` 或 `Error: <tool> on <site> needs the user's approval, and no approval channel is available.`。未经同意就到达分发阶段的写操作返回 `Error: <tool> needs the user's consent, which was not given.`，被取消的审批返回工具运行时的 `Error: tool call aborted before dispatch`。被允许的写操作和读取返回浏览器的普通结果；审批问题和审计记录都不是模型上下文。

#### Token 影响

拒绝会用一行短文本取代浏览器的结果；被允许的调用不增加 token。

#### KV Cache 影响

仅追加。结果与其他工具结果一样跟在会话已有历史之后。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **在 box 中不是安全边界** — 插件只把关模型的浏览器工具。在 box 中，模型还拥有处于完全访问模式、不逐条询问的 root shell，因此可以直接访问 Chromium 位于 `127.0.0.1:9222` 的调试端口（例如用 `curl` 或 `playwright-core`），并读取浏览器配置目录。只有当浏览器运行在 dsh 用户无法触及的地方时，同意机制才成为边界，这是平台层面的决定。
- **许可保存在模型可编辑的文件中** — `allowedSites` 以及部署的其他配置（包括其 MCP 服务器行）都是同一个 shell 能修改的文件，修改 `allowedSites` 会重新加载插件；没有 Client 页面管理许可。
- **只把关 Playwright MCP 提供方** — 工具名前缀和分类遵循固定版本的 `@playwright/mcp` 服务器；经由其他 MCP 服务器行访问的浏览器不受把关，上游日后新增的工具在被分类之前总是询问。
- **站点在操作之前读取，而非操作期间** — 页面若在列表读取与操作之间自行导航，操作会作用于其新的源；跨源 frame 内的点击按顶层页面的站点计。
- **导航算作读取** — 会改变状态的 `GET`（例如一键退订链接）无需询问即会执行，导航也可以把页面数据带到任意 URL。
- **许可按站点而非按操作种类** — 被允许的源上的所有站点写操作都被允许，包括发帖和购买。
- **审计记录没有 Client 渲染器** — 它存在于会话日志及其导出中，而不在 Chat 中。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
