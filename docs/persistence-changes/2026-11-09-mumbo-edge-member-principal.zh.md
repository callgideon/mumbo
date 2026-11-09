---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-09-mumbo-edge-member-principal

[English](2026-11-09-mumbo-edge-member-principal.md) | 中文

## 概述

为项目成员提交的提示词在 user-rpc 消息来源中加入 mumbo edge-member principal，即经 mumbo 边缘签名登录的项目成员的小写邮箱。

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
    after: "94d82fab378cb081d77a8603c795f13469649a1aeae093f58ac21472f5c471da"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-05-mcp-message-source"
    after: "fa865b9afe18915d90a67483e71691057fda0a04ff06ba2a5cf5a18f80471e5c"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-05-mcp-message-source"
    after: "a3c6fcc2bd58a457b862b4cd7b2dc43b1d32a011c80bab76a041a4c080d077c1"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-05-mcp-message-source"
    after: "6013b34796c91846aaf7213719093beff90a701f787aa5f7e4b6db968d3bc02a"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

只有当提示词的 Peer 由 @mumbo/edge-member authenticator 准入时才写入 edge-member 变体；owner 的提示词仍省略 principal，因此其来源与所有已有 Session 日志不变。该值只携带 kind 与边缘签名的小写邮箱，从不包含请求头、密钥或过期时间。kind 仍为 'user'，因此没有该包的构建仍把消息视为普通用户消息，读取方不驱动的 principal kind 交给驱动它的一方处理。当前读取方读取旧日志时找不到 edge-member principal，按原方式处理这些提示词。该字段不进入任何模型请求。SESSION_FORMAT_VERSION 不变。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/mumbo/edge-member packages/client/connection：携带正确签名的 x-mumbo-member 请求头的请求，经真实 Loader 组合（Web 承载、Connection、Gateway、远程访问）以 { kind: 'edge-member', email } 到达 session/prompt；被篡改、过期、过远、其他密钥签名与缺失的请求头都以 401 拒绝；9 个 edge-member 测试与 Connection 测试套件通过。

<a id="dev-note"></a>
## 开发备注

无。
