# 发布台账

本台账是版本、提交、tag、构建物和验收证据的本地索引。版本号相同不代表交付物相同；必须先区分 Linux Runtime、Desktop 与 Cloud Platform。

## 证据等级

- **已验证发布**：tag、构建物、SHA-256 和环境验收齐全。
- **发布确认，证据待补**：已由发布负责人确认实际发布，但历史 tag、构建物、环境验收或回滚记录不完整；不得当作可复现发布。
- **已构建待验收**：构建物存在，但外部验收或签名缺失。
- **冻结基线**：版本和提交明确，缺 tag/构建物证据。
- **Git 推定历史**：仅能根据版本变更提交回溯范围。

## Linux Runtime

| 版本 | Git 证据 | 范围 | 证据等级 |
| --- | --- | --- | --- |
| v1.0.1 | `runtime/v1.0.1`、`v1.0.1` → `7ee315b` | GitHub Actions 运行包构建、systemd 安装脚本、离线 Actions artifact 安装、运行包去 sourcemap | 冻结基线；规范 tag 为历史源码基线，仍需补回当时的 GitHub Release 资产和 SHA-256 后才可标为已验证发布 |

详见 [`runtime-v1.0.1.md`](runtime-v1.0.1.md)。

## Desktop

| 版本 | 版本/提交证据 | 回溯范围 | 证据等级 |
| --- | --- | --- | --- |
| v1.0.0 | `desktop/v1.0.0` → `7fc1e72` | 安全 Electron、本地服务、Control API、Tunnel 与运营后台的初始实现 | Git 推定历史；规范 tag 是历史源码基线 |
| v1.0.1 | `desktop/v1.0.1` → `ada0b45` | 重新登录复用设备绑定，避免重复注册触发设备数上限 | 冻结基线；旧安装包记录存在，但规范 tag 仅固定源码基线 |
| v1.0.2 | `desktop/v1.0.2`、`release/v1.0.2` → `6fb57dc` | Windows app-server 兼容/诊断、Tunnel 重试、会话分页、移动视口、运行时重载、更新与问题上报实现 | 冻结基线；tag 存在，仍需按产物证明验证 |
| v1.0.3 | `desktop/v1.0.3` → `b92bc2a` | 下载站构建配置、桌面更新产物托管、更新源迁移到 Control API 域名 | Git 推定历史；规范 tag 是历史源码基线 |
| v1.0.4 | `desktop/v1.0.4` → `73923c2` | Admin 默认 API 域名、Desktop/Control API 兼容回归、app-server 自动重载稳定性 | Git 推定历史；规范 tag 是历史源码基线 |
| v1.0.5 | `desktop/v1.0.5` → `5f8b5df` | macOS 更新安装可执行化、桌面客户体验优化 | Git 推定历史；规范 tag 是历史源码基线 |
| v1.0.6 | `desktop/v1.0.6` → `3ac606b` | 浮动工具和二维码配对弹窗优化；与 Cloud Platform v1.0.6 同期发布 | 发布确认，证据待补；规范 tag 仅固定源码范围，已确认不再向该版本加入后续提交 |
| v1.0.7 | `3ac606b` 之后的提交 | 待在 Linear 确认版本范围；当前仅为候选迭代 | 计划中 |

详见 [`desktop-v1.0.6.md`](desktop-v1.0.6.md)。现有 [`release-v1.0.0.md`](release-v1.0.0.md) 和 [`release-v1.0.1.md`](release-v1.0.1.md) 保留为历史材料，但它们的版本名称混用了 Web、Desktop 与后续增量，不能作为 Desktop 版本范围的唯一证据。

当前版本规划在 Linear 中分别由 [FOX-5](https://linear.app/foxhello/issue/FOX-5/确定-desktop-v107-的版本范围与发布需求)、[FOX-6](https://linear.app/foxhello/issue/FOX-6/确定-linux-runtime-v102-的版本范围与发布需求) 和 [FOX-7](https://linear.app/foxhello/issue/FOX-7/建立-cloud-platform-的独立版本基线与部署发布记录) 跟踪；历史证据回补由 [FOX-8](https://linear.app/foxhello/issue/FOX-8/回补-linux-runtime-与-desktop-历史发布证据) 跟踪。

## Cloud Platform

| 版本 | 发布关系与 Git 证据 | 范围 | 证据等级 |
| --- | --- | --- | --- |
| v1.0.6 | `cloud/v1.0.6` → `3ac606b`，与 Desktop v1.0.6 同期发布 | Control API、Tunnel Worker、Admin Web、PostgreSQL 与部署编排的当期生产组合 | 发布确认，证据待补；tag 仅为同期源码锚点，尚未回补不可变镜像 digest、精确部署 commit、迁移执行记录、环境验收和回滚镜像 |
| v1.0.7 | 与 Desktop v1.0.7 同步规划；支付和运行时域名配置为候选范围 | Control API、Tunnel Worker、Admin Web、支付、运行配置与 SMTP | 计划中；即使同步发布日期，仍须独立记录 Cloud tag、镜像 digest、迁移和回滚 |

详见 [`cloud-v1.0.6.md`](cloud-v1.0.6.md)。下一次涉及 Control API、Tunnel Worker、Admin Web 或迁移的正式部署前，必须先创建 Cloud Platform 的版本需求文档并记录镜像 digest、迁移、环境验收和回滚镜像。

## 历史 tag 说明

`release/v1.0.0` 和 `release/v1.0.1` 指向早期 Web/H5 版本；`v1.0.1` 指向 Linux Runtime；`release/v1.0.2` 指向 Desktop 版本变更。后续一律使用 `runtime/`、`desktop/`、`cloud/` 前缀，避免名称冲突。

2026-08-08 经发布负责人批准，补录以下 annotated 历史基线 tag：

| tag | 目标提交 | 含义 |
| --- | --- | --- |
| `runtime/v1.0.1` | `7ee315b` | Linux Runtime 源码基线 |
| `desktop/v1.0.0`–`desktop/v1.0.6` | `7fc1e72`、`ada0b45`、`6fb57dc`、`b92bc2a`、`73923c2`、`5f8b5df`、`3ac606b` | `apps/desktop/package.json` 的版本创建/变更提交 |
| `cloud/v1.0.6` | `3ac606b` | 与 Desktop 同期发布的源码参考锚点；不表示已识别云端生产镜像 |

这些 tag 不会改变表中的证据等级。实际构建物、镜像 digest、签名、SHA-256、环境验收和回滚记录仍由历史证据回补 Issue 跟踪。
