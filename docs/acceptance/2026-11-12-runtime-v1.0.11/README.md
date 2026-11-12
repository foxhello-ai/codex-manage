# Runtime v1.0.11 发布验收

已合并 main，正式发布 v1.0.11。记录时间：2026-11-12T14:48:16.815814+08:00。

- [正式 Release](https://github.com/foxhello-ai/codex-manage/releases/tag/v1.0.11)，源码 `2315e46b7a08834eb22f571737662c7cec814e03`；release/v1.0.11、v1.0.11、annotated runtime/v1.0.11 均固定同一源码。
- [instabox 发布流水线](https://github.com/foxhello-ai/codex-manage/actions/runs/43169476570)：192 项测试、类型检查、生产构建、8 项 Linux 安装生命周期及正式下载复核通过。
- [发布后三平台复验](https://github.com/foxhello-ai/codex-manage/actions/runs/43169841959)：Linux 8 项、Intel Mac 10 项、Apple ARM Mac 10 项均通过。
- 本机 Intel Mac 10 项 launchd 检查通过。新版本的安装、升级、还原、重启均核对 appVersion=v1.0.11；回滚旧版本保留兼容。
- 用正式下载包启动隔离服务，Web 设置页真实显示 v1.0.11，1440px/375px 均通过。[截图与 HTML 报告](../2026-11-12-settings-version/report.html)。

SHA-256：`1f4d2b5bfe0e11badc8012049ce89948010c62e368bb28e6a6b5906a0154c650`。

验收使用隔离服务和 CODEX_HOME，不升级用户当前生产安装，不读取真实账户凭证、不调用模型。

[汇总 JSON](release-summary.json)、[发布记录](release-verification.json)、[Linux](linux-ci.json)、[Intel Mac](macos-intel-ci.json)、[Apple ARM Mac](macos-arm64-ci.json)、[本机 Mac](macos-local-intel.json)。
