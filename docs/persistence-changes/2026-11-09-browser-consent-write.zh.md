---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-09-browser-consent-write

[English](2026-11-09-browser-consent-write.md) | 中文

## 概述

新增 browser-consent/write：@mumbo/browser-consent 为其允许的每次浏览器写操作追加的仅日志审计记录，包含站点、上游工具、授权方式和结果。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-09-browser-consent-write
baseline: false
changes:
  - root: "event:browser-consent/write"
    previous: null
    after: "2980b9eb6c37399ed3b106cf3165f80e7f527850c682a24df9878f2b29c3c79d"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

同一会话格式版本中的新根。已有日志不含此事件，仍然有效；早于它的读取方会拒绝含有它的日志，与所有读取时必需的事件相同。只有 @mumbo/browser-consent 会在 Playwright MCP 浏览器写操作的最终结果之后追加它；它从不对模型可见，也没有运行时状态、投影或回放读取它。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/mumbo/browser-consent --coverage：7 个测试通过，packages/mumbo/browser-consent/src 覆盖率 100%；Loader 组合测试断言了追加的记录。DSH_BROWSER_EXECUTABLE=<chromium> pnpm exec vitest run --config vitest.e2e.config.ts packages/mumbo/browser-consent：1 个测试在固定版本的 Playwright MCP 服务器和真实 Chromium 上通过。

<a id="dev-note"></a>
## 开发备注

无。
