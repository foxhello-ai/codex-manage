# Codex Web 会话管理技术调研文档

## 1. 调研信息

- 调研日期：2026-07-13
- 调研目录：`/config/projects/codex-manage`
- 会话目录：`~/.codex/sessions`
- 实际展开路径：`/config/.codex/sessions`
- 需求文档：[codex-web-requirements.md](./codex-web-requirements.md)
- 官方参考：Codex Manual / Codex App Server
- 官方参考 URL：`https://learn.chatgpt.com/docs/app-server.md`

## 2. 工具版本

本次调研使用以下版本。后续开发或问题排查时应优先与这些版本比对。

```text
codex --version
codex-cli 0.144.3

node --version
v22.23.1

npm --version
10.9.8
```

本次生成过 Codex app-server 协议定义，生成结果与 `codex-cli 0.144.3` 对应。

```bash
codex app-server generate-ts --out /tmp/codex-app-schema
codex app-server generate-json-schema --out /tmp/codex-app-json-schema
```

## 3. 调研命令

### 3.1 Codex CLI 能力

```bash
codex --version
codex --help
codex resume --help
codex app-server --help
codex remote-control --help
codex debug --help
```

关键发现：

- `codex resume` 存在，支持按 `SESSION_ID` 或 session name 恢复。
- `codex resume` 支持 `--last`、`--all`、`--include-non-interactive`、`--remote`、`--no-alt-screen`。
- `codex app-server` 存在，支持 `stdio://`、`ws://IP:PORT`、`unix://` 等 transport。
- `codex app-server` 支持生成 TypeScript bindings 和 JSON Schema。
- `codex remote-control` 存在，但本项目 MVP 不优先依赖。

### 3.2 会话目录结构

```bash
find ~/.codex -maxdepth 4 -type d
find ~/.codex/sessions -maxdepth 8 -type f
wc -l ~/.codex/sessions/2026/07/13/*.jsonl
file ~/.codex/sessions/2026/07/13/*.jsonl
```

关键发现：

- 会话文件按日期分层保存。
- 示例路径：

```text
~/.codex/sessions/2026/07/13/rollout-2026-07-13T18-05-11-019f5ca7-8a00-7400-a083-c0a6f8d76e7e.jsonl
```

- 文件格式是 New Line Delimited JSON，即 JSONL。
- 本次样例包含 2 个历史会话文件。

### 3.3 JSONL 结构

```bash
jq -r '.type // "NO_TYPE"' ~/.codex/sessions/2026/07/13/*.jsonl | sort | uniq -c
jq -r 'paths(scalars) | map(tostring) | join(".")' ~/.codex/sessions/2026/07/13/*.jsonl | sort -u
jq -r 'select(.type=="response_item") | (.payload.type // "NO_PAYLOAD_TYPE")' ~/.codex/sessions/2026/07/13/*.jsonl | sort | uniq -c
jq -r 'select(.type=="event_msg") | (.payload.type // "NO_PAYLOAD_TYPE")' ~/.codex/sessions/2026/07/13/*.jsonl | sort | uniq -c
```

事件类型统计：

```text
100 event_msg
157 response_item
2 session_meta
10 turn_context
2 world_state
```

`response_item` 子类型：

```text
1 custom_tool_call
1 custom_tool_call_output
45 function_call
41 function_call_output
54 message
23 reasoning
```

`event_msg` 子类型：

```text
31 agent_message
1 patch_apply_end
9 task_complete
10 task_started
8 thread_settings_applied
33 token_count
10 user_message
```

关键发现：

- JSONL 中包含 `session_meta`、`thread_settings_applied`、用户消息、agent 消息、reasoning、工具调用、命令调用输出等信息。
- `session_meta` 能提供 `id`、`cwd`、`cli_version` 等基础元信息。
- `thread_settings_applied` 能提供 `model`、`approval_policy`、权限配置等信息。
- 历史命令调用以 `response_item.payload.type=function_call`、`payload.name=exec_command` 出现。
- 命令参数中可读取 `cmd`、`workdir`、`yield_time_ms`、`max_output_tokens`、`sandbox_permissions`、`justification`、`prefix_rule`。
- 历史命令输出主要在 `function_call_output.payload.output` 字符串中，而不是独立 stdout/stderr 字段。

## 4. Codex App Server 调研

### 4.1 官方能力说明

Codex Manual 中的 app-server 章节说明：

- `codex app-server` 用于富客户端集成。
- 它支持 authentication、conversation history、approvals、streamed agent events。
- 协议是 JSON-RPC 2.0 风格，wire 上省略 `"jsonrpc":"2.0"`。
- stdio transport 使用 JSONL。
- WebSocket transport 目前是 experimental。
- 可通过 CLI 生成与当前 Codex 版本匹配的 TypeScript schema 或 JSON Schema。

本项目结论：

- Web 管理端应优先通过 `codex app-server` 集成 Codex。
- 只有 app-server 不可用或协议能力缺失时，才考虑 PTY/TUI fallback。

### 4.2 协议生成

```bash
codex app-server generate-ts --out /tmp/codex-app-schema
codex app-server generate-json-schema --out /tmp/codex-app-json-schema
```

生成协议中确认存在以下核心方法：

- `initialize`
- `thread/list`
- `thread/read`
- `thread/resume`
- `thread/fork`
- `thread/archive`
- `thread/delete`
- `turn/start`
- `turn/steer`
- `turn/interrupt`
- `command/exec`
- `command/exec/write`
- `command/exec/terminate`
- `config/read`

本项目必须避免调用：

- `thread/delete`
- 会删除历史数据的文件系统接口

### 4.3 只读验证

本次实际启动过 `codex app-server` stdio 模式，并完成以下只读调用：

- `initialize`
- `thread/list`
- `thread/read` with `includeTurns=true`
- `thread/resume` without starting a new turn

验证结果：

- `initialize` 成功。
- `thread/list` 能直接列出历史会话。
- `thread/list` 返回 `id`、`cwd`、`status`、`createdAt`、`updatedAt`。
- `thread/read includeTurns=true` 能读取历史 turns。
- `thread/resume` 能按 `threadId` 恢复历史 thread。
- `thread/resume` 返回 `cwd`、`model`、`modelProvider`、`approvalPolicy`、`approvalsReviewer`、`sandbox`、`activePermissionProfile`、`initialTurnsPage` 等运行所需信息。

### 4.4 thread/resume 结论

`ThreadResumeParams` 说明 thread 可通过三种方式恢复：

- `threadId`
- history
- path

协议说明优先使用 `threadId`。如果 `threadId` 标识的是正在运行的 thread，app-server 会重新加入该 thread。

本项目结论：

- “Codex CLI 原生 resume 能力”落地为 app-server 的 `thread/resume`。
- Web 后端使用 `threadId` 恢复会话。
- 对同一 thread 的重复恢复应复用已有 app-server runtime，不启动重复执行链路。

## 5. 审批调研

协议中确认存在以下 server request：

- `item/commandExecution/requestApproval`
- `item/fileChange/requestApproval`
- `item/permissions/requestApproval`
- `item/tool/requestUserInput`
- `mcpServer/elicitation/request`
- `applyPatchApproval`
- `execCommandApproval`

命令审批参数包含：

- `threadId`
- `turnId`
- `itemId`
- `startedAtMs`
- `approvalId`
- `reason`
- `command`
- `cwd`
- `commandActions`
- `proposedExecpolicyAmendment`
- `proposedNetworkPolicyAmendments`

命令审批决策包含：

- `accept`
- `acceptForSession`
- `acceptWithExecpolicyAmendment`
- `applyNetworkPolicyAmendment`
- `decline`
- `cancel`

MVP 采用：

- 允许：`accept`
- 本会话允许：`acceptForSession`
- 拒绝：`decline`
- 取消：`cancel`

## 6. 实时事件调研

协议中确认存在以下运行事件：

- `thread/started`
- `thread/status/changed`
- `turn/started`
- `turn/completed`
- `item/started`
- `item/completed`
- `item/agentMessage/delta`
- `item/commandExecution/outputDelta`
- `item/commandExecution/terminalInteraction`
- `item/fileChange/outputDelta`
- `item/fileChange/patchUpdated`
- `serverRequest/resolved`
- `thread/tokenUsage/updated`
- `error`
- `warning`

本项目结论：

- 后端通过 app-server 获取结构化事件。
- 后端转换为 Web 管理台自己的事件模型。
- 前端通过 SSE 或 WebSocket 接收事件。
- MVP 可优先使用 WebSocket，因为审批响应、输入、运行状态和事件推送都围绕会话实时交互。

## 7. 历史详情展示调研

`thread/read includeTurns=true` 能读取：

- `userMessage`
- `agentMessage`
- `fileChange`
- turn 状态
- turn 时间
- thread 元信息

但在本次样例中，`thread/read` 未将 JSONL 中既有 `exec_command` 历史还原为 `commandExecution` item。

本项目结论：

- 会话列表和消息主体优先使用 app-server。
- 历史命令回放使用 JSONL parser 补充解析。
- 运行中新任务的命令过程使用 app-server 实时事件。

## 8. 用户已审批决策

用户已确认以下决策：

1. 同意将“Codex CLI 原生 resume”具体落地为 app-server 的 `thread/resume`，而不是模拟终端 `codex resume`。
2. 接受历史命令展示采用“双通道”：app-server 读主会话，JSONL 补充解析历史命令。
3. 同意前端按 H5 优先适配，桌面端再增强为双栏/多栏。
4. 接受 app-server experimental 风险，并通过版本检测、schema 生成和 fallback 方案缓解。

## 9. H5 和移动端调研结论

需求补充：Web 界面必须支持 H5，适配移动端操作和使用。

设计约束：

- 移动端采用单栏布局。
- 会话列表和会话详情以页面切换为主。
- 桌面端可以增强为列表 + 详情双栏。
- 输入框固定在底部，并适配移动端软键盘。
- 审批卡片在移动端使用底部弹层或全屏确认页。
- 命令输出移动端默认折叠。
- 按钮和可点击区域应满足触控尺寸。
- 不依赖 hover 操作。
- 长命令、长路径、长输出必须支持换行、截断或横向滚动。

## 10. 风险和缓解

### 10.1 app-server experimental 风险

风险：

- app-server WebSocket transport 和部分协议字段标注 experimental。
- Codex 版本升级后协议可能变化。

缓解：

- 开发时从当前 Codex 版本生成 schema。
- 在启动时检测 `codex --version`。
- 将 app-server JSON-RPC 适配封装在独立模块。
- 保留 PTY/TUI fallback 设计，但 MVP 不优先实现。
- 文档中记录调研版本，便于后续比对。

### 10.2 历史命令解析风险

风险：

- `thread/read` 未完整返回历史命令 item。
- JSONL 格式可能随 Codex 版本变化。

缓解：

- 历史命令解析作为补充能力，不影响主会话列表和恢复。
- JSONL parser 做降级处理，无法解析时显示原始摘要或跳过命令详情。
- parser 只读 `~/.codex/sessions`，不修改历史文件。

### 10.3 局域网访问风险

风险：

- Web 管理台允许局域网访问。
- 单密码过弱时有未授权操作风险。

缓解：

- 除 `POST /api/login`、`GET /api/me` 和静态资源外，所有管理接口必须登录。
- 默认密码为 `fmzh2026`，不展示密码风险提示。
- 可通过 `CODEX_WEB_PASSWORD` 覆盖默认密码。
- 不暴露删除会话接口。
- 不暴露任意文件读取接口。

## 11. 推荐后续方案

推荐采用：

- 后端：Node.js + TypeScript + Fastify
- 前端：React + Vite + TypeScript
- Codex 适配：`codex app-server` stdio JSON-RPC
- 实时通道：WebSocket，必要时可降级 SSE + HTTP
- 历史补充解析：JSONL parser
- 运行态存储：MVP 使用内存 RuntimeManager
- 登录：单密码 + signed cookie/session
- H5：移动端优先布局，桌面端渐进增强

