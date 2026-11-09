---
description: "让模型通过一个由 xdotool、ImageMagick import 和 xsel 支撑的 computer 工具查看并操作 Linux X11 桌面。"
kind: "package-reference"
---

# @deepseek-ai/dsh-computer-use-x11

[English](README.md) | 中文

## 概述

通过截图、指针输入和键盘输入操作 Linux X11 显示（例如 Xvfb 虚拟屏幕）上的桌面应用。一个 `computer` 工具用 ImageMagick `import` 截取整个显示，用 `xdotool` 发送输入，并通过 `xsel` 粘贴非 ASCII 文本。截图通过持久化附件传给支持图像的模型，坐标从模型收到的图像映射回屏幕像素。此实验性软件包必须在组合配置中显式启用；主机负责安装这三个程序。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在运行 DSH 的机器上安装这些程序（Debian 或 Ubuntu：`apt-get install xdotool imagemagick xsel`），启动 X 服务器，然后把以下行加入已经提供工具、子进程、附件存储和支持图像的模型路由的组合配置：

```yaml
- name: '@deepseek-ai/dsh-computer-use'
- name: '@deepseek-ai/dsh-computer-use-x11'
  config:
    display: ':1'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `display` | 必填 | 作为 `DISPLAY` 传给每条命令的 X 显示 |
| `xauthority` | 无 | 作为 `XAUTHORITY` 传入的 X 授权文件绝对路径；省略时移除继承的 `XAUTHORITY` |
| `xdotoolPath`、`importPath`、`xselPath` | `xdotool`、`import`、`xsel` | 绝对路径，或在子进程提供者的 `PATH` 中查找的名称 |
| `timeoutMs` | `10000` | 每条命令的截止时间；输入文本时每个字符再加 `typeDelayMs` |
| `graceMs` | `1000` | 被取消或超时的命令在开始终止后可用的退出时间 |
| `maxScreenshotBytes` | `33554432` | 单次截图接受的最大 PNG 字节数 |
| `typeDelayMs` | `12` | 输入字符之间的延迟 |
| `dragSteps` | `10` | 拖动起点和终点之间的指针移动次数 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-computer-use-x11)列出所有可接受字段。

### 激活与失败

加载时解析三个可执行文件，并对该显示运行 `xdotool getdisplaygeometry`。缺少程序时激活失败，并给出安装命令和对应配置字段；显示无法连接时激活失败，给出 X 错误，并要求启动服务器或更正 `display`、`xauthority`。随后提供者以 `x11` 名称注册；第二个电脑操作提供者会激活失败。卸载时移除工具、中止正在运行的命令、等待其结束，然后释放注册。

未使用 `-auth` 启动的 X 服务器（例如 `Xvfb :1 -nolisten tcp`）接受没有 cookie 的本地客户端，因此 DSH 可以以不同于 X 会话的用户运行。否则请把 `xauthority` 设为 DSH 用户可读的 cookie 文件。

### 调用与结果

截图要求调用属于某个 Agent、存在附件存储，且模型路由声明支持图像输入；否则在截图前失败。其值包含模型收到的图像尺寸和已存储的附件引用。输入操作返回 `{"dispatched":true}`：X 服务器已收到输入，但效果未经验证。命令失败、超时、输出超限以及被 `xdotool` 跳过的按键名称都会成为工具错误。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

| 文件 | 职责 |
|---|---|
| [src/index.ts](src/index.ts) | 配置、启动检查、工具 schema、坐标映射、命令构造和有界执行 |
| [src/keys.ts](src/keys.ts) | 把模型书写的按键组合转换为 X keysym 名称 |

每条命令都通过 `ctx.subprocess` 运行，带有显式的 `DISPLAY` 和 `XAUTHORITY`、自己的截止时间、调用方的取消信号和提供者生命周期。截图的标准输出最多读取 `maxScreenshotBytes`，其他命令最多读取 64 KiB；超出上限会终止命令。标准错误保留最后 64 KiB 用于诊断。

每个 Agent 保存最近一次截图的几何信息：附件存储为调用模型路由生成的请求版本的图像尺寸，以及截取时的屏幕尺寸。指针坐标必须位于该图像内，并映射到对应屏幕区域的中心。第一次截图之前的指针操作会失败。

`xdotool` 直接输入可打印 ASCII、换行和制表符。基于 Chromium 的应用会丢弃或替换 `xdotool` 通过重映射空闲键码输入的字符，因此包含其他字符的文本会用 `xsel` 写入 CLIPBOARD 和 PRIMARY 选区，再用 shift+Insert 粘贴。`xsel` 进程持续提供该选区，直到另一个客户端接管。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [电脑操作服务](../../computer-use/computer-use/README.zh.md)——独占的具名注册。
- [电脑操作](../../../docs/subsystems/computer-use.zh.md)——提供者选择与共享桌面限制。
- [附件存储](../../attachment/attachment/README.zh.md)——持久化图像与模型请求版本。

-----

<a id="model-experience"></a>
## 模型体验

### Computer 工具

#### 模型看到什么

一个 `computer` 工具，带有 `action` 枚举（`screenshot`、`click`、`move`、`drag`、`scroll`、`type`、`key`），以及可选的 `x`、`y`、`toX`、`toY`、`button`、`count`、`modifiers`、`deltaX`、`deltaY`、`text` 和 `keys` 参数。下面的描述用配置的显示替换 `<display>`。截图结果在图像旁显示 `Screenshot of X display <display>, <width>x<height> px; coordinates use these pixels.`，输入结果显示 `{"dispatched":true}`，错误会指出被拒绝的参数、缺少的截图或失败的命令。

##### 工具描述

```markdown
Operate the Linux desktop on X display <display>. Take a screenshot before using coordinates and after each action to verify it: actions report dispatch, not success. x, y, toX and toY are pixels in the latest screenshot. Actions: screenshot; click (x, y, optional button, count, modifiers); move (x, y; hovers); drag (from x, y to toX, toY, optional button, modifiers); scroll (x, y, deltaX and deltaY in wheel clicks, positive scrolls right and down); type (literal text including newlines; text containing non-ASCII characters is pasted with shift+Insert, replacing the clipboard and primary selection); key (keys: chords such as ctrl+l, ctrl+shift+t, alt+F4 or Return, separated by spaces for a sequence; use ctrl, not cmd). Keyboard input goes to the focused window; click a window to focus it. Start GUI programs from the shell with DISPLAY=<display> so they appear on this desktop.
```

#### Token 影响

提供者挂载期间，工具定义为每个请求增加固定数量的 token。每次截图按模型路由请求的尺寸增加一张图像；其他结果只增加一行短文本。

#### KV Cache 影响

显示设置不变时，工具定义的请求前缀保持稳定。结果追加到 Session 历史。更改 `display`，或挂载、移除提供者，会改变工具定义，并可能减少前缀复用。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **没有无障碍树或窗口列表**——模型只能依据截图工作；除了点击或按键之外，无法读取元素文本、列出窗口或提升窗口。
- **共享桌面**——此提供者不为某个 Session 预留显示。其他 Session、用户自己的查看器和应用都可以在两次调用之间更改它，键盘输入总是发给当前拥有焦点的窗口。
- **剪贴板被替换**——输入非 ASCII 文本会替换 CLIPBOARD 和 PRIMARY 选区，不支持 shift+Insert 粘贴的应用收不到该文本。
- **取消与部分输入**——被取消、超时或失败的命令可能已经传入部分输入；如果 `xdotool` 在序列中途被终止，点击或拖动时按住的修饰键可能保持按下。重试前先截图观察。
- **屏幕几何**——映射使用最近一次截图时的屏幕尺寸；之后调整 X 屏幕大小会导致坐标映射错误，直到下一次截图。
- **没有审批关卡**——输入操作不经过逐次审批；需要审批的部署应组合工具策略。
- **实验性发布**——操作集合与结果不作稳定性承诺。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

安装 `xvfb`、`xdotool`、`imagemagick` 和 `xsel` 并下载 Playwright 的 Chromium 后，运行真实显示测试；否则它会自动跳过，并指出缺少的程序：

```sh
node node_modules/vitest/vitest.mjs run --config vitest.e2e.config.ts packages/experimental/computer-use-x11/tests/xvfb.e2e.ts
```

</details>
