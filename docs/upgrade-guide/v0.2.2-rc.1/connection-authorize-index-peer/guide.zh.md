---
kind: upgrade-guide
description: "Connection 的 authorizeIndex 改为返回准入的 Peer 而非布尔值，requestRejection 拒绝非 owner Peer。"
---

# `authorizeIndex` 返回准入的 Peer

[English](guide.md) | 中文

## 变更

在 `@deepseek-ai/dsh-client-connection` 中，`HostConnectionHandle.authorizeIndex(request, response)` 原先在调用方可以提供 index 时返回 `true`，写入重定向或 401 后返回 `false`。现在它返回 index 渲染所代表的 `PeerScope`，写入响应后返回 `undefined`。已注册的 authenticator 准入的请求返回该 authenticator 的非 owner Peer；owner 浏览器请求返回 `browserPeer`。`requestRejection(request)` 现在对以非 owner Peer 准入的请求返回 403。调用这两个方法的 Host 插件受影响。

## 迁移

1. 替换对 `authorizeIndex` 的布尔判断：`if (!ctx.connection.authorizeIndex(req, res)) return` 改为 `const peer = ctx.connection.authorizeIndex(req, res); if (peer === undefined) return`，`=== true` 比较改为 `!== undefined`。
2. 为返回的 Peer 渲染 index，例如 `ctx.webServer.renderIndex(html, peer)`，而不是 `ctx.connection.browserPeer`。
3. 只服务 owner 且绕过 Gateway 访问检查的路由，对 `peer.principal.kind !== 'owner'` 返回 403，与 inspector DevTools 路由相同。
4. 用 `pnpm run typecheck` 确认；对返回值剩余的布尔用法都会编译失败。
