# Codex Manage Desktop & Cloud Platform V1 验收报告

## 1. 验收结论

截至 2026-07-21，P1-P8 核心功能已完成代码验收，macOS x64 内部测试安装包已完成构建、镜像校验、挂载启动和嵌入式本地服务验证。

当前适合进入内部 Alpha 和外部资源联调，不满足公开 GA 条件。GA 阻断项为：真实 Cloudflare 与 PostgreSQL 17 验收、macOS arm64 和 Windows x64 实机、Apple Developer ID 签名与公证、Windows 代码签名、邮件/短信供应商和生产运维门禁。

## 2. 自动化结果

| 项目 | 结果 |
| --- | --- |
| 全仓 TypeScript 类型检查 | 通过 |
| 单元与集成测试 | 30 个测试文件，107 项通过 |
| PostgreSQL 迁移兼容测试 | 首次执行和重复执行通过 |
| 控制面状态流测试 | 用户、权益、设备上限、心跳、Named Tunnel、封禁联动通过 |
| Refresh Token 重放测试 | 通过 |
| Provisioning 封禁竞态补偿测试 | 通过 |
| Web Desktop/H5 E2E | 8 项通过 |
| Electron 开发态 E2E | 2 项通过，1 项按环境跳过 |
| DMG 内应用 E2E | 1 项通过 |
| 全量生产构建 | Desktop、Control API、Admin Web 全部通过 |

## 3. 功能验收

### 3.1 本地与桌面

- 首次启动要求设置本机密码。
- Fastify 只监听 `127.0.0.1`。
- 本地 Session、撤销全部 Session、一次性配对码可用。
- 二维码使用 URL Fragment，刷新二维码会撤销旧码。
- Electron 开启 context isolation、sandbox，关闭 Node Integration。
- 关闭窗口进入托盘，退出清理本地服务和 cloudflared。
- 支持开机启动并静默进入托盘。
- 支持导出滚动、脱敏的诊断日志。
- 支持设备解绑并撤销手机 Session。
- Named Tunnel Token 不进入 cloudflared 命令行。

### 3.2 云端控制面

- 邮箱和手机号验证码注册，默认产品页面为邮箱。
- 密码登录、密码重置、身份绑定和解绑。
- Access Token、原子 Refresh Token 轮换、设备凭证和设备 Access Token。
- 设备注册上限、设备列表、改名、解绑和心跳。
- Quick Tunnel 地址记录。
- Named Tunnel、固定域名、Cloudflare ingress、CNAME 和 Token 配置代码。
- 用户/设备封禁会撤销凭证、域名和 Tunnel，并创建撤销任务。
- 免费/正式套餐、订阅、权益、订单、支付占位和未来 Payment Adapter。

### 3.3 管理后台

- 管理员登录与 `operator_readonly` 写权限限制。
- 用户、设备、Tunnel、域名、订阅、订单、支付、审计查询。
- 人工开通正式权益。
- 用户和设备停用/恢复。
- 邮箱、手机号和管理员邮箱脱敏显示。
- 高风险操作二次确认并写审计日志。

## 4. 安装包结果

- 文件：`apps/desktop/release/Codex Manage-1.0.0.dmg`
- 平台：macOS x64
- 大小：约 138 MB
- SHA-256：`64cdaf6c906406118d7c46e07f3c4c1433509c4d43e7e1b158ebafc05df178e2`
- DMG CRC：挂载时系统完整校验通过
- Electron 主程序架构：x86_64
- 内置 cloudflared：x86_64，版本 2025.4.2
- App Transport Security：任意加载关闭，仅允许 localhost/127.0.0.1 HTTP
- 签名状态：未签名，仅限内部测试

对应校验和文件：`apps/desktop/release/SHA256SUMS.txt`。

## 5. 未完成的外部验收

当前机器没有 Docker、PostgreSQL 服务、Cloudflare Account/Zone Token、Apple Developer ID 发行证书或 Windows 环境，因此以下内容未伪造通过结论：

1. PostgreSQL 17 容器真实迁移、备份和恢复。
2. Cloudflare Named Tunnel 创建、DNS、Token、撤销和限流演练。
3. 邮箱与短信真实送达。
4. macOS arm64 构建和实机安装。
5. Windows x64 NSIS 构建、安装、卸载和 SmartScreen 验收。
6. macOS Developer ID 签名与 Notarization。
7. Windows 代码签名。
8. 邀请 Beta 的移动网络、弱网和长时间运行。
9. 多实例部署前的 Redis/网关共享限流。

## 6. 发布建议

1. 先部署预发布 PostgreSQL、Control API、Worker 和 Admin Web。
2. 使用独立 Cloudflare 测试 Zone 完成 Named Tunnel 全链路。
3. 接入至少邮件验证码通道，短信可以随后灰度。
4. 在 GitHub Actions 中生成 macOS arm64、macOS x64、Windows x64 三个平台签名包。
5. 完成安全审查、备份恢复和封禁撤销演练后进入 Invite Beta。
