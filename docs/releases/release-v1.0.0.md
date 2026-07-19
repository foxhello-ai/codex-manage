# Codex Manage v1.0.0 发布说明

## 发布信息

- 版本：`1.0.0`
- 标签：`release/v1.0.0`
- 发布日期：2026-07-15
- 分支：`main`
- 状态：MVP M0-M12 完成

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
- 支持 `codex.foxhello.com`、`codex.foxhello.cn` 开发访问配置。

## 安全边界

- 除登录和认证状态探测外，管理 API 均要求登录。
- WebSocket 握手要求有效登录 Cookie。
- 默认不修改 `~/.codex/config.toml` 或原始历史会话内容。
- 不提供任意文件读取和历史会话删除能力。
- 完全权限必须由用户显式确认，且只保存为当前服务内存状态。

## 验证结果

- TypeScript 类型检查通过。
- Vitest：13 个测试文件、46 项测试通过。
- Playwright：桌面/H5 共 6 项端到端测试通过。
- 前端和服务端生产构建通过。
- 生产依赖审计：0 vulnerabilities。
- 真实 Codex app-server 初始化、会话恢复、输入提交、双会话恢复和同会话防重复通过。

测试和截图详情见：

- [M11-M12 最终报告](../final-report-2026-07-15.md)
- [桌面与 H5 验收截图](../acceptance/2026-07-15/README.md)

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

发布验收期间，当前外部模型代理 `https://proxy.newbeechat.com/v1/responses` 持续返回 `502 Bad Gateway`。本地 Web、app-server、恢复、输入、状态和错误展示链路均验证通过；代理恢复后需补做一次真实新模型回复和真实审批生成的环境复验。
