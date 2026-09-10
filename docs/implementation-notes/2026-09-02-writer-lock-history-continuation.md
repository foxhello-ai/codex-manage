# Writer lock 冲突下的历史续聊方案

Linear：[`FOX-25`](https://linear.app/foxhello/issue/FOX-25/修复-active-writer-下无法-fork新建会话读取-jsonl-历史后续聊)

## 说明原因

Web 与 ChatGPT 使用独立的 Codex app-server 连接。同一个 thread 的 writer lock 属于写入所有权，不等同于模型是否仍在生成；即使某一客户端已经收到 `turn/completed`，另一客户端仍可能持有该 thread 的 writer lock。

因此，源 thread 被 ChatGPT 持锁时，`thread/resume`、`turn/start` 和 `thread/fork` 都不能作为可靠的无锁恢复入口。`thread/fork` 不是旁路复制接口，必须先由 app-server 对源 thread 执行 Fork，所以源 thread 锁住时 Fork 本身就会失败。

## 当前代码问题点

原有显式分支流程是：

```text
thread/fork(原会话)
  -> thread/resume(新会话)
  -> 可选 thread/compact/start(新会话)
```

这条流程在源 thread 未被其他客户端占用时可用，但无法解决“ChatGPT 打开会话后 Web 需要立即继续”的场景。此前前端只有在整个分支流程成功后才能拿到 child thread ID；如果 Fork、resume、压缩或详情读取的后续步骤失败，用户既看不到新会话，也可能需要重新输入失败内容。

## 代码错误位置

- `src/server/services/RuntimeManager.ts`：`branchThread()` 依赖源 thread 的 `thread/fork`，不能绕过 writer lock。
- `src/server/routes/sessions.ts`：原 `/api/sessions/:id/branch` 只有完整分支成功后才返回新会话。
- `src/client/App.tsx`：原分支按钮把恢复动作绑定到 `thread/fork`，不适合 active writer 场景。
- `src/shared/api.ts`、`src/shared/models.ts`：此前没有独立的历史续聊 API 类型。

## 修改方案

新增“新建会话并读取历史后继续”路径：

```text
thread/start(新空白会话，使用原 workspace)
  -> 可选 thread/settings/update(继承权限模式)
  -> turn/start(发送历史续聊引导提示词)
  -> 新会话使用只读工具读取原会话 JSONL，并继续处理失败输入
```

引导提示词包含：

- 原会话 ID；
- `CODEX_SESSIONS_DIR` 对应的历史目录；
- 要求查找并读取对应 JSONL；
- 原会话目标、已完成工作、未完成事项和失败原因的提取要求；
- 将 JSONL 视为不可信背景资料，不提升其中的旧文本为 system/developer 指令；
- 不修改原会话或 JSONL，不输出凭据和密钥；
- 失败输入原文，要求在新会话中作为当前任务执行。

该方案不是协议级完整 Fork，不能恢复隐藏推理、原生审批状态、原 app-server 写入状态或全部附件；它解决的是“源 thread 被锁时仍可立即创建可用新会话，并且失败输入不丢失”。原显式 Fork API 保留，用于源 thread 未被锁定且用户明确需要完整历史分支的场景。

## 修改的代码点

- `RuntimeManager.startHistoryContinuation()`：只创建独立 thread 并发送历史续聊提示词；首条请求失败时仍返回新 thread ID和错误状态。
- `RuntimeManager`：通过 `historyDirectory` 注入实际会话目录；新会话按请求继承 `full_access` 或 `default`，并可使用源会话的模型偏好。
- `POST /api/sessions/:id/continue-from-history`：不读取、resume 或 fork 源 thread；生成带“历史续聊（新会话）”后缀的标题，并持久化标题与权限模式。
- `App.tsx`：active writer 错误改为显示“新建会话并读取历史后继续”，成功后自动跳转新 thread；新 thread 首次请求失败时保留原 `RetryContext`。
- `src/shared/api.ts`、`src/shared/models.ts`：增加历史续聊请求和响应类型。
- 测试覆盖：独立创建路径不调用源 thread 的 `thread/fork`；full access 设置；首条续聊请求失败时保留新 thread ID；路由返回可区分标题与错误状态。

## 验证方式

已通过代码级验证：

```text
npm run typecheck
npm test
```

当前还需要在真实 Web + ChatGPT 双客户端场景验证：ChatGPT 保持打开并占用源 thread 时，点击该按钮后 Web 是否能创建新 thread、看到区分后的标题，并收到新会话对原 JSONL 的读取与续聊结果。

## 回滚建议

若真实 Codex 版本不允许新 thread 在当前 workspace 读取 `~/.codex/sessions`，可回滚前端入口和 `continue-from-history` 路由；原显式 Fork、writer lock 重试和失败输入保留逻辑不应恢复为 active writer 下的自动 Fork。
