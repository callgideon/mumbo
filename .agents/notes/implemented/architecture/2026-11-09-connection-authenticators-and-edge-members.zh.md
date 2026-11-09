# Agent Note: Connection authenticator 与 mumbo 项目成员

Status: implemented

[English](2026-11-09-connection-authenticators-and-edge-members.md) | 中文

## Problem

mumbo 共享项目是 mumbo 边缘之后的独立 Host，多人在其中协作。Connection 的准入是封闭的：`admit()` 对有效的浏览器 cookie 返回 owner 的 `browserPeer`，对 API cookie 返回 owner API Peer，除此之外什么也不返回。因此边缘用盒子的 owner 启动 token 为每个成员登录，Host 把每个成员的消息记录为 owner 的消息，每个成员都持有对设置、凭据与插件的 owner 权限。[peer principal 决策](2026-10-12-peer-principal-and-remote-access.zh.md) 已经在提示词上记录非 owner 调用方，并通过远程访问管控其调用，但它唯一的非 owner kind——liveshare 的 `share-viewer`——经进程内 relay 通道进入，而不是 HTTP 准入。

## Decision

### Connection 中的 authenticator 接口

`ctx.connection.authenticators.register(authenticator)` 注册一个同步的 `ConnectionAuthenticator`：`(request) => PeerScope | undefined`。[`admit()`](../../../../packages/client/connection/src/rpc-host.ts) 先执行 Host/Origin 检查，再按注册顺序询问每个 authenticator，然后检查浏览器与 API 凭据。authenticator 只回答携带其自有凭据的请求，从不拒绝请求，因此凭据缺失或无效的请求仍会进入 owner 认证。注册是注册方 fiber 的 effect。authenticator 用 `createPeer()` 创建并拥有自己的 Peer，保持 peer principal 决策中由创建方拥有的 principal 到 Peer 的映射。

所有准入路径使用相同顺序：`/api` 路由、专用 RPC 通道、经 `admitConnection()` 的 Gateway WebSocket 升级，以及 index。`authorizeIndex()` 返回 index 渲染所代表的 Peer；authenticator 的 Peer 不获得 cookie 即可得到 index，因此 `webserver/index-inject` 与访问快照为该 principal 渲染。`requestRejection()` 对非 owner Peer 返回 403，因为使用它的路由（inspector、open-in-app）绕过 Gateway 访问检查，与 exact Fetch 路由相同。

### `edge-member` principal

[`@mumbo/edge-member`](../../../../packages/mumbo/edge-member/README.zh.md) 声明 `edge-member { email }`，并注册一个 authenticator 与一个远程访问策略。authenticator 校验 `x-mumbo-member: <email>.<expiry>.<mac>`：email 是无填充 base64url 编码的小写地址，expiry 是 Unix 秒，MAC 是在盒子成员密钥下对原样发送的前两个字段计算的无填充 base64url HMAC-SHA256，以常量时间比较。过期、超前 600 秒以上、格式错误、重复或以其他密钥签名的请求头都不是成员。边缘按盒子派生成员密钥 HMAC(边缘密钥, `member:` + 盒子 id)，因此为一个盒子签发的请求头在其他盒子中都会失败；边缘在移除浏览器发送的请求头后，为每个代理请求签发一个五分钟后过期的新请求头。每个成员一个 Peer，服务该成员的所有连接，就像 `browserPeer` 服务 owner 的所有浏览器连接。

### 协作者访问

策略给所有成员相同的绑定：一个 `global` 角色，覆盖 Session 列表、搜索、control、模型目录、提供方列表、命令与 Workspace 跟随；每个 Workspace 上的 Workspace 角色（`workspace/follow`、`session/create`）；以及 Workspace 列出的每个 Session 上的 Session 角色（分页、跟随、projection、状态、附件、上传、提示、取消、队列更新、技能、目标与 Session 通知）。`bindings()` 在每次决策时读取 Workspace 注册表，因此新 Session 立即可达；插件在 `session/created` 与 Workspace 域变化时调用 `remoteAccess.invalidate()`，使访问快照随之更新。没有任何角色列出设置、凭据、插件、fork、重命名、模型选择或 Workspace 管理操作，因此远程访问默认拒绝它们。

### 威胁模型

| 参与方 | 能够 | 不能 |
|---|---|---|
| 成员的浏览器 | 经边缘以该成员身份行动 | 提交自己的 `x-mumbo-member`；边缘会移除它 |
| 截获请求头的人 | 在该盒子中以该成员身份行动至多十分钟 | 在其他盒子中使用、延长过期时间或修改邮箱 |
| 盒子内的代码 | 读取 `MUMBO_MEMBER_KEY` 并伪造成员请求头 | 获得任何额外能力：这些代码在该盒子中本就以 owner 权限运行 |
| 成员 | 阅读并提示 Workspace 列出的每个 Session，从而运行盒子的工具 | 修改设置、凭据或插件，或访问 owner 专用路由 |

提示会运行协调者的工具，因此成员可以指挥盒子中的工作。这正是项目盒子的用途：它不保存账户或密钥，其工作在子沙箱中运行。

### 项目盒子中的 owner token 与审批

边缘不再为项目路径向成员提供 owner 启动 token，因此成员只以自己的身份行动。Host 仍接受 owner cookie；只有边缘持有它，用于管理。项目盒子加载 [`deploy/mumbo-project.overlay.yml`](../../../../deploy/mumbo-project.overlay.yml)，它挂载本插件，并把审批策略与每个权限预设都设为 `never`。非 owner 不能回答 owner 审批，项目盒子的浏览器前也没有 owner，因此 `ask` 会让成员的回合无限期等待。在完全访问下没有命令需要提升权限，`never` 会立即拒绝其他请求。账户写入的同意机制仍只在个人盒子中，那里的 owner 就是浏览器前的用户。

## Alternatives considered

**继续以 owner 身份为成员登录，并在消息文本中写明成员。** 它不需要改动 harness，但持久日志把 owner 记为作者，协调者不解析文本就无法区分成员，且每个成员都持有对设置与凭据的 owner 权限。

**每个成员一个 liveshare 式的 relay 通道。** liveshare 在自己的通道上创建查看者 Peer，但边缘已经代理普通 HTTP 与 WebSocket 流量；relay 会为每个项目请求复制一遍 Web 客户端的传输。

**在 Gateway 或远程访问中准入成员。** 准入产生之后每项检查读取的 Peer，因此 Peer 必须在 Gateway 运行前存在；在 Gateway 内准入会让 index、WebSocket 升级与专用通道得到与 `/api` 不同的答案。

**在远程访问中加入按 kind 的绑定，例如所有 Session。** 它可以免于枚举 Workspace 列表，但会为一个使用方改变通用的决策与快照格式；枚举使用现有的精确资源规则。

**在盒子中保存按成员的允许列表或撤销列表。** 边缘拥有项目成员关系，只为当前成员签发短时效的请求头，盒子中的副本可能与之偏离；移除在最后一个请求头过期时生效。

**由边缘侧应答方回答的 `ask` 策略。** 它在项目盒子中保留一个审批点，但那里没有人可以回答，而项目盒子中也没有审批需要保护的东西。

## Consequences

任何插件现在都可以准入非 owner 的 HTTP principal 而无需修改 Connection，owner 专用路由通过一处检查保持只对 owner 开放。成员以 `principal: { kind: 'edge-member', email }` 出现在其消息上，因此协调者与之后的守卫可以分辨谁请求了什么。成员无法打开子代理的子 Session 记录，因为子 Session 不在 Workspace 列表中。被移除的成员在边缘签发的最后一个请求头过期前（至多十分钟）仍有访问权。每次成员决策都会扫描 Workspace 列表，其成本与盒子中的 Session 数量成线性关系。
