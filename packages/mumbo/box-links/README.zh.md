---
description: "为部署在 mumbo box edge 之后的部署提供侧栏链接，从 box 的 Web 页面通往 box 主页和桌面实时画面。"
kind: "package-reference"
---

# @mumbo/box-links

[English](README.md) | 中文

## 概述

`@mumbo/box-links` 在 Web 侧栏底部、账号菜单上方添加主页链接，并在配置时添加桌面链接。主页打开 box 主页，其中有此人的助手、桌面和共享项目；桌面打开 box 桌面的实时画面。两者都在新标签页中打开，因此会话、其草稿和页面连接保持打开。没有本插件的条目时，侧栏不显示这两个链接。

## 目录

- [配置](#configuration)
- [行为](#behavior)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="configuration"></a>
## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `home` | 必填 | box 主页的绝对 HTTP(S) URL。 |
| `desktop` | 省略 | 桌面实时画面的绝对 HTTP(S) URL；没有桌面的 box（例如项目 box）省略此项。 |

每个 URL 必须带有协议、主机和路径；其他值会使插件加载失败。box edge 通过 Loader overlay 添加该条目，参见 [`examples/person.overlay.yml`](examples/person.overlay.yml) 和 [`examples/project.overlay.yml`](examples/project.overlay.yml)。生成的[配置目录](../../../docs/config-catalog.zh.md#mumbobox-links)是可接受字段的完整来源。

<a id="behavior"></a>
## 行为

Host 部分通过 `webserver/index-inject` 把校验后的链接放入每个页面的引导数据，无论页面代表哪个 Peer。Client 部分再次校验，并注册一个 `sidebar.footer.action` 占位：宽侧栏中是图标加标签的行，窄栏中是带工具提示的纯图标行。标签来自 `boxLinks` 语言命名空间，覆盖每个 Client 语言。这些链接只是普通导航：不调用 Remote，也不需要访问授权，因此代表非所有者主体的页面同样显示它们。在该条目启动之前加载的页面不带链接，直到重新加载。

<a id="model-experience"></a>
## 模型体验

无，因为这些链接是浏览器导航，不注册工具、提示词段落或 Session 事件。

#### KV Cache 影响

不改变模型请求前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **没有房屋或显示器图标** — 在设计师批准专用图标之前，主页使用共享的层叠图标，桌面使用地球图标。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
