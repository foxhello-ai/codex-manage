# Codex Web 会话模型切换需求审核文档

## 1. 文档信息

- 文档日期：2026-07-19
- 文档状态：用户已确认，详细设计已审核通过，待实施
- 需求类型：MVP 完成后的增量需求
- 适用项目：Codex Web 会话管理台
- 审核代码分支：`feature/f-20260717-replace-logo`
- 审核 Codex 版本：`codex-cli 0.144.5`
- 主需求文档：[codex-web-requirements.md](./codex-web-requirements.md)
- 详细设计文档：[model-change-detailed-design.md](./model-change-detailed-design.md)
- 实施任务计划：[model-change-task-plan.md](./model-change-task-plan.md)
- 官方依据：[Codex App Server](https://learn.chatgpt.com/docs/app-server.md)

## 2. 用户目标

用户需要在同一个历史对话中切换 Codex app-server 当前明确支持的模型，例如将故障、能力不足或不再适合当前任务的模型切换为更合适的模型，同时保留原会话历史并继续工作。

本需求只解决“会话级模型切换”，不承担模型提供商和全局配置管理。

## 3. 重新评估结论

前一版需求将 cc-switch 本地模型目录作为补充来源。该方案不会修改 cc-switch，但会让 Web 与 cc-switch 文件格式产生不必要的耦合，不符合当前用户目标，因此本次重新评估后移除。

最终结论：

- Web 只使用 app-server `model/list` 返回的模型作为可选模型。
- Web 不读取或修改 cc-switch 的模型目录、配置文件和认证信息。
- Web 不修改 `~/.codex/config.toml`、`~/.codex/auth.json` 或 provider 配置。
- Web 不提供手工模型输入，不允许选择 app-server 当前未声明支持的模型。
- 历史会话当前模型不在 `model/list` 时仍可展示，但标记为“当前不可选”。
- 用户可以从支持列表中选择新模型，恢复原会话并继续任务。
- 会话模型切换只影响指定 thread，不影响其他会话或全局默认模型。

因此，该功能不会导致 cc-switch 无法使用。用户仍可独立使用 cc-switch 管理全局 provider 或默认模型；Web 服务重新启动后会基于当前 app-server 环境重新获取支持模型列表。

## 4. 官方能力与实测依据

审核确认的 app-server 能力：

| 场景 | app-server 方法 | 字段语义 |
| --- | --- | --- |
| 获取当前支持模型 | `model/list` | 返回模型、展示名、默认推理强度和支持的推理强度 |
| 恢复历史或失败会话 | `thread/resume` | `model` 可覆盖恢复后的 thread 模型 |
| 修改空闲会话 | `thread/settings/update` | `model` 和 `effort` 作用于后续 turns |
| 发送新任务 | `turn/start` | `model` 和 `effort` 作用于当前及后续 turns |

审核环境实测：

- `model/list` 返回 8 个当前支持模型，包括 `gpt-5.6-sol`。
- 故障会话 `019f705e-ed9c-78f1-9272-a2566889509c` 当前使用 `z-ai/glm-5.2`。
- `z-ai/glm-5.2` 不在当前 `model/list` 中，调用时代理返回 `502 Bad Gateway`。
- 同一 provider 环境下，显式选择 `gpt-5.6-sol` 可以正常响应。

该结果证明恢复故障会话的正确方式是从 `model/list` 中选择一个当前支持模型，而不是让 Web 接管 cc-switch。

## 5. 目标

本需求需要实现：

- 获取并展示 app-server 当前支持的模型。
- 展示当前会话实际使用的模型和推理强度。
- 在恢复历史会话前选择支持模型。
- 在会话等待输入时切换后续 turns 使用的模型。
- 将绑定故障或不再支持模型的旧会话切换到支持模型。
- 保留原会话历史、权限模式、sandbox 和审批策略。
- 模型切换失败时提供明确错误和恢复入口。
- 桌面端和 H5 均能完成模型查看与切换。

## 6. 非目标

本需求不包含：

- 读取、修改或监控 cc-switch 文件。
- 替代 cc-switch 的 provider 或默认模型管理能力。
- 修改 `config.toml`、`auth.json`、API Key、provider 地址或认证方式。
- 切换 app-server 当前 provider。
- 手工输入未出现在 `model/list` 中的模型。
- 自动选择所谓“最佳模型”。
- 根据任务内容自动切换模型。
- 模型失败后自动更换模型并重放任务。
- 在运行中的 turn 或等待审批时切换模型。
- 修改 Codex 原始 JSONL 会话文件。
- 模型价格、额度、速度或质量基准测试。

## 7. 名词与状态

### 7.1 当前支持模型

“当前支持模型”指当前 Web 后端所连接 app-server 的 `model/list` 返回且 `hidden=false` 的模型。

只有当前支持模型可以成为新的会话模型选择。

### 7.2 当前会话模型

当前会话模型来自：

- 历史会话 JSONL 中最后一次有效模型设置；或
- `thread/resume` 响应；或
- `thread/settings/updated` 通知。

当前会话模型可能不在当前支持模型列表中。此时只做展示，不允许再次选择该模型。

### 7.3 模型选择模式

- 跟随会话：不设置 Web 模型覆盖，继续使用会话当前模型。
- 显式覆盖：用户从当前支持模型列表中为指定会话选择模型。

## 8. 功能需求

### MR-001 支持模型列表

- 后端必须通过 app-server `model/list` 获取模型列表。
- 必须处理 `nextCursor` 分页，不能只读取第一页。
- 默认只返回 `hidden=false` 的模型。
- 每个模型至少包含 `model`、`displayName`、`description`、`isDefault`、`defaultReasoningEffort` 和 `supportedReasoningEfforts`。
- app-server 未就绪或 `model/list` 失败时，返回明确错误，不能使用本地猜测列表替代。
- 列表结果可以短期缓存，但手动刷新必须重新调用 app-server。

### MR-002 模型选择校验

- 后端必须使用最新一次成功的 `model/list` 结果校验模型选择。
- 请求模型不在支持列表时返回 `MODEL_NOT_SUPPORTED`。
- 前端不能仅通过修改请求参数绕过后端校验。
- 模型标识最大长度为 200 个字符，去除首尾空白后不能为空。
- 不提供 `allowUnverified`、手工输入或未知模型确认机制。

### MR-003 不支持模型展示

- 历史会话当前模型不在支持列表时仍必须展示。
- 该模型显示“当前会话模型，不在可选列表”状态。
- 不支持模型不能出现在下拉选择项中。
- 页面必须提供“切换到支持模型”操作入口。
- 用户未主动切换前，系统不得自动改变会话模型。

### MR-004 当前模型展示

会话详情必须展示：

- 当前实际模型。
- 模型提供商标识，如果可读取。
- 当前推理强度，如果可读取。
- 当前模型是否仍在支持列表。
- 是否存在 Web 显式覆盖。
- 最近一次模型切换状态和错误。

运行态实际模型优先于历史解析值和 Web 偏好值。期望模型与实际模型不一致时必须同时展示。

### MR-005 恢复前选择模型

- `history`、`failed` 和 `exited` 会话允许在恢复前选择支持模型和推理强度。
- 用户未选择新模型时保持“跟随会话”。
- 恢复时通过 `thread/resume` 传递显式模型覆盖。
- 恢复成功后以 app-server 响应中的 `model`、`modelProvider` 和 `reasoningEffort` 更新实际状态。
- 恢复失败时保留用户选择，但标记为尚未应用。

### MR-006 空闲会话切换

- 会话处于 `waiting_input` 时允许切换模型。
- 后端调用 `thread/settings/update`，传递 `threadId`、`model` 和可选 `effort`。
- 请求成功后等待 `thread/settings/updated` 通知确认实际模型。
- 切换不得改变权限模式、sandbox、审批策略、工作目录或其他 thread 设置。
- 切换成功不自动发送消息，不创建隐藏测试 turn。

### MR-007 状态限制

| 会话状态 | 是否允许切换 | 行为 |
| --- | --- | --- |
| `history` | 允许选择 | 保存偏好，在恢复时应用 |
| `starting` | 不允许 | 等待恢复完成 |
| `running` | 不允许 | 当前 turn 保持原模型 |
| `waiting_input` | 允许 | 立即调用 `thread/settings/update` |
| `waiting_approval` | 不允许 | 先处理审批 |
| `failed` | 允许选择 | 保存偏好，通过恢复应用 |
| `exited` | 允许选择 | 保存偏好，通过恢复应用 |

前端禁用状态与后端校验必须一致。

### MR-008 turn 启动一致性

- `turn/start` 必须携带运行态中已应用的显式模型和推理强度。
- 跟随会话模式下不能传递全局默认模型，避免覆盖原会话。
- `turn/steer` 不支持模型变更，继续使用 active turn 模型。
- `turn/start` 失败时不得把请求模型标记为实际模型。

### MR-009 推理强度

- 只展示目标模型 `supportedReasoningEfforts` 声明的选项。
- 默认使用目标模型 `defaultReasoningEffort`。
- 用户可以选择“不覆盖”，让 app-server 使用模型默认值。
- 推理强度按 app-server 返回的非空字符串处理，不在前端维护固定枚举。
- 切换模型后原推理强度不受支持时，自动选择新模型默认值并提示用户。

### MR-010 偏好持久化

Web 管理端在自身元数据中保存：

```json
{
  "modelSelectionMode": "follow_session | override",
  "preferredModel": "string | null",
  "preferredReasoningEffort": "string | null",
  "modelSelectionUpdatedAt": "string | null"
}
```

要求：

- 不修改 Codex 原始会话文件。
- 服务重启后恢复会话时重新校验偏好模型是否仍在 `model/list` 中。
- 偏好模型仍受支持时重新应用。
- 偏好模型已不受支持时停止应用并提示重新选择。
- 用户可以重置为“跟随会话”。

### MR-011 故障会话恢复

模型请求发生 4xx、5xx、超时、模型不存在或 provider 错误时：

- 消息区域必须展示明确错误，不能只显示在折叠状态面板中。
- 提供“选择其他模型”入口。
- 选择新模型后不自动重放失败消息。
- 用户可以显式选择“重试上一条消息”。
- 重试前展示原消息内容并要求确认。
- 重试创建新 turn，原失败 turn 和错误记录保留。

### MR-012 失败与回滚

- `thread/resume`、`thread/settings/update` 或 `turn/start` 失败时不更新实际模型。
- 保留切换前实际模型和权限状态。
- 不自动回退到默认模型或其他模型。
- 返回标准化错误码和安全错误信息。
- 错误信息不得包含令牌、Cookie、Authorization header 或认证配置。

### MR-013 并发与幂等

- 同一会话同一时间只允许一个模型或权限设置变更请求。
- 模型变更和权限变更必须串行执行，避免 `thread/settings/update` 相互覆盖。
- 重复提交相同目标模型时返回当前操作结果，不重复调用 app-server。
- 不同会话可以并发切换模型。
- app-server 响应和通知是最终状态来源。

### MR-014 实时事件

后端增加 Web 事件：

- `model_change_started`
- `model_change_completed`
- `model_change_failed`

事件至少包含：

- `threadId`
- 变更前模型。
- 请求模型。
- 实际模型，如果已确认。
- 推理强度。
- 操作时间。
- 安全处理后的错误信息。

### MR-015 安全与 cc-switch 隔离

- 模型列表和会话模型接口必须要求登录。
- Web 不读取或修改 cc-switch 目录及配置。
- Web 不读取或修改 `config.toml`、`auth.json` 和 provider 认证信息。
- API 不返回 provider 地址、认证字段或任何密钥。
- 模型标识仅作为结构化 app-server 参数，不拼接到 shell 命令。
- 只有 `model/list` 当前支持的模型允许成为显式覆盖值。

### MR-016 桌面与 H5

- 桌面端在运行状态区域或输入区附近提供模型选择器。
- H5 使用底部弹层或全屏选择页，不依赖 hover。
- 选择器支持搜索模型标识和展示名。
- 当前模型、默认模型和推荐升级信息按 app-server 元数据展示。
- 长模型名称支持省略并查看完整值。
- 不允许切换时必须说明原因，不能只禁用控件。

### MR-017 模型列表刷新

- 模型选择器提供手动刷新能力。
- 刷新重新调用 `model/list` 并更新缓存时间。
- 刷新失败保留上一次成功列表，同时展示数据时间和错误。
- 刷新不重启 app-server，不修改 provider，不影响活跃会话。
- 用户通过 cc-switch 在 Web 外部修改全局配置后，需要自行重启 Web/app-server；重启后 Web 重新读取 `model/list`。

## 9. API 需求

### 9.1 模型列表

新增：

```text
GET /api/models
```

可选查询参数：

- `refresh=true`：忽略缓存并重新调用 app-server。

响应示例：

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
      "defaultReasoningEffort": "low"
    }
  ],
  "loadedAt": "2026-07-19T00:00:00.000Z",
  "stale": false,
  "lastError": null
}
```

### 9.2 会话模型设置

新增：

```text
PATCH /api/sessions/:id/model
```

请求：

```json
{
  "mode": "follow_session | override",
  "model": "gpt-5.6-sol",
  "reasoningEffort": "high"
}
```

校验规则：

- `follow_session` 时 `model` 和 `reasoningEffort` 必须为 `null` 或省略。
- `override` 时 `model` 必填，并且必须在最新支持模型列表中。
- `reasoningEffort` 为空时使用模型默认值。
- `reasoningEffort` 非空时必须在目标模型支持列表中。

响应至少包含：

- 保存后的模型偏好。
- 当前实际模型。
- 是否已立即应用。
- 当前 runtime。
- 模型变更错误，如果失败。

### 9.3 恢复接口扩展

现有接口：

```text
POST /api/sessions/:id/resume
```

请求增加可选字段：

```json
{
  "permissionMode": "default | full_access",
  "model": "gpt-5.6-sol",
  "reasoningEffort": "high"
}
```

未传模型时使用已保存偏好；没有偏好时跟随会话。

## 10. 数据模型需求

### 10.1 ModelOption

```ts
type ModelOption = {
  id: string;
  model: string;
  displayName: string;
  description: string | null;
  hidden: boolean;
  isDefault: boolean;
  supportedReasoningEfforts: string[];
  defaultReasoningEffort: string | null;
};
```

### 10.2 SessionModelSelection

```ts
type SessionModelSelection = {
  mode: "follow_session" | "override";
  preferredModel: string | null;
  preferredReasoningEffort: string | null;
  actualModel: string | null;
  actualModelProvider: string | null;
  actualReasoningEffort: string | null;
  actualModelSupported: boolean | null;
  applied: boolean;
  updatedAt: string | null;
  lastError: string | null;
};
```

### 10.3 RuntimeSnapshot 扩展

运行状态增加：

- `model`
- `modelProvider`
- `reasoningEffort`
- `modelSelection`
- `modelChangeStatus`
- `modelChangeError`

## 11. 错误码

| 错误码 | 场景 |
| --- | --- |
| `MODEL_LIST_UNAVAILABLE` | 无法读取 app-server 支持模型列表 |
| `MODEL_NOT_SUPPORTED` | 请求模型不在当前支持列表中 |
| `MODEL_EFFORT_NOT_SUPPORTED` | 推理强度不受目标模型支持 |
| `MODEL_SWITCH_NOT_ALLOWED` | 当前会话状态不允许切换 |
| `MODEL_SWITCH_FAILED` | app-server 无法应用模型变更 |
| `MODEL_PROVIDER_UNAVAILABLE` | 当前 provider 或代理不可用 |
| `MODEL_REQUEST_TIMEOUT` | 模型请求超时 |

## 12. 验收标准

- AC-01：`GET /api/models` 完整展示 app-server `model/list` 的非隐藏模型并处理分页。
- AC-02：请求不在 `model/list` 中的模型时，后端返回 `MODEL_NOT_SUPPORTED`。
- AC-03：历史会话当前模型不受支持时仍可展示，但不会出现在选择项中。
- AC-04：历史会话可以在恢复前选择支持模型，恢复后的实际模型与选择一致。
- AC-05：`waiting_input` 会话切换模型后，下一 turn 使用新模型。
- AC-06：`running`、`starting` 和 `waiting_approval` 状态的前后端均拒绝模型切换。
- AC-07：模型切换不改变完全权限、审批策略和 sandbox 设置。
- AC-08：目标模型不支持原推理强度时，界面提示并使用目标模型默认值。
- AC-09：服务重启后，偏好模型仍受支持时能在恢复时重新应用。
- AC-10：偏好模型已不受支持时停止应用并要求重新选择。
- AC-11：重置为“跟随会话”后不再传递模型覆盖。
- AC-12：模型请求失败时，消息区展示错误和模型切换入口。
- AC-13：切换模型后不会自动重放失败消息，只有用户确认后才重试。
- AC-14：API 和 WebSocket 未登录访问返回未授权。
- AC-15：API 和页面不读取或暴露 cc-switch、provider 和认证配置。
- AC-16：桌面端和 H5 均能完成模型查看、切换和故障恢复。
- AC-17：刷新模型列表不会重启 app-server 或中断活跃会话。

## 13. 测试要求

单元测试：

- `model/list` 分页、隐藏模型过滤和缓存。
- 模型选择与推理强度校验。
- 不支持模型只读展示。
- 模型状态切换限制。
- 偏好持久化和失效处理。
- 错误信息脱敏。

集成测试：

- `thread/resume` 模型覆盖。
- `thread/settings/update` 空闲会话切换。
- `thread/settings/updated` 实际模型确认。
- `turn/start` 模型一致性。
- 模型变更与权限变更串行化。

端到端测试：

- 桌面和 H5 模型选择器。
- 历史会话恢复前选择模型。
- 不支持模型会话的恢复入口。
- 空闲会话切换模型。
- 运行中禁用切换。
- 502 错误展示、切换模型和人工重试。
- 模型列表刷新。

真实环境验收：

- 使用 `model/list` 中的模型完成真实响应。
- 使用故障模型会话切换到支持模型并继续原会话。
- 记录 Codex CLI 版本、模型名称和验收时间，不记录认证信息。

## 14. 兼容性与升级

- app-server 协议可能随 Codex CLI 版本变化，升级 CLI 后必须重新生成 schema 并运行兼容测试。
- 既有会话默认采用“跟随会话”，不会因功能上线被批量切换模型。
- 已有 Web 元数据缺少模型字段时按空值处理，不迁移 Codex 会话文件。
- 支持模型列表只代表 app-server 当前声明的能力，不保证 provider、额度和上游服务始终可用。
- cc-switch 与 Web 模型切换彼此独立：cc-switch 管理全局配置，Web 只管理指定会话的模型覆盖。

## 15. 重新审核记录

| 审核项 | 结果 | 说明 |
| --- | --- | --- |
| 用户目标一致性 | 通过 | 只实现当前支持模型的会话级切换 |
| 技术可行性 | 通过 | app-server schema 支持列表、恢复和设置更新 |
| cc-switch 隔离 | 通过 | 不读取、不修改、不依赖 cc-switch 文件 |
| 数据安全 | 通过 | 不修改 Codex JSONL 和全局配置 |
| 认证与密钥安全 | 通过 | 不读取或返回 provider 认证信息 |
| 失败安全 | 通过 | 禁止自动换模型和自动重放任务 |
| 向后兼容 | 通过 | 既有会话默认跟随原模型 |

重新审核结论：需求已收窄为“app-server 当前支持模型的会话级切换”，不会改变或破坏 cc-switch。用户已确认该版本，作为详细设计和后续实现的唯一需求基线。

## 16. 建议实施顺序

1. 新增 `ModelCatalogService`，只封装 `model/list`、分页、过滤和缓存。
2. 扩展共享模型、会话元数据和 runtime 数据结构。
3. 实现会话模型偏好接口和支持列表校验。
4. 扩展 `RuntimeManager` 的恢复、设置更新和 `turn/start` 参数。
5. 实现桌面/H5 模型选择器和状态限制。
6. 将模型错误展示到消息区并支持人工重试。
7. 完成单元、集成、端到端和真实环境验收。
