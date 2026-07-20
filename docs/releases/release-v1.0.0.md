# Codex Manage v1.0.0 发布说明

## 发布信息

- 版本：`1.0.0`
- 标签：`release/v1.0.0`
- 发布日期：2026-07-15
- 分支：`main`
- 状态：MVP M0-M12 与会话模型切换 MC-M0 至 MC-M8 完成

## 版本完成内容

### 会话管理

- 读取默认 `~/.codex/sessions` 会话目录。
- 按工作目录分组展示会话并支持关键词搜索。
- 支持会话备注标题的设置、修改和清空。
- 支持会话详情深链接、刷新以及浏览器前进和后退。
- 历史消息支持 Markdown、最近 5 轮默认展示和按批加载。
- 历史命令默认折叠，长输出支持滚动查看。
- 不提供历史会话删除接口或 UI。

### Codex 运行能力

- 使用 Codex app-server `thread/resume` 恢复原生会话。
- 支持多个不同会话并发恢复，同一会话防止重复恢复。
- 支持 Web 输入继续任务、即时回显和失败状态保留。
- 支持 `Ctrl+Enter`、`Meta+Enter` 发送，普通 Enter 换行。
- 支持 agent 文本、命令开始、命令输出和完成状态实时展示。
- 支持 WebSocket 鉴权、事件缓存、断线重连和页面刷新恢复。
- 支持默认审批模式和会话级完全权限模式。
- 支持命令、文件变更、权限和用户输入审批。
- 正确处理 app-server `idle` 状态及可重试错误。

### 会话模型切换（2026-07-19 增量）

- 通过 app-server `model/list` 展示当前支持模型，不使用本地猜测列表。
- 支持历史、失败、退出会话在恢复前保存模型和推理强度偏好。
- 支持 `waiting_input` 会话即时切换，并以 `thread/settings/updated` 通知确认实际模型。
- 运行中、恢复中和待审批状态拒绝切换并展示明确原因。
- 历史不支持模型继续展示，但不会出现在可选模型中。
- 桌面与 H5 提供搜索、默认模型、upgrade 信息、effort、跟随会话和手动刷新。
- 模型失败进入实时消息区；切换后不会自动重放，用户确认后才创建新 turn。
- 会话模型设置不改变权限模式、sandbox、审批策略、工作目录或其他会话。

### Web 与 H5

- 单密码登录、Cookie 登录态和明确登出入口。
- 支持本机及局域网监听。
- H5 会话列表使用可搜索侧边抽屉。
- H5 运行状态使用紧凑可展开状态条，不覆盖标题、消息或输入框。
- H5 详情使用独立消息滚动区和固定布局输入区。
- 审批操作在桌面与 H5 均支持允许一次、本会话允许、拒绝和取消。

### 设置、诊断与部署

- 提供 `/settings` 只读设置和诊断页面。
- 展示监听地址、端口、Sessions 目录、密码来源、Codex CLI 版本和 app-server 状态。
- 提供受认证保护的 `/api/config` 和 `/api/health`。
- 生产构建同时生成 Vite 前端产物和 esbuild 服务端产物。
- Fastify 提供静态文件服务和会话详情 SPA 回退。
- 支持 `codex.example.com`、`codex.example.cn` 开发访问配置。

## 安全边界

- 除登录和认证状态探测外，管理 API 均要求登录。
- WebSocket 握手要求有效登录 Cookie。
- 默认不修改 `~/.codex/config.toml` 或原始历史会话内容。
- 不读取、不修改、不监控、不依赖 cc-switch、`auth.json` 或 provider 认证配置。
- provider URL、凭据和全局配置路径在 API 与实时错误中统一脱敏。
- 不提供任意文件读取和历史会话删除能力。
- 完全权限必须由用户显式确认，且只保存为当前服务内存状态。

## 验证结果

- TypeScript 类型检查通过。
- Vitest：18 个测试文件、79 项测试通过。
- Playwright：桌面/H5 共 8 项端到端测试通过。
- 前端和服务端生产构建通过。
- 生产依赖审计：0 vulnerabilities。
- 真实 Codex app-server 初始化、会话恢复、输入提交、双会话恢复和同会话防重复通过。

测试和截图详情见：

- [M11-M12 最终报告](../final-report-2026-07-15.md)
- [桌面与 H5 验收截图](../acceptance/2026-07-15/README.md)
- [会话模型切换实施与真实验收](../implementation-notes/2026-07-19-session-model-switching.md)
- [会话模型切换桌面与 H5 截图](../acceptance/2026-07-19/README.md)

## 安装与启动

```bash
npm ci
npm run build
npm start
```

常用环境变量：

```text
CODEX_WEB_HOST=0.0.0.0
CODEX_WEB_PORT=4310
CODEX_WEB_PASSWORD=<your-password>
CODEX_CLI_PATH=codex
CODEX_SESSIONS_DIR=~/.codex/sessions
CODEX_WEB_SESSION_SECRET=<persistent-secret>
```

## 升级说明

- 从开发版本升级不需要迁移 Codex 原始 sessions。
- Web 备注元数据继续保存在 `.codex-manage/session-metadata.json`。
- 建议生产或长期局域网使用时配置 `CODEX_WEB_PASSWORD` 和持久化 `CODEX_WEB_SESSION_SECRET`。

## 已知外部环境问题

个别支持模型在发布验收期间仍可能返回 provider `502 Bad Gateway`。系统会保留原模型和失败 turn、展示脱敏错误，且不会自动降级或自动重放。真实验收已通过显式切换到另一支持模型并人工重试完成回复；真实 `waiting_approval` 构造仍保留为非破坏性环境复验项。
