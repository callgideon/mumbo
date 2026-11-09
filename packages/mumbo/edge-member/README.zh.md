---
description: "以边缘签名的请求头准入 mumbo 项目成员，作为可在项目盒子中阅读、跟随、提示与创建 Session 的非 owner principal。"
kind: "package-reference"
---

# @mumbo/edge-member

[English](README.md) | 中文

## 概述

`@mumbo/edge-member` 让 mumbo 共享项目的成员在项目盒子中以自己的身份行动。mumbo 边缘为每个代理请求附加签名的成员请求头；本插件注册一个 [Connection authenticator](../../client/connection/README.zh.md)，把签名正确的请求准入为 `edge-member` principal，并注册一个 [远程访问](../../api/remote-access/README.zh.md) 策略，授予成员协作所需的 Session 操作。成员的提示词以 `principal: { kind: 'edge-member', email }` 记录。设计与威胁模型见 [Agent Note](../../../.agents/notes/implemented/architecture/2026-11-09-connection-authenticators-and-edge-members.zh.md)。

## 目录

- [配置](#configuration)
- [成员请求头](#member-header)
- [成员访问](#member-access)
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

不是无填充 base64url 或解码后不足 32 字节的密钥会使插件加载失败，不注册任何 authenticator。插件需要 `connection`、`remoteAccess` 与 `workspaceRegistry` 服务。生成的 [配置目录](../../../docs/config-catalog.zh.md#mumboedge-member) 是可接受字段的完整来源。

<a id="member-header"></a>
## 成员请求头

边缘在代理到项目盒子的每个请求上发送 `x-mumbo-member: <email>.<expiry>.<mac>`，包括 WebSocket 升级与 index 页面，并先移除浏览器发送的任何 `x-mumbo-member` 请求头。

| 字段 | 内容 |
|---|---|
| `email` | 成员的小写地址，UTF-8，无填充 base64url。 |
| `expiry` | 以整秒计的 Unix 时间；边缘签发五分钟后的时间。 |
| `mac` | 在成员密钥下对原样发送的 `<email>.<expiry>` 计算的 HMAC-SHA256，无填充 base64url。 |

边缘按盒子派生成员密钥：HMAC-SHA256(边缘密钥, `member:` + 盒子 id)，并以 `MUMBO_MEMBER_KEY` 传给盒子。插件以常量时间比较 MAC，只有当过期时间未过且不超过 600 秒之后、地址是一个不含空白与控制字符的小写邮箱时才准入。缺失、重复、格式错误、过期或签名错误的请求头不会准入成员；请求继续进入 owner 的 cookie 认证，不携带 owner 凭据时以 401 拒绝。`signMemberHeader()` 与 `verifyMemberHeader()` 供边缘测试与本地检查使用。

<a id="member-access"></a>
## 成员访问

所有成员持有相同授权，每次决策时从 Workspace 注册表读取：

| 资源 | 操作 |
|---|---|
| `global` | `session/list`、`session/search`、`session/control`、`session/modelCatalog`、`llm/listProviders`、`llm/listConfigurableProviders`、`commands/list`、`workspace/follow` |
| 每个 Workspace | `workspace/follow`、`session/create` |
| Workspace 列出的每个 Session | 分页、跟随、projection、状态、事件、附件、上传、`session/prompt`、`session/cancel`、`session/updateQueue`、技能、目标、工具结果与转发的 `api-session/*` 通知 |

远程访问拒绝其他所有操作，包括设置、凭据、插件、fork、重命名、模型选择与 Workspace 管理。Gateway 之外的 owner 专用路由返回 403。创建 Session 或 Workspace 域变化时，插件调用 `remoteAccess.invalidate()`，使成员的访问快照跟随 Workspace 列表。

<a id="composition"></a>
## 组合

项目盒子加载 [`deploy/mumbo-project.overlay.yml`](../../../deploy/mumbo-project.overlay.yml)：它以 `key: !!js process.env.MUMBO_MEMBER_KEY` 插入本插件，并把审批策略设为 `never`，使成员的回合从不等待 owner 审批。`apps/cli` 依赖本包，使 `--patch` overlay 可以按名称引用它。

<a id="model-experience"></a>
## 模型体验

无：本包准入调用方并决定其远程访问，成员消息上记录的 `principal` 不进入模型请求。

#### KV Cache 影响

无直接影响。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **成员无法打开子代理记录** — 子代理的子 Session 不在任何 Workspace 列表中，因此成员对子代理地址的 `session/page` 与 `session/follow` 被拒绝。
- **移除不会立即生效** — 盒子不保存成员列表；被边缘移除的成员在为其签发的最后一个请求头过期前（至多十分钟）仍有访问权。
- **成员之间没有差异** — 所有成员持有相同授权；只读成员等角色需要在签名请求头中携带成员属性。
- **每次决策扫描 Workspace 列表** — 成员调用的成本随盒子中 Session 数量线性增长。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
