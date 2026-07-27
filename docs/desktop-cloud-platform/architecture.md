# Codex Manage 桌面与云平台总体技术架构

## 1. 文档信息

- 文档版本：V1.0
- 文档状态：已完成架构审核
- 审核日期：2026-07-21
- 需求依据：[桌面端、内网穿透与运营后台需求文档](./requirements.md)
- 适用范围：Desktop & Cloud Platform V1

## 2. 架构结论

V1 采用“本机数据面 + 云端控制面”架构：

- Codex 会话、命令、审批和项目文件始终留在用户电脑。
- Electron 桌面客户端负责本地进程、cloudflared、账号凭证、二维码和托盘生命周期。
- 现有 Fastify + React 应用演进为本地 Codex Manage 服务，通过 loopback 提供 Web 页面和 API。
- Cloudflare Tunnel 只负责将本机服务安全映射到公网。
- 云端控制服务只管理用户、设备、域名、Tunnel、权益和运营数据，不代理 Codex 指令。
- V1 云端采用模块化单体加异步 Worker，不提前拆分微服务。
- 正式稳定访问使用 remotely-managed Named Tunnel；Quick Tunnel 仅作为免费体验和故障诊断通道。

## 3. 架构审核结论

### 3.1 审核结果

架构已按以下维度完成审核：

- 现有 React、Fastify、Codex app-server 代码可复用性。
- macOS arm64、macOS x64、Windows x64 打包可行性。
- Cloudflare Tunnel API、DNS 路由和 Tunnel Token 权限边界。
- Quick Tunnel 限制与现有 WebSocket 实时通道兼容性。
- 本地高权限 Codex 能力的公网认证安全。
- 用户、设备、Tunnel、域名和权益数据一致性。
- 分阶段迁移对现有 79 个测试用例和 Web MVP 的影响。

审核结论为“可实施”，但以下修正必须作为实施门禁。

### 3.2 审核修正一：域名层级

原需求建议使用 `d-设备码.codex.xmwefun.cn`。Cloudflare 官方说明，多级子域名发布可能需要 Advanced Certificate。为避免 V1 增加证书产品和额外成本，域名调整为单级子域名：

| 用途 | V1 域名 |
| --- | --- |
| 桌面更新入口 | `codex-api.xmwefun.cn/updates/stable` |
| 云端控制 API | `codex-api.xmwefun.cn` |
| 管理后台 | `codex-admin.xmwefun.cn` |
| 设备固定域名 | `d-<设备短码>.xmwefun.cn` |

`codex.xmwefun.cn` 已被其他客户使用，不得作为 Codex Manage 桌面更新源。如果后续希望统一到 `*.codex.xmwefun.cn`，需先确认域名归属并配置覆盖该层级的高级证书。

### 3.3 审核修正二：Quick Tunnel 定位

Cloudflare 官方将 Quick Tunnel 定位为测试和开发用途，不承诺 SLA，并存在并发请求上限和不支持 SSE 等限制。因此：

- Quick Tunnel 在产品中命名为“体验通道”。
- 页面明确提示地址可能变化、无稳定性承诺。
- 不以 Quick Tunnel 作为正式付费或长期稳定服务的交付依据。
- 现有实时传输继续使用 WebSocket，不切换为 SSE。
- 正式用户和需要稳定访问的用户使用 Named Tunnel。

### 3.4 审核修正三：公网开放顺序

现有单默认密码、随机 session secret、`secure: false` Cookie 和 `0.0.0.0` 监听不满足公网开放要求。任何 Tunnel 功能启用前，必须先完成本地认证和 loopback 安全改造。

## 4. 架构原则

### 4.1 本地优先

- Codex 运行时和用户数据只存在本机。
- 云端故障不能阻止用户通过 localhost 使用 Codex Manage。
- 云端不设计命令转发、会话同步或远程执行接口。

### 4.2 最小权限

- 客户端只获得本设备 Tunnel Token。
- Cloudflare 账户 API Token 只存在云端 Secret Manager。
- 管理员后台不能访问用户本机服务。
- Electron Renderer 不获得 Node.js、文件系统或进程管理权限。

### 4.3 安全先于穿透

- 完成本地身份认证、配对码、会话撤销、限流和 Host 校验后，才允许打开公网 Tunnel。
- 公网访问和桌面控制面使用不同的认证边界。

### 4.4 渐进迁移

- 保留现有 Web MVP 和测试基线。
- 先将 Fastify 启动入口重构成可嵌入服务，再接入 Electron。
- 不在第一阶段一次性重写现有 Codex 会话管理代码。

### 4.5 可恢复和幂等

- 设备注册、Tunnel 创建、DNS 绑定、Token 轮换均必须支持幂等重试。
- 云端状态以数据库为业务真相，Cloudflare 为外部资源状态，使用对账任务消除漂移。

## 5. 总体架构图

```text
┌──────────────────────────── 用户电脑 ────────────────────────────┐
│                                                                  │
│  Electron Desktop                                                │
│  ├─ Main Process                                                 │
│  │  ├─ AppLifecycleManager                                       │
│  │  ├─ LocalServiceSupervisor ───────┐                           │
│  │  ├─ TunnelSupervisor              │                           │
│  │  ├─ CodexLocator                  │                           │
│  │  ├─ SecureCredentialStore         │                           │
│  │  └─ Tray / IPC / Diagnostics      │                           │
│  │                                   ▼                           │
│  ├─ Desktop Renderer          Local Web Utility Process          │
│  │  └─ 账号、状态、二维码      ├─ Fastify API                     │
│  │                            ├─ React Web/H5                    │
│  │                            ├─ LocalAuthService                │
│  │                            ├─ Codex app-server client         │
│  │                            └─ Local SQLite                    │
│  │                                   │                           │
│  └─ cloudflared native process ──────┼─ http://127.0.0.1:PORT    │
│                                      │                           │
│                               Codex CLI / ~/.codex/sessions      │
└──────────────────────────────────────┼───────────────────────────┘
                                       │ outbound Tunnel
                                       ▼
                              Cloudflare Edge / DNS
                                       │
                         https://d-xxxx.xmwefun.cn
                                       │
                                       ▼
                                  手机浏览器

┌──────────────────────────── 云端控制面 ──────────────────────────┐
│  Control API      Worker/Reconciler       Admin Web              │
│  ├─ Auth          ├─ Email/SMS jobs       ├─ 用户                │
│  ├─ Devices       ├─ Tunnel provisioning ├─ 设备                │
│  ├─ Tunnels       ├─ DNS reconciliation  ├─ Tunnel/域名         │
│  ├─ Entitlements  └─ Expiry jobs          └─ 套餐/审计           │
│  ├─ Audit                                                       │
│  └─ PostgreSQL + Redis + Secret Manager                          │
└──────────────────────────────────────────────────────────────────┘
```

## 6. 运行时边界

### 6.1 Electron Main Process

Main Process 是桌面应用的唯一系统权限入口，负责：

- 创建和销毁 BrowserWindow。
- 启动、监控和停止本地 Web Utility Process。
- 启动、监控和停止 cloudflared 原生进程。
- 使用操作系统安全存储保存账号和设备凭证。
- 管理托盘、开机启动、版本信息和诊断日志。
- 向 Renderer 暴露经过白名单约束的 IPC 方法。

Main Process 不承载 Codex 业务 API，避免本地 Web 请求阻塞桌面生命周期。

### 6.2 Desktop Renderer

Desktop Renderer 负责桌面控制台 UI：

- 账号注册、登录和退出。
- 设备名称和设备绑定状态。
- Codex CLI 检测状态。
- 本地服务和 Tunnel 状态。
- 地址、二维码、套餐和诊断展示。
- 启动、停止、重连、复制地址和打开 Codex Manage。

安全配置：

- `contextIsolation: true`。
- `nodeIntegration: false`。
- Renderer sandbox 开启。
- Preload 仅暴露固定类型 IPC，不暴露通用 `invoke`、shell 或文件 API。
- 禁止加载未在白名单中的远程页面到具有 Preload 权限的窗口。

### 6.3 Local Web Utility Process

现有 Fastify 服务迁移到独立 Utility Process，职责包括：

- 提供 Codex Manage Web/H5 静态页面。
- 管理 Codex app-server。
- 读取 `~/.codex/sessions`。
- 处理会话、模型、命令和审批。
- 提供本地密码登录和一次性二维码配对。
- 保存本地会话、授权设备和元数据。

Utility Process 只监听 loopback，不监听 `0.0.0.0`。

### 6.4 cloudflared Process

cloudflared 由 Main Process 作为普通子进程管理，不安装为系统服务：

- 二进制放在 ASAR 外部资源目录。
- 使用应用发布版本统一升级，禁用 cloudflared 自更新。
- 使用 JSON 日志格式并进行结构化解析。
- Token 通过进程输入或临时受限配置传递，不出现在普通日志。
- 退出时由 Supervisor 回收，避免遗留孤儿进程。

## 7. 代码仓库架构

目标结构：

```text
codex-manage/
├── apps/
│   ├── desktop/
│   │   ├── src/main/
│   │   ├── src/preload/
│   │   └── src/renderer/
│   ├── local-web/
│   │   ├── src/server/
│   │   └── src/client/
│   ├── control-api/
│   └── admin-web/
├── packages/
│   ├── shared-contracts/
│   ├── local-auth/
│   ├── tunnel-client/
│   ├── cloudflare-adapter/
│   ├── notification-adapters/
│   └── observability/
├── resources/cloudflared/
├── tooling/
└── docs/desktop-cloud-platform/
```

迁移采用渐进方式：

1. 根目录现有 `src/server` 和 `src/client` 保持可运行。
2. 先抽取 `createLocalWebApp()` 和 `startLocalWebServer()`。
3. 再移动到 `apps/local-web`，使用兼容脚本保持原命令可用。
4. 共享类型迁移到 `packages/shared-contracts`。
5. 云端和桌面应用在新目录独立构建。

包管理建议迁移为 npm workspaces。V1 不要求引入复杂构建平台；当构建耗时明显增加后再评估 Turborepo 或 Nx。

## 8. 现有本地服务改造

### 8.1 启动入口

当前 `src/server/index.ts` 在模块加载时直接创建 Fastify、启动 Codex app-server 并监听端口。需拆分为：

- `createLocalWebApp(config, dependencies)`：创建并注册路由，不监听端口。
- `LocalWebRuntime.start()`：启动 Codex app-server。
- `LocalWebRuntime.stop()`：关闭 Codex app-server 和其他资源。
- `startLocalWebServer(options)`：监听 loopback 并返回实际端口和关闭句柄。

这样可以同时支持 CLI 开发启动、自动化测试和 Electron Utility Process 嵌入。

### 8.2 配置目录

当前元数据默认基于 `process.cwd()`，桌面打包后不可依赖工作目录。桌面版统一使用 Electron `app.getPath("userData")` 派生目录：

```text
<userData>/
├── config.json
├── local.db
├── logs/
├── runtime/
└── tunnel/
```

Codex 原生数据仍位于用户的 `~/.codex`，不迁移到应用目录。

### 8.3 监听策略

- 默认监听 `127.0.0.1`。
- 首次启动选择可用端口并持久化为 `originPort`。
- 后续优先复用同一端口。
- 端口冲突时不静默切换正式 Named Tunnel 的 origin，先停止 Tunnel，再更新远端 ingress 配置后恢复。
- Quick Tunnel 可以直接使用当前实际端口启动。

### 8.4 Codex CLI 定位

图形应用启动时通常不继承用户终端 PATH，需提供 `CodexLocator`：

1. 检查用户保存的绝对路径。
2. 检查应用进程 PATH。
3. 检查 macOS 常见路径，如 `/opt/homebrew/bin/codex`、`/usr/local/bin/codex`。
4. 检查 Windows PATH 和常见 npm 全局安装目录。
5. 可使用固定、无用户输入的登录 shell 探测命令作为补充。
6. 允许用户通过文件选择器指定可执行文件。

所有进程启动使用参数数组，不拼接用户输入形成 shell 命令。

## 9. 本地身份与扫码授权架构

### 9.1 双身份体系

平台账号和本机 Codex 访问必须分离：

- 平台账号：管理设备、域名、Tunnel 和权益。
- 本机身份：控制谁能查看 Codex 会话和执行本机操作。

用户登录平台账号不等于自动获得本机 Codex 管理权限。远程手机必须通过本机密码或本机一次性配对码授权。

### 9.2 本地凭证

- 本机访问密码使用 Argon2id 或等效自适应算法保存哈希。
- 首次启用 Tunnel 前必须设置密码。
- 不再使用固定默认密码作为桌面公网模式凭证。
- 本地 session secret 必须持久化，不能每次启动随机变化。

### 9.3 本地会话

使用本地 SQLite 保存：

- 登录 Session ID 的哈希。
- Session 创建时间和过期时间。
- 授权来源：密码、二维码或桌面本机。
- 设备名称或浏览器摘要。
- 撤销时间。
- 全局 session epoch，用于“退出所有设备”。

浏览器只保存随机 Session Cookie，不在 Cookie 中保存权限数据。

### 9.4 配对码

- 配对码由本机生成，使用至少 256 bit 安全随机值。
- 本地只保存配对码哈希。
- 默认 5 分钟失效、一次使用、原子消费。
- 二维码通过 URL Fragment 携带配对码。
- `POST /api/local-auth/pair` 是未登录可访问的有限接口，单独限流。
- 配对成功后清理地址栏 Fragment 并签发远程安全 Cookie。

### 9.5 Cookie 与请求安全

- Tunnel HTTPS 请求签发 `Secure; HttpOnly; SameSite=Lax` Cookie。
- 本地 loopback 桌面访问使用独立的桌面启动令牌或本地 Session，不复用公网 Cookie 假设。
- 所有状态修改接口使用 CSRF Token 或双提交 Cookie。
- Fastify `trustProxy` 只信任 loopback cloudflared 连接，不信任任意来源的转发头。
- 校验 Host 必须是 localhost、loopback 或当前设备已分配域名，阻止 DNS rebinding。
- WebSocket 握手执行相同的 Host、Origin 和 Session 校验。

## 10. Tunnel 客户端架构

### 10.1 TunnelSupervisor

`TunnelSupervisor` 提供统一状态机和接口：

```text
unconfigured
  -> preparing
  -> starting
  -> online
  -> reconnecting
  -> stopped
  -> revoked
  -> failed
```

主要职责：

- 根据权益选择 Quick 或 Named 模式。
- 生成隔离的 cloudflared 运行参数。
- 启动和停止子进程。
- 解析结构化日志和公网地址。
- 执行指数退避重连。
- 发布状态给 Desktop Renderer。
- 将脱敏状态上报云端。

### 10.2 Quick Tunnel

启动逻辑等价于：

```text
cloudflared tunnel --url http://127.0.0.1:<originPort>
```

实现要求：

- 使用应用专属 HOME 或配置目录，避免用户已有 `.cloudflared/config.yaml` 影响 Quick Tunnel。
- 解析 cloudflared 输出的随机 `trycloudflare.com` URL。
- URL 变化时刷新二维码并上报后台。
- 使用 `--no-autoupdate`，由桌面安装包控制版本。
- 明确显示“体验通道、地址可能变化、无 SLA”。
- 对 429、网络不可达和配置冲突提供稳定错误码。

### 10.3 Named Tunnel

云端为每台正式设备创建一个 remotely-managed Tunnel：

1. Control API 创建 Tunnel，配置源为 Cloudflare。
2. Cloudflare Adapter 更新 ingress：设备域名指向 `http://127.0.0.1:<originPort>`。
3. ingress 末尾必须包含 `http_status:404` catch-all。
4. 创建 proxied CNAME，将设备域名指向 `<tunnel-id>.cfargotunnel.com`。
5. Control API 通过设备认证返回该 Tunnel 的运行 Token。
6. 客户端运行 cloudflared 并监控连接状态。

客户端永远不接收 Cloudflare 账户 API Token、Account ID 写权限凭证或 Zone DNS 写权限凭证。

### 10.4 Token 处理

- Tunnel Token 只通过经过设备认证的 HTTPS API 返回。
- 云端优先按需从 Cloudflare Token API 获取，不在普通业务表中保存明文。
- 如需缓存，使用 KMS 或 Secret Manager 加密，并设置短缓存期。
- 客户端保存在操作系统安全存储或受限内存中，不写普通日志和配置文件。
- 设备解绑、封禁或 Token 轮换时，旧 Token 必须失效。

### 10.5 二进制供应链

- 为 darwin-arm64、darwin-x64、win32-x64 分别维护版本清单。
- 构建时校验 cloudflared SHA-256。
- 二进制放在 `resources` 并设置正确执行权限。
- 安装包包含 Cloudflare License 和第三方软件声明。
- 不允许运行时从未知地址自动下载或替换 cloudflared。

## 11. 云端控制面架构

### 11.1 技术形态

V1 采用模块化单体：

- TypeScript + Fastify Control API。
- PostgreSQL 作为业务数据库。
- Redis 用于验证码、限流、短期状态和队列协调。
- 独立 Worker 处理邮件、短信、Tunnel 创建、DNS 操作、权益过期和对账。
- React + Vite 管理后台。
- OpenAPI 生成客户端类型，与 `shared-contracts` 对齐。

模块化单体可以在 V1 保持事务一致性和部署简单度，后续按负载将 Notification、Tunnel Provisioner 或 Billing 独立拆分。

### 11.2 业务模块

```text
AuthModule
├─ EmailVerification
├─ PhoneVerification
├─ PasswordCredential
└─ TokenRotation

DeviceModule
├─ DeviceRegistration
├─ DeviceCredential
├─ Heartbeat
└─ DeviceRevocation

TunnelModule
├─ QuickTunnelReport
├─ NamedTunnelProvisioning
├─ DomainAllocation
├─ TokenIssuance
└─ Reconciliation

EntitlementModule
├─ Plans
├─ Subscriptions
├─ Entitlements
└─ ManualGrant

AdminModule
├─ RBAC
├─ Operations
└─ AuditLog
```

### 11.3 认证模型

- 用户 Access Token：短期有效，用于桌面账号操作。
- 用户 Refresh Token：随机不透明值，服务端保存哈希并轮换。
- 设备凭证：注册设备时单独签发，服务端保存哈希。
- 设备 Access Token：设备凭证换取的短期 Token，用于心跳和 Tunnel 配置。
- 管理员 Session：与普通用户认证体系隔离，启用更严格的 MFA 预留。

桌面端使用 Electron `safeStorage`，底层由 macOS Keychain 或 Windows 系统保护能力保存 Refresh Token 和设备凭证。

### 11.4 邮件与短信

- Notification Adapter 定义统一发送接口。
- 邮箱是默认注册方式。
- 手机验证码至少支持 `+86`。
- 验证码保存在 Redis，只保存哈希、用途、过期时间和失败次数。
- 发送任务进入队列，接口不等待供应商完整发送过程。
- 供应商错误映射为内部稳定错误码。

## 12. Cloudflare Adapter

### 12.1 权限

Cloudflare API Token 最小需要：

- Account / Cloudflare Tunnel / Edit。
- Zone / DNS / Edit，仅限 `xmwefun.cn` Zone。

生产和测试使用不同 Token、账户资源前缀和数据库环境。

### 12.2 资源命名

- Tunnel 名称：`codex-device-<deviceCode>`。
- DNS 名称：`d-<deviceCode>.xmwefun.cn`。
- 外部资源 ID 全部记录在数据库，禁止通过名称猜测作为唯一关联方式。

### 12.3 Provisioning Saga

Named Tunnel 创建不是单数据库事务，采用可恢复 Saga：

1. 数据库创建 `provisioning` 记录并预留域名。
2. Worker 创建 Cloudflare Tunnel。
3. Worker 写入 ingress 配置。
4. Worker 创建 DNS CNAME。
5. Worker验证资源状态。
6. 数据库切换为 `active`。

任一步失败：

- 记录失败步骤和可重试错误码。
- 可安全重试已完成步骤。
- 无法恢复时执行补偿，删除未投入使用的 DNS 和 Tunnel。
- 不将半完成资源暴露给客户端。

### 12.4 对账

定时 Reconciler 检查：

- 数据库 active Tunnel 是否仍存在。
- DNS CNAME 是否指向正确 Tunnel。
- 域名是否重复绑定。
- 被撤销设备是否仍有活动连接。
- Cloudflare 状态与最近心跳是否冲突。

对账任务只自动修复明确幂等的差异，高风险删除交由管理员确认。

## 13. 数据架构

### 13.1 云端 PostgreSQL

主要关系：

```text
users 1 ── N devices
users 1 ── N user_identities
users 1 ── N subscriptions
devices 1 ── 1 active_tunnel
tunnels 1 ── N domain_history
plans 1 ── N subscriptions
subscriptions 1 ── N entitlements
admin_users 1 ── N audit_logs
```

关键约束：

- 已验证邮箱全局唯一。
- 已验证手机号和国家区号组合全局唯一。
- `device_code` 全局唯一。
- active 域名全局唯一。
- 每台设备同时最多一个 active Named Tunnel。
- 人工权益变更必须关联操作者和审计记录。

### 13.2 本地 SQLite

本地数据库只保存本机应用数据：

- 会话备注和模型偏好迁移数据。
- 本机密码哈希和认证配置。
- 浏览器登录 Session。
- 一次性配对码哈希和消费状态。
- 已授权浏览器摘要。
- 设备绑定的非敏感缓存。
- Tunnel 状态快照和诊断事件。

平台 Refresh Token、设备凭证和 Tunnel Token 优先进入 OS 安全存储，不进入普通 SQLite 字段。

### 13.3 数据保留

- 设备最新状态保留在主表。
- 原始心跳只短期保留，之后按小时或天聚合。
- 验证码过期后自动删除。
- Quick Tunnel 历史地址设置保留期限。
- 审计日志按合规要求长期保留且不可由普通管理员修改。

## 14. API 架构

### 14.1 云端 API

统一使用 `/v1` 版本前缀，主要资源：

```text
POST /v1/auth/email/codes
POST /v1/auth/email/register
POST /v1/auth/phone/codes
POST /v1/auth/phone/register
POST /v1/auth/login
POST /v1/auth/refresh
POST /v1/auth/logout

POST /v1/devices
GET  /v1/devices
PATCH /v1/devices/:deviceId
POST /v1/devices/:deviceId/credential/exchange
POST /v1/devices/:deviceId/heartbeat
POST /v1/devices/:deviceId/revoke

GET  /v1/devices/:deviceId/tunnel-config
POST /v1/devices/:deviceId/quick-tunnel
POST /v1/devices/:deviceId/named-tunnel/provision
POST /v1/devices/:deviceId/named-tunnel/token/rotate

GET  /v1/plans
GET  /v1/subscription
GET  /v1/entitlements
GET  /v1/orders
```

支付创建接口在 V1 返回稳定的“暂未开放”业务码，不产生已支付订单。

### 14.2 本地 API

现有会话 API 保持兼容，并新增：

```text
POST /api/local-auth/setup
POST /api/local-auth/login
POST /api/local-auth/pair
POST /api/local-auth/logout
POST /api/local-auth/logout-all
GET  /api/local-auth/sessions
DELETE /api/local-auth/sessions/:sessionId
POST /api/local-auth/pairing-code

GET  /api/desktop/status
GET  /api/tunnel/public-info
```

本地 API 不直接接受云端管理员指令。

### 14.3 错误模型

桌面、本地和云端共享错误结构：

```json
{
  "error": {
    "code": "TUNNEL_TOKEN_REVOKED",
    "message": "设备通道授权已失效",
    "requestId": "...",
    "retryable": false
  }
}
```

错误码稳定，`message` 可本地化；内部供应商错误和敏感地址不直接返回客户端。

## 15. 权益架构

### 15.1 决策点

客户端启动 Tunnel 前调用 Entitlement Resolver：

```text
if tunnel.named == true:
    使用 Named Tunnel
else if tunnel.quick == true:
    使用 Quick Tunnel 体验通道
else:
    不启动公网通道
```

### 15.2 缓存和降级

- 权益结果带签名、版本和到期时间。
- 客户端短期缓存最近一次有效权益。
- 云端短时不可用时，已运行 Named Tunnel 不立即中断。
- 到期或撤销后的宽限策略由服务端配置，客户端不能自行延长。
- 管理员人工开通与未来支付开通走同一 Subscription/Entitlement 体系。

## 16. 管理后台架构

- 独立部署于 `codex-admin.xmwefun.cn`。
- 只调用 Control API 管理接口。
- 管理员身份与普通用户身份分表或分认证域。
- 使用 RBAC：`admin`、`operator_readonly`。
- 高风险操作要求二次确认并写审计日志。
- Token 撤销、设备停用、用户封禁和人工权益变更为高风险操作。
- 不提供跳转用户设备公网域名并自动登录的后门。

## 17. 安全架构

### 17.1 信任边界

```text
不可信：公网浏览器、Tunnel 请求、Renderer 输入、Cloudflare 日志、邮件短信回调
半可信：已登录平台用户、已注册设备
高可信：Electron Main、Local Web loopback、云端 Worker、Secret Manager
```

### 17.2 主要威胁与控制

| 威胁 | 控制措施 |
| --- | --- |
| 公网暴力破解 | 限流、验证码、失败锁定、强密码 |
| 二维码泄漏 | Fragment、短有效期、一次使用、原子消费 |
| DNS rebinding | Host allowlist、Origin 校验、loopback 监听 |
| Cookie 劫持 | HTTPS、Secure、HttpOnly、Session 撤销 |
| CSRF | CSRF Token、SameSite、Origin 校验 |
| Renderer 被注入 | CSP、sandbox、contextIsolation、最小 IPC |
| Tunnel Token 泄漏 | 不写日志、OS 安全存储、可轮换和撤销 |
| Cloudflare API Token 泄漏 | 云端 Secret Manager、最小权限、环境隔离 |
| 管理员越权 | RBAC、审计、二次确认、无本机控制接口 |
| 供应链篡改 | cloudflared 校验和、签名安装包、固定来源 |

### 17.3 安全发布门禁

首次对公网试用前必须通过：

- 本地认证和二维码配对单元测试。
- Host、Origin、CSRF、Cookie 和 WebSocket 鉴权测试。
- Tunnel Token 日志扫描。
- Electron IPC 白名单检查。
- 依赖漏洞扫描和安装包签名检查。
- 外部渗透测试或独立安全评审。

## 18. 可用性与故障处理

### 18.1 故障隔离

UI 分别展示：

- Codex CLI 状态。
- 本地 Web 服务状态。
- 云端账号状态。
- Tunnel 状态。
- Cloudflare 资源状态。

某一层故障不能笼统显示为“系统异常”。

### 18.2 重试策略

- 本地服务：有限次数快速重启，之后停止并提示。
- cloudflared：指数退避并加入抖动。
- 云端 API：只对幂等请求自动重试。
- Tunnel Provisioning：由 Worker 按步骤重试。
- 邮件短信：有限次数重试，避免重复发送风暴。

### 18.3 离线模式

- 无互联网时允许 localhost 使用现有 Codex Manage。
- 无云端时不能注册新设备或新建 Named Tunnel。
- 已缓存配置和未撤销 Token 可以继续尝试恢复既有 Named Tunnel。
- Quick Tunnel 依赖互联网，失败时不影响本地服务。

## 19. 可观测性

### 19.1 客户端

- 结构化本地日志，按天和大小滚动。
- 日志字段包含组件、状态、错误码、版本和时间。
- 导出诊断包前进行 Token、邮箱、手机号、路径和 URL 脱敏。
- V1 默认不上传完整客户端日志，仅上报错误码和版本摘要。

### 19.2 云端

- 请求 ID 贯穿 API、Worker 和 Cloudflare Adapter。
- 指标包含注册成功率、验证码发送率、设备在线数、Tunnel 创建成功率、DNS 失败率和 Token 轮换失败率。
- 对 Cloudflare API 429、5xx 和权限错误设置独立告警。
- 对账发现域名/Tunnel 漂移时告警。

## 20. 构建和发布架构

### 20.1 构建矩阵

```text
macOS arm64  -> Electron + cloudflared-darwin-arm64
macOS x64    -> Electron + cloudflared-darwin-amd64
Windows x64  -> Electron + cloudflared-windows-amd64.exe
```

### 20.2 打包工具

推荐使用 electron-builder：

- macOS 输出 DMG。
- Windows 输出 NSIS EXE。
- cloudflared 配置为 extraResources，不打入 ASAR。
- 本地 Web 前端和服务端进入应用资源目录。
- 如果引入 SQLite 原生模块，CI 必须按 Electron ABI 和目标架构重建。

### 20.3 发布流水线

1. 安装依赖和锁文件校验。
2. 类型检查、单元测试和 Web E2E。
3. 构建四个应用和共享包。
4. 校验 cloudflared 版本与 SHA-256。
5. 构建目标安装包。
6. macOS 签名、公证和 stapling。
7. Windows 签名。
8. 安装、启动、升级和卸载冒烟测试。
9. 生成 SHA-256、版本清单和发布说明。
10. 上传官网下载存储。

V1 可以先提供版本检查和下载提示，自动更新作为后续增强；签名和公证不应因为暂不自动更新而省略。

## 21. 云端部署架构

V1 推荐最小生产拓扑：

```text
Cloudflare DNS/WAF
        │
        ├─ codex-api.xmwefun.cn   -> Control API
        ├─ codex-admin.xmwefun.cn -> Admin Web
        └─ codex.xmwefun.cn       -> 官网/下载

Control API ── PostgreSQL
      │       └─ automated backup
      ├────── Redis
      ├────── Worker
      └────── Secret Manager
```

测试、预发布和生产环境使用不同数据库、Redis、Cloudflare Token、邮件短信配置和域名前缀。

## 22. 架构决策记录

| 决策 | 结论 | 理由 |
| --- | --- | --- |
| 桌面框架 | Electron | 最大化复用 Node/Fastify/React |
| 本地服务进程 | Utility Process | 隔离主进程和业务服务 |
| 云端形态 | 模块化单体 + Worker | V1 事务简单、部署成本低 |
| 云端数据库 | PostgreSQL | 关系约束和运营查询适合 |
| 短期状态 | Redis | 验证码、限流、任务协调 |
| 本地数据库 | SQLite | 本机会话撤销和配置可靠 |
| 正式通道 | Named Tunnel | 固定域名、可管理、适合生产 |
| 体验通道 | Quick Tunnel | 零账号试用，但明确非生产 |
| 设备域名 | `d-xxx.xmwefun.cn` | 避免多级子域名证书成本 |
| 实时协议 | WebSocket | 已有实现，Quick Tunnel 不支持 SSE |
| Codex CLI | 外部检测 | 暂不随安装包分发 |
| 支付 | 接口和模型预留 | V1 不产生真实扣款 |

## 23. 架构验收标准

- 架构覆盖需求文档全部 V1 功能范围。
- 云端不存在 Codex 会话或命令上传链路。
- 公网 Tunnel 启用前存在强制安全门禁。
- Electron Renderer 无 Node.js 和通用系统权限。
- 本地服务默认只监听 loopback。
- Quick 与 Named Tunnel 使用统一状态机但隔离配置。
- Named Tunnel 创建、DNS 配置和撤销支持幂等重试。
- Cloudflare 账户 API Token 不下发客户端。
- macOS 双架构和 Windows x64 有独立构建产物。
- 现有 Web 测试基线可在迁移期间持续运行。

## 24. 外部技术依据

- Cloudflare Create a tunnel (API)：`https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel-api/`
- Cloudflare Quick Tunnels：`https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/`

官方机制核对结论：

- 创建远程管理 Tunnel 需要 Cloudflare Tunnel Edit 权限。
- 发布公网 hostname 需要 Zone DNS Edit 权限。
- ingress 必须包含最终 catch-all 规则。
- DNS CNAME 指向 `<tunnel-id>.cfargotunnel.com`。
- Tunnel 可以通过专属 Token 运行。
- Quick Tunnel 仅适合测试体验，无 SLA，存在并发限制且不支持 SSE。
