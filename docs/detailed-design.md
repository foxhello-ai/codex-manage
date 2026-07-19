# Codex Web 会话管理详细设计文档

## 1. 设计目标

基于需求文档和技术调研，实现一个局域网可访问、单用户密码保护的 Codex Web 会话管理台。

核心目标：

- 展示 `~/.codex/sessions` 中的 Codex 历史会话。
- 查看会话详情、历史消息和历史命令。
- 通过 Codex app-server 的 `thread/resume` 恢复会话。
- 在 Web 中继续发送任务。
- 实时展示 Codex 输出、命令执行过程和审批请求。
- 支持 H5 移动端使用。
- 不提供删除历史会话能力。

## 2. 总体架构

```text
Browser
  |
  | HTTP / WebSocket
  v
Web Server (Fastify)
  |
  | Auth / API / Static Assets
  v
Application Services
  |
  |-- SessionService
  |-- JsonlSessionParser
  |-- RuntimeManager
  |-- CodexAppServerClient
  |-- EventHub
  |-- ApprovalService
  |
  v
Codex CLI
  |
  | codex app-server stdio JSON-RPC
  v
~/.codex/sessions
```

## 3. 技术栈

后端：

- Node.js
- TypeScript
- Fastify
- `child_process.spawn`
- WebSocket
- Zod 或 TypeBox 做输入校验

前端：

- React
- Vite
- TypeScript
- React Router
- Zustand 或轻量 Context 状态管理
- CSS Modules 或普通 CSS

Codex 集成：

- 默认使用 `codex app-server` stdio JSON-RPC。
- app-server 不可用时返回明确错误。
- PTY/TUI fallback 作为后续扩展，不进入 MVP 主路径。

## 4. 目录结构

建议目录：

```text
.
├── docs/
├── package.json
├── tsconfig.json
├── vite.config.ts
├── src/
│   ├── server/
│   │   ├── index.ts
│   │   ├── config.ts
│   │   ├── auth/
│   │   ├── routes/
│   │   ├── services/
│   │   │   ├── SessionService.ts
│   │   │   ├── JsonlSessionParser.ts
│   │   │   ├── RuntimeManager.ts
│   │   │   ├── CodexAppServerClient.ts
│   │   │   ├── ApprovalService.ts
│   │   │   └── EventHub.ts
│   │   └── types/
│   ├── shared/
│   │   ├── api.ts
│   │   ├── events.ts
│   │   └── models.ts
│   └── client/
│       ├── main.tsx
│       ├── App.tsx
│       ├── pages/
│       ├── components/
│       ├── hooks/
│       └── styles/
└── tests/
```

## 5. 配置设计

配置来源：

- 环境变量。
- 默认值。
- 后续可增加配置文件。

配置项：

```text
CODEX_WEB_HOST=0.0.0.0
CODEX_WEB_PORT=4310
CODEX_WEB_PASSWORD=fmzh2026
CODEX_CLI_PATH=codex
CODEX_SESSIONS_DIR=~/.codex/sessions
CODEX_WEB_SESSION_SECRET=<auto-or-env>
```

默认值：

- 监听地址：`0.0.0.0`
- 监听端口：`4310`
- 默认密码：`fmzh2026`
- Codex CLI：`codex`
- 会话目录：`~/.codex/sessions`

安全要求：

- 默认不展示密码风险提示。
- session secret 未设置时，开发模式可自动生成；正式使用建议显式配置。

## 6. 认证设计

认证方式：

- 单密码登录。
- 后端校验密码。
- 登录成功后写入 signed cookie 或 server-side session。

接口：

- `POST /api/login`
- `POST /api/logout`
- `GET /api/me`

接口语义：

- `GET /api/me` 允许未登录访问，返回当前认证状态。
- 未登录时返回 `{ authenticated: false, defaultPassword: boolean }`，前端据此渲染登录页。
- 登录后返回 `{ authenticated: true, defaultPassword: boolean }`。
- 登出接口应清除 cookie，并返回未登录状态，保证登录/登出闭环可验证。

权限边界：

- 除登录接口、`GET /api/me` 和静态资源外，所有 API 和 WebSocket 连接都必须认证。
- WebSocket 握手时校验 cookie。
- 未登录访问管理接口返回 `401`。
- 未登录访问 `GET /api/me` 返回 `200` 和未登录状态。

## 7. Codex App Server 适配设计

### 7.1 运行方式

后端通过子进程启动：

```bash
codex app-server
```

使用 stdio transport：

- stdin 写入 JSON-RPC request。
- stdout 读取 JSON-RPC response、notification、server request。
- stderr 记录为诊断日志。

### 7.2 JSON-RPC 客户端

`CodexAppServerClient` 职责：

- 启动和停止 app-server 子进程。
- 完成 `initialize` / `initialized` 握手。
- 维护递增 request id。
- 将 response 按 id 分发给 pending promise。
- 将 notification 分发给 EventHub。
- 将 server request 分发给 ApprovalService。
- 处理进程退出和重启。

### 7.3 核心方法

封装以下方法：

- `initialize()`
- `listThreads(params)`
- `readThread(threadId, includeTurns)`
- `resumeThread(threadId)`
- `startTurn(threadId, input)`
- `steerTurn(threadId, expectedTurnId, input)`
- `interruptTurn(threadId, turnId)`
- `respondToServerRequest(requestId, payload)`

### 7.4 版本检测

启动时执行：

```bash
codex --version
```

记录：

- Codex CLI 版本。
- Node.js 版本。
- app-server 是否可用。

如果 app-server 不可用：

- 会话列表可退化为 JSONL 扫描。
- 恢复和继续任务不可用，并在 UI 中提示。

## 8. 会话列表设计

优先数据源：

- `thread/list`

补充数据源：

- JSONL 文件扫描。

列表字段：

- `id`
- `sessionId`
- `name`
- `remarkTitle`
- `displayTitle`
- `preview`
- `cwd`
- `createdAt`
- `updatedAt`
- `status`
- `cliVersion`
- `source`
- `path`

排序：

- 默认按 `updatedAt` 倒序。

搜索：

- 优先使用 `thread/list.searchTerm`。
- Web 管理台应将备注标题纳入搜索。
- 如果 app-server 搜索无法覆盖备注标题，后端应对本地会话元数据做补充过滤。
- 前端可做本页补充过滤。

状态映射：

```text
notLoaded -> history
running -> running
inProgress -> running
completed -> exited
failed -> failed
```

实际映射应以当前 app-server schema 的 `ThreadStatus` 为准。

备注标题：

- 备注标题是 Codex Manage 自己的会话展示元数据。
- 备注标题不写入 `~/.codex/sessions`，避免破坏 Codex 原生会话。
- 列表显示标题优先级：备注标题 > Codex thread name > preview 摘要 > thread id。
- 备注标题支持设置、修改和清空。
- 备注标题存储可以在 MVP 使用本地 JSON 元数据文件，后续再替换为数据库。

## 9. 会话详情设计

详情数据：

- `thread/read includeTurns=true`
- `thread/resume` 返回的 `initialTurnsPage`
- JSONL parser 补充的历史命令记录

展示内容：

- 会话元信息。
- 历史用户消息。
- 历史 agent 消息。
- 文件变更记录。
- 历史命令记录。
- 当前运行状态。
- 实时事件流。

详情页不修改原始历史文件。

## 10. JSONL 解析设计

`JsonlSessionParser` 职责：

- 扫描 `~/.codex/sessions/**/*.jsonl`。
- 从文件名和 `session_meta` 建立 threadId 到文件路径的映射。
- 解析历史命令调用。
- 解析历史命令输出。
- 解析必要的元信息兜底字段。

历史命令匹配：

- `response_item.payload.type == "function_call"`
- `payload.name == "exec_command"`
- 通过 `payload.call_id` 关联 `function_call_output.payload.call_id`

命令字段：

- `cmd`
- `workdir`
- `sandbox_permissions`
- `justification`
- `prefix_rule`
- `yield_time_ms`
- `max_output_tokens`

输出字段：

- `function_call_output.payload.output`

降级策略：

- JSON 解析失败时跳过该行并记录诊断。
- 命令参数解析失败时展示原始参数摘要。
- 找不到输出时展示命令无输出或输出缺失。

## 11. RuntimeManager 设计

职责：

- 管理 app-server client 生命周期。
- 管理 thread runtime 状态。
- 防止同一 thread 重复启动。
- 记录 active turn。
- 记录 pending approvals。
- 维护最近事件缓存。

MVP 采用单 app-server 进程管理多个 thread。

理由：

- app-server 协议原生支持 thread/list、thread/read、thread/resume。
- `thread/resume` 对运行中 thread 有 rejoin 语义。
- 单进程更容易统一事件分发和审批请求路由。

RuntimeState：

```ts
type RuntimeStatus =
  | "history"
  | "starting"
  | "running"
  | "waiting_input"
  | "waiting_approval"
  | "exited"
  | "failed";
```

状态字段：

- `threadId`
- `status`
- `activeTurnId`
- `startedAt`
- `updatedAt`
- `lastError`
- `pendingApprovalCount`
- `eventSeq`

## 12. 继续任务设计

用户输入流程：

1. 前端提交文本。
2. 后端检查登录态。
3. 后端检查 thread 是否已 resume。
4. 如果没有 active turn，调用 `turn/start`。
5. 如果已有 active turn 且允许追加输入，调用 `turn/steer`。
6. app-server 事件通过 WebSocket 推送给前端。

MVP 建议：

- 普通新任务使用 `turn/start`。
- 正在执行时的追加输入仅在明确支持场景下使用 `turn/steer`。
- 如果当前 turn 正在等待审批，输入框禁用，优先处理审批。

## 13. 审批设计

ApprovalService 职责：

- 接收 app-server server request。
- 生成 Web 端 approval id。
- 保存 request id 和 params 的映射。
- 推送审批事件到对应 thread。
- 接收前端审批决策。
- 向 app-server 写回 JSON-RPC response。
- 防止重复审批。

支持审批类型：

- command execution approval
- file change approval
- permissions approval
- tool user input

MVP UI 决策：

- 命令审批：允许、允许本会话、拒绝、取消。
- 文件变更审批：允许、允许本会话、拒绝、取消。
- 权限审批：先以允许/拒绝表达，具体 response 结构在实现时按 schema 映射。
- 用户输入请求：展示问题表单。

审批状态：

- `pending`
- `approved`
- `approved_for_session`
- `declined`
- `cancelled`
- `resolved`
- `failed`

## 14. 实时事件设计

后端内部事件统一为：

```ts
type WebEvent =
  | SessionStatusEvent
  | TurnStartedEvent
  | TurnCompletedEvent
  | AgentMessageDeltaEvent
  | CommandStartedEvent
  | CommandOutputDeltaEvent
  | CommandCompletedEvent
  | FileChangeEvent
  | ApprovalRequestedEvent
  | ApprovalResolvedEvent
  | ErrorEvent
  | WarningEvent;
```

WebSocket 消息：

```json
{
  "seq": 1,
  "threadId": "string",
  "type": "agent_message_delta",
  "payload": {}
}
```

事件缓存：

- 每个 thread 保留最近 N 条事件。
- 默认 N 可设为 500。
- 页面刷新后重新订阅并获取快照。

## 15. API 设计

认证：

- `POST /api/login`
- `POST /api/logout`
- `GET /api/me`

说明：`GET /api/me` 是认证状态探测接口，允许未登录访问并返回 `authenticated: false`；其他管理接口仍必须要求登录。

会话：

- `GET /api/sessions`
- `GET /api/sessions/:id`
- `GET /api/sessions/:id/commands`
- `PATCH /api/sessions/:id/metadata`

备注标题请求示例：

```json
{
  "remarkTitle": "string"
}
```

`remarkTitle` 为空字符串或 `null` 时表示清空备注标题。

运行：

- `POST /api/sessions/:id/resume`
- `POST /api/sessions/:id/input`
- `POST /api/sessions/:id/interrupt`
- `GET /api/sessions/:id/runtime`

审批：

- `POST /api/sessions/:id/approvals/:approvalId`

配置：

- `GET /api/config`
- `GET /api/health`

实时：

- `WS /api/sessions/:id/ws`

## 16. 前端页面设计

### 16.1 登录页

功能：

- 密码输入。
- 登录。
- 默认密码风险提示。

### 16.2 会话列表页

桌面端：

- 左侧列表。
- 右侧可展示选中详情或空状态。

移动端：

- 默认展示当前工作区或详情内容，不直接占满首屏显示完整会话列表。
- 会话列表默认收起在侧边栏/抽屉中。
- 点击会话列表按钮后，从侧边或底部打开列表抽屉。
- 抽屉内保留搜索框、刷新按钮和会话列表。
- 点击会话后关闭抽屉并进入详情页。

元素：

- 搜索框。
- 状态筛选。
- 会话卡片。
- 备注标题编辑入口。
- 设置入口。
- 登出按钮。
- 登录按钮必须在未登录首屏可见。

### 16.3 会话详情页

桌面端：

- 顶部元信息。
- 中间消息流。
- 右侧或下方命令/审批区域。
- 底部输入框。

移动端：

- 单栏。
- 顶部返回按钮。
- 元信息可折叠。
- 消息和命令按时间流展示。
- 输入框固定底部。
- 审批用底部弹层或全屏面板。

### 16.4 设置页

MVP 只读展示：

- Codex CLI 路径。
- Codex CLI 版本。
- sessions 目录。
- listen host/port。
- app-server 状态。
- 当前密码是否为默认值。

## 17. H5 适配设计

移动端断点：

- 小于 `768px` 使用移动布局。

交互要求：

- H5 会话列表默认收起，使用侧边栏或抽屉承载。
- H5 会话列表抽屉内必须支持搜索。
- H5 会话列表抽屉打开时应有明确关闭方式。
- 主要按钮触控区域不小于 44px。
- 输入框固定底部时避开安全区域。
- 使用 `env(safe-area-inset-bottom)`。
- 长命令使用等宽字体并允许横向滚动。
- 长输出默认折叠。
- 审批按钮固定在审批卡片底部。
- 不依赖 hover。

## 18. 安全设计

必须实现：

- 所有 API 鉴权。
- WebSocket 鉴权。
- 禁止删除会话。
- 禁止提供任意文件读取。
- JSONL parser 只读取 sessions 目录。
- 所有用户输入做长度限制。
- 审批请求必须由已登录用户触发。

不实现：

- 多用户权限。
- 公网认证体系。
- OAuth。
- 删除历史会话。

## 19. 错误处理

错误场景：

- Codex CLI 不存在。
- Codex CLI 版本过旧。
- app-server 启动失败。
- JSON-RPC 初始化失败。
- thread 不存在。
- thread/read 失败。
- thread/resume 失败。
- turn/start 失败。
- 审批 request 已过期。
- WebSocket 断开。

错误响应：

```json
{
  "error": {
    "code": "CODEX_APP_SERVER_UNAVAILABLE",
    "message": "Codex app-server is unavailable",
    "details": {}
  }
}
```

## 20. 测试策略

单元测试：

- JSONL parser。
- app-server JSON-RPC message router。
- approval state machine。
- runtime state mapping。
- API input validation。

集成测试：

- 登录流程。
- 会话列表。
- 会话详情。
- resume 流程。
- WebSocket 订阅。
- 审批请求模拟。

端到端测试：

- 桌面会话列表和详情。
- 移动端 H5 页面。
- 输入框软键盘布局。
- 审批弹层。
- 长命令输出折叠。

手工验收：

- 使用真实 `~/.codex/sessions`。
- 使用真实 `codex app-server`。
- 验证恢复和继续任务。

## 21. MVP 验收标准

- 未登录打开 Web 时能看到登录页和登录按钮。
- 能登录和登出。
- 登出后回到未登录状态。
- 未登录不能访问管理 API 和 WebSocket，`GET /api/me` 除外。
- 能显示历史会话列表。
- H5 移动端会话列表默认收起，点击后以侧边栏或抽屉展示。
- H5 会话列表抽屉内能搜索会话。
- 能搜索会话。
- 能设置、修改和清空会话备注标题。
- 能查看历史消息。
- 能查看历史命令记录。
- 能通过 `thread/resume` 恢复会话。
- 能发送新任务。
- 能实时显示 agent 文本输出。
- 能实时显示命令输出。
- 能展示并处理审批请求。
- 移动端可完整完成登录、查看、恢复、输入、审批。
- 不提供删除历史会话能力。

## 22. 增量详细设计

### 22.1 会话模型切换

app-server 当前支持模型列表、会话级模型覆盖、历史模型解析、运行时状态、桌面/H5 交互、错误恢复和测试设计以以下文档为准：

- [Codex Web 会话模型切换详细设计](./model-change-detailed-design.md)

该文档已于 2026-07-19 由用户审核通过，实施按 [会话模型切换任务计划](./model-change-task-plan.md) 执行。
