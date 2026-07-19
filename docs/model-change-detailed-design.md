# Codex Web 会话模型切换详细设计

## 1. 文档信息

- 文档日期：2026-07-19
- 文档状态：用户已确认，待实施
- 需求状态：用户已确认
- 适用项目：Codex Web 会话管理台
- 设计代码基线：`feature/f-20260717-replace-logo`
- Codex CLI 基线：`codex-cli 0.144.5`
- 需求文档：[model-change-requirements.md](./model-change-requirements.md)
- 主详细设计：[detailed-design.md](./detailed-design.md)
- 实施任务计划：[model-change-task-plan.md](./model-change-task-plan.md)
- 官方依据：[Codex App Server](https://learn.chatgpt.com/docs/app-server.md)

## 2. 设计目标

本设计实现“指定会话在 app-server 当前支持模型之间切换”，同时满足：

- 保留原会话 ID、历史 turns、命令记录和备注信息。
- 只使用 app-server `model/list` 返回的可选模型。
- 历史会话当前模型不受支持时仍可展示并切换离开。
- 会话级模型覆盖不影响其他会话或全局默认模型。
- 模型切换不改变权限模式、sandbox 和审批策略。
- 模型失败后展示错误，由用户显式选择模型和重试。
- 不读取、不修改、不依赖 cc-switch 文件或全局 provider 配置。

## 3. 非设计范围

本设计不实现：

- cc-switch 文件读取、目录适配或配置同步。
- `config.toml`、`auth.json`、API Key、provider 地址和认证信息管理。
- app-server provider 在线切换。
- 手工输入未知模型。
- 模型自动推荐、自动路由和自动降级。
- 运行中 turn 的模型热切换。
- 自动重放失败消息。
- Codex JSONL 历史文件修改。
- app-server 在线重启接口。

## 4. 设计决策

| 编号 | 决策 | 原因 |
| --- | --- | --- |
| D-001 | `model/list` 是唯一可选模型来源 | 与 app-server 当前能力一致，避免未知模型和外部目录耦合 |
| D-002 | 历史模型通过 JSONL 只读解析 | `thread/read` 当前只返回 `modelProvider`，不能完整展示历史模型 |
| D-003 | 运行态模型以 app-server 响应和通知为准 | 防止前端选择值与实际应用值不一致 |
| D-004 | 会话模型偏好存入 Web 元数据 | 服务重启后可重新应用，同时不修改 Codex 原始会话 |
| D-005 | `waiting_input` 才能即时切换 | 避免 active turn 和审批过程中的模型语义变化 |
| D-006 | 模型与权限设置使用同一会话操作锁 | 防止并发 `thread/settings/update` 产生竞态 |
| D-007 | `turn/start` 再次传递显式模型 | 作为恢复和设置更新后的最终一致性保护 |
| D-008 | 模型错误进入消息流 | 避免错误只在折叠状态区显示而表现为“没有动静” |
| D-009 | 切换成功不自动发消息 | 防止隐藏 token 消耗和不可见副作用 |
| D-010 | 不提供 app-server 在线重启 | 重启会影响所有运行态，超出本需求边界 |
| D-011 | 模型目录缓存 60 秒 | 降低频繁 app-server 请求，同时允许手动强制刷新 |
| D-012 | 设置更新通知等待上限 5 秒 | 给 UI 明确确认状态，超时后保留“待确认”而不误报成功 |

D-011 和 D-012 已于 2026-07-19 由用户审核确认。

## 5. 当前实现差距

当前代码状态：

- `RuntimeManager.resumeThread()` 只传 `threadId` 和权限字段。
- `RuntimeManager.sendInput()` 的 `turn/start` 只传 `threadId` 和 `input`。
- `thread/settings/update` 只用于权限模式切换。
- `SessionMetadataStore` 只保存 `remarkTitle`。
- `SessionDetail` 只包含 `modelProvider`，没有具体模型和推理强度。
- 前端没有模型目录、模型选择器和模型切换状态。
- 前端没有处理 WebSocket `error` 事件，模型错误不会进入实时消息区。
- 没有 `/api/models` 和 `/api/sessions/:id/model`。

## 6. 总体架构

```text
Browser
├── GET /api/models
│   └── ModelCatalogService
│       └── CodexAppServerClient -> model/list
│
├── GET /api/sessions/:id
│   └── SessionService
│       ├── CodexAppServerClient -> thread/read
│       ├── JsonlSessionParser -> historical model state
│       └── SessionMetadataStore -> model preference
│
├── PATCH /api/sessions/:id/model
│   └── SessionModelService
│       ├── ModelCatalogService -> validate supported model
│       ├── SessionMetadataStore -> persist preference
│       └── RuntimeManager -> thread/settings/update
│
├── POST /api/sessions/:id/resume
│   └── SessionModelService + RuntimeManager
│       └── CodexAppServerClient -> thread/resume
│
└── POST /api/sessions/:id/input
    └── SessionModelService + RuntimeManager
        ├── thread/resume when needed
        └── turn/start with applied model
```

模块边界：

- `ModelCatalogService` 只负责支持模型目录。
- `JsonlSessionParser` 只读历史 JSONL，补充历史模型状态。
- `SessionMetadataStore` 只负责 Web 偏好持久化。
- `SessionModelService` 负责业务校验和偏好生命周期。
- `RuntimeManager` 负责 app-server 调用、运行态和实时事件。
- Route 只做参数解析、鉴权和错误映射。

## 7. 模块设计

### 7.1 ModelCatalogService

新增文件：

```text
src/server/services/ModelCatalogService.ts
```

职责：

- 调用 app-server `model/list`。
- 处理分页、隐藏模型过滤和字段规范化。
- 维护 60 秒内存缓存。
- 支持强制刷新。
- 为模型和推理强度提供后端校验。
- 不读取任何本地模型配置文件。

建议接口：

```ts
type ModelCatalogQuery = {
  forceRefresh?: boolean;
};

class ModelCatalogService {
  list(query?: ModelCatalogQuery): Promise<ModelCatalogSnapshot>;
  getSupportedModel(model: string): Promise<ModelOption | null>;
  validateSelection(model: string, reasoningEffort: string | null): Promise<ValidatedModelSelection>;
  invalidate(): void;
}
```

内部状态：

```ts
type ModelCatalogCache = {
  models: ModelOption[];
  loadedAt: string;
  expiresAtMs: number;
  lastError: string | null;
};
```

分页算法：

1. 以 `cursor=null`、`limit=100` 调用 `model/list`。
2. 将 `data` 追加到结果。
3. 如果 `nextCursor` 非空则继续。
4. 最多读取 20 页，防止异常服务无限分页。
5. 按 `model` 去重，保留第一次出现的记录。
6. 过滤 `hidden=true`。
7. 按 `isDefault`、展示名排序。

缓存策略：

- 缓存有效且未指定 `forceRefresh`：直接返回。
- 缓存失效或强制刷新：发起新请求。
- 同一时间只保留一个刷新 Promise，避免重复刷新。
- 刷新失败且存在旧缓存：返回旧缓存，`stale=true`，携带安全错误。
- 刷新失败且没有缓存：抛出 `MODEL_LIST_UNAVAILABLE`。

选择校验策略：

1. 先读取当前缓存。
2. 请求模型存在时直接校验推理强度。
3. 请求模型不存在时强制刷新一次。
4. 刷新后仍不存在则返回 `MODEL_NOT_SUPPORTED`。
5. 推理强度不存在于目标模型支持列表时返回 `MODEL_EFFORT_NOT_SUPPORTED`。

### 7.2 JsonlSessionParser 扩展

修改文件：

```text
src/server/services/JsonlSessionParser.ts
```

新增能力：

```ts
readModelState(sessionId: string): Promise<HistoricalModelStateResult>;
```

不新增独立扫描服务，复用现有 sessions 目录遍历和 JSONL 容错逻辑，避免重复实现文件边界。

解析字段：

- `session_meta.payload.model_provider`
- `turn_context.payload.model`
- `turn_context.payload.collaboration_mode.settings.model`
- `turn_context.payload.collaboration_mode.settings.reasoning_effort`
- `event_msg.payload.type=thread_settings_applied` 中可读取的 `model`、provider 和 reasoning 字段

解析规则：

- 只处理匹配 `session_meta.payload.id` 或 `session_id` 的文件。
- 按文件内记录顺序保留最后一个非空值。
- 模型、provider、推理强度可以来自不同记录。
- 单行 JSON 失败时记录 diagnostics 并继续。
- 找不到模型时返回 `model=null`，不猜测全局默认模型。
- 该方法只读，不修改会话文件。

结果：

```ts
type HistoricalModelState = {
  model: string | null;
  modelProvider: string | null;
  reasoningEffort: string | null;
  updatedAt: string | null;
};

type HistoricalModelStateResult = {
  state: HistoricalModelState;
  diagnostics: {
    scannedFiles: number;
    parsedLines: number;
    parseErrors: number;
    matchedSessionFile: boolean;
  };
};
```

### 7.3 SessionMetadataStore 扩展

修改文件：

```text
src/server/services/SessionMetadataStore.ts
```

扩展元数据：

```ts
type PersistedModelSelection = {
  mode: "follow_session" | "override";
  preferredModel: string | null;
  preferredReasoningEffort: string | null;
  updatedAt: string | null;
};

type SessionMetadata = {
  remarkTitle: string | null;
  modelSelection: PersistedModelSelection;
};
```

默认值：

```ts
{
  remarkTitle: null,
  modelSelection: {
    mode: "follow_session",
    preferredModel: null,
    preferredReasoningEffort: null,
    updatedAt: null
  }
}
```

写入接口调整：

```ts
updateRemarkTitle(sessionId: string, remarkTitle: string | null): Promise<SessionMetadata>;
updateModelSelection(sessionId: string, selection: PersistedModelSelection): Promise<SessionMetadata>;
patch(sessionId: string, patch: Partial<SessionMetadata>): Promise<SessionMetadata>;
```

兼容规则：

- 旧文件只有 `remarkTitle` 时自动补齐默认模型选择。
- 未知字段保留，避免覆盖未来扩展。
- 清空备注时不能删除模型偏好。
- 清空模型偏好时不能删除备注。

并发与可靠性：

- 增加单文件写入队列，串行化 read-modify-write。
- 写入临时文件后使用同目录 `rename` 原子替换。
- 写入失败时保留原文件。
- 不将实际模型和运行错误写入持久元数据；这些属于运行态。

元数据示例：

```json
{
  "sessions": {
    "019f705e-ed9c-78f1-9272-a2566889509c": {
      "remarkTitle": "需求变更、技术预研",
      "modelSelection": {
        "mode": "override",
        "preferredModel": "gpt-5.6-sol",
        "preferredReasoningEffort": "high",
        "updatedAt": "2026-07-19T00:00:00.000Z"
      }
    }
  }
}
```

### 7.4 SessionModelService

新增文件：

```text
src/server/services/SessionModelService.ts
```

职责：

- 组合模型目录、历史模型、持久偏好和运行态。
- 校验模型选择请求。
- 根据会话状态决定“只保存偏好”或“立即应用”。
- 为恢复和发送输入解析有效模型覆盖。
- 处理偏好失效。
- 不直接发送 JSON-RPC；实际调用交给 `RuntimeManager`。

依赖：

```ts
constructor(
  modelCatalog: ModelCatalogService,
  metadataStore: SessionMetadataStore,
  jsonlParser: JsonlSessionParser,
  runtimeManager: RuntimeManager
)
```

建议接口：

```ts
getSessionModelState(sessionId: string): Promise<SessionModelState>;
updateSelection(sessionId: string, input: UpdateModelSelectionInput): Promise<ModelSelectionResponse>;
resolveForResume(sessionId: string, requestOverride?: ModelOverrideInput): Promise<ResolvedModelOverride>;
resolveForTurn(sessionId: string): Promise<ResolvedModelOverride>;
markResumeApplied(sessionId: string, actual: ActualModelState): Promise<void>;
```

状态处理：

- `history`、`failed`、`exited`：验证并保存偏好，`applied=false`，等待恢复。
- `waiting_input`：调用 `RuntimeManager.updateModel()`，请求接受后保存偏好。
- `starting`、`running`、`waiting_approval`：返回 `MODEL_SWITCH_NOT_ALLOWED`。
- `follow_session`：清除 Web 偏好；如果会话已恢复，不调用 `thread/settings/update`，当前实际模型保持不变。

`follow_session` 的含义是“Web 后续不再强制覆盖”，不是“恢复到首次创建时的模型”。Codex 会话本身最后实际使用的模型仍由 Codex 保存和恢复。

偏好失效：

- 恢复或发送新 turn 前重新校验显式偏好。
- 偏好模型不在当前目录时，不调用 app-server。
- 返回 `MODEL_NOT_SUPPORTED`，要求用户重新选择或切换为跟随会话。

### 7.5 RuntimeManager 扩展

修改文件：

```text
src/server/services/RuntimeManager.ts
```

扩展运行状态：

```ts
type RuntimeState = {
  // existing fields
  model: string | null;
  modelProvider: string | null;
  reasoningEffort: string | null;
  modelSelectionMode: "follow_session" | "override";
  preferredModel: string | null;
  preferredReasoningEffort: string | null;
  modelChangeStatus: "idle" | "pending" | "confirming" | "applied" | "failed";
  modelChangeError: string | null;
};
```

新增方法：

```ts
hydrateModelState(threadId: string, state: SessionModelState): RuntimeSnapshot;
updateModel(threadId: string, selection: ValidatedModelSelection): Promise<RuntimeSnapshot>;
resumeThread(threadId: string, options: ResumeThreadOptions): Promise<RuntimeSnapshot>;
sendInput(threadId: string, params: SendInputParams): Promise<RuntimeSnapshot>;
```

`ResumeThreadOptions`：

```ts
type ResumeThreadOptions = {
  permissionMode?: SessionPermissionMode;
  modelOverride?: ResolvedModelOverride;
};
```

`SendInputParams`：

```ts
type SendInputParams = {
  text: string;
  permissionMode?: SessionPermissionMode;
  modelOverride?: ResolvedModelOverride;
};
```

恢复参数构造：

```ts
{
  threadId,
  ...(fullAccess ? { sandbox: "danger-full-access", approvalPolicy: "never" } : {}),
  ...(override.model ? { model: override.model } : {})
}
```

当前 `ThreadResumeParams` 没有独立 `effort` 字段，因此恢复时：

- `model` 通过 `thread/resume` 传递。
- 恢复响应后，如果用户显式设置了推理强度且会话进入 `waiting_input`，再调用一次 `thread/settings/update { effort }`。
- 如果无需覆盖推理强度，不追加设置调用。

这一点属于当前 `0.144.5` schema 的协议约束。

`turn/start` 参数：

```ts
{
  threadId,
  input,
  ...(override.model ? { model: override.model } : {}),
  ...(override.reasoningEffort ? { effort: override.reasoningEffort } : {})
}
```

`thread/settings/update` 模型参数：

```ts
{
  threadId,
  model: selection.model,
  ...(selection.reasoningEffort ? { effort: selection.reasoningEffort } : {})
}
```

### 7.6 会话操作锁

`RuntimeManager` 增加按 `threadId` 的轻量 Promise 队列：

```ts
private readonly operationChains = new Map<string, Promise<void>>();

private runExclusive<T>(threadId: string, operation: () => Promise<T>): Promise<T>;
```

以下操作必须进入同一队列：

- `resumeThread`
- `updateModel`
- 权限模式更新
- 创建新的 `turn/start`

`turn/steer` 不切换模型，但仍需确认没有正在执行的 settings 更新。

锁只覆盖 JSON-RPC 请求和内存状态更新，不覆盖整个 turn 生命周期，因此不同用户请求不会被长时间阻塞。

### 7.7 设置更新确认

`thread/settings/update` 响应为空对象，实际设置通过 `thread/settings/updated` 通知确认。

处理流程：

1. 在发送请求前注册 `threadId` 对应的确认 waiter。
2. 设置 `modelChangeStatus=pending`，发布 `model_change_started`。
3. 发送 `thread/settings/update`。
4. 请求成功后设置 `modelChangeStatus=confirming`。
5. 等待 `thread/settings/updated`，最长 5 秒。
6. 通知模型与请求一致：更新实际模型，状态设为 `applied`。
7. 通知模型不一致：状态设为 `failed`，错误为 `MODEL_SWITCH_MISMATCH`。
8. 5 秒未收到通知：返回 `confirmationPending=true`，状态保持 `confirming`。
9. 后续通知到达时仍可完成对账并通过 WebSocket 更新 UI。

请求本身失败时：

- 取消 waiter。
- 恢复切换前实际模型。
- 设置 `modelChangeStatus=failed`。
- 发布 `model_change_failed`。

### 7.8 app-server 通知处理

`RuntimeManager.handleNotification()` 新增：

```text
thread/settings/updated
```

读取：

- `params.threadId`
- `params.threadSettings.model`
- `params.threadSettings.modelProvider`
- `params.threadSettings.effort`
- 权限和 sandbox 字段

无论通知来自模型切换还是权限切换，都使用完整 `threadSettings` 对运行态做对账，避免单独请求覆盖其他状态。

`thread/resume` 响应直接读取：

- `model`
- `modelProvider`
- `reasoningEffort`

错误通知：

- `willRetry=true`：运行态保持 `running`，错误进入实时消息。
- `willRetry=false`：运行态设为 `failed`，保留实际模型和偏好。
- `thread/status/changed` 不清除 `modelChangeError`；该错误只在下一次模型变更开始时清除。

### 7.9 SessionService 扩展

修改文件：

```text
src/server/services/SessionService.ts
```

`SessionDetail` 增加：

```ts
modelState: SessionModelState;
```

详情组合顺序：

1. `thread/read` 获取主体和 `modelProvider`。
2. `JsonlSessionParser.readModelState()` 获取历史模型和推理强度。
3. `SessionMetadataStore.get()` 获取模型偏好。
4. `RuntimeManager.getRuntime()` 获取当前运行态实际模型。
5. 运行态有实际模型时优先。
6. 计算当前模型是否存在于支持目录；目录读取失败时为 `null`，不能误标为不支持。

### 7.10 Route 设计

新增：

```text
src/server/routes/models.ts
```

注册：

```ts
registerModelRoutes(app, modelCatalogService);
```

修改：

```text
src/server/routes/sessions.ts
```

依赖增加：

```ts
sessionModelService?: SessionModelService
```

Route 只负责：

- Zod 参数校验。
- 调用服务。
- 将领域错误映射到 HTTP 状态码。
- 不拼装 app-server JSON-RPC 参数。

### 7.11 AppRuntime 与服务装配

修改：

```text
src/server/services/AppRuntime.ts
src/server/index.ts
```

建议装配：

```ts
const runtime = new AppRuntime(config);
const metadataStore = new SessionMetadataStore(config.metadataFile);
const jsonlParser = new JsonlSessionParser(config.sessionsDir);
const modelCatalog = new ModelCatalogService(runtime.appServer);
const sessionModelService = new SessionModelService(
  modelCatalog,
  metadataStore,
  jsonlParser,
  runtime.runtimeManager
);
const sessionService = new SessionService(
  runtime.appServer,
  metadataStore,
  jsonlParser,
  modelCatalog,
  runtime.runtimeManager
);
```

注册顺序：

```ts
registerModelRoutes(app, modelCatalog);
registerSessionRoutes(app, sessionService, jsonlParser, runtime.runtimeManager, sessionModelService);
```

## 8. 共享数据结构

修改：

```text
src/shared/models.ts
```

### 8.1 ModelOption

```ts
export type ModelOption = {
  id: string;
  model: string;
  displayName: string;
  description: string | null;
  hidden: boolean;
  isDefault: boolean;
  supportedReasoningEfforts: string[];
  defaultReasoningEffort: string | null;
  upgradeModel: string | null;
  upgradeCopy: string | null;
};
```

`upgradeModel` 和 `upgradeCopy` 由 `model/list` 的升级提示字段规范化得到，仅用于展示；
升级目标仍必须存在于当前非隐藏模型目录中，前端不能据此绕过后端模型校验。

### 8.2 ModelCatalogResponse

```ts
export type ModelCatalogResponse = {
  models: ModelOption[];
  loadedAt: string;
  stale: boolean;
  lastError: string | null;
};
```

### 8.3 ModelSelectionMode

```ts
export type ModelSelectionMode = "follow_session" | "override";
```

### 8.4 SessionModelState

```ts
export type SessionModelState = {
  mode: ModelSelectionMode;
  preferredModel: string | null;
  preferredReasoningEffort: string | null;
  actualModel: string | null;
  actualModelProvider: string | null;
  actualReasoningEffort: string | null;
  actualModelSupported: boolean | null;
  applied: boolean;
  confirmationPending: boolean;
  updatedAt: string | null;
  lastError: string | null;
};
```

### 8.5 RuntimeSnapshot 扩展

```ts
export type RuntimeSnapshot = {
  // existing fields
  model: string | null;
  modelProvider: string | null;
  reasoningEffort: string | null;
  modelSelection: SessionModelState;
  modelChangeStatus: "idle" | "pending" | "confirming" | "applied" | "failed";
  modelChangeError: string | null;
};
```

### 8.6 ModelSelectionResponse

```ts
export type ModelSelectionResponse = {
  selection: SessionModelState;
  runtime: RuntimeSnapshot;
  applied: boolean;
  confirmationPending: boolean;
};
```

### 8.7 WebSessionEvent 扩展

增加：

```ts
| "model_change_started"
| "model_change_completed"
| "model_change_failed"
```

## 9. API 详细设计

### 9.1 GET /api/models

请求：

```http
GET /api/models?refresh=true
```

Zod：

```ts
const ModelListQuery = z.object({
  refresh: z.coerce.boolean().optional().default(false)
});
```

成功响应：

```json
{
  "models": [
    {
      "id": "gpt-5.6-sol",
      "model": "gpt-5.6-sol",
      "displayName": "GPT-5.6-Sol",
      "description": "Latest frontier agentic coding model.",
      "hidden": false,
      "isDefault": true,
      "supportedReasoningEfforts": ["low", "medium", "high", "xhigh"],
      "defaultReasoningEffort": "low",
      "upgradeModel": null,
      "upgradeCopy": null
    }
  ],
  "loadedAt": "2026-07-19T00:00:00.000Z",
  "stale": false,
  "lastError": null
}
```

错误：

- 无缓存且 app-server 不可用：`503 MODEL_LIST_UNAVAILABLE`。
- 有旧缓存但刷新失败：返回 `200`，`stale=true` 和 `lastError`。

### 9.2 PATCH /api/sessions/:id/model

Zod：

```ts
const UpdateModelBody = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("follow_session"),
    model: z.null().optional(),
    reasoningEffort: z.null().optional()
  }),
  z.object({
    mode: z.literal("override"),
    model: z.string().trim().min(1).max(200),
    reasoningEffort: z.string().trim().min(1).max(40).nullable().optional()
  })
]);
```

行为：

- inactive 状态：保存偏好，返回 `applied=false`。
- `waiting_input`：立即应用，通知确认后返回 `applied=true`。
- 确认通知超时：返回 `202`，`confirmationPending=true`。
- 不允许状态：返回 `409 MODEL_SWITCH_NOT_ALLOWED`。
- 不支持模型：返回 `422 MODEL_NOT_SUPPORTED`。
- 不支持推理强度：返回 `422 MODEL_EFFORT_NOT_SUPPORTED`。

成功响应：

```json
{
  "selection": {
    "mode": "override",
    "preferredModel": "gpt-5.6-sol",
    "preferredReasoningEffort": "high",
    "actualModel": "gpt-5.6-sol",
    "actualModelProvider": "custom",
    "actualReasoningEffort": "high",
    "actualModelSupported": true,
    "applied": true,
    "confirmationPending": false,
    "updatedAt": "2026-07-19T00:00:00.000Z",
    "lastError": null
  },
  "runtime": {},
  "applied": true,
  "confirmationPending": false
}
```

### 9.3 POST /api/sessions/:id/resume

请求体扩展：

```ts
const ResumeBody = z.object({
  permissionMode: PermissionMode.optional().default("default"),
  model: z.string().trim().min(1).max(200).nullable().optional(),
  reasoningEffort: z.string().trim().min(1).max(40).nullable().optional()
});
```

优先级：

1. 请求体显式 model。
2. 已保存会话偏好。
3. 跟随会话，不传 model。

请求体显式 model 成功应用后同步保存为会话偏好。

### 9.4 POST /api/sessions/:id/input

请求体保持兼容，不增加前端必传字段：

```json
{
  "text": "继续任务",
  "permissionMode": "default"
}
```

后端发送前通过 `SessionModelService.resolveForTurn()` 获取模型覆盖，调用者不能绕过目录校验。

### 9.5 GET /api/sessions/:id

`session` 增加：

```json
{
  "modelState": {
    "mode": "override",
    "preferredModel": "gpt-5.6-sol",
    "actualModel": "z-ai/glm-5.2",
    "actualModelSupported": false,
    "applied": false
  }
}
```

### 9.6 GET /api/sessions/:id/runtime

返回扩展后的 `RuntimeSnapshot`。

## 10. 状态机设计

### 10.1 模型选择状态

```text
follow_session
    │ 用户选择支持模型
    ▼
override + applied=false
    │ resume 或 waiting_input 设置
    ▼
pending
    │ JSON-RPC 接受
    ▼
confirming
    ├── thread/settings/updated 匹配 -> applied
    ├── 通知不匹配 -> failed
    └── 5 秒超时 -> confirming + confirmationPending
```

### 10.2 会话状态与操作

| RuntimeStatus | 保存偏好 | 调用 app-server | 结果 |
| --- | --- | --- | --- |
| `history` | 是 | 否 | 下次恢复应用 |
| `failed` | 是 | 否 | 下次恢复应用 |
| `exited` | 是 | 否 | 下次恢复应用 |
| `waiting_input` | 成功后保存 | `thread/settings/update` | 即时应用 |
| `starting` | 否 | 否 | 409 |
| `running` | 否 | 否 | 409 |
| `waiting_approval` | 否 | 否 | 409 |

### 10.3 跟随会话

对 inactive 会话：

- 清除 Web 偏好。
- 下次 `thread/resume` 不传 model。

对 `waiting_input` 会话：

- 清除 Web 偏好。
- 不发送 `model:null`，避免不明确的 provider 默认行为。
- 当前实际模型保持不变。
- 后续服务重启后按 Codex 会话自身状态恢复。

## 11. 调用时序

### 11.1 获取模型列表

1. 前端打开模型选择器。
2. 调用 `GET /api/models`。
3. Route 调用 `ModelCatalogService.list()`。
4. 缓存有效则返回。
5. 缓存失效则分页调用 `model/list`。
6. 规范化并缓存。
7. 前端渲染搜索列表。

### 11.2 历史会话选择模型并恢复

1. 前端选择支持模型和推理强度。
2. 调用 `PATCH /api/sessions/:id/model`。
3. 服务校验目录并保存偏好，返回 `applied=false`。
4. 用户点击恢复。
5. `POST /resume` 读取偏好。
6. `RuntimeManager.resumeThread()` 调用 `thread/resume { threadId, model }`。
7. 使用响应中的实际模型更新 runtime。
8. 如果有显式 effort，再调用 `thread/settings/update { effort }`。
9. WebSocket 推送最新 `session_status`。

### 11.3 waiting_input 即时切换

1. 前端提交新模型。
2. 后端校验模型目录和状态。
3. 获取会话操作锁。
4. 发布 `model_change_started`。
5. 注册设置通知 waiter。
6. 调用 `thread/settings/update`。
7. 等待 `thread/settings/updated`。
8. 更新实际模型和偏好。
9. 发布 `model_change_completed`。
10. 释放操作锁。

### 11.4 发送新 turn

1. 前端发送普通任务。
2. 后端解析当前有效偏好。
3. 如果未恢复，先带 model 恢复。
4. 获取会话操作锁。
5. 构造 `turn/start`，附带显式 model 和 effort。
6. 请求成功后 runtime 进入 `running`。
7. 释放操作锁。
8. turn 执行不持有设置锁。

### 11.5 模型失败后切换与重试

1. app-server 推送 retrying 和 terminal error。
2. 后端将 error 事件推送到消息流。
3. 前端显示错误和“选择其他模型”。
4. 用户切换模型。
5. 切换成功后显示“模型已切换，是否重试上一条消息”。
6. 用户确认后使用现有输入接口重新发送原文本。
7. 创建新 turn，不修改原失败 turn。

## 12. 事务与失败一致性

app-server 状态与 Web 元数据无法形成单一数据库事务，采用补偿式一致性。

### 12.1 inactive 会话

- 只写 Web 元数据。
- 写入失败则不改变任何运行态。

### 12.2 waiting_input 会话

顺序：

1. app-server 应用模型。
2. 收到确认后写 Web 元数据。

如果 app-server 成功但元数据写入失败：

- 当前 runtime 保留已应用模型。
- 返回 `MODEL_PREFERENCE_PERSIST_FAILED`。
- `details.applied=true`。
- 提示当前进程有效，但服务重启后可能不再自动应用。
- 不反向切回旧模型，避免二次失败。

如果 app-server 失败：

- 不写偏好。
- 保留旧实际模型。

### 12.3 恢复会话

- 显式请求选择先保存偏好，满足“恢复失败仍保留用户选择”。
- 恢复失败时 `applied=false`。
- 恢复成功后更新实际模型。

## 13. 实时事件设计

### 13.1 model_change_started

```json
{
  "previousModel": "z-ai/glm-5.2",
  "requestedModel": "gpt-5.6-sol",
  "reasoningEffort": "high"
}
```

### 13.2 model_change_completed

```json
{
  "requestedModel": "gpt-5.6-sol",
  "actualModel": "gpt-5.6-sol",
  "modelProvider": "custom",
  "reasoningEffort": "high"
}
```

### 13.3 model_change_failed

```json
{
  "requestedModel": "gpt-5.6-sol",
  "errorCode": "MODEL_SWITCH_FAILED",
  "message": "模型切换失败"
}
```

### 13.4 error 事件前端处理

当前前端忽略 `error` 事件。设计增加：

- `applyRealtimeEvent()` 处理 `error`。
- 新增 `LiveErrorNotice`。
- retrying error 更新同一个错误卡片，避免 5 次重连生成 5 张卡片。
- terminal error 固定展示在实时消息区。
- 错误卡片包含“选择其他模型”按钮。

## 14. 前端详细设计

### 14.1 文件拆分

新增：

```text
src/client/ModelSelector.tsx
src/client/modelSelection.ts
src/client/modelSelection.test.ts
```

`ModelSelector.tsx`：

- 模型选择弹层。
- 搜索和推理强度选择。
- 当前模型、不支持模型和默认模型标记。
- 桌面弹窗与 H5 底部弹层共用内容。

`modelSelection.ts`：

- 纯函数状态判断。
- 模型排序和搜索。
- 推理强度默认值解析。
- 禁用原因文案。

### 14.2 Dashboard 状态

新增：

```ts
const [modelCatalog, setModelCatalog] = useState<ModelCatalogResponse | null>(null);
const [loadingModels, setLoadingModels] = useState(false);
const [modelCatalogError, setModelCatalogError] = useState<string | null>(null);
const [updatingModel, setUpdatingModel] = useState(false);
const [modelPickerOpen, setModelPickerOpen] = useState(false);
const [liveErrors, setLiveErrors] = useState<LiveErrorNotice[]>([]);
```

模型目录懒加载：

- 首次打开选择器时加载。
- 之后使用缓存。
- 用户点击刷新时传 `refresh=true`。

### 14.3 RuntimePanel

在权限控制下方增加模型控制：

```text
当前模型  z-ai/glm-5.2  [当前不可选]
偏好模型  gpt-5.6-sol · high
[切换模型]
```

按钮状态：

- `history`、`waiting_input`、`failed`、`exited`：可用。
- `starting`：显示“恢复中，暂不可切换”。
- `running`：显示“任务运行中，完成后可切换”。
- `waiting_approval`：显示“请先处理审批”。

### 14.4 模型选择器

模型项展示：

- 展示名。
- 模型标识。
- 描述。
- 默认模型标记。
- 支持的推理强度。
- upgrade 信息如果 app-server 返回。

交互：

1. 选择模型。
2. 根据模型元数据选择默认 effort。
3. 用户可选择其他支持 effort 或“不覆盖”。
4. 点击“应用模型”。
5. 显示切换状态。
6. 成功后关闭弹层。
7. 失败保留选择和错误。

### 14.5 H5

- 采用底部弹层，最大高度 `85dvh`。
- 顶部固定搜索和关闭按钮。
- 模型列表独立滚动。
- 底部固定“应用模型”按钮并适配 safe area。
- 模型名称允许两行，标识允许横向滚动或复制。
- 触控区域不小于 44px。

### 14.6 失败重试

新增 `RetryLastMessageDialog`：

- 显示上一条失败用户消息。
- 显示当前已切换模型。
- 按钮：“取消”“使用新模型重试”。
- 确认后调用现有 `sendSessionInput()`。
- 不新增后端 retry API。

## 15. 错误处理

### 15.1 领域错误

```ts
class ModelDomainError extends Error {
  constructor(
    readonly code: ModelErrorCode,
    message: string,
    readonly statusCode: number,
    readonly details?: Record<string, unknown>
  ) {}
}
```

错误映射：

| 错误码 | HTTP | 处理 |
| --- | ---: | --- |
| `MODEL_LIST_UNAVAILABLE` | 503 | 无可用目录，禁用选择器 |
| `MODEL_NOT_SUPPORTED` | 422 | 刷新目录并重新选择 |
| `MODEL_EFFORT_NOT_SUPPORTED` | 422 | 使用模型默认 effort |
| `MODEL_SWITCH_NOT_ALLOWED` | 409 | 展示当前状态限制 |
| `MODEL_SWITCH_FAILED` | 502 | 保留旧模型，展示错误 |
| `MODEL_SWITCH_MISMATCH` | 502 | 展示请求值与实际值 |
| `MODEL_PREFERENCE_PERSIST_FAILED` | 500 | 提示当前进程已应用但未持久化 |
| `MODEL_PROVIDER_UNAVAILABLE` | 503 | 提示 provider/代理不可用 |
| `MODEL_REQUEST_TIMEOUT` | 504 | 提示稍后重试或选择其他模型 |

`thread/settings/update` 已接受但 5 秒内未收到确认通知时，不作为领域错误；接口返回
HTTP `202`、`confirmationPending=true`，后续继续通过 WebSocket 对账。

### 15.2 脱敏

后端错误规范化：

- 移除 Authorization、Cookie、token、api_key 形式的内容。
- 不返回 `config.toml` 和 `auth.json` 路径内容。
- URL 仅保留 origin 和 path，不返回 query 参数。
- 错误详情最长 2000 字符。

## 16. 安全边界

- 所有模型 API 经过现有认证 hook。
- 模型值通过 JSON-RPC 结构化传递，不进入 shell。
- 不新增任意文件路径参数。
- JSONL 解析仅在已配置 sessionsDir 内。
- 不读取 cc-switch、config 或 auth 文件。
- 不修改 Codex JSONL。
- 不自动执行测试 turn。
- 不自动重放用户消息。
- 模型切换不改变权限模式。

## 17. 兼容与迁移

### 17.1 元数据兼容

旧格式：

```json
{
  "sessions": {
    "thread-id": {
      "remarkTitle": "标题"
    }
  }
}
```

读取时补齐模型默认值，写回时保留备注。

### 17.2 Codex CLI 版本

- 启动时继续显示 Codex CLI 版本。
- 模型功能首次调用时依赖 `model/list`。
- 方法不存在时返回 `MODEL_LIST_UNAVAILABLE`，页面展示当前 CLI 不支持。
- CLI 升级后通过 schema 生成和测试确认字段变化。

### 17.3 provider 外部变化

Web 不监控 cc-switch 或全局配置。

用户在 Web 外修改 provider 后：

1. 停止并重新启动 Web 服务。
2. 新 app-server 读取新的全局配置。
3. `GET /api/models` 获取新环境支持模型。
4. 已保存偏好如果不再受支持，恢复时要求重新选择。

## 18. 文件变更清单

### 18.1 新增文件

```text
src/server/services/ModelCatalogService.ts
src/server/services/ModelCatalogService.test.ts
src/server/services/SessionModelService.ts
src/server/services/SessionModelService.test.ts
src/server/routes/models.ts
src/server/routes/models.test.ts
src/client/ModelSelector.tsx
src/client/modelSelection.ts
src/client/modelSelection.test.ts
docs/implementation-notes/<date>-model-switching.md
```

### 18.2 修改文件

```text
src/shared/models.ts
src/shared/api.ts
src/server/services/JsonlSessionParser.ts
src/server/services/JsonlSessionParser.test.ts
src/server/services/SessionMetadataStore.ts
src/server/services/SessionMetadataStore.test.ts
src/server/services/SessionService.ts
src/server/services/SessionService.test.ts
src/server/services/RuntimeManager.ts
src/server/services/RuntimeManager.test.ts
src/server/services/AppRuntime.ts
src/server/routes/sessions.ts
src/server/routes/sessions.test.ts
src/server/index.ts
src/client/App.tsx
src/client/styles.css
tests/e2e/mvp.e2e.ts
```

不修改：

```text
~/.codex/config.toml
~/.codex/auth.json
cc-switch 目录或文件
~/.codex/sessions/**/*.jsonl
```

## 19. 测试设计

### 19.1 ModelCatalogService

- 单页模型列表。
- 多页 nextCursor。
- 隐藏模型过滤。
- 去重和排序。
- 60 秒缓存命中。
- 强制刷新。
- 并发刷新 single-flight。
- 失败时旧缓存降级。
- 无缓存失败返回错误。
- 模型不存在时强制刷新一次。
- effort 校验。

### 19.2 JsonlSessionParser

- 从 `turn_context` 读取 model。
- 从 collaboration mode 读取 model 和 effort。
- 多次设置取最后值。
- session_meta provider。
- 无效 JSON 行容错。
- 无模型返回 null。
- 不匹配 session 不返回数据。

### 19.3 SessionMetadataStore

- 旧格式兼容。
- 备注和模型偏好分别更新不覆盖。
- follow_session 规范化。
- override 必须有 model。
- 并发写入串行化。
- 原子替换失败保留旧文件。

### 19.4 SessionModelService

- inactive 只保存偏好。
- waiting_input 即时应用。
- running/starting/waiting_approval 拒绝。
- 不支持模型拒绝。
- 不支持 effort 拒绝。
- 偏好失效。
- follow_session 不发送 model:null。
- app-server 成功、元数据失败的部分成功响应。

### 19.5 RuntimeManager

- resume 带 model。
- resume 后 effort 设置。
- turn/start 带 model 和 effort。
- turn/steer 不变更模型。
- thread/settings/updated 对账。
- 5 秒确认超时。
- 模型与权限操作串行。
- 不同 thread 并行。
- 模型变更事件发布。
- retrying/terminal error 状态。

### 19.6 Route

- 未认证拒绝。
- Zod 参数校验。
- HTTP 状态码映射。
- refresh 查询参数。
- 202 确认中响应。
- API 不返回敏感信息。

### 19.7 前端

- 模型搜索与排序。
- 当前模型不支持提示。
- 状态禁用原因。
- effort 默认选择。
- 模型切换成功/失败/确认中。
- error WebSocket 事件展示。
- 重试对话框不自动发送。

### 19.8 E2E

桌面和 H5 各覆盖：

1. 登录。
2. 打开历史会话。
3. 打开模型选择器。
4. 选择支持模型。
5. 保存并恢复。
6. 验证实际模型展示。
7. waiting_input 切换模型。
8. running 状态禁止切换。
9. 模拟模型错误并显示切换入口。
10. 切换后人工确认重试。

E2E 不硬编码 Codex CLI 补丁版本，版本断言改为格式或接口返回值断言。

## 20. 需求追踪

| 需求 | 设计落点 |
| --- | --- |
| MR-001、MR-002 | ModelCatalogService、GET /api/models |
| MR-003、MR-004 | JsonlSessionParser、SessionModelState、RuntimePanel |
| MR-005、MR-006 | SessionModelService、resume、updateModel |
| MR-007 | 状态校验表和前后端禁用规则 |
| MR-008、MR-009 | turn/start 参数、effort 校验 |
| MR-010 | SessionMetadataStore |
| MR-011、MR-012 | error 消息、补偿式一致性、人工重试 |
| MR-013 | 会话操作锁 |
| MR-014 | WebSessionEvent 扩展 |
| MR-015 | 安全边界和不修改文件清单 |
| MR-016 | ModelSelector 桌面/H5 |
| MR-017 | ModelCatalogService 缓存与 refresh |

## 21. 实施顺序

1. 共享类型、错误类型和元数据结构。
2. ModelCatalogService 和模型路由。
3. JSONL 历史模型解析。
4. SessionModelService。
5. RuntimeManager 模型状态、操作锁和通知对账。
6. 会话 API 扩展。
7. 前端模型选择器和错误消息。
8. 桌面/H5 E2E。
9. 真实 app-server 验收。
10. 实施记录和发布说明。

每一步先运行相关单元测试，再进入下一层；完成后运行全量类型检查、单元测试、构建和 E2E。

## 22. 风险与缓解

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| app-server 协议升级 | 字段或通知变化 | 生成当前版本 schema，适配层集中处理 |
| model/list 暂时失败 | 选择器不可用 | 60 秒缓存和 stale 回退 |
| settings 通知延迟 | UI 无法立即确认 | 5 秒等待后返回 confirmationPending |
| 模型目录变化 | 已保存偏好失效 | 恢复前重新校验，要求重新选择 |
| app-server 成功但元数据失败 | 重启后偏好丢失 | 返回部分成功错误，保留当前实际模型 |
| 运行中误切换 | turn 行为不一致 | 前后端状态校验和会话操作锁 |
| 错误消息包含敏感信息 | 信息泄露 | 后端统一脱敏和长度限制 |
| 重试导致重复副作用 | 命令重复执行 | 禁止自动重放，用户显式确认 |

## 23. 用户审核结论

用户已于 2026-07-19 审核并确认以下设计决策：

1. 模型目录缓存时间采用 60 秒，支持手动强制刷新。
2. 历史模型通过现有 `JsonlSessionParser` 扩展读取，不新增独立扫描服务。
3. 会话模型偏好持久化到现有 `.codex-manage/session-metadata.json`。
4. `waiting_input` 模型切换等待 `thread/settings/updated` 最长 5 秒；超时显示“待确认”。
5. “跟随会话”不会发送 `model:null`，只清除 Web 偏好并保留当前实际模型。
6. `thread/resume` 只覆盖 model；显式 effort 在恢复后通过 `thread/settings/update` 应用。
7. app-server 模型成功但元数据写入失败时，不自动切回旧模型。
8. 模型选择器放在运行状态区域，H5 使用底部弹层。
9. 模型失败后不自动重试，用户确认后复用现有输入接口发送原消息。
10. 不新增 app-server 在线重启能力，不读取或修改 cc-switch。

审核结论：通过。详细设计状态更新为“用户已确认，待实施”，后续实现必须遵循本设计及其实施任务计划。

## 24. 内部审核结果

| 审核项 | 结果 | 说明 |
| --- | --- | --- |
| 需求覆盖 | 通过 | MR-001 至 MR-017 均有明确设计落点和测试要求 |
| 协议可行性 | 通过 | 基于 `codex-cli 0.144.5` schema，覆盖 `model/list`、`thread/resume`、`thread/settings/update`、`thread/settings/updated` 和 `turn/start` |
| cc-switch 影响 | 通过 | 不读取、不修改、不监控、不依赖 cc-switch 文件或 provider 配置 |
| 会话隔离 | 通过 | 覆盖只写入指定会话偏好，不修改全局默认模型和其他会话 |
| 运行一致性 | 通过 | 状态限制、会话操作锁、通知对账和 `turn/start` 显式参数共同保证一致性 |
| 历史兼容 | 通过 | 历史模型可只读展示；不可用模型不会继续作为新覆盖值 |
| 故障安全 | 通过 | 不自动降级、不自动重放；部分成功和确认延迟均有明确状态 |
| 数据安全 | 通过 | 不修改 Codex JSONL、`config.toml`、`auth.json` 或认证信息 |
| API 一致性 | 通过 | 共享类型、响应示例、HTTP 状态和 WebSocket 事件已对齐 |
| 测试完整性 | 通过 | 单元、路由、运行时、组件、桌面/H5 E2E 和真实 app-server 验收均已覆盖 |

内部审核结论：设计通过内部审核及用户审核。当前没有发现会破坏 cc-switch 或改变全局模型配置的路径；
实现阶段按 [model-change-task-plan.md](./model-change-task-plan.md) 的里程碑和质量门槛执行。
