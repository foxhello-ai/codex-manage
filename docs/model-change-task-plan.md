# Codex Web 会话模型切换实施任务计划

## 1. 文档信息

- 文档日期：2026-07-19
- 文档状态：用户已确认，实施中
- 需求状态：用户已确认
- 详细设计状态：用户已确认
- 实施代码基线：`feature/f-20260717-replace-logo`
- Codex CLI 基线：`codex-cli 0.144.5`
- 需求文档：[model-change-requirements.md](./model-change-requirements.md)
- 详细设计：[model-change-detailed-design.md](./model-change-detailed-design.md)
- 主任务规划：[task-plan.md](./task-plan.md)

## 2. 计划目标

按已确认需求和详细设计，实现指定会话在 app-server 当前支持模型之间切换，并满足：

- 保留原会话 ID、历史 turns、命令记录、备注和权限设置。
- 可选模型只来自 app-server `model/list`。
- 历史模型不受支持时仍可展示，但不能作为新的选择值。
- 模型覆盖只影响指定会话，不修改其他会话或全局默认模型。
- `history`、`failed`、`exited` 状态保存偏好并在恢复时应用。
- `waiting_input` 状态通过 `thread/settings/update` 即时应用。
- `starting`、`running`、`waiting_approval` 状态拒绝切换。
- 桌面端和 H5 均可查看、选择、确认和处理模型错误。
- 不读取、不修改、不监控、不依赖 cc-switch 文件。

## 3. 实施原则

- 每个里程碑必须先完成对应自动化测试，再进入依赖它的下一里程碑。
- Route 只负责鉴权、参数校验和错误映射，业务规则集中在服务层。
- app-server 响应和 `thread/settings/updated` 通知是运行态模型事实来源。
- 模型目录、模型偏好、历史模型和实际模型使用不同字段表达，不互相覆盖。
- 不修改 Codex JSONL、`config.toml`、`auth.json` 或 provider 配置。
- 不自动降级模型，不自动重放失败消息，不产生隐藏 turn。
- 既有权限切换、恢复、输入、审批和实时输出能力必须保持兼容。
- 发现 schema 与 `codex-cli 0.144.5` 不一致时停止扩展实现，先更新协议证据和设计记录。

## 4. 里程碑总览

| 里程碑 | 名称 | 状态 | 主要需求 | 退出门槛 |
| --- | --- | --- | --- | --- |
| MC-M0 | 基线冻结与实施准备 | 已完成 | 全部 | 需求、设计、协议和边界均已确认 |
| MC-M1 | 共享契约与偏好持久化 | 已完成 | MR-009、MR-010、MR-011 | 类型、兼容读取和原子写入测试通过 |
| MC-M2 | 支持模型目录与查询 API | 待开始 | MR-001、MR-002、MR-017 | 分页、缓存、刷新、校验和路由测试通过 |
| MC-M3 | 历史模型解析与会话详情 | 待开始 | MR-003、MR-004 | 历史模型可准确展示且不可用模型只读 |
| MC-M4 | 会话模型业务服务与变更 API | 待开始 | MR-005、MR-007、MR-010、MR-011 | 状态矩阵、偏好生命周期和 API 测试通过 |
| MC-M5 | 运行时应用、锁与通知对账 | 待开始 | MR-006、MR-008、MR-009、MR-012、MR-013、MR-014 | resume、settings、turn 和事件一致性测试通过 |
| MC-M6 | 桌面/H5 交互与故障恢复 | 待开始 | MR-003、MR-011、MR-012、MR-016 | 桌面和 H5 主流程组件测试通过 |
| MC-M7 | 全量自动化、回归与安全验证 | 待开始 | MR-015、MR-017、AC-01 至 AC-17 | typecheck、unit、build、E2E 全部通过 |
| MC-M8 | 真实环境验收与交付 | 待开始 | AC-01 至 AC-17 | 真实 app-server 验收、记录和发布文档完成 |

## 5. 依赖关系

```text
MC-M0
  └── MC-M1
        ├── MC-M2
        └── MC-M3
              └──────┐
MC-M2 ────────────────┼── MC-M4 ── MC-M5 ── MC-M6 ── MC-M7 ── MC-M8
MC-M1 ────────────────┘
```

执行约束：

- MC-M2 与 MC-M3 可在 MC-M1 完成后并行开发。
- MC-M4 必须等待 MC-M1、MC-M2、MC-M3 的契约稳定。
- MC-M6 可以提前制作静态布局，但联调完成必须等待 MC-M5。
- MC-M7 是正式全量质量门槛；此前各里程碑仍需运行其相关测试。
- MC-M8 不允许使用模拟 app-server 代替真实环境验收。

## 6. MC-M0：基线冻结与实施准备

状态：已完成。

目标：

- 冻结已审核需求、设计决策、协议版本和安全边界。
- 建立后续任务的唯一实施基线。

已完成任务：

- [x] 确认 17 条模型变更需求和 17 条验收标准。
- [x] 确认详细设计 D-001 至 D-012。
- [x] 基于 `codex-cli 0.144.5` schema 验证 `model/list`、`thread/resume`、`thread/settings/update`、`thread/settings/updated` 和 `turn/start`。
- [x] 确认模型目录缓存 60 秒、通知确认等待 5 秒。
- [x] 确认偏好保存到 `.codex-manage/session-metadata.json`。
- [x] 确认与 cc-switch、全局 provider 和认证配置完全隔离。
- [x] 需求和详细设计获得用户审核通过。

交付物：

- `docs/model-change-requirements.md`
- `docs/model-change-detailed-design.md`
- `docs/model-change-task-plan.md`

退出标准：已满足。

## 7. MC-M1：共享契约与偏好持久化

目标：

- 建立前后端共用模型类型、错误类型和持久化结构。
- 在不破坏现有备注元数据的前提下保存会话模型偏好。

任务：

- [x] MC-T101：在 `src/shared/models.ts` 增加 `ModelOption`、`ModelCatalogResponse`、`SessionModelState`、`ModelSelectionResponse` 和运行态扩展字段。
- [x] MC-T102：在 `src/shared/api.ts` 增加模型列表、模型变更和错误响应契约。
- [x] MC-T103：定义统一 `ModelErrorCode` 和安全错误详情结构。
- [x] MC-T104：扩展 `SessionMetadataStore`，增加 `modelSelection` 默认值和旧格式兼容读取。
- [x] MC-T105：实现备注与模型偏好互不覆盖的 patch/update 接口。
- [x] MC-T106：增加同一元数据文件写入队列和临时文件原子替换。
- [x] MC-T107：覆盖旧格式、未知字段保留、并发写入和写入失败测试。

主要文件：

- `src/shared/models.ts`
- `src/shared/api.ts`
- `src/server/services/SessionMetadataStore.ts`
- `src/server/services/SessionMetadataStore.test.ts`

退出标准：

- 旧元数据只有 `remarkTitle` 时可正常读取并补默认模型选择。
- 更新备注不会删除模型偏好，更新模型偏好不会删除备注。
- `follow_session` 和 `override` 数据可规范化、校验和持久化。
- 并发写入顺序稳定，失败时原文件保持有效。
- 相关单元测试和 `npm run typecheck` 通过。

## 8. MC-M2：支持模型目录与查询 API

目标：

- 使用 `model/list` 建立唯一可选择模型目录。
- 提供经过认证的模型列表与强制刷新接口。

任务：

- [ ] MC-T201：新增 `ModelCatalogService`，封装 `model/list`。
- [ ] MC-T202：实现 `nextCursor` 分页、20 页保护、模型去重、隐藏过滤和稳定排序。
- [ ] MC-T203：规范化展示名、描述、默认 effort、支持 effort、`upgradeModel` 和 `upgradeCopy`。
- [ ] MC-T204：实现 60 秒缓存、single-flight 刷新和手动强制刷新。
- [ ] MC-T205：实现旧缓存 stale 回退及无缓存失败错误。
- [ ] MC-T206：实现模型存在性和 reasoning effort 校验；未命中时强制刷新一次。
- [ ] MC-T207：新增并注册 `GET /api/models?refresh=true`。
- [ ] MC-T208：覆盖未认证、分页、缓存、并发刷新、失败回退和错误脱敏测试。

主要文件：

- `src/server/services/ModelCatalogService.ts`
- `src/server/services/ModelCatalogService.test.ts`
- `src/server/routes/models.ts`
- `src/server/routes/models.test.ts`
- `src/server/index.ts`

退出标准：

- `GET /api/models` 只返回 `hidden=false` 的 app-server 模型。
- 不存在模型返回 `MODEL_NOT_SUPPORTED`，不支持 effort 返回 `MODEL_EFFORT_NOT_SUPPORTED`。
- 刷新不会重启 app-server 或中断活跃会话。
- API 不返回 provider 认证信息、cc-switch 路径或本地配置内容。
- MC-M2 全部单元和路由测试通过。

## 9. MC-M3：历史模型解析与会话详情

目标：

- 从现有 JSONL 只读识别历史会话最后有效模型状态。
- 在详情 API 中区分历史模型、偏好模型和实际模型。

任务：

- [ ] MC-T301：扩展 `JsonlSessionParser.readModelState(sessionId)`。
- [ ] MC-T302：解析 `session_meta`、`turn_context`、collaboration settings 和 `thread_settings_applied`。
- [ ] MC-T303：实现按记录顺序取最后非空值、坏行容错和 diagnostics。
- [ ] MC-T304：确保只处理匹配 session，找不到模型时返回 `null` 而不猜测默认模型。
- [ ] MC-T305：扩展 `SessionService.getSessionDetail()` 聚合历史状态、持久偏好和目录支持状态。
- [ ] MC-T306：在详情响应中标识 `actualModelSupported=false` 的历史模型。
- [ ] MC-T307：覆盖多次切换、坏 JSON、不匹配 session、无模型和不可用模型测试。

主要文件：

- `src/server/services/JsonlSessionParser.ts`
- `src/server/services/JsonlSessionParser.test.ts`
- `src/server/services/SessionService.ts`
- `src/server/services/SessionService.test.ts`

退出标准：

- 历史会话可展示具体 model、provider 和 reasoning effort。
- 不在当前 `model/list` 的历史模型仍显示，但被标记为当前不可选。
- JSONL 单行损坏不会阻断详情主流程。
- 解析过程不修改任何 `~/.codex/sessions/**/*.jsonl`。
- MC-M3 相关测试通过。

## 10. MC-M4：会话模型业务服务与变更 API

目标：

- 集中实现模型选择校验、状态规则、偏好生命周期和 API 行为。

任务：

- [ ] MC-T401：新增 `SessionModelService` 并注入目录、元数据、JSONL 和 runtime 依赖。
- [ ] MC-T402：实现 `getSessionModelState()` 和模型状态组合优先级。
- [ ] MC-T403：实现 `updateSelection()`，覆盖 `follow_session` 与 `override`。
- [ ] MC-T404：实现 `history`、`failed`、`exited` 只保存偏好的路径。
- [ ] MC-T405：实现 `waiting_input` 即时应用编排接口。
- [ ] MC-T406：拒绝 `starting`、`running`、`waiting_approval` 状态切换。
- [ ] MC-T407：实现偏好失效检查和重新选择提示。
- [ ] MC-T408：新增 `PATCH /api/sessions/:id/model` 及 Zod 校验、认证和错误映射。
- [ ] MC-T409：实现 app-server 成功但元数据写入失败的部分成功响应，不回滚实际模型。
- [ ] MC-T410：覆盖状态矩阵、非法模型、非法 effort、follow_session 和部分成功测试。

主要文件：

- `src/server/services/SessionModelService.ts`
- `src/server/services/SessionModelService.test.ts`
- `src/server/routes/sessions.ts`
- `src/server/routes/sessions.test.ts`
- `src/server/services/AppRuntime.ts`

退出标准：

- 所有会话状态均严格符合需求状态矩阵。
- `follow_session` 只清除 Web 偏好，不发送 `model:null`。
- 无效偏好不会传给 app-server。
- 未认证请求被拒绝，领域错误映射为设计规定的 HTTP 状态。
- MC-M4 服务和路由测试通过。

## 11. MC-M5：运行时应用、锁与通知对账

目标：

- 让模型覆盖在恢复、空闲切换和发送新 turn 时一致生效。
- 防止模型设置与权限设置并发竞态。

任务：

- [ ] MC-T501：扩展 `RuntimeState`、`RuntimeSnapshot` 和模型变更状态。
- [ ] MC-T502：实现按 `threadId` 的会话操作 Promise 队列。
- [ ] MC-T503：将 resume、模型设置、权限设置和 turn 启动纳入同一会话锁。
- [ ] MC-T504：扩展 `thread/resume`，在存在显式偏好时传递 model。
- [ ] MC-T505：恢复成功后通过 `thread/settings/update` 应用显式 effort。
- [ ] MC-T506：实现 `waiting_input` 的 `thread/settings/update { model, effort }`。
- [ ] MC-T507：等待 `thread/settings/updated` 最长 5 秒，并按 threadId 对账实际设置。
- [ ] MC-T508：超时返回 HTTP 202/`confirmationPending=true`，后续通知到达时继续完成对账。
- [ ] MC-T509：通知模型不匹配时产生 `MODEL_SWITCH_MISMATCH`，请求失败时保留原实际模型。
- [ ] MC-T510：扩展 `turn/start`，再次显式传递有效 model 和 effort。
- [ ] MC-T511：保持 `turn/steer` 行为不变，不在 active turn 中热切换模型。
- [ ] MC-T512：发布 `model_change_started/completed/failed` WebSocket 事件并规范化模型错误。
- [ ] MC-T513：覆盖同 thread 串行、不同 thread 并行、确认超时、延迟通知和权限并发测试。

主要文件：

- `src/server/services/RuntimeManager.ts`
- `src/server/services/RuntimeManager.test.ts`
- `src/server/services/AppRuntime.ts`
- `src/shared/models.ts`

退出标准：

- 恢复、设置更新和下一 turn 使用的模型与偏好一致。
- 模型和权限设置不会互相覆盖或乱序。
- 5 秒确认超时不会误报失败，延迟通知仍能更新 UI。
- app-server 拒绝时保留旧实际模型并产生可展示错误。
- 不同会话仍可并行运行。
- MC-M5 运行时测试通过。

## 12. MC-M6：桌面/H5 交互与故障恢复

目标：

- 用户能够在桌面端和 H5 查看当前模型、选择支持模型并处理失败会话。

任务：

- [ ] MC-T601：增加前端模型目录加载、刷新和错误状态。
- [ ] MC-T602：新增 `ModelSelector.tsx` 和模型搜索、排序、默认标记、upgrade 提示。
- [ ] MC-T603：在运行状态区展示实际模型、provider、effort、偏好和支持状态。
- [ ] MC-T604：实现历史/失败/退出状态的“保存并在恢复时应用”。
- [ ] MC-T605：实现 `waiting_input` 即时应用和确认中状态。
- [ ] MC-T606：为 `starting`、`running`、`waiting_approval` 展示禁用原因。
- [ ] MC-T607：目标模型不支持当前 effort 时提示并选择默认 effort。
- [ ] MC-T608：处理模型变更 WebSocket 事件和通用 `error` 事件，将错误写入消息区。
- [ ] MC-T609：新增失败消息人工重试确认框，不自动发送原消息。
- [ ] MC-T610：桌面端使用运行状态区域选择器，H5 使用底部弹层并满足 44px 触控区域。
- [ ] MC-T611：覆盖搜索、禁用状态、成功、失败、确认中、不可用历史模型和人工重试组件测试。

主要文件：

- `src/client/ModelSelector.tsx`
- `src/client/modelSelection.ts`
- `src/client/modelSelection.test.ts`
- `src/client/App.tsx`
- `src/client/styles.css`

退出标准：

- 桌面端和 H5 均能完成查看、选择、应用和重置为跟随会话。
- 历史不可用模型有明确标识且不会出现在可选项中。
- 运行中和等待审批时无法切换，原因清晰。
- 错误在消息区可见，重试必须经过用户确认。
- 不展示 cc-switch、API Key、provider URL 或认证配置。
- MC-M6 前端测试通过。

## 13. MC-M7：全量自动化、回归与安全验证

目标：

- 证明模型切换功能完整覆盖 AC-01 至 AC-17，且不破坏现有能力。

任务：

- [ ] MC-T701：补齐 ModelCatalogService、JsonlSessionParser、SessionMetadataStore、SessionModelService 和 RuntimeManager 单元测试。
- [ ] MC-T702：补齐模型列表、模型变更、恢复和输入路由集成测试。
- [ ] MC-T703：补齐未认证 API/WebSocket、错误脱敏和非法参数测试。
- [ ] MC-T704：扩展桌面 Playwright：恢复前选择、空闲切换、运行中禁用、错误与人工重试。
- [ ] MC-T705：扩展 H5 Playwright：底部弹层、搜索、effort、错误和触控操作。
- [ ] MC-T706：验证模型列表刷新不重启 app-server、不影响活跃会话。
- [ ] MC-T707：回归登录、会话列表、详情、备注、恢复、输入、实时输出、命令和审批。
- [ ] MC-T708：执行不修改文件检查，确认未触碰 cc-switch、Codex JSONL、`config.toml` 和 `auth.json`。
- [ ] MC-T709：执行全量质量命令并保存结果。

质量命令：

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e
```

退出标准：

- 四项质量命令全部通过。
- AC-01 至 AC-17 均有自动化测试或明确真实环境验收项。
- 桌面端和 H5 E2E 均通过。
- 既有 MVP 主流程无回归。
- 安全边界检查无 cc-switch 或全局配置读写。

## 14. MC-M8：真实环境验收与交付

目标：

- 在真实 app-server 和真实历史会话上确认功能闭环，形成可发布记录。

任务：

- [ ] MC-T801：记录验收 Codex CLI 版本、时间和非敏感环境信息。
- [ ] MC-T802：验证 `model/list` 当前非隐藏模型与 Web 目录一致。
- [ ] MC-T803：使用支持模型恢复历史会话并完成真实响应。
- [ ] MC-T804：使用故障会话 `019f705e-ed9c-78f1-9272-a2566889509c` 切换到支持模型并继续原会话。
- [ ] MC-T805：在 `waiting_input` 状态切换模型，验证下一 turn 使用新模型。
- [ ] MC-T806：验证 `running` 和 `waiting_approval` 状态无法切换。
- [ ] MC-T807：验证完全权限、审批策略和 sandbox 在模型切换前后不变。
- [ ] MC-T808：验证失败消息不会自动重放，人工确认后才能重试。
- [ ] MC-T809：重启 Web/app-server 后验证受支持偏好重新应用、失效偏好要求重新选择。
- [ ] MC-T810：确认 cc-switch 可独立使用，Web 未创建对其文件或配置的依赖。
- [ ] MC-T811：生成实施记录、验收记录和发布说明。

交付物：

- `docs/implementation-notes/<date>-model-switching.md`
- 桌面/H5 验收截图或录像索引。
- 更新后的发布说明。
- 自动化测试结果摘要。

退出标准：

- 真实支持模型能在原会话中完成回复。
- 故障模型会话可切换并继续，不丢失历史。
- 会话级覆盖不影响其他会话和全局默认模型。
- 权限、sandbox、审批和 cc-switch 均未受到模型切换功能破坏。
- 验收不记录 token、API Key、Cookie 或 provider 认证信息。
- 发布文档完成，所有已知限制有记录。

## 15. 验收标准到里程碑映射

| 验收标准 | 主要里程碑 |
| --- | --- |
| AC-01、AC-02、AC-17 | MC-M2、MC-M7、MC-M8 |
| AC-03 | MC-M3、MC-M6 |
| AC-04、AC-05 | MC-M4、MC-M5、MC-M8 |
| AC-06、AC-07 | MC-M4、MC-M5、MC-M6 |
| AC-08 | MC-M2、MC-M4、MC-M6 |
| AC-09、AC-10、AC-11 | MC-M1、MC-M4、MC-M5 |
| AC-12、AC-13 | MC-M5、MC-M6 |
| AC-14、AC-15 | MC-M2、MC-M4、MC-M7 |
| AC-16 | MC-M6、MC-M7、MC-M8 |

## 16. 每个里程碑的完成定义

单个里程碑只有同时满足以下条件才能标记为完成：

- 清单中的必需任务已经完成或有经审核的变更说明。
- 对应单元、路由、组件或 E2E 测试通过。
- `npm run typecheck` 通过。
- 新增错误路径有用户可理解的提示且已脱敏。
- 没有修改 Codex JSONL、全局 provider、认证配置或 cc-switch。
- 相关文档、类型和 API 示例保持一致。
- 不遗留会阻断下一里程碑的已知问题。

## 17. 风险与停止条件

出现以下情况时暂停当前里程碑，不带问题进入下一阶段：

- 实际 app-server schema 与设计基线不一致。
- `thread/settings/updated` 无法可靠关联 thread 或无法确认实际模型。
- 模型设置与权限设置存在无法串行化的竞态。
- 元数据兼容处理可能覆盖既有备注或未知字段。
- 前端只能显示选择成功，但无法证明 app-server 实际应用。
- 实现需要读取、修改或依赖 cc-switch、`config.toml`、`auth.json`。
- 实现需要自动重放消息或自动切换到未获用户确认的模型。

风险处理后必须补充设计说明和回归测试，再恢复实施。

## 18. 建议交付批次

| 批次 | 包含里程碑 | 可审核成果 |
| --- | --- | --- |
| A：数据基础 | MC-M1 至 MC-M3 | 共享契约、偏好持久化、模型目录、历史模型详情 |
| B：后端闭环 | MC-M4 至 MC-M5 | 模型变更 API、恢复/空闲切换、运行时对账与事件 |
| C：用户体验 | MC-M6 | 桌面/H5 模型选择、错误展示和人工重试 |
| D：发布验收 | MC-M7 至 MC-M8 | 全量测试、真实环境验收、实施记录和发布说明 |

每个批次完成后均可独立提交审核；未经对应里程碑退出门槛验证，不进入下一批次。

## 19. 当前进度

- [x] MC-M0：基线冻结与实施准备。
- [x] MC-M1：共享契约与偏好持久化。
- [ ] MC-M2：支持模型目录与查询 API。
- [ ] MC-M3：历史模型解析与会话详情。
- [ ] MC-M4：会话模型业务服务与变更 API。
- [ ] MC-M5：运行时应用、锁与通知对账。
- [ ] MC-M6：桌面/H5 交互与故障恢复。
- [ ] MC-M7：全量自动化、回归与安全验证。
- [ ] MC-M8：真实环境验收与交付。

下一执行入口：MC-M2 与 MC-M3。
