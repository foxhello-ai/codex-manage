import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { RuntimeManager } from "./RuntimeManager";

class FakeAppServer extends EventEmitter {
  requests: Array<{ method: string; params: unknown }> = [];
  responses: Array<{ id: number; result: unknown }> = [];

  async request(method: string, params?: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    if (method === "turn/start") return { turn: { id: "turn-1" } };
    if (method === "thread/start") return { thread: { id: "thread-new", cwd: (params as { cwd: string }).cwd } };
    if (method === "thread/resume") return { thread: { id: (params as { threadId: string }).threadId } };
    return {};
  }

  respondToServerRequest(id: number, result: unknown) {
    this.responses.push({ id, result });
  }
}

describe("RuntimeManager", () => {
  it("starts a new thread in the requested workspace", async () => {
    const appServer = new FakeAppServer();
    const manager = new RuntimeManager(appServer as any);

    const result = await manager.startThread(" /workspace/app ");

    expect(result.threadId).toBe("thread-new");
    expect(result.runtime).toMatchObject({ threadId: "thread-new", status: "waiting_input" });
    expect(appServer.requests[0]).toEqual({
      method: "thread/start",
      params: { cwd: "/workspace/app" }
    });
  });

  it("continues a locked source thread through an independent history prompt", async () => {
    const appServer = new FakeAppServer();
    const manager = new RuntimeManager(appServer as any, { historyDirectory: "/home/test/.codex/sessions" });

    const result = await manager.startHistoryContinuation(
      "/workspace/app",
      "thread-locked",
      "请继续处理失败的任务",
      { permissionMode: "full_access" }
    );

    expect(result).toMatchObject({
      threadId: "thread-new",
      inputError: null,
      runtime: { status: "running", permissionMode: "full_access" }
    });
    expect(appServer.requests.map((request) => request.method)).toEqual(["thread/start", "thread/settings/update", "turn/start"]);
    expect(appServer.requests[2].params).toMatchObject({
      threadId: "thread-new",
      input: [{
        type: "text",
        text: expect.stringContaining("原会话 ID：thread-locked")
      }]
    });
    expect((appServer.requests[2].params as { input: Array<{ text: string }> }).input[0].text)
      .toContain("请继续处理失败的任务");
  });

  it("keeps the independent thread id when its first continuation request fails", async () => {
    const appServer = new FakeAppServer();
    appServer.request = async (method: string, params?: unknown) => {
      appServer.requests.push({ method, params });
      if (method === "thread/start") return { thread: { id: "thread-new" } };
      if (method === "turn/start") throw new Error("模型请求失败");
      return {};
    };
    const manager = new RuntimeManager(appServer as any, { historyDirectory: "/history" });

    const result = await manager.startHistoryContinuation("/workspace/app", "thread-locked", "重新处理");

    expect(result).toMatchObject({
      threadId: "thread-new",
      inputError: "模型请求失败",
      runtime: { threadId: "thread-new", status: "failed", lastError: "模型请求失败" }
    });
    expect(appServer.requests.map((request) => request.method)).toEqual(["thread/start", "turn/start"]);
  });

  it("does not resume the same active thread twice", async () => {
    const appServer = new FakeAppServer();
    const manager = new RuntimeManager(appServer as any);

    const first = await manager.resumeThread("thread-1");
    const second = await manager.resumeThread("thread-1");

    expect(first.status).toBe("waiting_input");
    expect(second.status).toBe("waiting_input");
    expect(appServer.requests.filter((request) => request.method === "thread/resume")).toHaveLength(1);
    expect(appServer.requests[0].params).toEqual({ threadId: "thread-1" });
  });

  it("applies full access and updates permission settings while waiting for input", async () => {
    const appServer = new FakeAppServer();
    const manager = new RuntimeManager(appServer as any);

    const fullAccessRuntime = await manager.resumeThread("thread-1", { permissionMode: "full_access" });

    expect(fullAccessRuntime.permissionMode).toBe("full_access");
    expect(appServer.requests[0]).toEqual({
      method: "thread/resume",
      params: {
        threadId: "thread-1",
        sandbox: "danger-full-access",
        approvalPolicy: "never"
      }
    });

    const defaultRuntime = await manager.resumeThread("thread-1", { permissionMode: "default" });

    expect(defaultRuntime.permissionMode).toBe("default");
    expect(appServer.requests[1]).toEqual({
      method: "thread/settings/update",
      params: {
        threadId: "thread-1",
        approvalPolicy: "on-request",
        permissions: ":workspace"
      }
    });

    const fullAccessAgain = await manager.resumeThread("thread-1", { permissionMode: "full_access" });

    expect(fullAccessAgain.permissionMode).toBe("full_access");
    expect(appServer.requests[2]).toEqual({
      method: "thread/settings/update",
      params: {
        threadId: "thread-1",
        approvalPolicy: "never",
        sandboxPolicy: { type: "dangerFullAccess" }
      }
    });
  });

  it("hydrates persisted permission mode before the first resume", async () => {
    const appServer = new FakeAppServer();
    const manager = new RuntimeManager(appServer as any);

    const hydrated = manager.hydratePermissionMode("thread-1", "full_access");

    expect(hydrated).toMatchObject({
      threadId: "thread-1",
      status: "history",
      permissionMode: "full_access"
    });
    expect(appServer.requests).toEqual([]);

    const resumed = await manager.resumeThread("thread-1");

    expect(resumed.permissionMode).toBe("full_access");
    expect(appServer.requests[0]).toEqual({
      method: "thread/resume",
      params: {
        threadId: "thread-1",
        sandbox: "danger-full-access",
        approvalPolicy: "never"
      }
    });
  });

  it("applies explicit default permissions after resuming a history runtime", async () => {
    const appServer = new FakeAppServer();
    const manager = new RuntimeManager(appServer as any);

    await manager.hydratePermissionMode("thread-1", "full_access");
    await manager.resumeThread("thread-1", { permissionMode: "default" });

    expect(appServer.requests.map((request) => request.method)).toEqual([
      "thread/resume",
      "thread/settings/update"
    ]);
    expect(appServer.requests[1].params).toEqual({
      threadId: "thread-1",
      approvalPolicy: "on-request",
      permissions: ":workspace"
    });
  });

  it("rejects permission changes while a turn is running", async () => {
    const appServer = new FakeAppServer();
    const manager = new RuntimeManager(appServer as any);

    await manager.resumeThread("thread-1");
    await manager.sendInput("thread-1", { text: "继续" });

    await expect(manager.resumeThread("thread-1", { permissionMode: "full_access" })).rejects.toThrow("暂时不能切换权限模式");
    expect(appServer.requests.some((request) => request.method === "thread/settings/update")).toBe(false);
  });

  it("starts a turn when sending input", async () => {
    const appServer = new FakeAppServer();
    const manager = new RuntimeManager(appServer as any);

    const runtime = await manager.sendInput("thread-1", { text: "继续" });

    expect(runtime.status).toBe("running");
    expect(runtime.activeTurnId).toBe("turn-1");
    expect(appServer.requests.map((request) => request.method)).toEqual(["thread/resume", "turn/start"]);
    expect(appServer.requests[1].params).toMatchObject({
      threadId: "thread-1",
      input: [{ type: "text", text: "继续", text_elements: [] }]
    });
  });

  it("retries the original thread after another client's writer lock is released", async () => {
    const appServer = new FakeAppServer();
    let resumeAttempts = 0;
    appServer.request = async (method: string, params?: unknown) => {
      appServer.requests.push({ method, params });
      if (method === "thread/resume" && (params as { threadId: string }).threadId === "thread-1") {
        resumeAttempts += 1;
        if (resumeAttempts === 1) throw new Error("thread already has an active writer");
        return { thread: { id: "thread-1" } };
      }
      if (method === "turn/start") return { turn: { id: "turn-1" } };
      return {};
    };
    const manager = new RuntimeManager(appServer as any, { writerLockRetryDelaysMs: [0] });

    const runtime = await manager.sendInput("thread-1", { text: "从最新历史继续" });

    expect(runtime).toMatchObject({
      threadId: "thread-1",
      status: "running",
      activeTurnId: "turn-1"
    });
    expect(appServer.requests.map((request) => request.method)).toEqual([
      "thread/resume",
      "thread/resume",
      "turn/start"
    ]);
    expect(appServer.requests[2].params).toMatchObject({
      threadId: "thread-1",
      input: [{ type: "text", text: "从最新历史继续", text_elements: [] }]
    });
  });

  it("creates a full fork only when explicitly requested", async () => {
    const appServer = new FakeAppServer();
    appServer.request = async (method: string, params?: unknown) => {
      appServer.requests.push({ method, params });
      if (method === "thread/fork") return { thread: { id: "thread-2" } };
      if (method === "thread/resume") return { thread: { id: "thread-2" } };
      return {};
    };
    const manager = new RuntimeManager(appServer as any);

    const result = await manager.branchThread("thread-1", "full_fork");

    expect(result).toMatchObject({
      threadId: "thread-2",
      runtime: { threadId: "thread-2", status: "waiting_input" }
    });
    expect(appServer.requests).toEqual([
      { method: "thread/fork", params: { threadId: "thread-1" } },
      { method: "thread/resume", params: { threadId: "thread-2" } }
    ]);
  });

  it("retries a fork after another client's writer lock is released", async () => {
    const appServer = new FakeAppServer();
    let forkAttempts = 0;
    appServer.request = async (method: string, params?: unknown) => {
      appServer.requests.push({ method, params });
      if (method === "thread/fork") {
        forkAttempts += 1;
        if (forkAttempts === 1) throw new Error("thread already has an active writer");
        return { thread: { id: "thread-2" } };
      }
      if (method === "thread/resume") return { thread: { id: "thread-2" } };
      return {};
    };
    const manager = new RuntimeManager(appServer as any, { writerLockRetryDelaysMs: [0] });

    const result = await manager.branchThread("thread-1", "full_fork");

    expect(result.threadId).toBe("thread-2");
    expect(appServer.requests.map((request) => request.method)).toEqual([
      "thread/fork",
      "thread/fork",
      "thread/resume"
    ]);
  });

  it("waits for thread/compacted when creating a compacted new topic", async () => {
    const appServer = new FakeAppServer();
    appServer.request = async (method: string, params?: unknown) => {
      appServer.requests.push({ method, params });
      if (method === "thread/fork") return { thread: { id: "thread-2" } };
      if (method === "thread/resume") return { thread: { id: "thread-2" } };
      if (method === "thread/compact/start") {
        queueMicrotask(() => appServer.emit("notification", {
          method: "thread/compacted",
          params: { threadId: "thread-2", turnId: "turn-compact" }
        }));
      }
      return {};
    };
    const manager = new RuntimeManager(appServer as any, { compactionTimeoutMs: 100 });

    const result = await manager.branchThread("thread-1", "compact_new_topic");

    expect(result).toMatchObject({
      threadId: "thread-2",
      runtime: { threadId: "thread-2", status: "waiting_input" }
    });
    expect(appServer.requests).toEqual([
      { method: "thread/fork", params: { threadId: "thread-1" } },
      { method: "thread/resume", params: { threadId: "thread-2" } },
      { method: "thread/compact/start", params: { threadId: "thread-2" } }
    ]);
  });

  it("steers the active turn when a second input arrives", async () => {
    const appServer = new FakeAppServer();
    const manager = new RuntimeManager(appServer as any);

    await manager.sendInput("thread-1", { text: "第一条" });
    await manager.sendInput("thread-1", { text: "补充说明" });

    expect(appServer.requests.map((request) => request.method)).toEqual([
      "thread/resume",
      "turn/start",
      "turn/steer"
    ]);
    expect(appServer.requests[2].params).toMatchObject({
      threadId: "thread-1",
      expectedTurnId: "turn-1",
      input: [{ type: "text", text: "补充说明", text_elements: [] }]
    });
  });

  it("does not start a duplicate turn while the active turn id is not synchronized", async () => {
    const appServer = new FakeAppServer();
    appServer.request = async (method: string, params?: unknown) => {
      appServer.requests.push({ method, params });
      if (method === "thread/resume") return { thread: { id: "thread-1" } };
      if (method === "turn/start") return {};
      return {};
    };
    const manager = new RuntimeManager(appServer as any);

    await manager.sendInput("thread-1", { text: "第一条" });
    await expect(manager.sendInput("thread-1", { text: "第二条" })).rejects.toThrow("尚未同步活动任务标识");
    expect(appServer.requests.map((request) => request.method)).toEqual([
      "thread/resume",
      "turn/start"
    ]);
  });

  it("blocks app-server reload while a turn or model change is active", async () => {
    const appServer = new FakeAppServer();
    const manager = new RuntimeManager(appServer as any);

    await manager.sendInput("thread-1", { text: "继续" });

    expect(manager.prepareForAppServerReload()).toEqual([
      { threadId: "thread-1", status: "running", reason: "active_runtime" }
    ]);
  });

  it("allows app-server reload from waiting input and moves sessions to history", async () => {
    const appServer = new FakeAppServer();
    const manager = new RuntimeManager(appServer as any);

    await manager.resumeThread("thread-1");

    expect(manager.prepareForAppServerReload()).toEqual([]);
    appServer.emit("exit", { code: 0, signal: null });
    manager.finishAppServerReload(true);

    expect(manager.getRuntime("thread-1")).toMatchObject({
      status: "history",
      activeTurnId: null,
      lastError: null,
      modelChangeStatus: "idle"
    });
  });

  it("maps an app-server idle thread to waiting for user input", async () => {
    const appServer = new FakeAppServer();
    const manager = new RuntimeManager(appServer as any);

    await manager.resumeThread("thread-1");
    appServer.emit("notification", {
      method: "thread/status/changed",
      params: { threadId: "thread-1", status: { type: "idle" } }
    });

    expect(manager.getRuntime("thread-1").status).toBe("waiting_input");
  });

  it("keeps a retrying turn running and only fails on the terminal error", async () => {
    const appServer = new FakeAppServer();
    const manager = new RuntimeManager(appServer as any);

    await manager.sendInput("thread-1", { text: "继续" });
    appServer.emit("notification", {
      method: "error",
      params: {
        threadId: "thread-1",
        willRetry: true,
        error: { message: "Reconnecting... 1/5" }
      }
    });

    expect(manager.getRuntime("thread-1")).toMatchObject({
      status: "running",
      lastError: "Reconnecting... 1/5"
    });

    appServer.emit("notification", {
      method: "error",
      params: {
        threadId: "thread-1",
        willRetry: false,
        error: { message: "upstream unavailable" }
      }
    });

    expect(manager.getRuntime("thread-1")).toMatchObject({
      status: "failed",
      lastError: "upstream unavailable"
    });
  });

  it("publishes and resolves command approvals", () => {
    const appServer = new FakeAppServer();
    const manager = new RuntimeManager(appServer as any);
    const events: unknown[] = [];
    manager.eventHub.subscribe("thread-1", (event) => events.push(event));

    appServer.emit("serverRequest", {
      id: 9,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", command: "npm test", cwd: "/repo", startedAtMs: 1 }
    });

    const pending = manager.approvalService.listPending("thread-1");
    expect(pending).toHaveLength(1);
    expect(manager.getRuntime("thread-1").status).toBe("waiting_approval");

    manager.submitApproval("thread-1", pending[0].id, { decision: "accept" });

    expect(appServer.responses).toEqual([{ id: 9, result: { decision: "accept" } }]);
    expect(manager.approvalService.listPending("thread-1")).toHaveLength(0);
    expect(events.some((event: any) => event.type === "approval_requested")).toBe(true);
    expect(events.some((event: any) => event.type === "approval_resolved")).toBe(true);
  });
  it("confirms a waiting-input model update from thread settings notification", async () => {
    const appServer = new FakeAppServer();
    const manager = new RuntimeManager(appServer as any, { modelConfirmationTimeoutMs: 100 });
    await manager.resumeThread("thread-1");

    const events: any[] = [];
    manager.eventHub.subscribe("thread-1", (event) => events.push(event));
    const pending = manager.updateModel("thread-1", {
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      option: {
        id: "gpt-5.6-sol",
        model: "gpt-5.6-sol",
        displayName: "GPT-5.6-Sol",
        description: null,
        hidden: false,
        isDefault: true,
        supportedReasoningEfforts: ["high"],
        defaultReasoningEffort: "high",
        upgradeModel: null,
        upgradeCopy: null
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    appServer.emit("notification", {
      method: "thread/settings/updated",
      params: {
        threadId: "thread-1",
        threadSettings: {
          model: "gpt-5.6-sol",
          modelProvider: "openai",
          effort: "high"
        }
      }
    });

    await expect(pending).resolves.toMatchObject({
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      modelChangeStatus: "applied",
      modelSelection: { applied: true, confirmationPending: false }
    });
    expect(appServer.requests.at(-1)).toEqual({
      method: "thread/settings/update",
      params: { threadId: "thread-1", model: "gpt-5.6-sol", effort: "high" }
    });
    expect(events.some((event) => event.type === "model_change_started")).toBe(true);
    expect(events.some((event) => event.type === "model_change_completed")).toBe(true);
  });

  it("returns confirmation pending after the notification timeout and reconciles a late notification", async () => {
    const appServer = new FakeAppServer();
    const manager = new RuntimeManager(appServer as any, { modelConfirmationTimeoutMs: 5 });
    await manager.resumeThread("thread-1");

    const result = await manager.updateModel("thread-1", {
      model: "gpt-5.6-sol",
      reasoningEffort: null,
      option: {
        id: "gpt-5.6-sol",
        model: "gpt-5.6-sol",
        displayName: "GPT-5.6-Sol",
        description: null,
        hidden: false,
        isDefault: true,
        supportedReasoningEfforts: [],
        defaultReasoningEffort: null,
        upgradeModel: null,
        upgradeCopy: null
      }
    });
    expect(result).toMatchObject({
      modelChangeStatus: "confirming",
      modelSelection: { confirmationPending: true, applied: false }
    });
    expect(manager.getReloadBlockers()).toEqual([]);

    appServer.emit("notification", {
      method: "thread/settings/updated",
      params: {
        threadId: "thread-1",
        threadSettings: { model: "gpt-5.6-sol", modelProvider: "openai" }
      }
    });
    expect(manager.getRuntime("thread-1")).toMatchObject({
      model: "gpt-5.6-sol",
      modelChangeStatus: "applied",
      modelSelection: { confirmationPending: false, applied: true }
    });
  });

  it("passes an explicit model through resume, effort settings, and turn start", async () => {
    const appServer = new FakeAppServer();
    const manager = new RuntimeManager(appServer as any);

    await manager.sendInput("thread-1", {
      text: "继续",
      modelOverride: {
        mode: "override",
        model: "gpt-5.6-sol",
        reasoningEffort: "high"
      }
    });

    expect(appServer.requests).toMatchObject([
      {
        method: "thread/resume",
        params: { threadId: "thread-1", model: "gpt-5.6-sol" }
      },
      {
        method: "thread/settings/update",
        params: { threadId: "thread-1", effort: "high" }
      },
      {
        method: "turn/start",
        params: { threadId: "thread-1", model: "gpt-5.6-sol", effort: "high" }
      }
    ]);
  });

});
