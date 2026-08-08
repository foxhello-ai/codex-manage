# Codex Manage 项目治理

本目录定义 Codex Manage 的持续迭代、文档维护和发布追溯规则。它适用于当前由一人负责产品、开发、测试和发布的阶段，也为后续引入人工或 AI 角色保留清晰的交接边界。

## 发布线

| 发布线 | 交付物 | 当前已知基线 | 版本事实来源 |
| --- | --- | --- | --- |
| Linux Runtime | Node 运行包、systemd 安装脚本、GitHub Release | v1.0.1 | 运行包 `build-info.txt`、Git tag、SHA-256、GitHub Release |
| Desktop | macOS arm64/x64 DMG/ZIP、Windows x64 NSIS、更新元数据 | v1.0.6 已冻结 | `apps/desktop/package.json`、Git tag、三平台产物与 SHA-256 |
| Cloud Platform | Control API、Tunnel Worker、Admin Web、数据库迁移与部署镜像 | 尚未建立语义版本基线 | 容器镜像 digest、迁移版本、部署记录与 Git tag |

三条发布线共享本地会话运行时、产品需求和 Linear 项目；它们的版本号、构建物、发布门禁和回滚记录必须分开管理。

## 事实来源与职责

| 内容 | 权威来源 | Linear 中的体现 |
| --- | --- | --- |
| 产品范围、技术设计、验收细节、构建物证据 | 本仓库 `docs/` | 链接到对应文档 |
| 需求优先级、当前状态、负责人、版本范围、阻塞关系 | Linear Issue / Milestone / Release | 可视化看板与版本范围 |
| 代码实现 | Git commit、分支、tag | Issue 中记录分支和提交；发布文档记录最终 ref |
| 客户问题报告 | Control API 问题库 | 人工分诊后关联或创建 Linear Issue |

`docs/` 是入口和长期证据库，Linear 是协作与可视追溯入口。两边使用相同的 Issue 标识、版本号、Git ref 和发布日期互相链接，不复制无法维护的全文。

## 当前管理约束

- 迭代按版本目标组织，不采用固定时长 Sprint。每个版本目标仍须在 Linear 中有一个 Milestone 或 Release，避免“本轮做什么”不可见。
- Desktop v1.0.6 的冻结提交为 `3ac606b`。该提交尚未有 `desktop/v1.0.6` tag、已签名构建物或 SHA-256 证据；因此本仓库仅把它视为冻结基线，不把它表述为可验证的正式发布。
- `3ac606b` 之后的代码进入 Desktop v1.0.7 的候选范围。未先升级版本号、确定范围、创建 tag 时，不得重新构建并分发名为 1.0.6 的安装包。
- 品牌图标统一与跨平台导出流程登记为 Backlog；在需求被排入版本前不改动图标代码或发布资源。

## Linear 初始追溯项

- [FOX-5：Desktop v1.0.7 版本范围与发布需求](https://linear.app/foxhello/issue/FOX-5/确定-desktop-v107-的版本范围与发布需求)
- [FOX-6：Linux Runtime v1.0.2 版本范围与发布需求](https://linear.app/foxhello/issue/FOX-6/确定-linux-runtime-v102-的版本范围与发布需求)
- [FOX-7：Cloud Platform 独立版本基线](https://linear.app/foxhello/issue/FOX-7/建立-cloud-platform-的独立版本基线与部署发布记录)
- [FOX-8：历史发布证据回补](https://linear.app/foxhello/issue/FOX-8/回补-linux-runtime-与-desktop-历史发布证据)
- [FOX-9：Release Pipeline 配置](https://linear.app/foxhello/issue/FOX-9/在-linear-配置三条发布线的-release-pipeline)
- [FOX-10：跨平台品牌图标](https://linear.app/foxhello/issue/FOX-10/统一跨平台品牌图标资产与导出流程)（Backlog，暂不改代码）
- [FOX-11：移动端视窗回归](https://linear.app/foxhello/issue/FOX-11/回归移动端会话页面的视窗适配cm-b-001)（从 `CM-B-001` 迁移）

## 使用入口

- [`iteration-workflow.md`](iteration-workflow.md)：从需求进入 Backlog 到发布复盘的迭代流程。
- [`issue-lifecycle.md`](issue-lifecycle.md)：需求、Feature、Improvement、Bug、客户问题报告的关系与分诊规则。
- [`release-process.md`](release-process.md)：三条发布线的版本、标签、构建、验收和回滚规则。
- [`templates.md`](templates.md)：版本需求、Issue、发布记录和问题分诊模板。
- [`../releases/README.md`](../releases/README.md)：历史与当前版本台账。
