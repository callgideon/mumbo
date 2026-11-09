# Agent Note: Connection authenticator 与 mumbo 项目成员

Status: implemented

[English](2026-11-09-connection-authenticators-and-edge-members.md) | 中文

## Problem

mumbo 共享项目是 mumbo 边缘之后的独立 Host，多人在其中协作。Connection 的准入是封闭的：`admit()` 对有效的浏览器 cookie 返回 owner 的 `browserPeer`，对 API cookie 返回 owner API Peer，除此之外什么也不返回。因此边缘用盒子的 owner 启动 token 为每个成员登录，Host 把每个成员的消息记录为 owner 的消息，协调者只能从边缘写入转发文本的 `[from <email>]` 前缀得知作者，每个成员都持有对设置、凭据与插件的 owner 权限。[peer principal 决策](2026-10-12-peer-principal-and-remote-access.zh.md) 已经在提示词上记录非 owner 调用方，并通过远程访问管控其调用，但它唯一的非 owner kind——liveshare 的 `share-viewer`——经进程内 relay 通道进入，而不是 HTTP 准入。

## Decision

### Connection 中的 authenticator 接口

`ctx.connection.authenticators.register(authenticator)` 注册一个同步的 `ConnectionAuthenticator`：`(request) => PeerScope | undefined`。[`admit()`](../../../../packages/client/connection/src/rpc-host.ts) 先执行 Host/Origin 检查，再按注册顺序询问每个 authenticator，然后检查浏览器与 API 凭据。authenticator 只回答携带其自有凭据的请求，从不拒绝请求，因此凭据缺失或无效的请求仍会进入 owner 认证；抛错的 authenticator 会被记录并跳过。注册是注册方 fiber 的 effect。authenticator 用 `createPeer()` 创建并拥有自己的 Peer，保持 peer principal 决策中由创建方拥有的 principal 到 Peer 的映射。

`/api` 路由与经 `admitConnection()` 的 Gateway WebSocket 升级使用这一顺序，因此非 owner Peer 只能到达检查远程访问的 Gateway，以及下文声明了访问规则的 exact Fetch 路由。其他所有绕过 Gateway 的路由仍只对 owner 开放：未声明 `access` 的 exact Fetch 路由与专用 RPC 通道对非 owner Peer 返回 403，`requestRejection()` 为 inspector、open-in-app 等兄弟路由对其返回 403，`authorizeIndex()` 仍只检查 owner 凭据，因此已有的 `if (!authorizeIndex(...))` owner 检查保持原意。`admitIndex()` 是面向任意 principal 的 index 准入：它返回 authenticator 的 Peer 且不签发 cookie，否则经 `authorizeIndex()` 返回 `browserPeer`；frontend-static 为它返回的 Peer 渲染 index，包括 `webserver/index-inject` 与访问快照。

<a id="exact-fetch-route-access"></a>
### exact Fetch 路由访问

exact Fetch 路由绕过 Gateway，因此由它声明自己的非 owner 规则：`access: { action, resources }` 指定一个 remote-access action，并为每种资源类型指定携带资源 id 的查询参数；空映射表示 `global`。对非 owner 请求，[共享 Fetch handler](../../../../packages/client/connection/src/rpc-host.ts) 要求每个列出的参数恰好出现一次且非空，然后询问经 `ctx.connection.fetch.authorize()` 安装的唯一 authorizer，只在其返回 true 时运行路由。未声明 `access` 的路由、没有 authorizer 的组合、已释放的 Peer、缺失、为空或重复的参数、抛错的 authorizer 以及被拒绝的请求都返回 403；owner 跳过该检查。非 owner 的路由收到的请求，其 signal 在 Peer 释放时也会中止，因此过期成员的上传或导出会像其 Gateway 流一样停止。注册时拒绝 `remoteAccess/follow`，因为远程访问对所有 principal 都允许它。[Gateway](../../../../packages/api/gateway/src/index.ts) 把 authorizer 安装为不带 `args` 的 `remoteAccess.decide({ principal, action, resources })`，因此 condition 必须像对快照一样保守地回答，Connection 也不依赖 remote-access；remote-access 的测试已经依赖 Connection，反向导入会形成项目引用环。要求参数只出现一次，使被检查的 id 与路由服务的 id 相同，尽管各路由以 `get()`（第一个值）或 `Object.fromEntries`（最后一个值）读取查询。

每条路由采用最能描述其所服务内容的最窄 action。浏览器二进制上传 `/api/session/uploadFileBinary` 像编码 Remote `fileUploads/upload` 一样，在其 `sessionId` 指定的 Session 下暂存凭证，但以流式传输且没有总字节上限，因此在该 Session 上采用自己的 `fileUploads/uploadBinary`；复用 Remote 的 action 会让所有授权编码上传的策略都获得流式上传权，包括 liveshare 查看者，其 relay 会经共享 handler 转发查询字符串。Session 日志下载 `/api/session.export` 与 Markdown 复制 `/api/session.markdown` 在其指定的 Session 上采用路由专用 action `sessionLog/export` 与 `sessionLog/markdown`；归档还包含每个子代理后代的日志及这些日志引用的附件，由根 Session 上的 `sessionLog/export` 覆盖。复用 `session/events` 会让所有已列出它的现有策略（包括 liveshare 查看者）获得下载权。`/api/file` 读取文件系统提供方能读取的任意绝对路径，包括盒子的机密、启动日志与每个 Session 日志，因此其 action `hostFiles/readAny` 作用于 `global` 并表明这一可达范围；没有任何内置策略授予它。变更摘要、在盒子上打开文件等交付物路由不声明访问规则，保持只对 owner 开放。

### `edge-member` principal

[`@mumbo/edge-member`](../../../../packages/mumbo/edge-member/README.zh.md) 声明 `edge-member { email }`，并依次注册一个远程访问策略、一个 authenticator 与成员署名。authenticator 校验 `x-mumbo-member: <email>.<expiry>.<mac>`：email 是无填充 base64url 编码的小写地址，expiry 是 Unix 秒，MAC 是在盒子成员密钥下对原样发送的前两个字段计算的无填充 base64url HMAC-SHA256，以常量时间比较。过期、超前 600 秒以上、格式错误、重复或以其他密钥签名的请求头都不是成员。边缘按盒子派生成员密钥 HMAC(边缘密钥, `member:` + 盒子 id)，因此为一个盒子签发的请求头在其他盒子中都会失败；边缘在移除浏览器发送的请求头后，为每个代理请求签发一个五分钟后过期的新请求头。

每个成员一个 Peer，服务该成员的所有连接，就像 `browserPeer` 服务 owner 的所有浏览器连接，并在该成员最新请求头过期前保持存活。之后插件释放它：Gateway 关闭该成员的 WebSocket 并结束其流，客户端经边缘重连，新请求头创建新的 Peer。因此只在 WebSocket 升级时校验一次的请求头无法让被移除的成员保持连接。

### 协作者访问

策略给所有成员相同的绑定：一个 `global` 角色，覆盖创建 Session，Session 列表、搜索、control、模型目录、预设与提供方列表、命令与 Workspace 跟随；每个 Workspace 上的 Workspace 角色（`workspace/follow`、`session/create`）；以及 Workspace 列出的每个 Session 与每个存活 Session 上的 Session 角色，存活 Session 包括运行中的子代理子 Session。Session 角色可以阅读与跟随 Session 及其作业与工作区文件、提示与取消、回答其问题、经 Remote 的 `fileUploads/upload` 或浏览器二进制路由（`fileUploads/uploadBinary`）上传、下载其日志归档并复制为 Markdown（`sessionLog/export`、`sessionLog/markdown`）、接收其通知，并列出 `session/create`，使复用 Workspace 列出的空白 Session（同时解析为该 Workspace 与该 Session）得到允许。没有任何角色列出设置、凭据、插件、fork、重命名、模型选择、队列编辑或 Workspace 管理操作，因此远程访问默认拒绝它们；队列编辑会保留被编辑消息的来源，因而会把一个人的文本记录为另一个人的。绑定被缓存，并在 `session/created`、`session/disposed` 或 Workspace 域变化提交后重建，每次重建都调用 `remoteAccess.invalidate()`，使访问快照随之更新。Workspace 注册表在其实体持有新的 Session 列表之前发出 `domain/changed`，因此该重建等到发出变化的写入完成后才运行；否则成员的快照会缺少其刚创建的 Session，客户端也不会为它提供输入框。

### 成员署名

principal 不进入模型请求，因此只记录 `principal` 无法让协调者知道消息的作者。`agent/pre-step` 监听器在每条 principal 为 `edge-member` 的进入消息之前插入一条 user 角色通知，来源为 `{ kind: 'mumbo-member', form: 'notice' }`，文本为 `The next message is from project member <email>.`。通知与消息一起进入 Session 日志，因此模型请求仍可从日志重建，恢复的 Session 会重放它。成员经盒子自身页面发送的消息不再需要边缘的文本前缀。

### 威胁模型

| 参与方 | 能够 | 不能 |
|---|---|---|
| 成员的浏览器 | 经边缘以该成员身份行动 | 提交自己的 `x-mumbo-member`；边缘会移除它 |
| 截获请求头的人 | 在该盒子中以该成员身份行动，直到请求头过期（至多十分钟） | 在其他盒子中使用、延长过期时间或修改邮箱 |
| 成员，经 Remote 调用与获授权的 exact 路由 | 阅读、跟随、提示、上传到并导出每个获授权的 Session | 调用设置、凭据、插件或队列编辑方法，或访问 Gateway 之外的其他路由 |
| 成员，经代理的工具 | 指挥协调者，其工具在完全访问且审批为 `never` 时不受约束地运行 | 被约束：这些工具可以读取 `MUMBO_MEMBER_KEY` 与 owner cookie 的签名记录，从而伪造其他成员的请求头或 owner cookie |

访问策略在 Remote API 层面把成员与 owner 分开，并为其消息署名；它不是针对指挥代理提升权限的成员的约束边界。在盒子以独立身份或只在子沙箱中运行工具之前，成员是可信的协作者。

### 项目盒子中的 owner token 与审批

边缘不再为项目路径向成员提供 owner 启动 token，因此成员只以自己的身份行动。Host 仍接受 owner cookie；只有边缘持有它，用于管理。项目盒子加载 [`deploy/mumbo-project.overlay.yml`](../../../../deploy/mumbo-project.overlay.yml)，它挂载本插件，并把审批策略与每个权限预设都设为 `never`。非 owner 不能回答 owner 审批，项目盒子的浏览器前也没有 owner，因此 `ask` 会让成员的回合无限期等待。在完全访问下没有命令需要提升权限，`never` 会立即拒绝其他请求。账户写入的同意机制仍只在个人盒子中，那里的 owner 就是浏览器前的用户。

## Alternatives considered

**继续以 owner 身份为成员登录，并在消息文本中写明成员。** 它不需要改动 harness，但持久日志把 owner 记为作者，成员在盒子自身页面中的文本不带名字，且每个成员都持有对设置与凭据的 owner 权限。

**每个成员一个 liveshare 式的 relay 通道。** liveshare 在自己的通道上创建查看者 Peer，但边缘已经代理普通 HTTP 与 WebSocket 流量；relay 会为每个项目请求复制一遍 Web 客户端的传输。

**在 Gateway 或远程访问中准入成员。** 准入产生之后每项检查读取的 Peer，因此 Peer 必须在 Gateway 运行前存在；在 Gateway 内准入会让 index 与 WebSocket 升级得到与 `/api` 不同的答案。

**让 `authorizeIndex()` 返回准入的 Peer。** 它免去第二个方法，但 `if (!authorizeIndex(...))` 对 Peer 结果仍能编译，因此每个已有的 owner 检查都会悄然开始服务成员。

**边缘使用 Ed25519 签名，使盒子只持有公钥。** 它阻止盒子内的代码伪造其他成员的请求头，但这些代码同样可以读取 owner cookie 的签名记录与 Session 日志，因此署名仍无法抵御指挥代理提升权限的成员；真正起作用的边界是对工具的约束。

**在模型适配器中渲染 principal。** 它可以免去额外的日志事件，但适配器只读取面向模型的来源，而不作为自身日志事件的模型可见输入会破坏“每个模型请求都可从日志重建”的规则。

**在远程访问中加入按 kind 的绑定，例如所有 Session。** 它可以免于枚举 Session，但会为一个使用方改变通用的决策与快照格式；枚举使用现有的精确资源规则。

**在盒子中保存按成员的允许列表或撤销列表。** 边缘拥有项目成员关系，只为当前成员签发短时效的请求头，盒子中的副本可能与之偏离；移除在最后一个请求头过期时生效。

**由 Connection 自行调用远程访问。** 它不需要 authorizer，但 Connection 会导入已经依赖 Connection 的 remote-access，通用传输层也会承载 PDP 的 API。

**每条路由在自己的 `fetch(request, peer)` 中判定。** 它允许从请求体得出资源，但每条路由都会重复判定及其默认值，忘记判定的路由会服务所有非 owner。

**每条路由一个资源读取函数。** 它比参数映射更灵活，但每个读取函数都要校验自己的 wire 值；参数映射把“恰好一次”与非空检查留在 Connection 中，而 exact 路由本就在查询中携带 id。

**经必需的 `sessionId` 向成员开放 `/api/file`。** Session 可以把路径限定在其工作区根目录，就像 `workspaceFiles` 在 `confine` 中所做的那样，但这种限定只能作用于非 owner（owner 的页面也会渲染其文件引用），而 `ConnectionFetchRoute.fetch` 收不到 Peer。在某个改动传入 Peer 之前，该路由在 `global` 上声明 `hostFiles/readAny`，且没有任何成员角色授予它。

**由边缘侧应答方回答的 `ask` 策略。** 它在项目盒子中保留一个审批点，但那里没有人可以回答，而项目盒子中也没有审批需要保护的东西。

## Consequences

任何插件现在都可以准入非 owner 的 HTTP principal 而无需修改 Connection，Gateway 之外的每条路由在声明访问规则之前都保持只对 owner 开放。成员以 `principal: { kind: 'edge-member', email }` 出现在其消息上，协调者读到指明每个成员的通知，每条成员消息约十个 token。成员无法在页面中打开已结束的子代理记录，因为没有 Workspace 列出它，但已授权 Session 的日志下载包含它；成员经策略授权的三条 exact 路由上传以及下载或复制 Session 日志，而记录中的媒体引用不会为其渲染，因为 `/api/file` 对成员保持关闭。资源位于请求体中的 exact 路由无法声明访问规则。成员的 WebSocket 在请求头过期后重连，至多每十分钟一次。被移除的成员在边缘签发的最后一个请求头过期前仍有访问权。在项目盒子约束工具之前，成员经代理的工具仍等同于 owner。
