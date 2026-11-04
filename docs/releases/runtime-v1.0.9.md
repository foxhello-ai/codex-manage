# Linux Runtime v1.0.9

已于 2026-11-04 发布：[GitHub Release v1.0.9](https://github.com/foxhello-ai/codex-manage/releases/tag/v1.0.9)。冻结源码为 `a921a7a86005b0f9d2b11d687011aab7fcee21e7`；`release/v1.0.9`、`v1.0.9` 和规范 annotated tag `runtime/v1.0.9` 均指向该提交。

## 范围

- 支持向桌面持有的原会话投递主用户文字，保留原 thread ID 和已保存上下文；Manage 空闲时确认卸载后释放自己的 writer。
- 当底部绿色提示已说明桌面处理方式时，不再重复显示桌面限制或占用的红色错误卡片。
- 包含 v1.0.8 之后的任务会话分组、Web/H5 工作台改进、列表分页和生产页面性能优化。
- Release 附带安装脚本；流水线下载实际 Release 文件，在隔离 Linux 用户和独立 systemd 服务下验证安装与运行。

## 发布门禁

本地已通过 165 项单元/路由测试、类型检查、生产构建和 8 项桌面/手机专项界面回归。发布流水线的以下检查也全部通过：

1. 新安装 tgz、Actions 形态 zip 安装。
2. Manage 登录、未登录拒绝访问、认证后 API、页面和全部入口静态资源。
3. 安装上一版本，再升级到本版本；配置文件和会话目录标记保留。
4. 通过 `current` 链接回滚上一版本并恢复本版本，验证 systemd 重启、停止和启动。
5. 正式发布后重新下载，校验 SHA-256 并确认与已验收文件一致。

本次 [发布流水线](https://github.com/foxhello-ai/codex-manage/actions/runs/41762042449) 的测试、构建、安装、官网部署和正式发布均成功。8 个安装阶段为 fresh-install、artifact-zip、previous-release、upgrade、rollback、restore、restart、start；各阶段的登录、健康状态和静态资源均通过，配置权限为 `0600`。

正式发布后重新下载的 tgz、SHA-256 和安装脚本与已验收文件一致。运行包 SHA-256：

```text
411833b711e1ff626f9923cc645b20aee4ab0e1c89ba5d87e5e51de4aade3489
```

完整结果见 Release 的 `runtime-installation-verification.json` 资产及本地 [验收记录](../acceptance/2026-11-04-runtime-v1.0.9/release-verification.json)。流水线运行状态同时写入 `verification/runtime-v1.0.9` 分支中的 `release-verification.json`，规范 Runtime tag 的注释也保存了对应安装报告。

## 安装

在有仓库权限的设备下载 Release 中的 `install-runtime.sh`、`codex-manage-runtime.tgz` 和同名 `.sha256`，上传到 Linux 主机。该主机需要 Node.js、systemd，以及已安装并登录 Codex 的实际会话所属用户：

```bash
sha256sum -c codex-manage-runtime.tgz.sha256
sudo bash ./install-runtime.sh --user <实际运行用户> --package ./codex-manage-runtime.tgz
```

安装路径为 `/opt/codex-manage/current`；配置入口为 `/opt/codex-manage/env`。安装不会迁移其他用户的 Codex 会话。

## 验证边界

自动验收使用 Ubuntu 24.04、Node.js 22 和官方 Codex CLI 0.163.0。它验证真实 systemd、安装包与 app-server 启动，使用新建的隔离 Linux 用户，不使用真实 ChatGPT/Codex 账号、不调用真实模型。会话目录保留检查使用专用标记文件，不代表对真实工程会话和工具副作用的验收。

桌面续聊的双端验收仍以已记录的 macOS 官方桌面独立 profile 和模拟模型结果为准，不能由 Linux 安装通过推定真实账号续聊已验收。本次 Release 内附的一键安装脚本仅支持 Linux；macOS/Windows 原生桌面安装包属于单独发布线。

## 发布后的安装器修订

2026-11-04，`main` 安装器补充 macOS launchd 支持，可安装同一份 `v1.0.9` Web Runtime。macOS 使用当前用户执行，不使用 `sudo` 或 `--user deploy`。`v1.0.9` Release 内的旧安装器未修改，Mac 需从 `main` 获取新脚本；不能用本次修订推定旧 Release 已包含 macOS 安装器。具体命令及 Intel、Apple arm64、Linux 回归证据见 [macOS 安装验收](../acceptance/2026-11-04-macos-runtime-installation/README.md)。
