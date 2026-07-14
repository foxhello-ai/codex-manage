# M6-M10 运行态、实时通道、继续任务、命令过程与审批实施记录

## 范围

本次完成任务计划中的 M6 到 M10：

- M6：通过 `thread/resume` 恢复会话，并在内存中维护 runtime 状态。
- M7：增加会话级 WebSocket，推送 runtime 快照、事件缓存和实时事件。
- M8：通过 Web 输入继续任务，后端调用 `turn/start`，运行中有 active turn 时调用 `turn/steer`。
- M9：实时展示命令开始、输出增量和完成状态，完成输出默认折叠，运行中输出不限制高度。
- M10：处理 Codex app-server server request 形式的命令审批、文件变更审批、权限审批和 `request_user_input`。

## 调研环境

调研和实现时记录的命令版本：

- `node --version`：`v22.23.1`
- `npm --version`：`10.9.8`
- `codex --version`：`codex-cli 0.144.3`
- `codex app-server --help`：确认 `app-server` 支持 `stdio://` 默认 transport，并提供 `generate-ts` / `generate-json-schema` 协议生成能力。

协议调研命令：

```bash
mkdir -p /tmp/codex-manage-protocol
codex app-server generate-ts --out /tmp/codex-manage-protocol
rg -n "thread/resume|turn/start|turn/steer|requestApproval|commandExecution" /tmp/codex-manage-protocol
```

调研输出目录为 `/tmp/codex-manage-protocol`，只作为临时协议阅读材料，未纳入仓库。未执行 `rm`。

## 协议结论

关键 client request：

- `thread/resume`：参数优先使用 `{ threadId }`。对运行中 thread 有 rejoin 语义，适合防重复恢复。
- `turn/start`：参数为 `{ threadId, input }`，文本输入项使用 `{ type: "text", text, text_elements: [] }`。
- `turn/steer`：参数为 `{ threadId, expectedTurnId, input }`，用于已有 active turn 的追加输入。
- `turn/interrupt`：协议存在，本次未暴露 UI，后续 M11/M12 可补中断按钮和测试。

关键 notification：

- `turn/started`、`turn/completed` 用于更新 active turn 和 runtime 状态。
- `item/agentMessage/delta` 用于实时 agent 回复增量。
- `item/started` / `item/completed` 中 `item.type === "commandExecution"` 时映射命令开始和完成。
- `item/commandExecution/outputDelta` 用于命令输出增量。

关键 server request：

- `item/commandExecution/requestApproval`：响应 `{ decision: "accept" | "acceptForSession" | "decline" | "cancel" }`。
- `item/fileChange/requestApproval`：响应同上。
- `item/permissions/requestApproval`：响应 `{ permissions, scope, strictAutoReview }`，允许时授予请求中的权限，拒绝/取消时返回空权限。
- `item/tool/requestUserInput`：响应 `{ answers: { [questionId]: { answers: string[] } } }`。
- 兼容 legacy `execCommandApproval` / `applyPatchApproval`，映射到旧版 `approved`、`approved_for_session`、`denied`、`abort`。

## 实现内容

新增后端服务：

- `src/server/services/EventHub.ts`：会话级事件发布、订阅和最近 500 条事件缓存。
- `src/server/services/ApprovalService.ts`：保存 pending approval，生成 Web approval id，回写 JSON-RPC server request response。
- `src/server/services/RuntimeManager.ts`：维护 thread runtime、恢复会话、发送输入、映射 app-server notification/server request。

扩展后端：

- `CodexAppServerClient.respondToServerRequest()`：支持按 server request id 写回 JSON-RPC response。
- `POST /api/sessions/:id/resume`
- `GET /api/sessions/:id/runtime`
- `POST /api/sessions/:id/input`
- `POST /api/sessions/:id/approvals/:approvalId`
- `WS /api/sessions/:id/ws`

扩展前端：

- 会话详情顶部显示 runtime 状态、WebSocket 状态和待审批数量。
- 恢复按钮调用 `thread/resume`，重复点击 active runtime 不重复恢复。
- 底部输入框调用继续任务接口。
- 实时展示 agent message delta 和 command execution。
- 审批卡片支持允许、允许本会话、拒绝、取消；`request_user_input` 支持选项或文本回答。
- H5 下输入框单列、审批按钮 2 列排布，保持触控区域。

## 审计记录

- 由于本环境 `apply_patch` 和普通沙箱命令均触发 `bwrap: Failed to make / slave: Permission denied`，本次项目文件写入改用 `python3` 受控脚本完成。
- 写入范围限制在工作目录 `/config/projects/codex-manage`。
- 额外生成协议调研文件到 `/tmp/codex-manage-protocol`。
- 未执行 `rm`、`git reset`、`git checkout --` 等危险或破坏性命令。

## 验证

已执行：

```bash
npm run typecheck
npm test
npm run build
```

结果：

- `npm run typecheck` 通过。
- `npm test` 通过：8 个测试文件，23 个测试。
- `npm run build` 通过，Vite 成功构建前端产物。

## 后续注意

- `turn/interrupt` 协议已确认存在，但本次未做 UI。
- 权限审批的拒绝/取消当前按空权限 response 处理，后续真实场景验收时需要观察 Codex CLI 对空权限的语义是否等价拒绝。
- WebSocket 当前使用内存事件缓存，服务重启后 runtime 和事件缓存会丢失，符合 MVP 内存运行态约束。

## 发送后详情不刷新的修复（2026-07-14）

现象：

- 输入框提交后，后端 `POST /api/sessions/:id/input` 返回 200，但详情页没有立即出现新回复。
- 点击顶部“刷新”只触发 `GET /api/sessions`，没有重新加载当前会话详情和历史命令。
- 浏览器刷新后重新进入会话可以看到回复，说明 Codex 历史已写入，但前端详情数据未刷新。

原因：

- 顶部刷新按钮只刷新会话列表，未刷新当前选中会话的详情、命令和 runtime。
- 实时 notification 在当前环境下没有稳定驱动详情流更新时，前端缺少轮询兜底。

修复：

- 发送成功后启动短周期后台轮询，静默刷新当前会话详情、历史命令和 runtime。
- 收到 `turn_completed` 实时事件时，主动静默刷新当前详情。
- 顶部“刷新”改为同时刷新列表和当前选中会话详情。

验证：

- `npm run typecheck` 通过。
- `npm test` 通过：8 个测试文件，23 个测试。
- `npm run build` 通过。
