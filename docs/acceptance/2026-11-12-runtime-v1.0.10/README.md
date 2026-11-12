# Runtime v1.0.10 发布验收

时间：2026-11-12T14:01:38.592018+08:00。源码 `e375a3a5ae4fd438ff68f6012e3a64ebc7639d31`。已合并 main 并正式发布；规范 annotated tag runtime/v1.0.10 与下载 tag v1.0.10 均固定同一源码。

- [正式 Release](https://github.com/foxhello-ai/codex-manage/releases/tag/v1.0.10)
- [instabox 发布与 Linux 安装流水线](https://github.com/foxhello-ai/codex-manage/actions/runs/43164120666)：189 项测试、生产构建、8 项 systemd 安装生命周期及官网部署通过。
- [发布后 Linux / Intel Mac / Apple ARM Mac 安装矩阵](https://github.com/foxhello-ai/codex-manage/actions/runs/43164721926)：三项均通过，下载的是本次正式发布包。
- 本机 Intel Mac 10 项 launchd 检查通过；配置、数据和会话目录标记保留，校验失败不破坏运行服务。
- 发布后重新下载核验 SHA-256：`13ae8023610ad4d58eb8d0c6fc78575bf58052cc00974e430216146b6585fd98`。

验证使用隔离目录、用户和服务，不修改用户现有安装，不重新登录真实账号、不调用模型。功能中的真实原桌面 Web 问题回传另见 [交互验收](../2026-11-12-desktop-interaction-sync/report.html)。

[汇总 JSON](release-summary.json)、[发布完整记录](release-verification.json)、[Linux](linux-ci.json)、[Intel Mac](macos-intel-ci.json)、[Apple ARM Mac](macos-arm64-ci.json)、[本机 Mac](macos-local-intel.json)。
