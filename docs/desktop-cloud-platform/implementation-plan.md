# Codex Manage 桌面与云平台分阶段实施计划

## 1. 文档信息

- 文档版本：V1.0
- 文档状态：已完成计划审核
- 审核日期：2026-07-21
- 需求依据：[桌面端、内网穿透与运营后台需求文档](./requirements.md)
- 架构依据：[总体技术架构](./architecture.md)
- 目标版本：Desktop & Cloud Platform V1

## 2. 计划目标

在保留现有 Codex Manage Web 功能和测试基线的前提下，分阶段交付：

- macOS Apple Silicon、macOS Intel、Windows x64 桌面安装包。
- 安全的本地服务和二维码配对登录。
- Quick Tunnel 体验通道。
- Named Tunnel 固定域名正式通道。
- 邮箱和手机号注册。
- 用户、设备、Tunnel、域名控制面。
- 运营管理后台。
- 套餐、订阅、权益、订单和支付预留。
- 签名、公证、发布和生产试运行能力。

## 3. 当前基线

截至 2026-07-21，现有项目基线为：

- React + Vite 前端。
- Fastify + TypeScript 后端。
- Codex app-server stdio JSON-RPC 集成。
- 会话列表、详情、恢复、实时输出、审批和模型切换已实现。
- 生产构建可生成前端和服务端产物。
- 单元测试基线：18 个测试文件、79 个测试通过。
- TypeScript 类型检查通过。

当前不具备：

- Electron 桌面壳。
- 安装包构建与签名。
- cloudflared 进程管理。
- 公网安全认证和一次性二维码配对。
- 云端用户、设备、Tunnel、域名和权益服务。
- 管理员后台。

## 4. 实施原则

### 4.1 安全门禁

在本地认证、loopback 监听、Host/Origin 校验、CSRF、Cookie 和 WebSocket 鉴权改造完成前，不允许向真实公网开放 Tunnel。

### 4.2 保持回归基线

- 每个阶段必须保持现有 79 个测试通过。
- 迁移目录或启动方式时，先增加兼容入口，再删除旧入口。
- 现有会话数据和元数据迁移必须可回滚。

### 4.3 可独立验收

每个阶段都有明确交付物、退出条件和阻断条件。未通过当前阶段门禁，不进入依赖该阶段的生产功能。

### 4.4 环境隔离

开发、测试、预发布和生产使用独立：

- 数据库和 Redis。
- Cloudflare Token 和 Tunnel。
- 域名前缀。
- 邮件和短信配置。
- 安装包渠道和签名配置。

### 4.5 不提前接支付

V1 只实现套餐、订阅、权益、订单和支付占位，不接微信、支付宝或真实扣款。

## 5. 工作流划分

实施工作分为六条工作流：

| 工作流 | 主要内容 |
| --- | --- |
| W1 本地 Web | Fastify 重构、本地认证、配对、Codex 兼容 |
| W2 桌面端 | Electron、进程管理、托盘、安全存储、诊断 |
| W3 Tunnel | cloudflared、Quick Tunnel、Named Tunnel、域名 |
| W4 云端控制面 | 用户、设备、心跳、权益、Worker、Cloudflare Adapter |
| W5 管理后台 | 用户、设备、域名、Tunnel、订阅、审计 |
| W6 发布质量 | 测试、安全、签名、公证、安装、升级和运维 |

## 6. 阶段总览

| 阶段 | 名称 | 主要输出 | 粗略工作量 |
| --- | --- | --- | --- |
| P0 | 技术准备与外部资源就绪 | ADR、环境、供应商和发布准备 | 3–5 人日 |
| P1 | 仓库与本地服务可嵌入改造 | Workspaces、App Factory、回归基线 | 5–8 人日 |
| P2 | 公网安全基础 | 本机密码、Session、配对码、安全中间件 | 8–12 人日 |
| P3 | Electron 桌面基础 | 主进程、Utility Process、托盘、诊断 | 10–15 人日 |
| P4 | Quick Tunnel 体验版 | cloudflared、随机地址、二维码、重连 | 6–10 人日 |
| P5 | 云端账号与设备控制面 | 邮箱、手机、设备、心跳、Token | 12–18 人日 |
| P6 | Named Tunnel 与固定域名 | Cloudflare Adapter、DNS、Token、对账 | 10–15 人日 |
| P7 | 运营管理后台 | 用户、设备、Tunnel、域名、审计 | 8–12 人日 |
| P8 | 套餐、权益与支付预留 | Plan、Subscription、Entitlement、占位页 | 5–8 人日 |
| P9 | 多平台打包与发布 | 三平台产物、签名、公证、下载发布 | 10–15 人日 |
| P10 | 试运行与正式发布 | 安全复核、灰度、运维手册、GA | 8–12 人日 |

以上为人日估算，不是固定日历承诺。部分云端工作可与桌面工作并行。按 3 名开发人员加 1 名测试人员配置，且外部证书、短信和签名资源及时就绪，V1 建议预留约 10–14 个自然周。

## 7. P0：技术准备与外部资源就绪

### 7.1 目标

确认架构关键决策和外部依赖，避免开发完成后被域名、证书、短信或签名阻塞。

### 7.2 任务

- 固化 Electron、electron-builder、PostgreSQL、Redis 技术基线。
- 建立 ADR：进程模型、认证边界、Tunnel 模式、单级设备域名。
- 将 V1 设备域名确定为 `d-<deviceCode>.xmwefun.cn`。
- 准备开发和预发布域名，例如 `d-dev-*.xmwefun.cn` 或独立测试 Zone。
- 创建最小权限 Cloudflare API Token：Tunnel Edit、Zone DNS Edit。
- 确认 Cloudflare Account ID、Zone ID 和 Secret 存储方案。
- 选择邮件服务商并创建测试凭证。
- 选择短信服务商并创建测试签名、模板和凭证。
- 准备 Apple Developer 账号、证书和公证凭证。
- 准备 Windows 代码签名证书方案。
- 确定云端部署环境、数据库备份和日志平台。
- 定义版本号、发布渠道和测试包命名规则。

### 7.3 交付物

- ADR 清单。
- 开发、预发布和生产环境配置清单。
- Secret 清单和责任人。
- 外部供应商准备状态表。
- 风险与阻塞项列表。

### 7.4 退出门禁 G0

- 架构文档已批准。
- 域名层级修正已确认。
- Cloudflare 测试环境可调用 API。
- 至少邮件测试通道可用；短信可以处于申请中，但必须有明确完成时间。
- 签名和公证申请已启动。

## 8. P1：仓库与本地服务可嵌入改造

### 8.1 目标

在不改变现有用户功能的情况下，将项目调整为可以承载桌面、云端和后台的单仓结构，并使 Fastify 服务可被 Electron 启动和停止。

### 8.2 任务

- 启用 npm workspaces。
- 建立 `apps`、`packages`、`resources` 和 `tooling` 目录。
- 抽取 `createLocalWebApp()`。
- 抽取 `LocalWebRuntime.start()` 和 `stop()`。
- 抽取 `startLocalWebServer()`，返回实际监听地址、端口和关闭句柄。
- 将配置加载从全局模块初始化改为显式注入。
- 移除业务代码对 `process.cwd()` 的持久化路径依赖。
- 增加用户数据目录抽象，CLI 模式继续兼容当前目录。
- 建立 `shared-contracts` 包，迁移公共 API 类型和错误结构。
- 保持原 `npm run dev`、`npm test`、`npm run typecheck` 可用。
- 为启动、停止、端口冲突和 app-server 启动失败增加测试。

### 8.3 交付物

- 可嵌入的 Local Web App Factory。
- Workspaces 基础结构。
- 兼容原开发流程的脚本。
- 本地服务生命周期测试。

### 8.4 验收

- CLI 模式仍可启动完整 Web 应用。
- 测试中可以创建和关闭 Fastify 实例，不残留端口和 Codex 子进程。
- 现有 79 个测试全部通过。
- 类型检查通过。
- 现有 E2E 核心流程无回归。

### 8.5 退出门禁 G1

本地服务已可被外部生命周期管理，且原 Web MVP 回归通过。

## 9. P2：公网安全基础

### 9.1 目标

完成所有 Tunnel 前置安全能力，使本地服务具备安全公网访问基础。

### 9.2 任务

- 将桌面模式默认监听地址改为 `127.0.0.1`。
- 实现持久化本地 session secret。
- 引入本地 SQLite 和迁移机制。
- 实现本机访问密码初始化、修改和验证。
- 使用 Argon2id 或审核通过的等效密码哈希。
- 实现 server-side Session、过期、单会话撤销和全部撤销。
- 实现一次性配对码生成、哈希保存、过期和原子消费。
- 实现 URL Fragment 配对页面和授权码清理。
- 增加登录、密码、配对和验证码类接口限流。
- 增加 CSRF 防护。
- 增加 Host allowlist 和 Origin 校验。
- 严格配置 `trustProxy`。
- 改造公网 Cookie 的 Secure、HttpOnly 和 SameSite 属性。
- 改造 WebSocket 鉴权。
- 为桌面本机打开 Web 页面设计独立启动令牌或本地 Session。
- 禁止默认公共密码在桌面 Tunnel 模式生效。

### 9.3 测试

- 密码设置、验证和修改单元测试。
- Session 创建、过期、撤销和 logout-all 测试。
- 配对码过期、重复使用和并发消费测试。
- Host header 和 DNS rebinding 测试。
- CSRF、Origin 和 Cookie 属性测试。
- WebSocket 未授权、过期和已撤销测试。
- 日志敏感字段扫描测试。

### 9.4 交付物

- LocalAuthService。
- PairingCodeService。
- 本地 Session 管理页面。
- 安全中间件和回归测试。
- 公网安全检查清单。

### 9.5 退出门禁 G2

- 安全测试全部通过。
- 未认证公网请求无法访问 Codex API 或 WebSocket。
- 配对码一次使用和过期行为可验证。
- 本地服务只监听 loopback。
- 完成独立代码审查后，才允许进入真实 Tunnel 测试。

## 10. P3：Electron 桌面基础

### 10.1 目标

交付不含公网 Tunnel 的桌面 Alpha，验证 macOS 和 Windows 上的进程、路径、存储和托盘生命周期。

### 10.2 任务

- 建立 Electron Main、Preload 和 Renderer。
- 配置 `contextIsolation`、sandbox 和关闭 Node Integration。
- 定义强类型 IPC 白名单。
- 使用 Utility Process 启动本地 Fastify 服务。
- 实现 LocalServiceSupervisor。
- 实现应用退出时的进程清理。
- 实现系统托盘和最小化行为。
- 实现开机启动开关。
- 实现 `app.getPath("userData")` 数据目录。
- 集成 Electron `safeStorage`。
- 实现 CodexLocator：保存路径、常见路径、PATH 和用户选择。
- 展示 Codex CLI 版本、app-server 状态和错误。
- 实现桌面诊断页和脱敏日志导出。
- 增加“打开本地 Codex Manage”入口。

### 10.3 测试矩阵

- macOS arm64 启动、托盘、退出和 Codex 查找。
- macOS x64 启动、托盘、退出和 Codex 查找。
- Windows x64 启动、托盘、退出和 Codex 查找。
- Finder/桌面快捷方式启动，不依赖终端 PATH。
- 本地端口占用和 Utility Process 异常退出。
- 关闭窗口不停止服务，明确退出会停止服务。
- 安全存储读写和账号退出清理。

### 10.4 交付物

- 三平台可运行的未签名开发包。
- 桌面控制台首页。
- 本地服务生命周期管理。
- Codex CLI 检测与引导。
- 托盘和诊断能力。

### 10.5 退出门禁 G3

- 三个平台至少各有一次真实环境启动记录。
- 不安装 Node.js 也能运行桌面客户端和本地服务。
- 不安装 Codex CLI 时应用正常进入诊断页而不崩溃。
- 退出后无遗留本地服务进程。

## 11. P4：Quick Tunnel 体验版

### 11.1 目标

交付内部可用的扫码远程访问 Alpha，验证 cloudflared 打包、进程管理、WebSocket 和二维码安全链路。

### 11.2 任务

- 建立 `tunnel-client` 包和 TunnelSupervisor 状态机。
- 下载并固定三个目标平台的 cloudflared 版本。
- 记录并校验每个平台二进制 SHA-256。
- 将二进制以 extraResources 方式打包到 ASAR 外。
- 使用隔离的 cloudflared 配置目录。
- 启动 Quick Tunnel 并解析随机 URL。
- 增加启动、停止、重连和指数退避。
- 将 Tunnel 状态推送给 Desktop Renderer。
- 地址变化时更新二维码和复制入口。
- 二维码接入 P2 的一次性配对码。
- 增加 Quick Tunnel 体验提示、无 SLA 提示和地址变化提示。
- 验证现有 WebSocket 实时输出和审批通过 Quick Tunnel 可用。
- 处理 Quick Tunnel 429、网络故障和用户已有 config 文件场景。

### 11.3 测试

- 三平台 cloudflared 可执行和权限测试。
- 随机地址解析测试。
- 子进程异常退出和重连测试。
- 网络断开、恢复和手动停止测试。
- 二维码过期、刷新和重复使用测试。
- 手机移动网络访问、登录、WebSocket 和审批 E2E。
- 日志中不存在 Tunnel Token、配对码和密码。

### 11.4 交付物

- Quick Tunnel 内部体验版安装包。
- 桌面二维码和 Tunnel 状态 UI。
- 体验版风险提示。
- 移动网络扫码验收记录。

### 11.5 退出门禁 G4

- 安全门禁 G2 保持通过。
- 手机使用非本机局域网网络可以完成配对和 Codex 会话操作。
- WebSocket 在 Quick Tunnel 下稳定工作。
- Quick Tunnel 明确标识为体验能力，不对外承诺稳定 SLA。

## 12. P5：云端账号与设备控制面

### 12.1 目标

交付用户注册、登录、设备绑定、设备凭证和在线心跳，为 Named Tunnel 和后台提供控制面基础。

### 12.2 任务

#### 云端基础

- 建立 Control API 和 Worker 应用。
- 建立 PostgreSQL、Redis 和数据库迁移。
- 建立 OpenAPI 和 shared-contracts 生成流程。
- 建立请求 ID、日志、指标和错误模型。

#### 用户认证

- 邮箱验证码或验证链接注册，作为默认 UI。
- 手机短信验证码注册，至少支持 `+86`。
- 密码设置、登录、刷新和退出。
- Refresh Token 哈希保存、轮换和撤销。
- 邮箱和手机号唯一性及绑定验证。
- 验证码限流、人机校验接口和防刷策略。

#### 设备

- 用户登录后注册设备。
- 生成全局唯一 device ID 和不可枚举 device code。
- 签发独立设备凭证，服务端只保存哈希。
- 客户端使用 safeStorage 保存凭证。
- 设备凭证换取短期 Device Access Token。
- 心跳、版本、在线状态和脱敏错误码上报。
- 设备名称修改、解绑和凭证撤销。

### 12.3 测试

- 邮箱验证码过期、错误和频率限制。
- 手机验证码过期、错误和频率限制。
- 重复邮箱、手机号和并发注册。
- Refresh Token 轮换、复用检测和撤销。
- 设备注册幂等性。
- 设备凭证泄漏后的撤销测试。
- 心跳在线、离线判定测试。
- 云端故障时本地模式降级测试。

### 12.4 交付物

- Control API 初版。
- Worker 和通知适配层。
- 邮箱、手机号注册登录页面。
- 设备注册、心跳和解绑。
- 开发、预发布环境部署。

### 12.5 退出门禁 G5

- 邮箱和手机号注册均可在预发布环境完成。
- 桌面端可以注册、重新登录和解绑设备。
- 设备凭证与用户 Token 相互隔离。
- 后台数据库中不存在明文密码、验证码和设备凭证。

## 13. P6：Named Tunnel 与固定域名

### 13.1 目标

交付正式稳定通道，实现 `d-<deviceCode>.xmwefun.cn` 固定域名、Cloudflare 资源创建、Token 下发、撤销和对账。

### 13.2 任务

- 建立 Cloudflare Adapter。
- 使用最小权限 API Token 调用 Tunnel 和 DNS API。
- 实现 Tunnel、Domain、Provisioning Job 数据表。
- 实现域名预留和唯一性约束。
- 创建 remotely-managed Tunnel。
- 更新 ingress 指向设备 `originPort`。
- 添加最终 `http_status:404` catch-all。
- 创建 proxied CNAME 到 `<tunnel-id>.cfargotunnel.com`。
- 获取设备专属 Tunnel Token。
- 通过设备认证接口返回 Token。
- 客户端启动 Named Tunnel 并上报连接状态。
- 实现 Token 轮换、设备停用和 Tunnel 撤销。
- 实现 Provisioning Saga 和失败补偿。
- 实现 Cloudflare 对账任务。
- 实现 originPort 变化时的配置更新流程。

### 13.3 测试

- 创建 Tunnel、更新 ingress、创建 DNS 的契约测试。
- Cloudflare 401、403、404、409、429 和 5xx 错误映射。
- 每一步失败后的幂等重试和补偿测试。
- 域名并发分配唯一性测试。
- Token 轮换和旧 Token 失效测试。
- 设备解绑后域名和 Tunnel 停用测试。
- 应用、电脑和网络重启后固定域名保持测试。
- Cloudflare 资源与数据库漂移对账测试。

### 13.4 交付物

- Named Tunnel Provisioner。
- Cloudflare Adapter。
- 固定域名正式通道。
- Token 轮换、撤销和对账任务。
- 预发布固定域名端到端验收记录。

### 13.5 退出门禁 G6

- 固定域名跨客户端重启保持不变。
- Cloudflare 账户级 Token 未进入客户端产物或日志。
- 解绑设备后旧 Token 和域名访问失效。
- Provisioning 失败不会留下对用户可见的半完成资源。

## 14. P7：运营管理后台

### 14.1 目标

交付平台运营所需的用户、设备、Tunnel、域名和审计管理能力。

### 14.2 任务

- 建立 Admin Web 和管理员认证。
- 实现 `admin`、`operator_readonly` RBAC。
- 实现数据概览。
- 实现用户查询、详情、封禁和恢复。
- 实现设备查询、详情、停用和 Token 撤销。
- 实现 Tunnel、域名状态和 Cloudflare 资源查看。
- 实现 Tunnel 重建和 Token 轮换操作。
- 所有高风险操作增加二次确认。
- 实现不可修改的审计日志。
- 邮箱、手机号、Token 和外部错误信息脱敏。
- 禁止后台提供进入用户设备并自动登录的能力。

### 14.3 测试

- RBAC 矩阵测试。
- 越权访问测试。
- 高风险操作审计测试。
- 用户封禁对设备和 Tunnel 的联动测试。
- 只读运营账号写操作拒绝测试。
- 敏感字段脱敏测试。

### 14.4 交付物

- `codex-admin.xmwefun.cn` 预发布后台。
- 用户、设备、Tunnel、域名管理页面。
- 审计日志页面。
- 管理员操作手册初版。

### 14.5 退出门禁 G7A

- 权限矩阵和审计测试通过。
- 管理后台不能访问任何本机 Codex 数据。
- 高风险操作均可追溯。

## 15. P8：套餐、权益与支付预留

### 15.1 目标

实现 Quick/Named 模式选择所需权益，以及未来支付接入所需的数据和页面边界。

### 15.2 任务

- 建立 Plan、Subscription、Entitlement、Order、Payment 表。
- 实现 Entitlement Resolver。
- 实现 `tunnel.quick`、`tunnel.named`、`device.max_count`。
- 实现管理员人工开通、延期、暂停和取消订阅。
- 记录人工变更原因和审计日志。
- 桌面端增加套餐与订阅页面。
- 展示当前套餐、权益和到期时间。
- 增加升级、续费和订单入口。
- 支付入口返回“暂未开放”。
- 建立未来支付 Adapter 接口和回调路由占位。
- 确保不生成虚假已支付记录。

### 15.3 测试

- 权益生效、过期和撤销测试。
- 设备数量上限测试。
- Quick 到 Named 切换测试。
- Named 权益到期宽限策略测试。
- 人工开通审计测试。
- 支付占位接口不产生扣款或已支付记录测试。

### 15.4 交付物

- 套餐、订阅和权益服务。
- 管理后台人工开通页面。
- 客户端套餐与支付占位页面。
- 支付 Adapter 接口定义。

### 15.5 退出门禁 G7B

- Tunnel 模式由服务端权益决定。
- 管理员可以人工开通正式权益。
- 支付功能保持不可扣款状态。

## 16. P9：多平台打包与发布

### 16.1 目标

交付可安装、可签名、可公证、可下载的 Release Candidate。

### 16.2 任务

- 配置 electron-builder。
- 配置 macOS arm64、macOS x64、Windows x64 构建矩阵。
- 将正确架构的 cloudflared 注入安装包。
- 生成第三方 License 清单。
- 验证所有原生依赖 Electron ABI。
- 配置 macOS Developer ID 签名和 Notarization。
- 配置 Windows 代码签名。
- 实现版本检查和官网下载提示。
- 建立安装、覆盖升级和卸载自动化冒烟测试。
- 验证卸载不删除 `~/.codex/sessions` 和用户项目。
- 验证用户数据目录升级兼容。
- 生成 SHA-256、版本清单和发布说明。
- 建立 `codex.xmwefun.cn` 下载页面。

### 16.3 测试矩阵

| 平台 | 安装 | 首启 | 托盘 | Quick | Named | 升级 | 卸载 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| macOS arm64 | 必测 | 必测 | 必测 | 必测 | 必测 | 必测 | 必测 |
| macOS x64 | 必测 | 必测 | 必测 | 必测 | 必测 | 必测 | 必测 |
| Windows x64 | 必测 | 必测 | 必测 | 必测 | 必测 | 必测 | 必测 |

### 16.4 交付物

- 签名和公证后的 macOS arm64 安装包。
- 签名和公证后的 macOS x64 安装包，或审核通过的 Universal 包。
- 签名后的 Windows x64 EXE。
- 下载页、校验和和发布说明。
- 安装与卸载验收记录。

### 16.5 退出门禁 G8

- 三个平台安装包签名验证通过。
- macOS 公证通过。
- 新安装和覆盖升级均不破坏用户数据。
- 安装包内不包含 Codex CLI、Cloudflare 账户 Token 或测试环境 Secret。

## 17. P10：试运行与正式发布

### 17.1 目标

通过内部 Alpha、邀请 Beta 和灰度发布验证稳定性与安全性，完成 V1 正式发布。

### 17.2 阶段发布

#### Internal Alpha

- 内部账号。
- Quick Tunnel 为主。
- 验证三平台进程、二维码和 WebSocket。

#### Invite Beta

- 少量邀请用户。
- 开通 Named Tunnel 固定域名。
- 验证邮件、短信、设备、后台和人工权益。

#### Release Candidate

- 使用正式签名安装包。
- 完成安全测试、容量测试和故障演练。
- 冻结数据库和 API 兼容变更。

#### General Availability

- 正式下载页开放。
- 逐步扩大 Named Tunnel 用户数量。
- 监控注册、Tunnel、DNS、崩溃和客服反馈。

### 17.3 任务

- 进行独立安全审查或渗透测试。
- 检查 Cookie、CSRF、Host、Origin、WebSocket 和 IPC。
- 检查日志、安装包和数据库敏感信息。
- 进行 Cloudflare API 限流和故障演练。
- 进行数据库备份恢复演练。
- 进行 Token 撤销和设备封禁演练。
- 进行邮件、短信供应商故障演练。
- 编写用户安装、Codex CLI 安装和故障排查说明。
- 编写管理员、客服和运维手册。
- 建立告警、值班和故障升级流程。
- 收集 Beta 指标并修复阻断问题。

### 17.4 GA 门禁 G9

- V1 需求验收全部通过。
- 无未处理的高危或严重安全问题。
- 关键告警、备份和恢复流程已验证。
- Quick Tunnel 页面明确体验属性。
- Named Tunnel 固定域名稳定性达到内部发布标准。
- 客服和运维能够定位本地服务、Codex、Tunnel、Cloudflare 和云端故障层级。

## 18. 阶段依赖

```text
P0 -> P1 -> P2 -> P3 -> P4
             │     │
             │     └──────────────┐
             ▼                    │
             P5 -> P6 -> P7       │
              └────> P8           │
                    │              │
                    └──────┬───────┘
                           ▼
                          P9 -> P10
```

并行建议：

- P5 云端账号与设备可以在 P1 完成后与 P2、P3 并行。
- P7 后台框架可以在 P5 后开始，Tunnel 管理页面等待 P6 接口。
- P8 套餐模型可以在 P5 数据基础完成后与 P7 并行。
- P9 构建流水线可以在 P3 先搭骨架，正式签名发布等待 P4、P6、P8 完成。

不可并行突破的门禁：

- P2 未完成，不得对真实公网启用 P4 或 P6。
- P5 未完成，不得向客户端发放 Named Tunnel Token。
- P6 未完成，不得宣称固定域名可用。
- P9 签名和安全检查未完成，不得公开发布。

## 19. 测试策略

### 19.1 单元测试

- 本地认证和配对码。
- Tunnel 状态机和日志解析。
- Codex 路径定位。
- 权益解析。
- Cloudflare 错误映射。
- Provisioning Saga。
- 管理后台权限判断。

### 19.2 集成测试

- Fastify + SQLite。
- Control API + PostgreSQL + Redis。
- Worker + 测试 Cloudflare Adapter。
- 邮件和短信 Sandbox。
- Electron Main + Utility Process。
- cloudflared 测试进程。

### 19.3 E2E

- 桌面账号注册和设备绑定。
- Quick Tunnel 扫码登录。
- Named Tunnel 固定域名登录。
- Codex 会话恢复、实时输出和审批。
- 管理员开通权益、设备获得 Named Tunnel。
- 设备解绑后访问失效。

### 19.4 安全测试

- 暴力破解和限流。
- CSRF、XSS、Host header 和 DNS rebinding。
- WebSocket 越权。
- 配对码重放和并发消费。
- Refresh Token 重放。
- 设备 Token 和 Tunnel Token 撤销。
- Electron IPC 和导航策略。
- 安装包 Secret 扫描。

### 19.5 发布测试

- 三平台干净系统安装。
- 覆盖升级和配置迁移。
- 卸载数据保留。
- 防火墙、代理和弱网。
- Finder、开始菜单和开机启动。
- Codex 未安装、路径异常和版本过低。

## 20. 数据迁移计划

现有 `.codex-manage/session-metadata.json` 迁移到本地 SQLite：

1. 启动时检测旧文件。
2. 在事务中导入备注和模型偏好。
3. 写入迁移版本和源文件哈希。
4. 校验导入数量。
5. 保留只读备份，不立即删除旧文件。
6. 多次启动保持幂等，不重复导入。
7. 迁移失败时继续使用旧存储或阻止写入，并展示诊断信息。

不得修改或迁移 `~/.codex/sessions` 原始文件。

## 21. 配置与 Secret 管理

### 21.1 客户端可公开配置

- Control API 地址。
- 产品官网和下载地址。
- 最低 Codex CLI 版本。
- cloudflared 版本清单和校验和。
- 功能开关默认值。

### 21.2 客户端 Secret

- 用户 Refresh Token。
- 设备凭证。
- Tunnel Token。

以上进入操作系统安全存储，不进入 Git、普通配置、安装包默认值或日志。

### 21.3 云端 Secret

- Cloudflare API Token、Account ID、Zone ID。
- 数据库和 Redis 凭证。
- 邮件和短信供应商密钥。
- JWT 或 Token 签名密钥。
- 管理员认证密钥。
- 未来支付渠道密钥。

全部通过部署平台 Secret Manager 注入。

## 22. 发布与回滚

### 22.1 客户端

- 发布渠道区分 `dev`、`beta`、`stable`。
- 发现严重问题时停止下载并回退下载页版本。
- 数据库迁移尽量向后兼容至少一个客户端版本。
- Tunnel 配置协议保留版本字段，旧客户端无法理解时返回明确升级要求。

### 22.2 云端

- 数据库迁移使用 expand/contract 策略。
- API 先兼容旧客户端，再发布新客户端，最后清理旧字段。
- Worker 新旧版本避免重复执行同一 Provisioning Job。
- Cloudflare 删除操作默认软停用，确认无引用后再清理资源。

## 23. 项目管理和审核机制

### 23.1 每阶段评审

- 需求覆盖评审。
- 架构偏差评审。
- 安全评审。
- 测试结果评审。
- 发布或进入下一阶段批准。

### 23.2 Definition of Done

每个功能只有同时满足以下条件才算完成：

- 代码实现和代码审查完成。
- 类型检查、单元测试和相关 E2E 通过。
- 安全和隐私要求验证通过。
- 错误状态和诊断信息完整。
- 文档、配置和迁移说明更新。
- 无明文 Secret、临时调试后门和未处理高风险日志。

### 23.3 变更控制

以下变更必须更新需求或 ADR 后实施：

- 将 Quick Tunnel 改为正式服务承诺。
- 改用多级设备域名。
- 在客户端内置 Codex CLI。
- 接入真实支付。
- 向云端上传 Codex 会话或命令数据。
- 允许管理员远程控制用户本机 Codex。

## 24. 计划审核结论

实施计划已完成以下审核：

- 所有 V1 需求均有对应实施阶段。
- 安全改造位于 Tunnel 之前，不存在先暴露后补安全的路径。
- Quick Tunnel 和 Named Tunnel 的产品定位及技术依赖已分离。
- 用户、设备、Tunnel、后台和权益阶段依赖闭合。
- macOS 双架构和 Windows x64 均有构建与验收任务。
- Codex CLI 不进入安装包，但有完整检测与引导计划。
- 支付只做预留，没有真实扣款路径。
- 当前 Web MVP 有持续回归门禁和数据迁移方案。

审核结果：计划可执行，可以从 P0 和 P1 开始实施。
