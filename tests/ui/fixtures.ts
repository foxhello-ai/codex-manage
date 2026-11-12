// Test-only API fixtures. The application continues to use its existing endpoints.
import type { Page, WebSocketRoute } from "@playwright/test";
import type { ApprovalSummary, ModelCatalogResponse, RuntimeSnapshot, SessionDetail, SessionModelState, SessionStatus, SessionSummary, TaskSummary, WebSessionEvent } from "../../src/shared/models";

export const longPath = "/Volumes/Development/" + "非常长的工作目录用于验证手机阅读与换行/".repeat(6) + "codex-manage";
export const sessionId = "ui-session";
export const longTitle = "改善手机端会话操作与长回复阅读体验，保留任务分组、授权和失败恢复的现有真实流程";
export const selection: SessionModelState = {
  mode: "follow_session", preferredModel: null, preferredReasoningEffort: null, updatedAt: null,
  actualModel: "gpt-ui-supported-model-with-a-long-identifier", actualModelProvider: "test-provider",
  actualReasoningEffort: "high", actualModelSupported: true, applied: true, confirmationPending: false, lastError: null
};
export const catalog: ModelCatalogResponse = { models: [
  { id: "model-1", model: selection.actualModel!, displayName: "当前模型（较长的名称用于验证换行）", description: null, hidden: false, isDefault: true, supportedReasoningEfforts: ["medium", "high"], defaultReasoningEffort: "high", upgradeModel: null, upgradeCopy: null },
  { id: "model-2", model: "another-supported-model", displayName: "另一个可用模型", description: null, hidden: false, isDefault: false, supportedReasoningEfforts: ["low", "high"], defaultReasoningEffort: "low", upgradeModel: null, upgradeCopy: null }
], loadedAt: "2026-11-03T00:00:00Z", stale: false, lastError: null };

export async function installUiHarness(page: Page, options: { status?: SessionStatus; failInput?: boolean; failUpload?: boolean; child?: boolean; externalQueue?: boolean; approvals?: ApprovalSummary[]; snapshotOnConnect?: boolean; managed?: boolean; runtimeApprovals?: boolean; runtimeSequence?: number } = {}) {
  let seq = options.runtimeSequence ?? 10;
  const sockets = new Set<WebSocketRoute>();
  const calls: { path: string; method: string; body: Record<string, unknown> | null }[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  let sessions: SessionSummary[] = Array.from({ length: 12 }, (_, index) => ({
    id: index ? `session-${index}` : sessionId, sessionId: index ? `session-${index}` : sessionId,
    title: index ? `已有会话 ${index}：检查移动端布局` : longTitle,
    defaultTitle: index ? `已有会话 ${index}：检查移动端布局` : longTitle, remarkTitle: null,
    summary: "这是服务端已有会话摘要。用于检查较长内容的层级、行距和换行表现。".repeat(3),
    workspace: index % 2 ? "/workspace/another-project" : longPath,
    createdAt: "2026-11-01T01:00:00Z", updatedAt: `2026-11-03T01:${String(50 - index).padStart(2, "0")}:00Z`,
    status: index === 0 ? options.status ?? "waiting_input" : index === 1 ? "running" : index === 2 ? "failed" : "history",
    cliVersion: null, source: null
  }));
  let runtime: RuntimeSnapshot = {
    threadId: sessionId, status: options.status ?? "waiting_input", permissionMode: "default", activeTurnId: options.status === "running" || options.status === "waiting_approval" ? "live-turn" : null,
    startedAt: "2026-11-03T01:00:00Z", updatedAt: "2026-11-03T01:00:00Z", lastError: null, pendingApprovalCount: options.status === "waiting_approval" ? 1 : 0,
    eventSeq: seq, model: selection.actualModel, modelProvider: "test-provider", reasoningEffort: "high", modelSelection: selection, modelChangeStatus: "idle", modelChangeError: null
  };
  if (options.managed) runtime = { ...runtime, executionSource: "manage" };
  if (options.externalQueue) runtime = { ...runtime, executionSource: "external_queue", deliveries: [], status: "history" };
  let tasks: TaskSummary[] = [{ id: "task-ui", name: "手机端体验优化与现有会话分组", pinned: false, sessionIds: [sessionId, "session-1"], sessionCount: 2, recentSessionId: sessionId, recentSessionTitle: longTitle, updatedAt: "2026-11-03T01:00:00Z" }];
  const detail = (id: string): SessionDetail => ({
    ...(sessions.find((item) => item.id === id) ?? sessions[0]!), id, sessionId: id, path: null, modelProvider: "test-provider", historyMode: null, modelState: runtime.modelSelection,
    turns: Array.from({ length: 12 }, (_, index) => ({
      id: `turn-${index}`, status: "completed", error: null, startedAt: "2026-11-03T01:00:00Z", completedAt: "2026-11-03T01:01:00Z", durationMs: null,
      items: [
        { id: `user-${index}`, type: "user_message" as const, text: `第 ${index + 1} 轮：请检查手机阅读体验，并确认长路径可以完整阅读。` },
        { id: `process-${index}`, type: "agent_message" as const, phase: "commentary", text: "这是已有的过程消息，完成后继续沿用折叠呈现。" },
        { id: `agent-${index}`, type: "agent_message" as const, phase: "final_answer", text: `第 ${index + 1} 轮回复。\n\n## 阅读与操作\n\n${"正文以 16px 为基准，完整展示回复。普通文字和路径可以换行，代码保留自身滚动。\n\n".repeat(4)}工作目录：${longPath}\n\n\`\`\`sh\ncommand --long-argument=${"very-long-value-".repeat(30)}\n\`\`\`\n\n最后一段仍然完整可读。` }
      ]
    }))
  });
  const approval: ApprovalSummary = {
    id: "approval-ui", requestId: 1, threadId: sessionId, turnId: "live-turn", itemId: "command-ui", kind: "command_execution", status: "pending", title: "允许检查当前项目构建？", command: "npm run build -- " + "--long-command-argument ".repeat(20), cwd: longPath, reason: "此请求来自已有审批状态。", questions: [], raw: {}, createdAt: "2026-11-03T01:00:00Z", resolvedAt: null
  };
  let approvals = options.approvals ?? (options.status === "waiting_approval" ? [approval] : []);
  function snapshot(sequence = seq, pending = approvals) {
    return JSON.stringify({ seq: sequence, threadId: sessionId, type: "snapshot", payload: { runtime: { ...runtime, eventSeq: sequence }, approvals: pending, events: [] }, createdAt: "2026-11-03T01:00:00Z" });
  }
  function emit(type: WebSessionEvent["type"], payload: Record<string, unknown>) {
    const event: WebSessionEvent = { seq: ++seq, threadId: sessionId, type, payload, createdAt: "2026-11-03T01:02:00Z" };
    sockets.forEach((socket) => socket.send(JSON.stringify(event)));
  }
  await page.routeWebSocket(/\/api\/sessions\/.*\/ws/, (socket) => {
    sockets.add(socket);
    socket.onClose(() => sockets.delete(socket));
    if (options.snapshotOnConnect !== false) socket.send(snapshot());
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const body = request.postDataJSON() as Record<string, unknown> | null;
    calls.push({ path, method, body });
    const json = async (data: unknown, status = 200) => route.fulfill({ status, json: data });
    if (path === "/api/me") return json({ authenticated: true, defaultPassword: false, user: { id: options.child ? "child-ui" : "owner", role: options.child ? "child" : "owner", displayName: "UI Test", localEmail: null, active: true, ownerUserId: null } });
    if (path === "/api/config") return json({ appVersion: "v1.0.10", host: "127.0.0.1", port: 4311, codexCliPath: "/usr/bin/codex", sessionsDir: "/test/sessions", defaultPassword: false, codexCliVersion: "test", codexVersionError: null, appServer: { status: "ready", pid: null, initialized: true, lastError: null }, runtimeReload: null });
    if (path === "/api/models") return json(catalog);
    if (path === "/api/tasks" && method === "GET") return json({ tasks });
    if (path === "/api/tasks" && method === "POST") {
      const task = { ...tasks[0]!, id: "new-task", name: String(body?.name), sessionIds: [], sessionCount: 0, recentSessionId: null, recentSessionTitle: null };
      tasks = [task, ...tasks]; return json({ task });
    }
    if (path === "/api/sessions" && method === "GET") {
      const search = url.searchParams.get("search") ?? "";
      return json({ sessions: sessions.filter((item) => [item.title, item.summary, item.workspace, item.remarkTitle].some((text) => text?.includes(search))) });
    }
    const task = tasks.find((item) => path.startsWith(`/api/tasks/${item.id}`));
    if (task) {
      if (method === "PATCH") Object.assign(task, body);
      if (method === "POST" && path.includes("/sessions/")) {
        const id = path.split("/").at(-1)!;
        if (!task.sessionIds.includes(id)) task.sessionIds.push(id);
        task.sessionCount = task.sessionIds.length;
      } else if (method === "POST" && path.endsWith("/sessions")) return createResult(String(body?.cwd), task);
      return json({ task: { ...task, sessions: sessions.filter((item) => task.sessionIds.includes(item.id)) } });
    }
    function createResult(cwd: string, task?: TaskSummary) {
      const created = { ...sessions[0]!, id: "new-session", sessionId: "new-session", title: "新会话", workspace: cwd, status: "waiting_input" as const };
      sessions = [created, ...sessions]; runtime = { ...runtime, threadId: created.id, status: "waiting_input", activeTurnId: null };
      return json({ session: created, runtime, threadId: created.id, ...(task ? { task, contextPrompt: "已有任务上下文" } : {}) });
    }
    if (path === "/api/sessions" && method === "POST") return createResult(String(body?.cwd));
    if (path.endsWith("/metadata")) {
      const item = sessions.find((item) => path.includes(item.id))!;
      item.remarkTitle = body?.remarkTitle as string | null; item.title = item.remarkTitle ?? item.defaultTitle;
      return json({ session: item });
    }
    if (path.endsWith("/attachments")) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      if (options.failUpload || String(body?.name).startsWith("fail")) return json({ error: { code: "UPLOAD_FAILED", message: "测试上传失败" } }, 500);
      return json({ attachment: { name: body?.name, path: `${longPath}/.attachments/${body?.name}`, mimeType: body?.mimeType, size: body?.size } });
    }
    if (path.endsWith("/input")) {
      await new Promise((resolve) => setTimeout(resolve, 180));
      if (options.failInput) return json({ error: { code: "MODEL_REQUEST_TIMEOUT", message: "请求未完成，请重试或切换模型。" } }, 500);
      if (options.externalQueue) {
        runtime = { ...runtime, eventSeq: ++seq, deliveries: [{
          requestId: String(body?.clientRequestId), threadId: sessionId, text: String(body?.text),
          queueId: "native-queue-1", turnId: null, itemId: null, status: "unknown", error: null, createdAt: new Date().toISOString()
        }] };
        return json({ runtime }, 202);
      }
      runtime = { ...runtime, status: "running", activeTurnId: "live-turn", eventSeq: ++seq }; return json({ runtime });
    }
    if (path.endsWith("/model")) {
      const nextSelection = { ...runtime.modelSelection, mode: body?.mode, preferredModel: body?.model ?? null, actualModel: body?.model ?? selection.actualModel, preferredReasoningEffort: body?.reasoningEffort ?? null } as SessionModelState;
      runtime = { ...runtime, modelSelection: nextSelection, model: nextSelection.actualModel, eventSeq: ++seq }; return json({ selection: nextSelection, runtime, applied: true, confirmationPending: false });
    }
    if (path.endsWith("/resume")) { runtime = { ...runtime, permissionMode: body?.permissionMode as RuntimeSnapshot["permissionMode"], eventSeq: ++seq }; return json({ runtime }); }
    if (path.includes("/approvals/")) {
      approvals = []; runtime = { ...runtime, status: "waiting_input", activeTurnId: null, pendingApprovalCount: 0, eventSeq: ++seq };
      return json({ approval: { ...approval, status: "resolved" }, runtime });
    }
    if (path.endsWith("/runtime")) return json({ runtime, ...(options.runtimeApprovals === false ? {} : { approvals }) });
    if (path.endsWith("/desktop-questions") && method === "GET") return json({ available: false, turnId: null, questions: [], submissions: [] });
    const id = path.match(/^\/api\/sessions\/([^/]+)$/)?.[1];
    if (id) return json({ session: { ...detail(decodeURIComponent(id)), ...(url.searchParams.get("turns") === "false" ? { turns: [] } : {}) } });
    pageErrors.push(`Unexpected API request: ${method} ${path}`);
    return json({ error: { code: "UNEXPECTED_UI_REQUEST", message: path } }, 404);
  });
  return { calls, pageErrors, emit, getRuntime: () => runtime, getDetail: detail,
    sendSnapshot: (sequence?: number, pending?: ApprovalSummary[]) => sockets.forEach(socket => socket.send(snapshot(sequence, pending))),
    setApprovals: (pending: ApprovalSummary[]) => { approvals = pending; },
    disconnect: () => sockets.forEach(socket => socket.close()),
    socketCount: () => sockets.size
  };
}
