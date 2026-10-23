---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-23-mcp-message-source

[English](2026-10-23-mcp-message-source.md) | 中文

## 概述

新增 mcp 消息来源：白名单中的人通过 @mumbo/mcp 入口发送的用户消息，以 principal 记录此人的 handle。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-23-mcp-message-source
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-13-user-rpc-principal"
    after: "32bb18c82053221f1c275ddecc88711f2520a2bfe8bb745fea65ed955b33e353"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "a226c7c957f9eb496a92fb3b132797325468a2a754d41a317e2f985474a81325"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-13-user-rpc-principal"
    after: "d93853442c28d0bd3523c19374449a0ce11fcedf74ca1d89ae13c700f0a9ef98"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "42b59da9feb7097bd2ccb03dc3b689c3036f3a8244409d57a79bb662afd3a141"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有日志不含该来源，仍然有效。该来源为普通用户消息标注归属；读取方对未知来源类型走默认分支，保留消息及其内容，因此没有 @mumbo/mcp 的读取方也能加载此类日志，并把消息显示为以类型命名的注入上下文行。principal 为字符串时，Chat 将其标为 mcp:<principal>。只有 agent_send 通过 Agent.followup 写入该来源。不新增事件类型，也不改变 Session header。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/mumbo/mcp/tests --coverage：53 个测试通过，packages/mumbo/mcp/src 覆盖率 100%。pnpm exec vitest run packages/client/ui-chat/tests/event-projection.client.spec.ts packages/client/ui-chat/tests/turn-trigger.client.spec.tsx：32 个测试通过。

<a id="dev-note"></a>
## 开发备注

无。
