# 会话深链接、完全权限与实时输出调研记录

## 基本信息

- 日期：2026-07-15
- 代码基线：`7209ff3`
- 调研目标：验证会话详情深链接、按会话启用 Codex 完全权限、实时输出滚动控制、用户发送即时回显和 `Ctrl+Enter` 发送的可行性。

## 调研环境与命令版本

- `codex --version`：`codex-cli 0.144.3`
- `node --version`：`v22.23.1`
- `npm --version`：`10.9.8`

执行的关键调研命令：

```bash
codex --version
codex app-server --help
codex app-server generate-ts --experimental --out /tmp/codex-manage-permissions-protocol-01443
node --version
npm --version
```

调研时从官方 Codex 手册核对以下主题：`Agent approvals & security`、`Codex App Server`、`Permissions`。本机协议类型以当前 CLI 生成结果为准，避免以其他版本的字段推断实现。

## 审计记录

- 工作目录外新增临时协议类型目录：`/tmp/codex-manage-permissions-protocol-01443`。
- 临时目录只用于读取 `ThreadResumeParams`、`TurnStartParams`、`ThreadSettingsUpdateParams`、`SandboxPolicy` 和 `AskForApproval` 的当前版本类型；未纳入仓库。
- 未修改 `~/.codex/config.toml`、Codex 会话文件或其他工作目录外的持久文件。
- 未执行 `rm`、`git reset`、`git checkout --` 等破坏性命令。

## 现状结论

### 会话详情导航

当前前端仅以 `selectedSessionId` 和 `DashboardView` 维护详情状态，未读取或写入浏览器 URL。因此刷新浏览器后会回到会话列表，无法保留当前详情。

开发服务器的 Vite SPA 回退可以处理详情路径；生产部署则必须由反向代理或静态服务将非 `/api` 的 `/<sessionId>` 请求回退到前端入口文件。当前 Fastify 服务仅注册 API 和 WebSocket 路由，不承担静态前端文件服务。

### 会话级完全权限

当前 `RuntimeManager.resumeThread()` 只发送 `{ threadId }`，所有审批均由现有审批面板处理。

本机 `0.144.3` 协议确认 `thread/resume` 支持下列会话及后续回合覆盖字段：

```ts
{
  threadId,
  sandbox: "danger-full-access",
  approvalPolicy: "never"
}
```

`thread/resume` 的 `sandbox` 枚举包含 `"danger-full-access"`。`approvalPolicy` 枚举包含 `"never"`。此外，`turn/start` 和 `thread/settings/update` 也支持为当前及后续回合设置审批策略和 sandbox policy。

因此，完全权限可按单一恢复会话启用，不需要修改全局 `~/.codex/config.toml`，也不会影响并发运行的其他会话。该模式等价于让 Codex 以承载 Web 服务的系统账号跳过审批执行命令，并拥有完整文件系统与网络访问边界，必须显式确认后使用。

### 实时输出滚动

`LiveOutputPanel` 在 `liveMessages` 或 `liveCommands` 变化时无条件执行 `scrollTop = scrollHeight`。增量事件持续到达或任务完成后刷新详情时，用户会被反复拉到底部。

当前运行状态已在 `RuntimeSnapshot.status` 提供。可将自动跟随限制为 `starting` 和 `running` 两种状态；`waiting_input`、`waiting_approval`、`exited`、`failed` 与 `history` 状态不改变用户当前滚动位置。

### 用户发送即时回显和快捷键

实时输出当前只渲染 Codex 增量消息和运行中命令；`TaskInput` 在请求成功后清空输入框，直至 Codex 返回首个增量前没有可见反馈。前端已经存在 `.messageItem.user` 样式，但实时面板未使用它。

可在提交时先插入带本地唯一 ID 的用户消息，状态为“发送中”；输入接口成功后标为“已发送”，失败则保留消息并标为“发送失败”。历史区仍以 Codex JSONL 解析的真实记录为准，实时区与历史区不会同时渲染，避免重复。

`TaskInput` 使用表单提交，textarea 没有键盘事件。为 textarea 增加 `onKeyDown` 即可实现 `Ctrl+Enter` 发送；普通 `Enter` 不拦截，仍用于换行，移动端继续使用发送按钮。

## 已确认决策

1. 详情 URL 采用 `/<sessionId>`；生产部署必须配置 SPA 回退。
2. 完全权限需要二次确认、显著展示状态、只影响当前会话；启用时使用 `sandbox: "danger-full-access"` 和 `approvalPolicy: "never"`。
3. 自动滚动仅在 `starting` 或 `running` 时生效，进入待输入后停止。
4. 用户消息采用“发送中 / 已发送 / 发送失败”的实时即时回显。
5. `Ctrl+Enter` 发送，`Enter` 换行。

## 风险与约束

- 完全权限会绕过 Web 审批卡片，且其权限上限为运行 Web 服务的账号；局域网部署必须使用强密码、可信网络和 TLS/访问控制。
- 会话权限为当前 App Server 的内存运行态设置。服务重启后再次恢复时，需要由 Web 管理端重新传入所选策略；不写入 Codex 原始会话历史。
- 深链接路径与 API、静态资源路径冲突时，部署层必须优先匹配 `/api/*` 与真实静态文件，再执行 SPA 回退。
- 用户本地回显仅表示 Web 请求的提交状态，不应误标为 Codex 已完成执行。
