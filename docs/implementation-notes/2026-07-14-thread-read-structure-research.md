# thread/read 结构调研记录

## 基本信息

- 日期：2026-07-14
- 类型：M4 会话详情实现前结构调研
- Codex CLI：`codex-cli 0.144.3`
- Node.js：`v22.23.1`
- npm：`10.9.8`
- 调研方式：临时脚本启动 `codex app-server`，调用 `initialize`、`thread/list`、`thread/read`
- 调研脚本位置：`/tmp/codex-thread-read-shape.mjs`、`/tmp/codex-thread-read-items.mjs`
- 隐私处理：只记录字段结构、类型和数量统计；不记录真实消息正文、真实路径或真实 thread id

## 调研结论

`thread/read` 可用请求参数：

```ts
{
  threadId: string;
  includeTurns: true;
}
```

返回顶层结构：

```ts
{
  thread: Thread;
}
```

`Thread` 主要字段：

```ts
{
  id: string;
  sessionId: string;
  preview: string;
  createdAt: number;
  updatedAt: number;
  recencyAt: number;
  status: { type: string };
  path: string;
  cwd: string;
  cliVersion: string;
  source: string;
  threadSource: string;
  historyMode: string;
  modelProvider: string;
  name: string | null;
  turns: Turn[];
}
```

`Turn` 结构：

```ts
{
  id: string;
  items: ThreadItem[];
  itemsView: string;
  status: string;
  error: unknown | null;
  startedAt: number;
  completedAt: number;
  durationMs: number;
}
```

采样中 turn 状态包括：

- `completed`
- `interrupted`

## Item 类型

本机采样 2 个 thread，共 26 个 turn、259 个 item。

item 类型统计：

- `userMessage`：27
- `agentMessage`：225
- `fileChange`：6
- `contextCompaction`：1

### userMessage

```ts
{
  id: string;
  type: "userMessage";
  clientId: null;
  content: Array<{
    type: "text";
    text: string;
    text_elements: unknown[];
  }>;
}
```

### agentMessage

```ts
{
  id: string;
  type: "agentMessage";
  text: string;
  phase: string;
  memoryCitation: null;
}
```

### fileChange

```ts
{
  id: string;
  type: "fileChange";
  status: "completed";
  changes: Array<{
    path: string;
    kind: { type: string };
    diff: string;
  }>;
}
```

采样中 file change kind 为：

- `add`

### contextCompaction

```ts
{
  id: string;
  type: "contextCompaction";
}
```

## M4 实现范围确认

已确认 M4 首版范围：

- 展示基础元信息：`cwd`、`createdAt`、`updatedAt`、`cliVersion`、`modelProvider`、`status`。
- 展示历史消息：`userMessage.content[].text`、`agentMessage.text`。
- `fileChange` 展示简要卡片，diff 默认折叠。
- `contextCompaction` 展示为系统事件。
- 未知 item 类型按系统事件兜底。
- 历史命令展示留到 M5 JSONL parser。
- 恢复和实时输出留到 M6-M8。

## 风险和实现建议

- 本次只采样到本机 app-server 可列出的 2 个 thread，后端映射必须对未知字段和未知 item 类型宽松处理。
- `thread/read` 返回结构不是公开稳定 API 文档的一部分，后续升级 Codex CLI 后需要重新比对。
- M4 不应依赖 `commandExecution` item，因为本次样本未出现该类型；命令历史按 M5 从 JSONL 补充更稳。
