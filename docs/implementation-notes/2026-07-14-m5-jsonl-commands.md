# M5 JSONL 历史命令解析实现记录

## 基本信息

- 日期：2026-07-14
- 对应任务：M5 JSONL 历史命令解析
- 前置调研：`docs/implementation-notes/2026-07-14-jsonl-command-research.md`

## 实现内容

### 后端

- 新增 `JsonlSessionParser`。
- 每次请求实时扫描 `CODEX_SESSIONS_DIR/**/*.jsonl`，MVP 暂不做缓存。
- 通过 `session_meta.payload.id` 和 `session_meta.payload.session_id` 匹配会话。
- 解析 `response_item.payload.type === "function_call"` 且 `payload.name === "exec_command"` 的历史命令。
- 解析 `payload.arguments` JSON 字符串，提取：
  - `cmd`
  - `workdir`
  - `sandbox_permissions`
  - `justification`
  - `prefix_rule`
  - `tty`
  - `yield_time_ms`
  - `max_output_tokens`
- 通过 `call_id` 关联 `function_call_output`。
- 缺失输出的命令标记为 `running`，已关联输出的命令标记为 `completed`。
- 新增 `GET /api/sessions/:id/commands`。
- 返回解析诊断信息：扫描文件数、解析行数、解析错误数、是否匹配到会话文件。

### 前端

- 会话详情页新增默认折叠的“历史命令”区块。
- 展示命令状态、命令内容、工作目录、审批/沙箱摘要和输出。
- 支持复制命令。
- 已完成命令输出默认折叠，展开后限制高度并滚动。
- 运行中命令输出不做高度限制。
- 未匹配 JSONL 文件或无命令时显示空状态。

## 验证

- `npm run typecheck`：通过。
- `npm test`：通过，7 个测试文件、18 个用例。
- `npm run build`：通过。
- 本机 API 验证：登录、`GET /api/sessions`、`GET /api/sessions/:id/commands` 均返回 200。
- 本机 API 验证结果：命令接口返回 469 条命令，其中 468 条 completed、1 条 running。

## 审计记录

- 未执行删除类命令。
- 本轮修改均在项目工作目录 `/config/projects/codex-manage` 内完成。
- 调研脚本位于 `/tmp`，未写入仓库，调研结果已脱敏归档。
- 由于当前沙箱执行命令时出现 `bwrap: Failed to make / slave: Permission denied`，读取、写入、测试和构建命令使用了提升权限执行。
