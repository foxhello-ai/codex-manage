# 发布管理与可追溯规则

## 1. 三条发布线

### Linux Runtime

构建入口为 `.github/workflows/build-runtime-package.yml`，推送 `release/vX.Y.Z` 分支触发；发布物是 `codex-manage-runtime.tgz`、同名 SHA-256、包内 `build-info.txt`、安装脚本和安装验收 JSON。版本号由发布分支和 GitHub Release tag 共同确定。正式记录必须写明运行包的 Git ref、SHA-256、安装脚本版本和 systemd 验收结果。

当前下载兼容入口沿用 GitHub Release 的 `vX.Y.Z` tag；通过安装验收及正式下载复核后，额外生成规范的 `runtime/vX.Y.Z` annotated tag，记录相同源码提交与安装证据。草稿 Release 通过安装、升级/回滚和服务启停后才可正式发布。每次运行结果写入 `verification/runtime-vX.Y.Z` 分支，正式发布的完整安装报告同时作为 Release asset 保存。

### Desktop

构建入口为 `.github/workflows/desktop-release.yml`；发布物包含 macOS arm64/x64 的 DMG/ZIP 与 Windows x64 NSIS，以及更新元数据和 SHA-256。版本权威字段为 `apps/desktop/package.json`。每次发布必须从干净提交构建并创建 `desktop/vX.Y.Z` annotated tag；不得使用无 tag 的工作区或以相同版本号重发不同内容。

### Cloud Platform

交付物为 Control API、Tunnel Worker、Admin Web 容器镜像、PostgreSQL 迁移与 Docker Compose 部署记录。建立语义版本基线前，每次部署至少记录镜像 digest、Git commit、迁移版本、环境、执行时间、回滚镜像和验收结果。建立基线后使用 `cloud/vX.Y.Z` tag。

## 2. Git 约定

未来新 tag 使用以下命名，避免旧的 `release/v1.0.1` 与 `v1.0.1` 混淆不同发布物：

```text
runtime/vX.Y.Z
desktop/vX.Y.Z
cloud/vX.Y.Z
```

历史 tag 保留，不改写：`release/v1.0.0`、`release/v1.0.1`、`release/v1.0.2` 和 `v1.0.1`。所有历史结论以 [`../releases/README.md`](../releases/README.md) 的证据等级为准。

经发布负责人批准，可以为已明确版本号提交补录 `runtime/`、`desktop/` 或 `cloud/` 的 **annotated 历史基线 tag**。tag 注释必须写明补录日期、目标提交、证据边界和对应台账；它只固定源码参考点，不等同于当期构建物、镜像 digest、签名或环境验收。补录 tag 本身不得提高证据等级。

## 3. 发布门禁

每个版本需求文档必须按发布线列出以下门禁及结果：

| 类别 | Linux Runtime | Desktop | Cloud Platform |
| --- | --- | --- | --- |
| 代码 | 类型检查、单元/E2E、生产构建 | 同左及 Desktop E2E | 类型检查、API/迁移测试、镜像构建 |
| 构建物 | tgz、build-info、SHA-256 | 三平台安装包、更新元数据、SHA-256 | 镜像 digest、迁移包 |
| 安全 | 配置和权限检查 | 签名、公证、更新签名、凭证脱敏 | Secret、TLS、CORS、权限、备份 |
| 环境验收 | systemd 启停、升级/回滚 | 安装、升级、卸载、Tunnel、真实平台 | PostgreSQL 迁移、Worker、Cloudflare、后台 |
| 回滚 | 恢复 `current` 链接 | 恢复已签名旧包/撤回更新元数据 | 回滚镜像和迁移策略 |

## 4. 发布记录的证据等级

- **已验证发布**：存在规范 tag、构建物、SHA-256 和对应环境验收。
- **已构建待验收**：存在构建物/校验和，但缺签名、实机或生产验证。
- **冻结基线**：存在明确提交和版本号，但缺 tag 或构建物证据。
- **Git 推定历史**：只能从版本变更提交推导范围，不能宣称已对客户发布。

旧版本默认不倒打 tag。经发布负责人明确批准后，可按第 2 节补录“历史基线 tag”；无法确认当期构建物时，必须保留 Git 推定、冻结基线或发布确认但证据待补状态，禁止将 tag 表述为已验证发布。
