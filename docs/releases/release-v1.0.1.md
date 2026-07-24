# Codex Manage Desktop v1.0.1

发布日期：2026-07-23

分支：`feature/f-20260721-desktop`

## 发布目的

修复桌面端普通退出平台账号后，本地设备凭据被删除，重新登录重复注册设备并触发免费套餐设备数量上限的问题。

关联故障：`CM-INC-20260723-002`。

## 主要变更

- 用户登录 Session 与设备绑定凭据分开加密保存。
- 同一账号退出后重新登录时复用原设备，不重复调用设备注册接口。
- 明确执行“解绑当前设备”时才撤销服务端设备并删除本地绑定。
- 自动迁移旧版加密 Session 中已有的设备绑定。
- 设备凭据被服务端撤销后，清理失效绑定并按名额规则重新注册。
- 保留 Codex NVM 自动发现、cloudflared 参数兼容和跨架构资源修复。

## 安装包

| 平台 | 文件 | SHA-256 |
| --- | --- | --- |
| macOS Intel x64 | `Codex Manage-1.0.1.dmg` | `ee79936f9b58a544c082515f74e60870b823add0b720cdac475021c8d7d14c2f` |
| macOS Apple Silicon arm64 | `Codex Manage-1.0.1-arm64.dmg` | `3e3821596a133f4a3af59473b5864159b2735b5f5f93e3c5c13c97b160969bf5` |
| Windows x64 NSIS | `Codex Manage Setup 1.0.1.exe` | `a00f63e56f2c232b370a9345874ed2c9835734d78870e8340452f6dae1218990` |

> 2026-07-25 复核：`apps/desktop/release` 中同名 `1.0.1` 产物 SHA-256 如上。由于 2026-07-24 又合入 `fbc4c24` 和 `2243b00`，最终对客户交付前必须重新打包并再次更新本节哈希。

## 验证结果

- 桌面生产构建通过。
- macOS Intel、Apple Silicon DMG 构建通过。
- Windows x64 NSIS 构建通过。
- Intel DMG 已安装到 `/Applications/Codex Manage.app`。
- 安装应用版本为 `1.0.1`，运行架构为 x86_64。
- 打包应用 Electron E2E 通过。
- 正式用户数据启动后，诊断日志确认：
  - `version=1.0.1`
  - Codex CLI 可用，版本 `codex-cli 0.142.0`
  - 本地服务状态为 `running`
  - 本地服务端口为 `4310`
- 原 `1.0.0` 应用已备份到 `apps/desktop/release/backups/`。

## 签名状态

当前构建机没有有效的 Apple `Developer ID Application` 证书，也没有配置 Windows 代码签名证书，因此本次 DMG 和 NSIS 是内部验收用未签名安装包。

对外发布前仍需：

1. 使用有效 Apple Developer ID 签名 macOS 应用。
2. 完成 Apple notarization 和 stapling。
3. 使用受信任的 Windows Authenticode 证书签名 NSIS。
4. 在干净的 Intel Mac、Apple Silicon Mac 和 Windows x64 设备分别安装验收。

## 已知恢复事项

如果用户已经在旧版中执行过退出并丢失原设备凭据，安装 1.0.1 后仍需先在管理后台停用旧活动设备，释放设备名额。新设备成功绑定后，后续退出再登录将复用设备，不再重复占用名额。

## 2026-07-23 至 2026-07-24 后续补丁

这些补丁已合入 `feature/f-20260721-desktop`，用于下一次重新打包和回归：

| 提交 | 类型 | 变更 | 状态 |
| --- | --- | --- | --- |
| `07cd4de` | Windows 兼容 | `CodexAppServerClient` 支持 Windows `.cmd` 启动 app-server | 已合入 |
| `2d5a927` | 启动诊断 | 本地服务启动失败时向上抛出 app-server 原始错误 | 已合入 |
| `808d0c8` | Named Tunnel | 正式权益存在时自动 provision 专属 Tunnel，避免继续使用 Quick Tunnel 随机域名 | 已合入 |
| `5df9aec` | 托盘 | Windows 托盘增加双击打开主窗口 | 已合入 |
| `8a36c10` | iPhone 入口 | 扫码面板增加 iPhone 添加到主屏幕操作指引 | 已合入 |
| `3ff7faa` | 进程治理 | 启动失败与退出路径清理 app-server，降低孤儿进程导致的后续启动失败 | 已合入 |
| `9805d6d` | Windows 兼容 | Windows Codex 定位优先完整路径，避免裸 `codex` 命中错误入口 | 已合入 |
| `0c3856f` | Windows 兼容 | 版本检测使用 `execFile`，Windows `.cmd` 走 shell 兼容启动 | 已合入 |
| `fbc4c24` | 远程通道 | 云端 `500`、`503` 和 `desktop:start-tunnel` 首次临时失败增加短重试 | 已合入，需重新打包 |
| `2243b00` | 会话展示 | `thread/list` 分页扫描并兼容 `id`/`sessionId`，修复部分会话不展示 | 已合入，需重新打包 |

详细记录见：

- `docs/implementation-notes/2026-07-24-windows-session-and-tunnel-stability.md`
- `docs/implementation-notes/2026-07-25-provider-switch-app-server-reload.md`

## 当前未关闭事项

- `cc switch` 外部切换服务商后，应用内长生命周期 `codex app-server` 不会自动重载；当前需要重启 Codex Manage。该问题已登记为 `CM-INC-20260725-005`，尚待代码修复。
- 本地已有 `1.0.1` 安装包文件时间早于 2026-07-24 的部分补丁，不能作为“包含全部修复”的最终客户包。
