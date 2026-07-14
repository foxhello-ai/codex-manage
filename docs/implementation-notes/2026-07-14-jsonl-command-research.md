# JSONL 历史命令结构调研记录

## 基本信息

- 日期：2026-07-14
- 类型：M5 JSONL 历史命令解析实现前结构调研
- Codex CLI：`codex-cli 0.144.3`
- Node.js：`v22.23.1`
- npm：`10.9.8`
- 调研目录：`~/.codex/sessions`
- 调研脚本：`/tmp/codex-jsonl-command-research.mjs`、`/tmp/codex-jsonl-command-research-summary.mjs`
- 隐私处理：只记录字段结构、类型和数量统计；不记录真实命令、真实 workdir、真实输出正文或真实 session id

## 样本统计

- 扫描 `.jsonl` 文件：2 个
- 总字节数：3056475
- 总行数：2289
- JSON 解析成功：2289
- JSON 解析失败：0

## 顶层记录类型

```text
session_meta: 2
event_msg: 732
response_item: 1517
world_state: 4
turn_context: 33
compacted: 1
```

通用记录结构：

```ts
{
  timestamp: string;
  type: string;
  payload: object;
}
```

## payload 类型

```text
task_started: 32
message: 316
user_message: 33
agent_message: 268
token_count: 331
task_complete: 31
thread_settings_applied: 30
reasoning: 218
function_call: 478
function_call_output: 477
custom_tool_call: 14
patch_apply_end: 6
custom_tool_call_output: 14
context_compacted: 1
```

## exec_command 调用

历史命令调用来自：

```ts
record.type === "response_item"
record.payload.type === "function_call"
record.payload.name === "exec_command"
```

payload 结构：

```ts
{
  type: "function_call";
  name: "exec_command";
  call_id: string;
  arguments: string; // JSON 字符串
}
```

`arguments` 解析后观察到字段：

```ts
{
  cmd: string;
  workdir: string;
  yield_time_ms: number;
  max_output_tokens: number;
  sandbox_permissions?: string;
  justification?: string;
  prefix_rule?: string[];
  tty?: boolean;
}
```

统计：

- `exec_command`：446
- `arguments` JSON 解析失败：0
- `workdir`：446 条都有
- `yield_time_ms`：446 条都有
- `max_output_tokens`：446 条都有
- `sandbox_permissions`：432 条有，14 条缺失
- `justification`：432 条有，14 条缺失
- `prefix_rule`：107 条有
- `tty`：7 条有

`sandbox_permissions` 分布：

```text
require_escalated: 432
<missing>: 14
```

## function_call_output 输出

输出来自：

```ts
record.type === "response_item"
record.payload.type === "function_call_output"
```

payload 结构：

```ts
{
  type: "function_call_output";
  call_id: string;
  output: string;
  internal_chat_message_metadata_passthrough: {
    turn_id: string;
  };
}
```

统计：

- `function_call_output`：477
- `output` 全部为 string
- 输出长度分布：
  - `1-200`：176
  - `201-1000`：166
  - `1001-10000`：116
  - `>10000`：19

## 关联关系

- `function_call` 带 `call_id`：478
- `function_call_output` 带 `call_id`：477
- 输出能匹配到调用：477
- `exec_command` 能匹配到输出：445
- `exec_command` 缺失输出：1
- 输出没有对应调用：0
- `response_item` 里带 `turn_id` metadata：1517

结论：M5 可以通过 `call_id` 关联命令调用和输出，并通过 `internal_chat_message_metadata_passthrough.turn_id` 归属到 turn。

## 已确认实现范围

- 新增 `JsonlSessionParser`，每次请求实时扫描解析，MVP 暂不做缓存。
- 新增 `GET /api/sessions/:id/commands`。
- API 可向已登录用户返回完整 `cmd`、`workdir` 和完整输出。
- 前端展示历史命令、workdir、审批参数摘要、输出。
- 历史输出完整返回前端；UI 默认折叠。
- 已完成命令输出限制高度并折叠查看；运行中命令不做高度限制。
- 缺失输出的命令按未完成/运行中状态展示。

## 风险和建议

- 当前样本较少，实现必须宽松处理未知字段。
- JSONL 解析失败应跳过坏行并保留诊断，不影响会话详情主流程。
- 输出可能很长，前端必须默认折叠，避免页面卡顿。
- 后续如 sessions 数量增大，可增加索引缓存或按 threadId 建立文件映射缓存。
