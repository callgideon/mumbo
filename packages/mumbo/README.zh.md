---
description: "mumbo 包组：按用户划分的 box 部署为运行中 Web 主机增加的内容，从供人们自己的工具访问，到浏览器写操作的同意机制。"
kind: "package-group"
---

# mumbo/：按用户 box 平台的包

[English](README.md) | 中文

## 概述

mumbo 家族收纳按用户划分的 box 部署为运行中 Web 主机增加的内容：供人们自己的工具使用的经过身份验证的访问，以及助手以本人已登录账号操作时的同意机制。每个包都挂接到已有服务，不注册模型工具。每个包的 README 拥有其约定。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

每个包负责一项部署关注点。

| 包 | 职责 |
|---|---|
| [`browser-consent/`](browser-consent/README.zh.md) | 读取免问，写入需问：对本人 Chromium 中 Playwright MCP 浏览器写操作的同意机制与审计记录 |
| [`mcp/`](mcp/README.zh.md) | 经过身份验证的 loopback MCP 服务器，白名单中的人通过它驱动主机的助手会话 |

-----

<a id="related-documentation"></a>
## 相关文档

- [MCP 客户端](../mcp/README.zh.md)——相反方向：把外部 MCP 服务器接入为原生工具。
- [GitHub webhook 适配器](../experimental/webhook-github/README.zh.md)——另一个位于专用监听器上的经过身份验证的入口。

<a id="dev-note"></a>
## 开发备注

无。
