---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-09-mumbo-edge-member-principal

[English](2026-11-09-mumbo-edge-member-principal.md) | 中文

## 概述

为项目成员提交的提示词在 user-rpc 与 retry-rpc 消息来源中加入 mumbo edge-member principal，即经 mumbo 边缘签名登录的项目成员的小写邮箱；并加入 mumbo-member 通知来源，在每条这类消息之前指明该成员。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-09-mumbo-edge-member-principal
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-05-mcp-message-source"
    after: "12bf9822316484478396044ced9fd85d113028c288b5854dd12e3fe23a6081d5"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-05-mcp-message-source"
    after: "4ff746fb6f467e9b89f92df53476a10c26638d57572ec0f94046fd4cf810d104"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-05-mcp-message-source"
    after: "40dd32765c49c5177ceb86fc8383b4bd19858e3b445cbb4abf5d3820309c25e4"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-05-mcp-message-source"
    after: "2ad95fc11778969450c02aa9d23f1716e820f8ce4bec00d8a00be9f8c85e4e85"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

只有当提示词的 Peer 由 @mumbo/edge-member authenticator 准入时才写入 edge-member 变体；owner 的提示词仍省略 principal，因此其来源与所有已有 Session 日志不变。principal 只携带 kind 与边缘签名的小写邮箱，从不包含请求头、密钥或过期时间。kind 仍为 'user'，因此没有该包的构建仍把消息视为普通用户消息，读取方不驱动的 principal kind 交给驱动它的一方处理。mumbo-member 来源标记该包在每条成员消息之前插入的一条 user 角色通知，form 为 'notice' 并带一行摘要；它像其他 user 角色上下文消息一样进入请求，因此没有该包的读取方把它作为普通用户文本重放，重放的请求与记录的请求一致。当前读取方读取旧日志时找不到这两个变体，按原方式处理这些消息。principal 不进入任何模型请求。SESSION_FORMAT_VERSION 不变。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/mumbo/edge-member packages/client/connection：携带正确签名的 x-mumbo-member 请求头的请求，经真实 Loader 组合（Web 承载、Connection、Gateway、远程访问）以 { kind: 'edge-member', email } 到达 session/prompt；被篡改、过期、过远、其他密钥签名、重复与缺失的请求头都以 401 拒绝；真实 AgentLoop 步骤在成员消息之前紧接记录 mumbo-member 通知并把两者发给模型，只有 owner 消息的步骤不记录通知；18 个 edge-member 测试与 Connection 测试套件通过。

<a id="dev-note"></a>
## 开发备注

无。
