# Codex Manage 文档索引

本文档将仓库资料按用途归类。产品范围与当前交付状态以项目级文档为准；按日期记录的实施笔记、验收截图和故障记录用于追溯具体变更。

## 项目级资料

| 类别 | 入口 | 用途 |
| --- | --- | --- |
| 项目治理与迭代 | [`governance/`](governance/) | 三条发布线、版本目标迭代、需求/Issue 生命周期、发布门禁与模板 |
| 发布台账 | [`releases/README.md`](releases/README.md) | 版本、提交、标签、构建物、验收证据与历史缺口 |
| 产品概览与开发说明 | [`../README.md`](../README.md) | 产品边界、目录、开发、构建和 Linux 运行包说明 |
| 产品全局架构 | [`../README.md#产品全局架构与分支边界`](../README.md#产品全局架构与分支边界) | Web/H5、Linux Runtime 与 Desktop Runtime 的并列用户侧执行面，独立 Tunnel 模块、Cloud Platform、支付与运营后台的关系，以及 1.0.7 候选分支边界 |
| Web/H5 基线 | [`codex-web-requirements.md`](codex-web-requirements.md)、[`detailed-design.md`](detailed-design.md)、[`task-plan.md`](task-plan.md)、[`technical-research.md`](technical-research.md) | 原始 Web 会话管理产品需求、技术设计与实施规划 |
| 模型切换 | [`model-change-requirements.md`](model-change-requirements.md)、[`model-change-detailed-design.md`](model-change-detailed-design.md)、[`model-change-task-plan.md`](model-change-task-plan.md) | 模型选择与切换需求、设计和任务规划 |
| 受控协作用户 MVP | [`controlled-collaboration-mvp.md`](controlled-collaboration-mvp.md) | 主/子用户、指定会话授权与 workspace 隔离的最小需求基线；实施状态以 Linear [FOX-21](https://linear.app/foxhello/issue/FOX-21/mvp-受控协作用户会话授权与-workspace-隔离) 为准 |
| V4 UI 审核 | [`v4-ui-review-2026-08-13.md`](v4-ui-review-2026-08-13.md) | V1/V4 UI 审核结论、实现差距、保留资产与中间内容清理边界 |
| V5 移动端实现交接 | [`implementation-notes/2026-08-14-v5-mobile-ui-design-handoff.md`](implementation-notes/2026-08-14-v5-mobile-ui-design-handoff.md) | V5 Conversation、Drawer 与 Approval Sheet 的 Figma 规格、编码范围与验收标准；对应 Linear `FOX-19`。 |
| 桌面与云平台 | [`desktop-cloud-platform/implementation-status.md`](desktop-cloud-platform/implementation-status.md)；完整需求、架构和实施计划仍在 [`feature/f-20260721-desktop`](https://github.com/foxhello-ai/codex-manage/tree/feature/f-20260721-desktop/docs/desktop-cloud-platform) | Desktop & Cloud Platform V1 的需求、架构、实施计划与当前状态；未合并资料不得被误认为 `main` 当前代码 |
| 当前状态 | [`desktop-cloud-platform/implementation-status.md`](desktop-cloud-platform/implementation-status.md) | 交付范围、阶段状态、外部验收门禁和已知缺口 |
| 验收与部署 | [`desktop-cloud-platform/acceptance-report.md`](desktop-cloud-platform/acceptance-report.md)、[`deployment-guide.md`](desktop-cloud-platform/deployment-guide.md) | 已完成验证、未完成的外部验收和生产部署步骤 |
| 发布记录 | [`releases/`](releases/) | 安装包版本、校验和、签名状态和发布后补丁 |
| 待办 | [`backlog.md`](backlog.md) | 未关闭的产品/体验待办 |

## 变更与追溯资料

- [`acceptance/2026-11-12-desktop-interaction-sync/report.html`](acceptance/2026-11-12-desktop-interaction-sync/report.html)：自包含 HTML 验收报告，内嵌桌面/手机截图与 JSON 证据，逐项说明原始需求完成程度和 instabox 多账号/组织授权步骤。
- [`implementation-notes/2026-11-12-desktop-interaction-sync.md`](implementation-notes/2026-11-12-desktop-interaction-sync.md)：历史分页、审批/途中问答修复的实现与验收；明确默认桌面跨端交互未打通、instabox Actions 待激活。
- [`desktop-interaction-sync-requirements.md`](desktop-interaction-sync-requirements.md)：2026-11-12 用户批准的桌面会话性能、审批同步、途中问答、桌面交互通道验证及 instabox Linux CI 迁移需求与验收标准。
- [`implementation-notes/2026-11-03-desktop-session-handoff.md`](implementation-notes/2026-11-03-desktop-session-handoff.md)：桌面原会话文字投递、双端持久消息同步、Manage 空闲释放的实现、兼容边界和隔离验收方式。
- [`implementation-notes/`](implementation-notes/)：按日期的调研、实现和问题修复记录。若项目级状态与笔记冲突，以日期更晚、且包含实现和验证记录的笔记为准，并在项目级文档中回写确认结论。
- [`implementation-notes/2026-10-30-session-continuation-research.md`](implementation-notes/2026-10-30-session-continuation-research.md)：持锁会话接续预研；验证同服务恢复、跨服务原生 Fork 与历史继承，提出逻辑会话恢复链和共享运行时方案，修正早期笔记的版本范围。
- [`implementation-notes/2026-10-30-shared-runtime-feasibility.md`](implementation-notes/2026-10-30-shared-runtime-feasibility.md)：独立验证项 SRF-01；真实官方桌面与当前 Manage 接入同一服务，验证双向消息、运行状态、中断、审批及重连，记录产品同步缺口与复现证据。
- [`implementation-notes/2026-11-03-desktop-owned-runtime-feasibility.md`](implementation-notes/2026-11-03-desktop-owned-runtime-feasibility.md)：独立验证项 SRF-02；验证官方桌面通过启动适配器创建唯一后台、Manage 随后接入，以及双方退出、重启与原会话恢复的边界。
- [`implementation-notes/2026-11-03-desktop-native-continuation.md`](implementation-notes/2026-11-03-desktop-native-continuation.md)：保持桌面原有启动方式和后台，实测内置 `codex queue` 从外部续聊桌面既有 thread；覆盖空闲投递、运行中排队与上下文保留，区分原生发送能力和 Manage 尚待实现的接入。
- [`implementation-notes/2026-11-03-writer-lock-upgrade-history.md`](implementation-notes/2026-11-03-writer-lock-upgrade-history.md)：走查 Git 与官方版本变更，实测 `0.144.3`、`0.146.0`、`0.147.0` 和桌面内置版，确认升级引入单写入者限制及 Manage 的接入适配缺口。
- [`implementation-notes/2026-11-03-manage-writer-release.md`](implementation-notes/2026-11-03-manage-writer-release.md)：验证 Manage 先持有写入权时桌面的冲突，以及取消订阅后按 thread 释放、保留后台和上下文的可行性；明确当前产品尚未自动释放、桌面界面自动恢复尚未验收。
- [`implementation-notes/2026-11-03-desktop-service-and-session-release-proposal.md`](implementation-notes/2026-11-03-desktop-service-and-session-release-proposal.md)：待审核方案；整合桌面原后台的 queue 续聊、被动消息同步和 Manage 空闲释放写入权，列出能力边界、改造范围及验收门禁。
- [`implementation-notes/2026-09-02-writer-lock-history-continuation.md`](implementation-notes/2026-09-02-writer-lock-history-continuation.md)：记录 active writer 下 Fork 失败的原因，以及不等待源 thread 锁、通过新会话读取 JSONL 历史后继续的实现方案。
- [`incidents/`](incidents/)：故障记录索引。
- [`acceptance/`](acceptance/)：Web/H5 与模型切换的验收截图。
- [`desktop-cloud-platform/electron-update-change-request.md`](desktop-cloud-platform/electron-update-change-request.md)：Electron 更新变更需求，已审核、待设计实现。
- [`desktop-cloud-platform/issue-reporting-change-request.md`](desktop-cloud-platform/issue-reporting-change-request.md)：问题反馈与自动上报变更需求，已审核、待设计实现。

## 当前同步基线（2026-08-08）

- 本地代码、验收和发布文档为技术事实来源；Linear 的 Codex Manage 项目保存便于协作的项目摘要、状态、发布与开放事项，不替代仓库中可审计的完整技术文档。
- Desktop & Cloud Platform 的核心 P1–P8 已完成代码验收；公开 GA 仍受真实外部环境验收、跨平台签名发布和生产运维门禁限制。
- 项目负责人确认 Cloud Platform `v1.0.6` 与 Desktop `v1.0.6` 同期发布；镜像 digest、部署时间、迁移与环境验收尚待在发布台账中补证。
- `cc switch` 后的 app-server 重载代码已于 2026-07-25 记录为完成，尚需 macOS/Windows 实机安装包回归；该较新记录应覆盖同日实施状态文档中“仍需新增 reload 能力”的过期表述。
- 自 2026-08-08 起，项目按 Linux Runtime、Desktop、Cloud Platform 三条独立发布线管理；需求与风险共享，但版本、构建物、验收与回滚记录不得混用。具体规则见 [`governance/`](governance/)。
