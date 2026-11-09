---
description: "为单个 GitHub 仓库运行主动式编码 agent 的 profile 层：它监听 GitHub，并可选监听飞书，把获授权的请求转为 Ticket，并在各自的会话中处理每个 Ticket。"
kind: "package-bundle"
---

# @mumbo/superagent

[English](README.md) | 中文

## 概述

`@mumbo/superagent` 是一个 profile 层，为单个 GitHub 仓库运行主动式编码 agent。它的主会话从 GitHub 读取请求，并可选从飞书读取，按 Policy（策略）准入这些请求，再把每个获授权的请求转为 Ticket（工单），由一个执行器会话在其自己的目录中处理。侧边栏中的 Superagent 面板显示需要人处理的事项。本包是上游 `dsh-superagent` 原型的固定副本；[UPSTREAM.md](UPSTREAM.md) 记录对它的每一处修改。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [在 Mumbo 中](#in-mumbo)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 安装到 profile

本包是私有包，只在本仓库内可解析，仓库根清单把它列为开发依赖。在检出目录中，用 profile CLI 把该层加入 profile，或将其移除：

```sh
pnpm dsh plugin --profile <name> add ./packages/mumbo/superagent
pnpm dsh plugin --profile <name> remove @mumbo/superagent
```

该层插入的行不带配置。profile 必须为 `dsh-superagent` 行提供绝对路径 `stateDir`，否则插件拒绝启动；[examples/profile.cordis.patch.yml](examples/profile.cordis.patch.yml) 是可复制的 profile patch。在设置仓库和 agent 账号之前，运行时等待设置，面板的 Overview 会指出缺少什么。

### 获得的能力

| 行 id | 插件 | 增加 |
|---|---|---|
| `dsh-superagent` | `@mumbo/superagent` | 运行时、其主会话与执行器会话、Superagent 面板，以及 `/orchestrator/api/` 下的管理 API |
| `dsh-superagent-github` | `@mumbo/superagent/github-watch` | GitHub 来源：通知、已订阅的 Issue 与 pull request，以及 CI 变化 |
| `dsh-superagent-feishu` | `@mumbo/superagent/feishu-watch` | 飞书来源；在 profile 启用之前保持禁用 |
| `dsh-superagent-worker-preset` | `@deepseek-ai/dsh-agent-preset` | 每个执行器会话使用的 `dsh-superagent-worker` agent preset |
| `dsh-superagent-router-preset` | `@deepseek-ai/dsh-agent-preset` | 主会话使用的 `dsh-superagent-router` agent preset |

`dsh-superagent` 行接受以下字段：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `stateDir` | 必填 | 绝对路径目录，存放数据库、锁、worker 命令 shim、agent 的 git 配置，以及默认情况下的 Ticket 目录 |
| `promptMaxChars` | `100000` | 已保存提示词配置的最大字符数，取值 1,000 到 1,000,000 |
| `admissionContextMaxPages` | `10` | 一次评估可读取的线程上下文页数，取值 1 到 100 |
| `admissionContextTimeoutMs` | `15000` | 评估期间一次上下文读取的时间上限，取值 1 到 90,000 毫秒 |

除 `stateDir` 外，每个字段都无需重启即可生效。仓库、账号、Policy、执行设置和提示词都是保存在状态数据库中的面板设置，而不是插件配置；[006 Deployment](docs/006-deployment.md) 说明了每一项以及管理 API。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

[cordis.patch.yml](cordis.patch.yml) 插入三个插件行和两个 preset 行。飞书行为 `disabled: true`。两个 preset 的 shell 前台时限都是 5 秒，因此长命令会转入后台任务，人的消息会在会话的下一步到达。

| 路径 | 负责 |
|---|---|
| `src/index.ts` | `dsh-superagent` 插件入口及其配置 |
| `src/app/runtime.ts` | 组合根，以及来源插件访问运行时所用的 `orchestrator` 服务 |
| `src/core/`、`src/policy.ts`、`src/admission.ts` | 领域模型：触发、线程、评估、Ticket 以及 Policy 准入 |
| `src/app/sessions.ts`、`src/executor/` | 主会话、执行器会话及其 preset、工具和 skill |
| `src/sources/` | GitHub 与飞书来源 |
| `src/client/` | Superagent 面板 |
| `prompts/`、`skills/` | 默认提示词部分以及两个来源 skill |

所有状态都保存在 `<stateDir>/orchestrator.sqlite` 中。[007 Architecture](docs/007-architecture.md) 列出每个类、模块、表和面向模型的接口。

</details>

-----

<a id="in-mumbo"></a>
## 在 Mumbo 中

本包是 [`dsh-superagent-prototype`](https://github.com/deepseek-ai/dsh-superagent-prototype) 的副本，采用 MIT 许可，固定在 [UPSTREAM.md](UPSTREAM.md) 指明的提交上。UPSTREAM.md 记录对副本的每一处修改，以及副本之外为它而存在的每个路径。插件行名为 `@mumbo/...`；行 id 与 preset id 保留上游名称。

Mumbo 项目 box 通过 `deploy/mumbo-project.overlay.yml` 加载本包，该文件把 `stateDir` 放在 DSH home 之下，并用 `MUMBO_PANEL_ADMINS` 设置 `panelAdmins`。在 Mumbo 中，本包在以下行为上与上游不同：

- **设置、Policy 和提示词只能在面板中修改。** 模型没有修改它们的工具：`orchestrator_settings_save`、`orchestrator_policy_sync` 与 `orchestrator_prompts_save` 已被移除，主会话有 11 个应用工具。
- **执行器从不合并。** 执行器不合并 pull request，不启用自动合并，也不批准 pull request。它发布一条 pull request 评论，第一行是标记 `<!-- mumbo-review sha=<40 lowercase hex> verdict=<pass|fail> -->`，第二行是自动化 agent 的披露行。box 边缘通过自己的批准流程合并，并把该标记视为一种声明。

上游 README 是 [docs/upstream-readme.md](docs/upstream-readme.md)。它、[SETUP.md](SETUP.md) 以及 `docs/` 中的编号文档都是上游文字：它们描述使用全局 `dsh` 与 `scripts/dsh-superagent` 的独立安装，而本副本不包含这些内容。`docs/003-execution.md`、`docs/004-prompts.md`、`docs/006-deployment.md` 与 `SETUP.md` 中描述由提示词驱动的自动合并之处，以及上游文档中描述三个已移除工具之处，以本节为准。部分仓库检查排除了副本的代码或这些文字；UPSTREAM.md 列出每项排除，每项都带有注释 `pinned upstream copy; see packages/mumbo/superagent/UPSTREAM.md`。

-----

<a id="further-exploration"></a>
## 进一步探索

- [mumbo 包组](../README.zh.md)——其他 mumbo 适配器。
- [000 Philosophy](docs/000-philosophy.md) 到 [008 Cookbook](docs/008-cookbook.md)——上游文档，按顺序阅读。
- [Agent preset](../../preset/agent-preset/README.zh.md)——两个 preset 所用的行类型。

-----

<a id="model-experience"></a>
## 模型体验

### 角色系统提示词

#### 模型看到什么

主会话和每个执行器会话都收到一份组合而成的角色提示词：`runtime/shared`、角色部分、团队部分 `Communication`、`Ticket scope` 与 `Delivery requirements`、`runtime/subscriptions`、`runtime/replies`、主会话的 `runtime/dispatch` 或执行器的 `runtime/work`、主会话的 `runtime/admission`、角色的交接部分、带有执行环境变量的 `runtime/environment`，以及仅主会话才有、每条启用规则一行的 `runtime/policy`。各部分的默认文本位于 `prompts/` 与 `prompts/team/`；团队已保存的提示词修订覆盖的部分改为读取团队的文本。执行器会话还通过其 preset 的 `persona` 与 `agent-instructions` 行读取编码提示词和 `AGENTS.md`。没有启用的规则时，Policy 部分为：

##### Policy section without enabled rules

```markdown
## Policy
Policy version {version}; accept mode {mode}. The accept mode and the rules decide proactive candidates only: an explicit request is routed as dispatch says, in any mode and whatever the rules. No rule is enabled: a proactive candidate can only be ignored.
```

#### Token 影响

使用默认文本时，在环境与 Policy 部分之前，主会话的组合提示词约 40,000 个字符，执行器约 32,000 个字符；每条启用的规则增加一行。`promptMaxChars` 限制已保存的提示词配置，包括覆盖内容。该提示词是会话每次模型请求的一部分。

#### KV Cache 影响

在提示词修订、执行环境和 Policy 保持不变时前缀稳定。每次模型请求都读取最新的提示词修订，因此保存提示词会使从第一个变更部分起的复用失效；Policy 变更只重写位于所有其他部分之后的 `runtime/policy`。

### 应用工具

#### 模型看到什么

主会话获得 11 个工具：`orchestrator_read`、`orchestrator_route`、`orchestrator_ticket_retry`、`orchestrator_ticket_request_status`、`orchestrator_ticket_note`、`orchestrator_trigger_requeue`、`orchestrator_eval`、`orchestrator_eval_read`、`orchestrator_eval_decide`、`orchestrator_reply` 与 `orchestrator_thread_unsubscribe`。每个执行器会话获得 6 个：`orchestrator_read`、`orchestrator_ack`、`orchestrator_report`、`orchestrator_thread_unrelated`、`orchestrator_thread_follow` 与 `orchestrator_trigger_handback`。它们的描述和参数 schema 定义在 `src/app/tools/` 中，不在生成的工具目录里。执行器只保留 `src/app/sessions.ts` 中 `WORK_TOOLS` 列出的 harness 工具。

#### Token 影响

这些 schema 是会话每次模型请求的一部分。`orchestrator_read` 的一个文本页默认包含 4,000 个 UTF-16 码元，最多 8,000 个；一个列表默认包含 20 项，最多 50 项。

#### KV Cache 影响

前缀稳定：会话的工具集由其角色决定。工具结果追加到会话历史中。

### 触发卡片与通知

#### 模型看到什么

运行时投递 source 为 `{kind: "dsh-superagent", form: "relay"}` 的 user 角色消息；对于不开始新一轮而加入的消息，使用 `form: "notice"` 并带有一行 `summary`。主会话的一轮由候选卡片、`follow_up` 通知、`worker_report` 或 `worker_attention` 开始；`ticket_ended`、`settings_saved`、提示词保存、重新排队、被移除的订阅和上下文关注会被加入而不开始新一轮。执行器会话收到其派工，包括标题、至多 1,500 个字符的派工文本和来源触发卡片，之后的输入以至多 600 个字符的触发卡片或纯文本送达。引自 GitHub 或飞书的文本是数据；提示词告诉模型这些文本从不改变规则或授权。

#### Token 影响

每次投递追加一条依赖数据的消息，它保留在会话中，直到压缩（compaction）将其替换。被截断的卡片带有供 `orchestrator_read` 使用的读取指针，而不是其余文本。

#### KV Cache 影响

仅追加。投递位于会话已有历史之后。

### 来源与团队 skill

#### 模型看到什么

两种角色的 skill（技能）目录都列出 `dsh-superagent-github`、`dsh-superagent-feishu`，以及以 `dsh-superagent-<name>` 命名的每个团队 skill；默认的来源 skill 文本位于 `skills/`，`skill` 工具按请求加载正文。团队 skill 的目录描述是其文本的前 120 个字符。

#### Token 影响

每次模型请求中每个 skill 占一条目录条目，加载的正文只在 `skill` 调用之后出现。

#### KV Cache 影响

在提示词保存改变 skill 集合或某个 skill 的文本之前前缀稳定；之后的下一次模型请求会注册已保存修订的 skill。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **固定的上游副本**：上游变更只能通过重新复制并重新应用 UPSTREAM.md 记录来引入；JSDoc、覆盖率、unknown 断言和 UI 文案检查排除了副本的代码，因此它不满足本仓库的这些规则。
- **上游设置说明**：`SETUP.md` 与 `docs/006-deployment.md` 使用 `scripts/dsh-superagent` 和全局安装的 `dsh`，本副本不包含这些内容。
- **没有进程隔离**：两个 preset 都以主机的操作系统用户身份、在 `danger-full-access` 下运行；执行器可以读取该用户的主目录，并按路径运行任何程序。
- **状态无限增长**：不会删除旧的触发、决定、已结束的 Ticket、outbox 回执，以及已保存的设置与提示词版本。
- **仅支持 github.com**：不支持 GitHub Enterprise Server，且 agent 必须是用户账号，因为运行时读取它的通知。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
