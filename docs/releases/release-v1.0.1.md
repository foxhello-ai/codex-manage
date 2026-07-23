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
| macOS Intel x64 | `Codex Manage-1.0.1.dmg` | `30d8e2f2a8547acbfe96196c1ec677c100893a97236bc5a512b2449e09bfce78` |
| macOS Apple Silicon arm64 | `Codex Manage-1.0.1-arm64.dmg` | `2cac7aebb320376a91a0830eea7247dbbe7c3b1cb1bfa6482a3c3c510f45767f` |
| Windows x64 NSIS | `Codex Manage Setup 1.0.1.exe` | `585e72f252e7eb566baefc4b7e6c44da89af6a6ba371a1ccbfebc1bd45f4196e` |

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
