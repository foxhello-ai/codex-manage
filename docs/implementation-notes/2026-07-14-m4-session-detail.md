# M4 会话详情实现记录

## 基本信息

- 日期：2026-07-14
- 对应任务：M4 会话详情
- 前置调研：`docs/implementation-notes/2026-07-14-thread-read-structure-research.md`

## 实现内容

### 后端

- 新增 `SessionService.getSessionDetail(sessionId)`。
- 使用 `thread/read`，请求参数为 `{ threadId, includeTurns: true }`。
- 新增 `GET /api/sessions/:id`。
- 详情接口返回稳定的 Web 模型，避免前端直接依赖 app-server 原始结构。
- 复用备注标题元数据，详情标题与列表标题保持一致。
- 支持映射以下 item：
  - `userMessage` -> `user_message`
  - `agentMessage` -> `agent_message`
  - `fileChange` -> `file_change`
  - `contextCompaction` -> `context_compaction`
  - 未知类型 -> `unknown`

### 前端

- 选择会话后加载真实详情，不再只展示占位元信息。
- 展示基础元信息：工作目录、更新时间、会话 ID、模型来源、历史模式、CLI 版本。
- 展示历史 turn 和消息流。
- `fileChange.diff` 默认折叠，避免详情页过长。
- H5 下继续使用会话抽屉选择会话，选择后关闭抽屉并进入详情。
- 会话消息支持轻量 Markdown 渲染，覆盖标题、列表、引用、代码块、行内代码、粗体/斜体和链接。
- 消息默认以固定预览高度展示；点击用户或 Codex 回复后打开详情弹层，弹层内容支持滚动查看。
- 详情顶部隐藏 CLI 版本、模型来源、历史模式等技术信息，改为显著展示会话备注或名称。
- 历史对话默认展示最近 5 轮，点击加载更多后按 5 轮增量向前展开。

## 未纳入 M4 的内容

- 历史命令展示留到 M5 JSONL parser。
- `thread/resume` 恢复留到 M6。
- WebSocket 实时事件留到 M7。
- Web 输入继续任务留到 M8。
- 命令执行过程和审批交互留到 M9/M10。

## 验证

- `npm run typecheck`：通过。
- `npm test`：通过，6 个测试文件、15 个用例。
- `npm run build`：通过。
- 本机 API 验证：登录、`GET /api/sessions`、`GET /api/sessions/:id` 均返回 200；详情返回 turn 和 item 类型统计正常。

## 审计记录

- 未执行删除类命令。
- 本轮修改均在项目工作目录 `/config/projects/codex-manage` 内完成。
- 由于当前沙箱执行命令时出现 `bwrap: Failed to make / slave: Permission denied`，读取、写入、测试和构建命令使用了提升权限执行。
- 调研脚本位于 `/tmp`，未写入仓库，调研结果已脱敏归档。
