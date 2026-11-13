# Runtime v1.0.12 发布验收

已合并 main，并于 2026-11-13 10:35:28（北京时间）正式发布 v1.0.12。

- [正式 Release](https://github.com/foxhello-ai/codex-manage/releases/tag/v1.0.12)，源码 `78d21b69a557d4bbc1e9734c4b949aa543766ade`；release/v1.0.12、v1.0.12 和 annotated runtime/v1.0.12 固定同一源码。
- [发布流水线](https://github.com/foxhello-ai/codex-manage/actions/runs/43353117556)：197 项测试、类型检查、生产构建、Linux 安装验收、正式下载复核均通过。
- [发布后三平台复验](https://github.com/foxhello-ai/codex-manage/actions/runs/43353472449)：Linux 8 项、Intel Mac 10 项、Apple ARM Mac 10 项全部通过，包含安装、升级、回滚、启停、配置保留及运行版本核对。
- 本机 Intel Mac 10 项 launchd 检查通过，使用正式发布包及隔离 CODEX_HOME；未升级用户原安装。
- 正式发布包设置页在 1440px 和 375px 显示 v1.0.12，截图见[HTML 验收报告的发布部分](../2026-11-13-history-503/report.html#release)。

SHA-256：`2e78aa561db678dd638585f079b84698be3884b2a1bac7e56153d7cade03a3e1`。

本版修复已确认的历史与实时输出显示缺陷；远端用户原会话的实际 503 效果仍需升级后复测。安装验收使用隔离服务，没有调用模型或读取真实账号凭证。

[汇总 JSON](release-summary.json)、[发布记录](release-verification.json)、[Linux](linux-ci.json)、[Intel Mac](macos-intel-ci.json)、[Apple ARM Mac](macos-arm64-ci.json)、[本机 Mac](macos-local-intel.json)、[设置页记录](settings-ui.json)。
