# 会话模型切换实施与验收记录

## 基本信息

- 日期：2026-07-19（UTC）
- 分支：`main`
- Codex CLI：`codex-cli 0.144.5`
- Web 监听端口：`4310`
- app-server：`ready / initialized`
- 需求文档：[model-change-requirements.md](../model-change-requirements.md)
- 详细设计：[model-change-detailed-design.md](../model-change-detailed-design.md)
- 任务计划：[model-change-task-plan.md](../model-change-task-plan.md)

本文只记录非敏感验收信息，不包含 Cookie、token、API Key、provider 地址或认证配置。

## 实施结果

- 支持模型只来自 app-server `model/list`，不接受手工模型标识。
- 模型偏好按会话保存到 `.codex-manage/session-metadata.json`，不修改 Codex JSONL。
- 历史不支持模型继续展示，但不能作为新选择值。
- `history`、`failed`、`exited` 保存偏好并在恢复时应用。
- `waiting_input` 使用 `thread/settings/update` 即时切换并等待通知确认。
- `starting`、`running`、`waiting_approval` 按状态拒绝切换。
- 恢复、模型设置、权限设置和新 turn 启动按 thread 串行化。
- 桌面与 H5 均提供模型搜索、effort 选择、跟随会话、错误入口和人工重试确认。
- 不读取、不修改、不监控、不依赖 cc-switch、`config.toml`、`auth.json` 或全局 provider 配置。

## 自动化验证

- `npm run typecheck`：通过。
- `npm test`：18 个测试文件、79 个测试通过。
- `npm run build`：前端和服务端生产构建通过。
- `npm run test:e2e`：桌面/H5 共 8 个 Playwright 场景通过。
- E2E 覆盖历史不支持模型、模型搜索、默认 effort、运行中禁用、终止错误、切换后不自动重发、人工确认重试和 H5 44px 触控区域。
- 未认证模型 API 和 WebSocket upgrade、错误脱敏、非法参数均有自动化测试。

## 真实 app-server 验收

### 模型目录

- `model/list` 返回 7 个非隐藏模型。
- 手动强制刷新成功，`stale=false`，未重启 app-server。
- 目录默认模型为 `gpt-5.6-sol`。

### 故障会话恢复

验收会话：`019f705e-ed9c-78f1-9272-a2566889509c`。

验收前状态：

- 历史 turn：5。
- 历史模型：`z-ai/glm-5.2 / high`。
- 历史 provider 标识：`custom`。
- 当前目录支持状态：不支持。
- Web 偏好：跟随会话。

验收过程与结果：

1. 在 `history` 状态选择 `gpt-5.6-sol / low`，接口返回 `applied=false`，只保存偏好。
2. 使用默认权限恢复，实际模型确认为 `gpt-5.6-sol / low`，状态进入 `waiting_input`。
3. 在 `waiting_input` 切换为 `gpt-5.4-mini / medium`，通知确认成功，权限仍为 `default`。
4. 发送无工具验收消息，原会话新增一个完成 turn，并收到 `MODEL_SWITCH_ACCEPTED`。
5. 在运行中的另一 turn 尝试切换模型，返回 `409 MODEL_SWITCH_NOT_ALLOWED`，原模型和权限保持不变。
6. 重启 Web/app-server 后，持久偏好仍存在；再次恢复时正确应用偏好模型和 effort。
7. provider 失败时只产生一个失败 turn，没有自动降级或自动重放；用户显式切换回 `gpt-5.4-mini / medium` 并人工重试后收到完整回复。
8. 最终会话保留 9 个历史 turn，当前模型为 `gpt-5.4-mini / medium`，状态为 `waiting_input`，权限为 `default`。

### 权限与 sandbox 一致性

- 默认权限下多次模型切换均保持 `permissionMode=default`。
- 验收中显式切换为 `full_access` 后，连续切换 `gpt-5.4` 和 `gpt-5.4-mini`，`permissionMode` 始终保持 `full_access`。
- 随后显式恢复为 `default`，最终状态确认成功。
- 模型变更没有自动批准请求、改变工作目录或修改全局 sandbox 配置。
- 为避免制造额外外部副作用，真实环境未主动构造 `waiting_approval`；该状态的拒绝行为由 RuntimeManager、路由和桌面/H5 E2E 覆盖。

### 错误脱敏修复

真实 provider 502 验收暴露出错误文本包含上游 URL。实施中已修复：

- `sanitizeModelError()` 统一将 HTTP/HTTPS URL 替换为 `[REDACTED_URL]`。
- JSON-RPC 实时错误、模型目录错误、路由错误和运行态错误均使用同一脱敏逻辑。
- `SessionService` 返回的历史 turn error 同样执行脱敏。
- 真实失败复验确认运行态只返回 `[REDACTED_URL]`，不再包含 provider 地址。

## cc-switch 隔离验证

- 环境中存在独立的 `/usr/bin/cc-switch`。
- 验收未执行 cc-switch，也未读取其目录或配置。
- 源码扫描未发现 cc-switch、`config.toml` 或 `auth.json` 的读写路径。
- 模型切换只调用 app-server JSON-RPC，并只保存会话级 Web 元数据，因此不会阻止 cc-switch 独立使用。

## 验收截图

- [桌面模型选择器](../acceptance/2026-07-19/desktop-model-selector.png)
- [H5 模型选择器](../acceptance/2026-07-19/mobile-model-selector.png)

## 已知限制

- 不同支持模型仍可能受各自上游 provider 可用性影响；系统不会自动降级到其他模型。
- `thread/settings/update` 超过 5 秒未确认时会保持确认中，并等待后续通知对账。
- app-server 不提供恢复时独立 effort 参数，因此显式 effort 在恢复后通过 settings update 应用。
- 失败消息的人工重试创建新 turn，原失败 turn 永久保留。

## 交付结论

会话模型切换功能已完成 MC-M1 至 MC-M8。指定故障会话已从不支持模型恢复到当前支持模型并完成真实回复；会话历史、权限、审批边界、sandbox 和 cc-switch 独立性均保持。
