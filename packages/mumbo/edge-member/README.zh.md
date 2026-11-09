---
description: "以边缘签名的请求头准入 mumbo 项目成员，作为可在项目盒子中阅读、跟随、提示与创建 Session 的非 owner principal。"
kind: "package-reference"
---

# @mumbo/edge-member

[English](README.md) | 中文

## 概述

`@mumbo/edge-member` 让 mumbo 共享项目的成员在项目盒子中以自己的身份行动。mumbo 边缘为每个代理请求附加签名的成员请求头；本插件注册一个 [Connection authenticator](../../client/connection/README.zh.md)，把签名正确的请求准入为 `edge-member` principal，并注册一个 [远程访问](../../api/remote-access/README.zh.md) 策略，授予成员协作所需的 Session 操作。成员的提示词以 `principal: { kind: 'edge-member', email }` 记录，模型在其前读到一条指明该成员的通知。设计与威胁模型见 [Agent Note](../../../.agents/notes/implemented/architecture/2026-11-09-connection-authenticators-and-edge-members.zh.md)。

## 目录

- [配置](#configuration)
- [成员请求头](#member-header)
- [成员访问](#member-access)
- [成员署名](#member-attribution)
- [组合](#composition)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="configuration"></a>
## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `key` | 必填 | 本盒子的成员密钥，无填充 base64url，至少 32 字节。 |

不是无填充 base64url 或解码后不足 32 字节的密钥会使插件加载失败，不注册任何 authenticator。插件需要 `connection`、`remoteAccess`、`workspaceRegistry` 与 `sessions` 服务。生成的 [配置目录](../../../docs/config-catalog.zh.md#mumboedge-member) 是可接受字段的完整来源。

<a id="member-header"></a>
## 成员请求头

边缘在代理到项目盒子的每个请求上发送 `x-mumbo-member: <email>.<expiry>.<mac>`，包括 WebSocket 升级与 index 页面，并先移除浏览器发送的任何 `x-mumbo-member` 请求头。

| 字段 | 内容 |
|---|---|
| `email` | 成员的小写地址，UTF-8，无填充 base64url。 |
| `expiry` | 以整秒计的 Unix 时间；边缘签发五分钟后的时间。 |
| `mac` | 在成员密钥下对原样发送的 `<email>.<expiry>` 计算的 HMAC-SHA256，无填充 base64url。 |

边缘按盒子派生成员密钥：HMAC-SHA256(边缘密钥, `member:` + 盒子 id)，并以 `MUMBO_MEMBER_KEY` 传给盒子。插件以常量时间比较 MAC，只有当过期时间未过且不超过 600 秒之后、地址是一个不含空白与控制字符的小写邮箱时才准入。缺失、重复、格式错误、过期或签名错误的请求头不会准入成员；请求继续进入 owner 的 cookie 认证，不携带 owner 凭据时以 401 拒绝。

每个成员一个 Peer，服务该成员的所有连接，在该成员最新请求头过期前保持存活。之后插件释放它，关闭该成员的 WebSocket 并结束其流；客户端经边缘重连，边缘的新请求头会创建新的 Peer。因此被移除的成员在十分钟内失去所有连接。`signMemberHeader()` 与 `verifyMemberHeader()` 供边缘测试与本地检查使用。

<a id="member-access"></a>
## 成员访问

所有成员持有相同授权，以 `MEMBER_GLOBAL_ROLE`、`MEMBER_WORKSPACE_ROLE` 与 `MEMBER_SESSION_ROLE` 导出：

| 资源 | 操作 |
|---|---|
| `global` | `session/create`、`session/list`、`session/search`、`session/control`、`session/modelCatalog`、`session/canOpenWorkspacePath`、`agentPresets/list`、`llm/listProviders`、`llm/listConfigurableProviders`、`web/listProviders`、`commands/list`、`workspace/follow` |
| 每个 Workspace | `workspace/follow`、`session/create` |
| Workspace 列出的每个 Session 与每个存活 Session | 分页、跟随、projection、状态、事件、附件、作业（`job/list`）、工作区文件（`workspaceFiles/list`、`workspaceFiles/changes`）、`fileUploads/upload`、`fileUploads/uploadBinary`、`sessionLog/export`、`sessionLog/markdown`、`session/prompt`、`session/cancel`、用于复用空白 Session 的 `session/create`、`userQuestions/answer`、`userQuestions/attachWait`、技能、目标、工具结果与转发的 `api-session/*` 通知 |

存活 Session 包括运行中的子代理子 Session。远程访问拒绝其他所有操作，包括设置、凭据、插件、fork、重命名、模型选择（它同时保存 owner 的默认模型）、队列编辑与 Workspace 管理；队列编辑会保留被编辑消息的来源，因而会把一个人的文本记录为另一个人的。在 Gateway 之外的 exact Fetch 路由中，成员可以到达三个，均作用于其 `sessionId` 查询指定的 Session：经 `fileUploads/uploadBinary` 到达浏览器二进制上传 `/api/session/uploadFileBinary`，经 `sessionLog/export` 与 `sessionLog/markdown` 到达 Session 日志下载 `/api/session.export` 与 Markdown 复制 `/api/session.markdown`。其他所有 exact 路由（包括文件媒体引用 `/api/file`、变更摘要与在盒子上打开文件）、专用 RPC 通道与 Gateway 之外的其他路由返回 403。创建或释放 Session 时，以及 Workspace 域变化提交之后，插件重建绑定并调用 `remoteAccess.invalidate()`，使成员的访问快照跟随这两个列表；注册表在其实体持有新列表之前发出变化，因此该重建在发出变化的写入完成后运行。

<a id="member-attribution"></a>
## 成员署名

对于 `edge-member` Peer 提交的每条进入消息，`agent/pre-step` 监听器在其前插入一条 user 角色的通知，来源为 `{ kind: 'mumbo-member', form: 'notice', summary }`。通知与消息一起进入 Session 日志，因此协调者模型能看到每条消息的作者，恢复的 Session 会重放相同的请求。owner 消息与其他来源不变。

<a id="composition"></a>
## 组合

项目盒子加载 [`deploy/mumbo-project.overlay.yml`](../../../deploy/mumbo-project.overlay.yml)：它以 `key: !!js process.env.MUMBO_MEMBER_KEY` 插入本插件，并把审批策略设为 `never`，使成员的回合从不等待 owner 审批。根清单把这个私有包列为开发依赖，因此从仓库启动的 Host 可以从 `--patch` overlay 按名称解析它；已发布的 `@deepseek-ai/dsh` 包不依赖它。

<a id="model-experience"></a>
## 模型体验

### 成员署名通知

#### 模型看到的内容

在项目成员发送的每条消息之前紧接一条 user 角色消息，其中 `<email>` 是成员的小写地址；成员自身消息上记录的 `principal` 不进入模型请求。

##### 原文

```markdown
The next message is from project member <email>.
```

#### Token 影响

每条成员消息约 10 个 token 加上地址，保留在 Session 中，直到压缩替换或移除它。owner 消息不增加任何内容。

#### KV Cache 影响

只追加。通知与其前置的消息一起进入，位于 Session 已有历史之后，因此可复用的请求前缀保持不变。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **成员指挥的代码以盒子的权限运行** — 成员的提示会运行协调者的工具；在完全访问且审批为 `never` 时，这些工具可以读取盒子内的成员密钥与 owner cookie 的签名记录。访问策略让成员无法调用设置、凭据与插件，并为其消息署名，但无法约束指挥代理提升权限的成员。在盒子以独立身份运行工具之前，应把成员视为可信的协作者。
- **媒体引用不会为成员渲染** — `/api/file` 可读取盒子能读取的任何文件，包括 `/root/.mumbo/start.sh`、dsh 日志中的 owner 启动 token 以及每个 Session 日志，因此没有任何成员角色授予其 `hostFiles/readAny`。等到该路由能把非 owner 限定在某个 Session 的工作区根目录时才会向成员开放，这需要缺失的接口：`ConnectionFetchRoute.fetch` 收不到 Peer。
- **成员无法在页面中打开已结束的子代理记录** — 子代理的子 Session 只在存活时被授权，因为没有 Workspace 列出它；已授权 Session 的日志下载仍包含每个子代理后代的日志。
- **交付物路由只对 owner 开放** — 变更摘要、比较以及打开声明或变更的文件（`/api/changes.*`、`/api/present.*`）对成员返回 403。
- **回答不携带成员** — `userQuestions/answer` 不记录 principal，因此模型无法分辨是哪个成员回答了问题。
- **移除不会立即生效** — 盒子不保存成员列表；被边缘移除的成员在为其签发的最后一个请求头过期前（至多十分钟）仍有访问权。
- **没有时钟偏差容忍** — 盒子按自身时钟拒绝过期时间已过或超前 600 秒以上的请求头，因此盒子与边缘的时钟偏差必须在五分钟以内。
- **成员之间没有差异** — 所有成员持有相同授权；只读成员等角色需要在签名请求头中携带成员属性。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
