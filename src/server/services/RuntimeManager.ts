import type { JsonRpcNotification, JsonRpcRequest } from "./CodexAppServerClient";
import { ApprovalService } from "./ApprovalService";
import { EventHub } from "./EventHub";
import type { CodexAppServerClient } from "./CodexAppServerClient";
import type { ApprovalDecision, ApprovalResponse, RuntimeSnapshot, RuntimeStatus, SessionModelState, SessionPermissionMode } from "../../shared/models";

type RuntimeState = {
  threadId: string;
  status: RuntimeStatus;
  permissionMode: SessionPermissionMode;
  activeTurnId: string | null;
  startedAt: string;
  updatedAt: string;
  lastError: string | null;
};

type SendInputParams = {
  text: string;
  permissionMode?: SessionPermissionMode;
};

type SubmitApprovalParams = {
  decision: ApprovalDecision;
  answers?: Record<string, string[]>;
};

export class RuntimeManager {
  readonly eventHub = new EventHub();
  readonly approvalService: ApprovalService;
  private readonly runtimes = new Map<string, RuntimeState>();

  constructor(private readonly appServer: CodexAppServerClient) {
    this.approvalService = new ApprovalService(appServer, this.eventHub, (threadId) => {
      this.refreshApprovalStatus(threadId);
    });

    this.appServer.on("notification", (message: JsonRpcNotification) => this.handleNotification(message));
    this.appServer.on("serverRequest", (message: JsonRpcRequest) => this.handleServerRequest(message));
    this.appServer.on("exit", () => this.markAllFailed("Codex app-server 已退出"));
    this.appServer.on("error", (error: Error) => this.markAllFailed(error.message));
  }

  async resumeThread(threadId: string, options: { permissionMode?: SessionPermissionMode } = {}): Promise<RuntimeSnapshot> {
    const current = this.runtimes.get(threadId);
    if (current && current.status !== "failed" && current.status !== "exited") {
      const permissionMode = options.permissionMode;
      if (permissionMode && permissionMode !== current.permissionMode) {
        if (current.status !== "waiting_input") {
          throw new Error("会话运行中或正在等待审批，暂时不能切换权限模式");
        }
        await this.appServer.request("thread/settings/update", buildPermissionSettings(threadId, permissionMode));
        this.setRuntime(threadId, { permissionMode, lastError: null });
      }
      return this.snapshot(threadId);
    }

    const permissionMode = options.permissionMode ?? "default";
    this.setRuntime(threadId, { status: "starting", permissionMode, activeTurnId: null, lastError: null });

    try {
      const params = permissionMode === "full_access"
        ? { threadId, sandbox: "danger-full-access", approvalPolicy: "never" }
        : { threadId };
      await this.appServer.request("thread/resume", params);
      const runtime = this.runtimes.get(threadId);
      if (runtime?.status === "starting") {
        this.setRuntime(threadId, { status: "waiting_input", lastError: null });
      }
      return this.snapshot(threadId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setRuntime(threadId, { status: "failed", lastError: message });
      throw error;
    }
  }

  async sendInput(threadId: string, params: SendInputParams): Promise<RuntimeSnapshot> {
    const text = params.text.trim();
    if (!text) throw new Error("输入内容不能为空");

    const runtime = this.runtimes.get(threadId);
    if (!runtime || runtime.status === "history" || runtime.status === "failed" || runtime.status === "exited") {
      await this.resumeThread(threadId, { permissionMode: params.permissionMode });
    }

    const latest = this.runtimes.get(threadId);
    if (latest?.status === "waiting_approval") {
      throw new Error("当前会话正在等待审批，请先处理审批");
    }

    const input = [{ type: "text", text, text_elements: [] }];
    if (latest?.activeTurnId && latest.status === "running") {
      await this.appServer.request("turn/steer", { threadId, expectedTurnId: latest.activeTurnId, input });
    } else {
      await this.appServer.request("turn/start", { threadId, input });
    }

    this.setRuntime(threadId, { status: "running", lastError: null });
    return this.snapshot(threadId);
  }

  getRuntime(threadId: string): RuntimeSnapshot {
    return this.snapshot(threadId);
  }

  submitApproval(threadId: string, approvalId: string, params: SubmitApprovalParams): ApprovalResponse {
    const current = this.approvalService.get(approvalId);
    if (!current || current.threadId !== threadId) throw new Error("Approval not found");
    const approval = this.approvalService.submit(approvalId, params);
    return { approval, runtime: this.runtimes.has(threadId) ? this.snapshot(threadId) : null };
  }

  private handleServerRequest(request: JsonRpcRequest) {
    const handled = this.approvalService.handleServerRequest(request);
    if (!handled) {
      this.appServer.respondToServerRequest(request.id, {});
    }
  }

  private handleNotification(notification: JsonRpcNotification) {
    const params = asRecord(notification.params);
    const threadId = readString(params.threadId) ?? readString(asRecord(params.thread).id);
    if (!threadId) return;

    switch (notification.method) {
      case "thread/status/changed":
        this.setRuntime(threadId, { status: mapRuntimeStatus(asRecord(params.status)), lastError: null });
        break;
      case "turn/started": {
        const turn = asRecord(params.turn);
        const turnId = readString(turn.id) ?? readString(params.turnId);
        this.setRuntime(threadId, { status: "running", activeTurnId: turnId, lastError: null });
        this.eventHub.publish(threadId, "turn_started", { turn });
        break;
      }
      case "turn/completed": {
        const turn = asRecord(params.turn);
        this.setRuntime(threadId, { status: this.approvalService.getPendingCount(threadId) > 0 ? "waiting_approval" : "waiting_input", activeTurnId: null });
        this.eventHub.publish(threadId, "turn_completed", { turn });
        break;
      }
      case "item/agentMessage/delta":
        this.eventHub.publish(threadId, "agent_message_delta", {
          turnId: readString(params.turnId),
          itemId: readString(params.itemId),
          delta: readString(params.delta) ?? ""
        });
        break;
      case "item/commandExecution/outputDelta":
        this.eventHub.publish(threadId, "command_output_delta", {
          turnId: readString(params.turnId),
          itemId: readString(params.itemId),
          delta: readString(params.delta) ?? ""
        });
        break;
      case "item/started":
        this.handleItemEvent(threadId, "command_started", params);
        break;
      case "item/completed":
        this.handleItemEvent(threadId, "command_completed", params);
        break;
      case "error":
        this.setRuntime(threadId, {
          status: params.willRetry === true ? "running" : "failed",
          lastError: readError(params.error) ?? "Codex 执行失败"
        });
        this.eventHub.publish(threadId, "error", params);
        break;
      case "warning":
        this.eventHub.publish(threadId, "warning", params);
        break;
      default:
        this.eventHub.publish(threadId, "raw", { method: notification.method, params });
    }
  }

  private handleItemEvent(threadId: string, eventType: "command_started" | "command_completed", params: Record<string, unknown>) {
    const item = asRecord(params.item);
    if (item.type !== "commandExecution") return;

    this.eventHub.publish(threadId, eventType, {
      turnId: readString(params.turnId),
      itemId: readString(item.id),
      command: readString(item.command) ?? "",
      cwd: readString(item.cwd) ?? "",
      status: readString(item.status),
      output: readString(item.aggregatedOutput),
      exitCode: typeof item.exitCode === "number" ? item.exitCode : null,
      durationMs: typeof item.durationMs === "number" ? item.durationMs : null
    });
  }

  private refreshApprovalStatus(threadId: string) {
    const pendingApprovalCount = this.approvalService.getPendingCount(threadId);
    const runtime = this.runtimes.get(threadId);
    if (pendingApprovalCount > 0) {
      this.setRuntime(threadId, { status: "waiting_approval" });
      return;
    }
    if (runtime?.status === "waiting_approval") {
      this.setRuntime(threadId, { status: runtime.activeTurnId ? "running" : "waiting_input" });
    }
  }

  private markAllFailed(message: string) {
    for (const threadId of this.runtimes.keys()) {
      this.setRuntime(threadId, { status: "failed", lastError: message });
    }
  }

  private setRuntime(threadId: string, patch: Partial<RuntimeState>) {
    const now = new Date().toISOString();
    const current = this.runtimes.get(threadId);
    const next: RuntimeState = {
      threadId,
      status: patch.status ?? current?.status ?? "history",
      permissionMode: patch.permissionMode ?? current?.permissionMode ?? "default",
      activeTurnId: patch.activeTurnId !== undefined ? patch.activeTurnId : current?.activeTurnId ?? null,
      startedAt: current?.startedAt ?? now,
      updatedAt: now,
      lastError: patch.lastError !== undefined ? patch.lastError : current?.lastError ?? null
    };
    this.runtimes.set(threadId, next);
    this.eventHub.publish(threadId, "session_status", { runtime: this.snapshot(threadId) });
  }

  private snapshot(threadId: string): RuntimeSnapshot {
    const now = new Date().toISOString();
    const runtime = this.runtimes.get(threadId) ?? {
      threadId,
      status: "history" as RuntimeStatus,
      activeTurnId: null,
      permissionMode: "default" as SessionPermissionMode,
      startedAt: now,
      updatedAt: now,
      lastError: null
    };

    return {
      ...runtime,
      pendingApprovalCount: this.approvalService.getPendingCount(threadId),
      eventSeq: this.eventHub.getLastSeq(threadId),
      model: null,
      modelProvider: null,
      reasoningEffort: null,
      modelSelection: emptyModelState(),
      modelChangeStatus: "idle",
      modelChangeError: null
    };
  }
}

function emptyModelState(): SessionModelState {
  return {
    mode: "follow_session",
    preferredModel: null,
    preferredReasoningEffort: null,
    actualModel: null,
    actualModelProvider: null,
    actualReasoningEffort: null,
    actualModelSupported: null,
    applied: false,
    confirmationPending: false,
    updatedAt: null,
    lastError: null
  };
}

function buildPermissionSettings(threadId: string, permissionMode: SessionPermissionMode) {
  if (permissionMode === "full_access") {
    return {
      threadId,
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" }
    };
  }
  return {
    threadId,
    approvalPolicy: "on-request",
    permissions: ":workspace"
  };
}

function mapRuntimeStatus(value: Record<string, unknown>): RuntimeStatus {
  const type = readString(value.type) ?? readString(value.status);
  switch (type) {
    case "starting":
      return "starting";
    case "running":
    case "inProgress":
    case "loaded":
      return "running";
    case "waitingInput":
    case "waiting_input":
    case "idle":
      return "waiting_input";
    case "waitingApproval":
    case "waiting_approval":
      return "waiting_approval";
    case "failed":
    case "errored":
      return "failed";
    case "completed":
    case "exited":
      return "exited";
    default:
      return "history";
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readError(value: unknown): string | null {
  if (typeof value === "string") return value;
  const record = asRecord(value);
  return readString(record.message) ?? readString(record.error);
}
