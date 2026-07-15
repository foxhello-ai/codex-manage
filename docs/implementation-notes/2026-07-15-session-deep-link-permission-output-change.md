# 会话深链接、完全权限与实时反馈变更设计

## 基本信息

- 日期：2026-07-15
- 依据：[技术调研记录](./2026-07-15-session-deep-link-permission-output-research.md)
- 状态：实施中，权限交互与实时发送体验已完成，深链接和生产 SPA 回退待实现

## 变更目标

1. 进入会话详情后使用 `/<sessionId>`，浏览器刷新、前进和后退均能恢复正确详情。
2. 允许用户为当前恢复会话显式启用 Codex 完全权限，避免该会话持续等待审批。
3. 任务进入待输入后停止实时输出自动跳底，便于阅读结果。
4. 发送任务后立即展示用户消息和提交状态。
5. 支持 `Ctrl+Enter` 发送，保留 `Enter` 换行。

## 详细设计

### 1. URL 与页面状态

- 列表页使用 `/`。
- 详情页使用 `/<sessionId>`，`sessionId` 使用 URL 编码。
- 应用初始化时读取 `window.location.pathname`：根路径展示列表，单段路径按会话 ID 加载详情。
- 用户从列表进入详情时使用 `history.pushState`；返回列表时使用 `history.pushState` 回到 `/`。
- 监听 `popstate`，按 URL 切换页面和当前会话，不依赖重新选择列表项。
- 找不到会话、会话被搜索过滤或详情加载失败时展示错误和返回列表入口，不将 URL 静默替换为其他会话。
- 部署说明要求将非 `/api/*` 且非静态资源的路径回退到前端入口文件。

### 2. 完全权限

#### 交互

- 在详情页运行状态区域提供“完全权限”开关或同等明确控件。
- 默认关闭，显示“需审批”。
- 用户开启时弹出二次确认，明确说明该会话将跳过审批并以 Web 服务账号拥有完整文件及网络访问权限。
- 确认后显示“完全权限已启用”状态；取消则不改变当前策略。
- 仅允许在会话尚未恢复、`waiting_input`、`exited` 或 `failed` 时更改。运行中和待审批时禁用该控件，避免改变正在执行的权限边界。
- 关闭完全权限后，下一次恢复使用默认审批策略；不修改 `~/.codex/config.toml`，不写入 Codex 原始 session JSONL。

#### 数据与接口

- 扩展恢复请求为可选 body：`{ permissionMode?: "default" | "full_access" }`。
- 默认值为 `default`，保持现有行为。
- 服务端根据模式调用：

```ts
appServer.request("thread/resume", {
  threadId,
  sandbox: "danger-full-access",
  approvalPolicy: "never"
});
```

- `RuntimeSnapshot` 增加当前内存态 `permissionMode`，通过恢复接口、运行状态接口和 WebSocket `session_status` 返回。
- 当 `permissionMode === "full_access"` 时，前端隐藏审批操作区，并保留状态标识。若 Codex 仍产生非普通审批请求，继续展示错误或兼容处理，不自动批准未知请求。
- App Server 或 Web 服务重启后，运行态清空；用户再次恢复时需重新选择该模式。

### 3. 实时输出滚动

- `LiveOutputPanel` 接收当前 `runtime.status`。
- 仅当状态为 `starting` 或 `running` 时，在新实时消息或命令输出到来后自动滚动到底部。
- `waiting_input`、`waiting_approval`、`exited`、`failed` 和 `history` 时保留用户当前滚动位置。
- 用户再次发送任务并进入运行态后，恢复自动跟随最新输出。
- 不改变实时消息数量限制、命令输出截断、事件缓存和历史内容折叠规则。

### 4. 用户消息即时回显

- 定义实时消息的角色和投递状态：`user | agent` 与 `sending | sent | failed`。
- 用户点击发送或使用快捷键时，先插入一条本地 `user/sending` 消息，再调用输入接口。
- 接口成功后更新为 `user/sent`；接口失败后更新为 `user/failed`，并保留现有运行错误提示。
- Codex 的 `agent_message_delta` 继续追加到 `agent` 消息，不与本地消息合并。
- 切换会话时清空该会话的内存实时消息；展开历史内容时仍只展示解析出的历史会话记录。

### 5. 输入快捷键

- textarea 的 `Ctrl+Enter` 调用与提交按钮相同的提交函数，并调用 `preventDefault()` 防止换行。
- macOS 同时兼容 `Meta+Enter`。
- 不带修饰键的 `Enter` 保留 textarea 换行行为。
- 禁用状态、空文本校验、待审批限制和重复提交防护沿用当前逻辑。

## 涉及模块

- `src/client/App.tsx`：URL 同步、页面初始化、权限控件、实时消息状态、滚动条件和快捷键。
- `src/client/styles.css`：完全权限状态、确认弹层、用户消息投递状态的视觉区分，以及移动端适配。
- `src/shared/models.ts`：权限模式和实时消息相关共享数据模型。
- `src/shared/api.ts`：恢复请求 body 类型。
- `src/server/routes/sessions.ts`：恢复请求参数校验和权限模式传递。
- `src/server/services/RuntimeManager.ts`：按模式恢复、内存运行态记录及状态推送。
- `src/server/routes/sessions.test.ts`、`src/server/services/RuntimeManager.test.ts`：接口及协议参数测试。


## 实施进度

### 已完成：接口闭环

- `resume` 和 `input` 请求均校验 `permissionMode`，仅接受 `default` 与 `full_access`。
- 首次以完全权限恢复时，`thread/resume` 传递 `sandbox: "danger-full-access"` 与 `approvalPolicy: "never"`。
- 已恢复且处于 `waiting_input` 时，使用 `thread/settings/update` 双向切换权限：
  - 完全权限使用 `approvalPolicy: "never"` 与 `sandboxPolicy.type: "dangerFullAccess"`。
  - 需审批模式使用 `approvalPolicy: "on-request"` 与内置 `:workspace` 权限配置。
- `running`、`starting` 与 `waiting_approval` 状态由服务端拒绝切换权限。
- `RuntimeSnapshot.permissionMode` 通过 HTTP 和 WebSocket 运行态事件同步。

### 已完成：Web 交互

- 详情页运行状态区域新增“完全权限”开关，默认显示“需审批”。
- 启用完全权限前展示二次确认，明确提示跳过审批及完整文件系统、网络访问风险。
- 完全权限状态在运行面板及浮动运行状态中显著展示。
- 运行中、启动中和待审批状态禁用权限开关。
- 完全权限生效时隐藏普通审批操作区；若仍收到审批请求，仅展示异常提示，不自动批准。
- 桌面端和 H5 均提供稳定的开关触控区域及响应式确认弹层。
- 发送任务时立即插入用户消息，并展示 `发送中`、`已发送`、`发送失败` 状态。
- 发送失败时保留输入框原文和失败消息，便于用户修正或重试。
- 实时输出仅在 `starting` 或 `running` 状态自动跟随到底部，其他状态保留阅读位置。
- 支持 `Ctrl+Enter` 和 `Meta+Enter` 发送，普通 Enter 保持换行；连续触发不会并发提交。
- 切换会话后，旧会话尚未完成的输入请求不会覆盖新会话运行态或消息状态。

### 待实现

- 会话详情 URL 深链接与浏览器前进、后退。
- 生产部署 SPA 回退说明与对应验收。

### 验证

- `npm run typecheck`：通过。
- `npm test`：9 个测试文件、28 项测试通过。
- `npm run build`：通过。

## 验收标准

1. 打开 `/<有效会话ID>`、刷新页面和浏览器前进/后退后，仍展示同一会话详情。
2. 无效会话 ID 显示可理解错误，不错误跳转到其他会话。
3. 默认模式恢复请求不附带完全权限字段，保持当前审批流程。
4. 完全权限确认后，恢复请求准确传递 `sandbox: "danger-full-access"` 和 `approvalPolicy: "never"`；其他会话的恢复参数不受影响。
5. 完全权限切换在运行中和待审批状态不可用，并有明确原因提示。
6. 运行中实时输出继续自动跟随；进入 `waiting_input` 后新增渲染不改变滚动位置。
7. 发送后立即显示用户内容；成功、失败分别显示正确投递状态。
8. `Ctrl+Enter` 和 `Meta+Enter` 各发送一次，普通 `Enter` 只换行；重复触发不会并发发送。
9. 桌面端和 H5 均可完成详情访问、权限确认、输入发送和查看实时输出。
10. `npm run typecheck`、`npm test` 与 `npm run build` 通过。

## 非目标

- 不修改 Codex 原始会话 JSONL 或全局 `~/.codex/config.toml`。
- 不改变历史会话删除限制。
- 不将完全权限设置持久化为全局或跨服务重启配置。
- 不新增多用户授权模型或远程 App Server 暴露。
