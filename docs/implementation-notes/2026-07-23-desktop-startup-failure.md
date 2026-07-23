# Desktop Codex 与 cloudflared 启动失败诊断

日期：2026-07-23  
分支：`feature/f-20260721-desktop`

## 现象

- Codex CLI 显示“未检测到”，错误为 `spawn codex ENOENT`。
- 模型接口提示 `Codex app-server is not ready`。
- Quick Tunnel 持续显示 `cloudflared 已退出（code=0, signal=null）` 并指数退避重试。

## 已确认根因

### 1. Finder 启动环境无法发现 NVM 中的 Codex CLI

Codex CLI 实际位于 `~/.nvm/versions/node/<version>/bin/codex`。macOS 从 Finder 启动应用时不会加载交互式 shell 的 NVM PATH。现有定位器仅尝试：

- `CODEX_CLI_PATH`
- `codex`
- `/opt/homebrew/bin/codex`
- `/usr/local/bin/codex`

检测失败后，桌面主进程仍把字符串 `codex` 传给本地服务，最终导致 app-server ENOENT。

此外，NVM 中的 `codex` 入口使用 `#!/usr/bin/env node`。即使定位到绝对路径，如果没有把同目录加入子进程 PATH，仍会报 `env: node: No such file or directory`。

### 2. cloudflared 2025.4.2 不支持 `--logformat`

当前启动参数为：

```text
cloudflared --no-autoupdate tunnel --logformat json --url <origin>
```

打包版本 `cloudflared 2025.4.2` 返回：

```text
Incorrect Usage. flag provided but not defined: -logformat
```

该 CLI 使用错误会打印帮助并以退出码 0 结束，因此监督器把它误报为“正常退出后重连”。移除 `--logformat json` 后，Quick Tunnel 能创建 trycloudflare URL 并注册 QUIC 连接。

## 审核结论

修复范围限定为桌面启动兼容性，不改变云端 API、数据库、认证或 Tunnel 业务协议：

1. 扩展 Codex CLI 候选路径，覆盖 NVM、Volta、asdf、mise、Bun、pnpm 和常见系统目录。
2. 检测 Codex 版本和启动本地服务时，将 Codex 所在目录前置到 PATH，确保 `env node` 可用。
3. cloudflared 参数移除已废弃的 `--logformat`。
4. 保留纯文本和 JSON 两种日志解析，并记录精简后的失败诊断，避免只有退出码而没有原因。
5. 增加 NVM/Finder PATH、子进程 PATH、Quick Tunnel 参数和异常退出诊断测试。
6. 测试隔离目录必须在申请 Electron 单实例锁前生效，避免本机已运行安装版时测试实例直接退出。
7. 修正 electron-builder `afterPack` 相对路径，恢复安装包构建。
8. cloudflared 下载脚本对 macOS 压缩包先解压，再按清单校验最终二进制；确保 arm64、x64 和 Windows x64 资源完整。

## 验收标准

- 打包应用能检测当前 NVM 中安装的 Codex CLI。
- `codex app-server` 完成 initialize/initialized 握手，状态为 ready。
- Quick Tunnel 不再因参数错误立即退出，能获得 `trycloudflare.com` URL。
- Named Tunnel 仍通过受限 token 文件启动，Token 不出现在进程参数或日志中。
- 桌面类型检查、单元测试、构建和 Electron E2E 全部通过。

## 修复结果

### Codex CLI 与本地服务

- 在 Finder 风格的最小 PATH 下，自动发现 `~/.nvm/versions/node/v22.22.0/bin/codex`。
- 版本检测结果为 `codex-cli 0.142.0`。
- Codex 目录会被前置到版本检测和本地服务子进程 PATH，`#!/usr/bin/env node` 可正常解析。
- 打包应用 E2E 已确认 Codex CLI 状态为“可用”，本地服务状态为“运行中”。

### cloudflared

- Quick Tunnel 与 Named Tunnel 启动参数均不再包含 `--logformat`。
- 打包内 `cloudflared 2025.4.2` 已真实创建 `trycloudflare.com` Quick Tunnel URL。
- arm64、x64、Windows x64 二进制 SHA-256 均与 `manifest.json` 一致。
- Apple Silicon 安装包包含 arm64 cloudflared，Intel 安装包包含 x64 cloudflared。

### 自动化验证

2026-07-23 已完成：

- `npm run typecheck:all`：通过。
- 桌面定向单元测试：5 项通过。
- 全仓测试：110 项首次通过；2 项 PGlite 测试在并行高负载下超时，隔离顺序复跑 3 项全部通过。
- `npm run build:desktop`：通过。
- `npm run test:desktop:e2e`：开发版 2 项通过，打包项按配置跳过。
- 配置 `CODEX_PACKAGED_APP_PATH` 后：打包版、首次密码设置、Quick Tunnel 二维码共 3 项 E2E 全部通过。
- macOS arm64 与 x64 DMG：构建成功。

## 已知发布事项

当前机器没有有效的 `Developer ID Application` 证书，因此 DMG 为未签名构建。功能验证不受影响，但对外分发前仍需配置有效证书并完成 Apple notarization。
