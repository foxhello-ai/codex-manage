# Codex Web 会话管理任务规划文档

## 1. 目标

按 MVP 范围实现 Codex Web 会话管理台，并满足 H5 移动端使用要求。

MVP 交付物：

- 可运行的 Web 服务。
- 单密码登录。
- 会话列表。
- H5 收起式会话列表侧边栏/抽屉。
- 会话备注标题。
- 会话详情.
- `thread/resume` 恢复。
- Web 输入继续任务。
- 实时输出。
- 审批交互。
- 历史命令展示。
- H5 移动端适配。

## 2. 开发原则

- 优先使用 Codex app-server JSON-RPC。
- 不模拟终端 TUI 作为主路径。
- 不提供删除历史会话能力。
- 运行态 MVP 使用内存管理。
- JSONL 解析只作为历史命令补充。
- H5 移动端不是后补项，页面开发时同步验收。

## 3. 里程碑

### M0：项目脚手架

目标：

- 建立 TypeScript 全栈项目基础。
- 能启动后端和前端开发环境。

任务：

- 初始化 `package.json`。
- 配置 TypeScript。
- 配置 Fastify。
- 配置 Vite + React。
- 配置 lint/test 基础命令。
- 建立 `src/server`、`src/client`、`src/shared`。

验收：

- `npm install` 成功。
- `npm run dev` 可启动。
- 浏览器能打开基础页面。

### M1：认证和配置

目标：

- 实现单密码登录和基础配置读取。

任务：

- 实现配置模块。
- 实现 `POST /api/login`。
- 实现 `POST /api/logout`。
- 实现 `GET /api/me`，允许未登录访问并返回认证状态。
- 实现登录页，未登录首屏必须显示登录按钮。
- 实现登出入口，登出后清除登录态并回到未登录状态。
- 实现路由保护，除 `POST /api/login` 和 `GET /api/me` 外的管理接口必须登录。
- 默认密码为 `admin`，不展示密码风险提示。

验收：

- 正确密码可登录。
- 错误密码不可登录。
- 未登录访问管理 API 返回 `401`。
- 未登录访问 `GET /api/me` 返回 `authenticated: false`。
- 登录后能访问管理 API。
- 登出后管理 API 重新返回 `401`。
- 登录态刷新页面后仍有效。

### M2：Codex app-server 客户端

目标：

- 后端能启动并对接 `codex app-server`。

任务：

- 实现 `CodexAppServerClient`。
- 实现 initialize 握手。
- 实现 request/response 分发。
- 实现 notification 分发。
- 实现 server request 分发。
- 实现进程退出处理。
- 实现 `codex --version` 检测。

验收：

- 服务启动后能检测 Codex CLI 版本。
- 能完成 app-server initialize。
- app-server 不可用时返回明确错误。

### M3：会话列表

目标：

- 使用 `thread/list` 展示历史会话。

任务：

- 实现 `SessionService.listSessions`。
- 实现 `GET /api/sessions`。
- 实现搜索参数。
- 实现状态映射。
- 实现会话列表 UI。
- 实现移动端收起式列表侧边栏/抽屉。
- 实现抽屉内搜索。
- 实现会话备注标题展示、设置、修改和清空。

验收：

- 能显示 `~/.codex/sessions` 中的历史会话。
- 默认按更新时间倒序。
- 搜索可用。
- 移动端列表默认收起，点击后以侧边栏或抽屉展示。
- 移动端抽屉内搜索可用。
- 会话备注标题可设置、修改和清空。

### M4：会话详情

目标：

- 使用 `thread/read includeTurns=true` 展示历史消息。

任务：

- 实现 `SessionService.getSessionDetail`。
- 实现 `GET /api/sessions/:id`。
- 映射 userMessage、agentMessage、fileChange。
- 实现详情页消息流。
- 实现元信息展示。
- 实现移动端详情页。

验收：

- 可进入会话详情。
- 可看到历史用户消息和 agent 消息。
- 可看到 cwd、createdAt、updatedAt、cliVersion 等信息。
- 移动端可完整浏览。

### M5：JSONL 历史命令解析

目标：

- 补充展示历史命令执行记录。

任务：

- 实现 sessions 目录扫描。
- 建立 threadId 到 JSONL 文件路径映射。
- 解析 `exec_command` function_call。
- 解析 function_call_output。
- 实现 `GET /api/sessions/:id/commands`。
- 前端展示历史命令列表。
- 长输出折叠。

验收：

- 能显示历史命令内容、workdir、审批参数摘要。
- 能显示历史命令输出。
- JSONL 解析失败不影响详情页主流程。

### M6：恢复会话

目标：

- 使用 `thread/resume` 恢复指定会话。

任务：

- 实现 `RuntimeManager.resumeThread`。
- 实现 `POST /api/sessions/:id/resume`。
- 防止同一 thread 重复恢复。
- 保存 runtime 状态。
- 前端实现恢复按钮和运行状态。

验收：

- 点击恢复后成功调用 `thread/resume`。
- 重复点击不会创建重复 runtime。
- 恢复失败时 UI 展示错误。

### M7：实时通道

目标：

- 前后端建立会话级 WebSocket。

任务：

- 实现 `EventHub`。
- 实现 `WS /api/sessions/:id/ws`。
- 实现 WebSocket 鉴权。
- 实现事件序号。
- 实现最近事件缓存。
- 前端实现事件订阅和重连。

验收：

- 已登录用户可订阅会话事件。
- 未登录连接被拒绝。
- 页面刷新后能重新订阅。

### M8：继续任务

目标：

- 在 Web 中发送新任务并显示实时输出。

任务：

- 实现 `POST /api/sessions/:id/input`。
- 封装 `turn/start`。
- 必要时封装 `turn/steer`。
- 处理 `turn/started`、`turn/completed`。
- 处理 `item/agentMessage/delta`。
- 前端实现底部输入框。
- 移动端适配软键盘。

验收：

- 恢复后的会话可发送任务。
- 能实时看到 agent 回复。
- turn 完成后状态更新。
- 移动端可输入和发送。

### M9：命令执行过程

目标：

- 实时展示运行中新命令的执行过程。

任务：

- 处理 `item/started` 中的 commandExecution。
- 处理 `item/commandExecution/outputDelta`。
- 处理 `item/completed`。
- 前端展示命令卡片。
- 输出默认折叠。
- 支持复制命令。

验收：

- 命令开始、输出、完成能实时展示。
- 长输出不会卡住页面。
- 移动端命令卡片可读可操作。

### M10：审批交互

目标：

- Web 端处理 Codex 审批请求。

任务：

- 实现 `ApprovalService`。
- 处理 `item/commandExecution/requestApproval`。
- 处理 `item/fileChange/requestApproval`。
- 处理 `item/permissions/requestApproval`。
- 处理 `item/tool/requestUserInput`。
- 实现 `POST /api/sessions/:id/approvals/:approvalId`。
- 前端实现审批卡片。
- 移动端实现审批底部弹层或全屏面板。

验收：

- 审批请求能显示。
- 允许、允许本会话、拒绝、取消能回传。
- 同一审批不能重复处理。
- 审批完成后 UI 状态更新。

### M11：设置和诊断

目标：

- 提供只读设置和健康检查。

任务：

- 实现 `GET /api/config`。
- 实现 `GET /api/health`。
- 展示 Codex CLI 版本。
- 展示 sessions 目录。
- 展示 app-server 状态。
- 展示监听地址和端口。

验收：

- 设置页能查看当前配置。
- app-server 异常能在设置页看到。

### M12：测试和验收

目标：

- 完成自动化和手工验收。

任务：

- 单元测试 JSONL parser。
- 单元测试 JSON-RPC router。
- 单元测试 approval state machine。
- API 集成测试。
- 前端关键页面测试。
- H5 移动端截图验收。
- 真实 Codex session 手工验收。

验收：

- 核心测试通过。
- 桌面端可用。
- 移动端可用。
- MVP 验收标准全部通过。

## 4. 推荐开发顺序

推荐按以下顺序开发：

1. M0 项目脚手架
2. M1 认证和配置
3. M2 Codex app-server 客户端
4. M3 会话列表
5. M4 会话详情
6. M5 JSONL 历史命令解析
7. M6 恢复会话
8. M7 实时通道
9. M8 继续任务
10. M9 命令执行过程
11. M10 审批交互
12. M11 设置和诊断
13. M12 测试和验收

## 5. 任务依赖

```text
M0 -> M1
M0 -> M2
M2 -> M3
M3 -> M4
M4 -> M5
M2 -> M6
M6 -> M7
M7 -> M8
M8 -> M9
M7 -> M10
M2 -> M11
M1..M11 -> M12
```

## 6. 风险任务

优先处理以下风险任务：

- M2 app-server 客户端。
- M6 thread/resume。
- M10 审批响应。
- M5 JSONL 命令解析。
- M8 移动端输入框软键盘适配。

这些任务决定 MVP 是否能闭环。

## 7. 开发完成定义

单个任务完成需要满足：

- 后端接口或前端页面已实现。
- 有必要的错误处理。
- 有基础测试或手工验证记录。
- 移动端布局不破。
- 不引入删除历史会话能力。
- 不绕过登录认证。

## 8. MVP 最终验收清单

- 未登录首屏显示登录按钮。
- 登录成功和失败路径正常。
- 登录后显示登出按钮。
- 登出后回到未登录状态。
- 未登录管理 API 和 WebSocket 被拒绝，`GET /api/me` 除外。
- 会话列表正常展示。
- H5 会话列表默认收起，点击后以侧边栏或抽屉展示。
- 会话搜索正常。
- H5 会话列表抽屉内搜索正常。
- 会话备注标题可设置、修改和清空。
- 会话详情正常展示。
- 历史命令可展示。
- `thread/resume` 成功。
- 可发送新任务。
- agent 文本实时显示。
- 命令输出实时显示。
- 审批请求可处理。
- 多个不同会话可同时恢复。
- 同一会话不会重复启动。
- 移动端登录、列表、详情、输入、审批完整可用。
- 不存在删除历史会话入口。

## 9. 当前进度记录（2026-07-14）

已完成：

- M0：项目脚手架。
- M1：认证和配置。
- M2：Codex app-server 客户端。
- M3：会话列表、H5 抽屉和备注标题。
- M4：会话详情。
- M5：JSONL 历史命令解析。
- M6：恢复会话，使用 `thread/resume`，同一 active thread 防重复恢复。
- M7：会话级 WebSocket，支持鉴权、事件序号、最近事件缓存和前端重连。
- M8：Web 输入继续任务，封装 `turn/start`，active turn 场景封装 `turn/steer`。
- M9：实时命令执行过程，展示开始、输出增量、完成和复制命令。
- M10：审批交互，支持命令执行、文件变更、权限请求和 `request_user_input`。
- M11：设置和诊断页面，包括只读配置、健康检查、CLI 版本和 app-server 异常展示。
- M12：单元、集成和 Playwright 桌面/H5 验收，真实 Codex session 恢复与输入链路验收。

2026-07-15 补充变更已完成：

- 会话详情深链接，支持刷新、浏览器前进和后退。
- 会话级完全权限模式、即时回显、实时输出滚动控制和发送快捷键。
- 生产前后端构建、Fastify 静态资源服务和 SPA 详情路径回退。

MVP 里程碑 M0-M12 已完成。当前外部模型代理持续返回 502，代理恢复后需补做一次真实模型回复和真实审批生成的环境复验；详见最终报告。

## 10. 增量任务计划

### 10.1 会话模型切换

会话级模型选择、故障模型恢复、推理强度、运行时一致性、桌面/H5 交互及验收采用独立里程碑编号 `MC-M0` 至 `MC-M8`：

- [Codex Web 会话模型切换实施任务计划](./model-change-task-plan.md)

该增量计划不修改既有 MVP M0-M12 的完成状态，不接入或修改 cc-switch。
