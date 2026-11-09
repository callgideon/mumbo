---
description: "mumbo 包组：把运行中的 Web 主机连接到人们自己的工具以及其旁边的 box edge 页面的部署适配器。"
kind: "package-group"
---

# mumbo/：把运行中的主机连接到 mumbo 平台

[English](README.md) | 中文

## 概述

mumbo 家族把运行中的 Web 主机与其周围的平台连接起来：在明确的身份验证之后连接人们自己的工具，并连接 box edge 在主机旁提供的页面。它的包不自带会话、工具或存储行为。每个包的 README 拥有其约定。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 职责 |
|---|---|
| [`box-links/`](box-links/README.zh.md) | 从 box 的 Web 页面通往 box 主页和桌面实时画面的侧栏链接 |
| [`mcp/`](mcp/README.zh.md) | 经过身份验证的 loopback MCP 服务器，白名单中的人通过它驱动主机的助手会话 |

-----

<a id="related-documentation"></a>
## 相关文档

- [MCP 客户端](../mcp/README.zh.md)——相反方向：把外部 MCP 服务器接入为原生工具。
- [GitHub webhook 适配器](../experimental/webhook-github/README.zh.md)——另一个位于专用监听器上的经过身份验证的入口。

<a id="dev-note"></a>
## 开发备注

无。
