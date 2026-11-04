# macOS Runtime 安装验收

## 原因与修正范围

MacBook Air 执行 Linux 安装命令时提示 `Required command not found: systemctl`。`v1.0.9` 附带安装器没有系统判断，直接要求 root、systemd、getent 和 sha256sum，并写入 `/etc/systemd/system`。这次错误发生在下载、安装运行包之前。

`main` 的安装器从 `1d8cf1a` 起增加 macOS 分支；验收脚本修订到 `b7a7300`。macOS 使用当前桌面登录用户的 launchd LaunchAgent，拒绝 sudo 和其他用户，采用系统自带 `shasum -a 256`，保存 Node/CLI 绝对路径和工具链 PATH。安装、数据、日志和密码位于用户目录。官方桌面应用无需修改。

安装器 SHA-256：`6970baf73fbc24d2aede91fc9e8bf030dde6756c2d1f4fafd80a3c54d8701549`。

运行包继续使用已发布的 `v1.0.9`，源码为 `a921a7a86005b0f9d2b11d687011aab7fcee21e7`，SHA-256 为 `411833b711e1ff626f9923cc645b20aee4ab0e1c89ba5d87e5e51de4aade3489`。未替换该 Release 的任何资产、版本分支或 tag；Release 内旧安装脚本仍只支持 Linux，macOS 必须使用 `main` 的新脚本。

## 环境与实际验证

| 环境 | 服务 | CLI | 证据 |
| --- | --- | --- | --- |
| 本机 macOS / Intel x64，Darwin 22.6.0，Node 22.22.0 | 真实 launchd | 桌面内置 `0.162.0-alpha.2` | `local-intel.json` |
| GitHub macOS 15 / Intel x64，Node 22 | 真实 launchd | 官方 `0.163.0` | `ci-macos-intel.json` |
| GitHub macOS 15 / Apple arm64，Node 22 | 真实 launchd | 官方 `0.163.0` | `ci-macos-arm64.json` |
| GitHub Ubuntu 24.04 / x64，Node 22 | 真实 systemd | 官方 `0.163.0` | `ci-linux.json` |

CI：[Verify Runtime Installer / 41782936658](https://github.com/foxhello-ai/codex-manage/actions/runs/41782936658)，检验提交 `b7a730061309f2f7e775823bbb585eb04e85fcb0`。

macOS 通过 10 个阶段：Release 在线下载安装、同版本 tgz 重装、Actions 形态 zip 安装、上一版本安装、升级、回滚、恢复、校验失败后服务保留、重启、`--no-start` 后手动启动。每阶段验证 Manage 密码登录、未登录/错误密码拒绝、健康状态、会话 API、页面和全部入口静态资源。另验证配置 `0600`、密码不变、数据与会话目录标记保留、错误用户提前拒绝，以及带空格、`&` 和 `#` 的路径。

Linux 回归检查 tgz/zip 安装、上一版本安装、升级/回滚/恢复、重启、停止/启动与配置/会话目录标记保留。验收中的连续主动启停会重置专用测试 unit 的启动计数，服务本身仍保留 systemd 的默认频率保护。

## Mac 安装命令

先安装 Node.js 22+ 与 Codex CLI，并在当前用户下完成 Codex 登录。也可使用已安装官方桌面应用附带的 CLI。在当前用户的桌面终端执行，不使用 `sudo` 或 `--user deploy`：

```bash
curl -fsSL https://raw.githubusercontent.com/foxhello-ai/codex-manage/main/scripts/install-runtime.sh \
  | bash -s -- --version 1.0.9
```

详细路径、密码查看方式和服务启停命令见 [README](../../../README.md#macos-安装macbook-air--pro)。

## 验证边界

这些检查使用真实的发行运行包、系统服务管理器和 Codex app-server，但使用隔离 `CODEX_HOME`，不读取真实账号凭据、不恢复真实工程会话、不发送模型请求。Manage 访问密码登录已验证；真实 ChatGPT/Codex 账号登录和模型续聊不属于这次安装验收。Apple arm64 的验证来自 GitHub 的 macOS runner，没有在用户这台 MacBook Air 上执行安装。

LaunchAgent 在该用户登录后启动、退出登录后停止，电脑休眠时不能持续提供远程访问。该交付物为 Web Runtime，不是 `.app` 桌面安装包。
