# Codex Manage Desktop & Cloud Platform 实施状态

## 1. 文档信息

- 记录日期：2026-07-29
- 对应需求版本：V1.1
- 对应架构版本：V1.0
- 对应实施计划版本：V1.0
- 当前结论：核心代码已完成，Windows 启动、远程通道和会话展示补丁已合入；支付首版代码已完成，待微信/支付宝商户参数联调、生产套餐价格配置和小额真实订单验收

## 2. 阶段状态

| 阶段 | 状态 | 已完成内容 | 剩余门禁 |
| --- | --- | --- | --- |
| P0 外部资源 | 部分完成 | 域名、技术栈、Secret 清单与 CI 骨架已确定 | Cloudflare 正式凭证、邮件/短信供应商、签名证书、生产部署环境 |
| P1 本地服务 | 已完成 | Fastify App Factory、显式生命周期、桌面入口、用户数据目录、兼容原 Web 模式 | 无代码阻断 |
| P2 公网安全 | 已完成 | loopback、SQLite、scrypt、本地 Session、二维码配对、Host/Origin、限流、WebSocket 鉴权、CSP | 独立安全审查仍建议在公开发布前执行 |
| P3 Electron | 已完成 | Main/Preload/Renderer 隔离、托盘、开机启动、本地服务重启、安全存储、诊断导出、Codex 检测 | Electron 更新、问题反馈与自动上报、macOS arm64、Windows x64 实机验收 |
| P4 Quick Tunnel | 已完成 | cloudflared 管理、随机地址解析、退避重连、一次性二维码、Token 文件传递、心跳记录 | 手机真实移动网络与弱网长时间测试 |
| P5 账号与设备 | 已完成单实例 V1 | 邮箱/手机号验证码注册、登录、刷新轮换、密码重置、身份绑定/解绑、设备注册/解绑、凭证和心跳 | 真实邮件/短信供应商联调；多实例限流需接 Redis |
| P6 Named Tunnel | 已完成代码 | Named Tunnel、ingress、DNS、Token、Provisioning Job、重试、崩溃任务回收、封禁竞态补偿 | 真实 Cloudflare Zone 端到端验收和对账演练 |
| P7 管理后台 | 已完成 V1 | 管理员登录、RBAC、概览、用户/设备/Tunnel/域名/订阅/订单/支付/审计查询、人工开通、停用恢复、敏感账号脱敏 | 问题上报列表和处理流程、生产数据量下的分页和运营流程验收 |
| P8 权益与支付 | 首版已完成 | 通用支付模块、`billing_` 表、微信/支付宝 Provider、订单/支付/回调/退款预留接口、桌面二维码支付、后台套餐配置和回调日志；上线准备清单见 `docs/desktop-cloud-platform/payment-production-readiness.md` | 微信/支付宝商户参数联调、生产价格配置、小额真实订单验收 |
| P9 多平台发布 | 部分完成 | electron-builder、三平台 CI、cloudflared SHA 校验、版本注入、校验和生成、macOS x64 DMG、Electron 更新需求变更单 | Electron 更新设计实现、arm64/Windows 构建与实机、Developer ID、公证、Windows 签名 |
| P10 正式发布 | 未开始 | 已具备内部 Alpha 基础 | 安全审查、备份恢复、告警、灰度、客服与运维流程 |

## 3. 2026-07-23 至 2026-07-24 桌面补丁

- Windows Codex CLI 定位优先完整 `.cmd` 路径，并兼容 Node/Electron 对 `.cmd` 的启动差异。
- 本地服务启动失败时保留并抛出原始错误，减少只有 `Codex app-server is not ready` 的模糊诊断。
- 启动失败和退出路径补充 app-server 清理，降低孤儿进程导致的下次启动失败。
- 正式权益用户启动远程通道时，如果云端仍返回 Quick Tunnel，会自动 provision Named Tunnel 后再使用专属域名。
- 云端控制 API `500`、`503` 临时错误和 `desktop:start-tunnel` 首次启动失败增加短重试。
- Windows 托盘增加双击恢复主窗口；macOS 托盘行为保持不变。
- iPhone 扫码面板增加“添加到主屏幕”指引，用于生成桌面入口标签。
- 会话列表增加 `thread/list` 分页扫描，搜索覆盖后续页；会话详情和前端选中逻辑兼容 `id` 与 `sessionId`。

## 4. 当前已知缺口

- 外部执行 `cc switch` 后，当前应用内已运行的 `codex app-server` 不会自动读取新的服务商配置，必须重启应用。后续需新增 app-server reload API、模型目录缓存失效和前端强制刷新入口。
- 本地 `apps/desktop/release` 中已有 `1.0.1` 安装包文件时间早于 2026-07-24 的部分补丁，最终客户交付前必须重新打包并更新哈希。
- Windows 31.50 已用于复现启动问题，仍需用包含全部补丁的新 Windows 安装包执行完整安装回归。
- macOS 和 Windows 都需要验证开机自动启动、静默进入托盘、托盘单击/双击恢复窗口。
- Electron 自动/手动更新仅完成需求审核，尚未接入主进程、更新源、签名发布和安装包回归。
- 问题反馈与自动上报仅完成需求审核，尚未接入桌面入口、自动采集、云端存储、后台处理和隐私校验回归。

## 5. 本次收尾补强

- Refresh Token 轮换改为 PostgreSQL 事务内锁定、撤销和双 Token 原子写入，阻止并发重放。
- 设备数量判断改为用户级事务锁，阻止并发注册绕过套餐上限。
- 验证码增加五次错误上限，达到阈值后自动失效。
- Provisioning Worker 可以回收超时的 running Job。
- 设备在 Tunnel 创建期间被封禁时，不再被异步完成流程重新激活；外部资源转入撤销补偿。
- Cloudflare 删除操作对 404 幂等，并增加 API 超时。
- originPort 变化时自动重新排队更新 Named Tunnel ingress。
- 二维码刷新会立即撤销旧配对码。
- Named Tunnel Token 改用权限受限的临时文件传给 cloudflared，不进入进程命令行。
- 桌面端增加开机启动、托盘复制地址、设备解绑、本地服务有限重启、托盘双击恢复和脱敏诊断日志导出。
- 云端认证失效时，桌面客户端会停止仍在运行的 Tunnel。
- 管理后台增加域名、支付和审计页面，用户邮箱和手机号默认脱敏。
- 桌面和本地 Web 增加 CSP；macOS 包关闭任意网络加载，只保留 loopback HTTP 例外。

## 6. 关键代码位置

- 本地服务：`src/server/app.ts`、`src/server/start.ts`、`src/server/auth/LocalAuthService.ts`
- 桌面端：`apps/desktop/src/main/index.ts`、`TunnelSupervisor.ts`、`DiagnosticLog.ts`、`CodexLocator.ts`、`CloudClient.ts`、`LocalServiceSupervisor.ts`
- 控制 API：`apps/control-api/src/ControlService.ts`、`db/PgControlStore.ts`
- Cloudflare：`apps/control-api/src/cloudflare/CloudflareAdapter.ts`、`provisioner.ts`
- 管理后台：`apps/admin-web/src/main.tsx`
- 数据库迁移：`apps/control-api/src/db/migrations/001_initial.sql`
- 部署：`deploy/docker-compose.yml`
- 发布：`.github/workflows/desktop-release.yml`

## 7. 当前不应对外宣称的内容

- 未签名 DMG 不是正式公开发行包。
- Named Tunnel 代码完成不等于已通过真实 Cloudflare 生产验证。
- PGlite 集成测试不能替代目标 PostgreSQL 17 环境的上线前迁移演练。
- macOS arm64 和 Windows x64 尚无包含全部 2026-07-24 补丁的新安装包实机安装记录。
- 真实支付代码已接入，但公开宣发前必须完成微信/支付宝生产商户参数联调和小额真实订单验收。
- 当前 API 限流器为单实例内存实现；水平扩容前必须换成 Redis 或网关级共享限流。
