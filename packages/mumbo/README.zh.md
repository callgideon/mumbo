---
description: "mumbo 包组：让人从自己的工具访问运行中 Web 主机的部署适配器。"
kind: "package-group"
---

# mumbo/：从你自己的工具访问运行中的主机

[English](README.md) | 中文

## 概述

mumbo 家族在明确的身份验证之后，把运行中的 Web 主机已有的能力开放给人们自己的工具。它的包不自带会话、工具或存储行为；它们把已有服务适配到外部协议。每个包的 README 拥有其约定。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

每个包适配一种外部协议。

| 包 | 职责 |
|---|---|
| [`mcp/`](mcp/README.zh.md) | 经过身份验证的 loopback MCP 服务器，白名单中的人通过它驱动主机的助手会话 |

-----

<a id="related-documentation"></a>
## 相关文档

- [MCP 客户端](../mcp/README.zh.md)——相反方向：把外部 MCP 服务器接入为原生工具。
- [GitHub webhook 适配器](../experimental/webhook-github/README.zh.md)——另一个位于专用监听器上的经过身份验证的入口。

<a id="dev-note"></a>
## 开发备注

无。
