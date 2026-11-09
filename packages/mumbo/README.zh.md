---
description: "mumbo 包组：按用户划分的 box 部署为运行中 Web 主机增加的内容，从供人们自己的工具访问以及主机旁的 box edge 页面，到浏览器写操作的同意机制。"
kind: "package-group"
---

# mumbo/：按用户 box 平台的包

[English](README.md) | 中文

## 概述

mumbo 家族收纳按用户划分的 box 部署为运行中 Web 主机增加的内容：供人们自己的工具使用的经过身份验证的访问、box edge 在主机旁提供的页面、项目成员，以及助手以本人已登录账户行动时的同意机制。每个包都接入现有服务，不注册任何模型工具。每个包的 README 负责其约定。

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
| [`box-links/`](box-links/README.zh.md) | 从 box 的 Web 页面通往 box 主页和桌面实时画面的侧栏链接 |
| [`browser-consent/`](browser-consent/README.zh.md) | 读取免问，写入需问：对本人 Chromium 中 Playwright MCP 浏览器写操作的同意机制与审计记录 |
| [`edge-member/`](edge-member/README.zh.md) | 以边缘签名的请求头把项目成员准入为拥有协作者访问权的非 owner principal |
| [`mcp/`](mcp/README.zh.md) | 经过身份验证的 loopback MCP 服务器，白名单中的人通过它驱动主机的助手会话 |

-----

<a id="related-documentation"></a>
## 相关文档

- [MCP 客户端](../mcp/README.zh.md)——相反方向：把外部 MCP 服务器接入为原生工具。
- [GitHub webhook 适配器](../experimental/webhook-github/README.zh.md)——另一个位于专用监听器上的经过身份验证的入口。

<a id="dev-note"></a>
## 开发备注

无。
