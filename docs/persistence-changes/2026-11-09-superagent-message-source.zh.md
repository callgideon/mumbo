---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-09-superagent-message-source

[English](2026-11-09-superagent-message-source.md) | 中文

## 概述

新增 dsh-superagent 消息来源：@mumbo/superagent 运行时投递给其主会话或执行器会话的 user 角色消息；它排队或插入的触发卡片或报告使用 form relay，不开始新一轮而直接注入的通知使用 form notice 并带有一行摘要。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-09-superagent-message-source
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-09-mumbo-edge-member-principal"
    after: "c04c341f9be056ec931e297ca2a6b8fd0af2af5044a9f9e47d17898717a5213c"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-09-mumbo-edge-member-principal"
    after: "8365a54d8790bb4bed42f90c2ef0e8878bd15d71710411a1dea6068f0d194437"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-09-mumbo-edge-member-principal"
    after: "26b91610009e78fbae68506f52d06b2af95df1257019d257caf1a708f745cdd2"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-09-mumbo-edge-member-principal"
    after: "e37b05a1ae468930cff046161f29a8a5e5d504779119ea00b88e5853eca8a307"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有日志不含该来源，仍然有效。该来源为内容即投递文本的普通 user 角色消息标注归属；读取方对未知来源类型走默认分支，保留消息及其内容，因此没有 @mumbo/superagent 的读取方也能加载此类日志，并把消息显示为以类型命名的注入上下文行，重放的请求与记录的请求一致。form 的各备选项是共享的 ContextFormed 备选项，运行时只写入 relay 与 notice。运行时只在重启后为恢复去重而读取自己的类型和消息 id（dsh-superagent: 加上 request id）；没有其他读取方依赖该类型。当前读取方读取旧日志时找不到该来源，并按原样处理其中的消息。不新增事件类型，也不改变 Session header，SESSION_FORMAT_VERSION 不变。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/mumbo/superagent/tests/delivery.spec.ts：15 个测试通过，覆盖跨已恢复历史与待处理收件箱的每个 request id 只投递一次。pnpm exec vitest run packages/client/ui-chat/tests/event-projection.client.spec.ts packages/client/ui-chat/tests/turn-trigger.client.spec.tsx：48 个测试通过。记录后 pnpm run verify-persistence-changes 与 pnpm run verify-persistence-catalog 通过。

<a id="dev-note"></a>
## 开发备注

无。
