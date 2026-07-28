import type { JsonRpcNotification, JsonRpcRequest } from "./CodexAppServerClient";
import { ApprovalService } from "./ApprovalService";
import { EventHub } from "./EventHub";
import type { CodexAppServerClient } from "./CodexAppServerClient";
import { ModelDomainError, sanitizeModelError } from "../modelErrors";
import type {
  ApprovalDecision,
  ApprovalResponse,
  ModelChangeStatus,
  ResolvedModelOverride,
  RuntimeSnapshot,
  RuntimeStatus,
  SessionModelState,
  SessionPermissionMode,
  ValidatedModelSelection
} from "../../shared/models";

type RuntimeState = {
  threadId: string;
  status: RuntimeStatus;
  permissionMode: SessionPermissionMode;
  activeTurnId: string | null;
  startedAt: string;
  updatedAt: string;
  lastError: string | null;
  model: string | null;
  modelProvider: string | null;
  reasoningEffort: string | null;
  modelSelection: SessionModelState;
  modelChangeStatus: ModelChangeStatus;
  modelChangeError: string | null;
};

export type ResumeThreadOptions = {
  permissionMode?: SessionPermissionMode;
  modelOverride?: ResolvedModelOverride;
};

export type SendInputParams = {
  text: string;
  permissionMode?: SessionPermissionMode;
  modelOverride?: ResolvedModelOverride;
};

type SubmitApprovalParams = {
  decision: ApprovalDecision;
  answers?: Record<string, string[]>;
};

type SettingsWaiterResult = "matched" | "mismatch" | "timeout";

type SettingsWaiter = {
  expectedModel: string;
  expectedEffort: string | null;
  timedOut: boolean;
  resolve: (result: SettingsWaiterResult) => void;
  timer: NodeJS.Timeout;
};

export type RuntimeReloadBlocker = {
  threadId: string;
  status: RuntimeStatus;
  reason: "active_runtime" | "pending_operation" | "model_change";
};

export type RuntimeManagerOptions = {
  modelConfirmationTimeoutMs?: number;
};

export class RuntimeManager {
  readonly eventHub = new EventHub();
  readonly approvalService: ApprovalService;
  private readonly runtimes = new Map<string, RuntimeState>();
  private readonly operationChains = new Map<string, Promise<void>>();
  private readonly settingsWaiters = new Map<string, SettingsWaiter>();
  private readonly modelConfirmationTimeoutMs: number;
  private appServerReloading = false;

  constructor(
    private readonly appServer: CodexAppServerClient,
    options: RuntimeManagerOptions = {}
  ) {
    this.modelConfirmationTimeoutMs = options.modelConfirmationTimeoutMs ?? 5_000;
    this.approvalService = new ApprovalService(appServer, this.eventHub, (threadId) => {
      this.refreshApprovalStatus(threadId);
    });

    this.appServer.on("notification", (message: JsonRpcNotification) => this.handleNotification(message));
    this.appServer.on("serverRequest", (message: JsonRpcRequest) => this.handleServerRequest(message));
    this.appServer.on("exit", () => {
      if (!this.appServerReloading) this.markAllFailed("Codex app-server 已退出");
    });
    this.appServer.on("error", (error: Error) => this.markAllFailed(sanitizeModelError(error)));
  }

  hydrateModelState(threadId: string, state: SessionModelState): RuntimeSnapshot {
    this.setRuntime(threadId, {
      model: state.actualModel,
      modelProvider: state.actualModelProvider,
      reasoningEffort: state.actualReasoningEffort,
      modelSelection: state,
      modelChangeStatus: state.confirmationPending ? "confirming" : state.lastError ? "failed" : state.applied ? "applied" : "idle",
      modelChangeError: state.lastError
    });
    return this.snapshot(threadId);
  }

  async resumeThread(threadId: string, options: ResumeThreadOptions = {}): Promise<RuntimeSnapshot> {
    return this.runExclusive(threadId, async () => {
      const current = this.runtimes.get(threadId);
      if (current && current.status !== "history" && current.status !== "failed" && current.status !== "exited") {
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

      const permissionMode = options.permissionMode ?? current?.permissionMode ?? "default";
      const override = options.modelOverride;
      const selection = override?.mode === "override" && override.model
        ? {
            ...emptyModelState(),
            mode: "override" as const,
            preferredModel: override.model,
            preferredReasoningEffort: override.reasoningEffort,
            updatedAt: new Date().toISOString()
          }
        : current?.modelSelection ?? emptyModelState();

      this.setRuntime(threadId, {
        status: "starting",
        permissionMode,
        activeTurnId: null,
        lastError: null,
        modelSelection: { ...selection, applied: false, confirmationPending: false, lastError: null },
        modelChangeError: null
      });

      try {
        const params = {
          threadId,
          ...(permissionMode === "full_access" ? { sandbox: "danger-full-access", approvalPolicy: "never" } : {}),
          ...(override?.mode === "override" && override.model ? { model: override.model } : {})
        };
        const response = asRecord(await this.appServer.request("thread/resume", params));
        const thread = asRecord(response.thread);
        const actualModel = readString(response.model) ?? readString(thread.model) ?? override?.model ?? current?.model ?? null;
        const actualModelProvider =
          readString(response.modelProvider)
          ?? readString(thread.modelProvider)
          ?? current?.modelProvider
          ?? null;
        let actualEffort =
          readString(response.reasoningEffort)
          ?? readString(thread.reasoningEffort)
          ?? current?.reasoningEffort
          ?? null;

        if (override?.mode === "override" && override.reasoningEffort) {
          await this.appServer.request("thread/settings/update", {
            threadId,
            effort: override.reasoningEffort
          });
          actualEffort = override.reasoningEffort;
        }

        const applied = selection.mode === "override" ? selection.preferredModel === actualModel : false;
        this.setRuntime(threadId, {
          status: "waiting_input",
          model: actualModel,
          modelProvider: actualModelProvider,
          reasoningEffort: actualEffort,
          modelSelection: {
            ...selection,
            actualModel,
            actualModelProvider,
            actualReasoningEffort: actualEffort,
            actualModelSupported: selection.mode === "override" ? applied : null,
            applied,
            confirmationPending: false,
            lastError: null
          },
          modelChangeStatus: applied ? "applied" : "idle",
          modelChangeError: null,
          lastError: null
        });
        return this.snapshot(threadId);
      } catch (error) {
        const message = sanitizeModelError(error);
        this.setRuntime(threadId, {
          status: "failed",
          lastError: message,
          modelSelection: {
            ...selection,
            applied: false,
            confirmationPending: false,
            lastError: message
          },
          modelChangeStatus: selection.mode === "override" ? "failed" : "idle",
          modelChangeError: selection.mode === "override" ? message : null
        });
        throw error;
      }
    });
  }

  async updateModel(threadId: string, selection: ValidatedModelSelection): Promise<RuntimeSnapshot> {
    return this.runExclusive(threadId, async () => {
      const current = this.runtimes.get(threadId);
      if (!current || current.status !== "waiting_input") {
        throw new ModelDomainError("MODEL_SWITCH_NOT_ALLOWED", "当前会话状态不允许切换模型", 409, {
          status: current?.status ?? "history"
        });
      }

      if (
        current.model === selection.model
        && current.reasoningEffort === selection.reasoningEffort
        && current.modelSelection.mode === "override"
        && current.modelSelection.preferredModel === selection.model
      ) {
        return this.snapshot(threadId);
      }

      const previous = { ...current, modelSelection: { ...current.modelSelection } };
      const requestedAt = new Date().toISOString();
      this.setRuntime(threadId, {
        modelChangeStatus: "pending",
        modelChangeError: null,
        modelSelection: {
          ...current.modelSelection,
          mode: "override",
          preferredModel: selection.model,
          preferredReasoningEffort: selection.reasoningEffort,
          applied: false,
          confirmationPending: false,
          updatedAt: requestedAt,
          lastError: null
        }
      });
      this.eventHub.publish(threadId, "model_change_started", {
        previousModel: previous.model,
        requestedModel: selection.model,
        reasoningEffort: selection.reasoningEffort,
        changedAt: requestedAt
      });

      const confirmation = this.createSettingsWaiter(threadId, selection.model, selection.reasoningEffort);

      try {
        await this.appServer.request("thread/settings/update", {
          threadId,
          model: selection.model,
          ...(selection.reasoningEffort ? { effort: selection.reasoningEffort } : {})
        });
        if (this.runtimes.get(threadId)?.modelChangeStatus === "pending") {
          this.setRuntime(threadId, { modelChangeStatus: "confirming" });
        }
      } catch (error) {
        this.cancelSettingsWaiter(threadId);
        const message = sanitizeModelError(error);
        this.runtimes.set(threadId, previous);
        this.setRuntime(threadId, {
          modelChangeStatus: "failed",
          modelChangeError: message,
          modelSelection: { ...previous.modelSelection, lastError: message, confirmationPending: false }
        });
        this.eventHub.publish(threadId, "model_change_failed", {
          requestedModel: selection.model,
          errorCode: classifyModelRequestError(error).code,
          message
        });
        throw classifyModelRequestError(error);
      }

      const result = await confirmation;
      if (result === "mismatch") {
        throw new ModelDomainError("MODEL_SWITCH_MISMATCH", "app-server 实际模型与请求模型不一致", 502, {
          requestedModel: selection.model,
          actualModel: this.runtimes.get(threadId)?.model ?? null
        });
      }
      return this.snapshot(threadId);
    });
  }

  async sendInput(threadId: string, params: SendInputParams): Promise<RuntimeSnapshot> {
    const text = params.text.trim();
    if (!text) throw new Error("输入内容不能为空");

    const runtime = this.runtimes.get(threadId);
    if (!runtime || runtime.status === "history" || runtime.status === "failed" || runtime.status === "exited") {
      await this.resumeThread(threadId, {
        permissionMode: params.permissionMode,
        modelOverride: params.modelOverride
      });
    }

    return this.runExclusive(threadId, async () => {
      const latest = this.runtimes.get(threadId);
      if (latest?.status === "waiting_approval") {
        throw new Error("当前会话正在等待审批，请先处理审批");
      }

      const input = [{ type: "text", text, text_elements: [] }];
      if (latest?.activeTurnId && latest.status === "running") {
        await this.appServer.request("turn/steer", {
          threadId,
          expectedTurnId: latest.activeTurnId,
          input
        });
      } else {
        const override = params.modelOverride;
        await this.appServer.request("turn/start", {
          threadId,
          input,
          ...(override?.mode === "override" && override.model ? { model: override.model } : {}),
          ...(override?.mode === "override" && override.reasoningEffort ? { effort: override.reasoningEffort } : {})
        });
      }

      this.setRuntime(threadId, { status: "running", lastError: null });
      return this.snapshot(threadId);
    });
  }

  getRuntime(threadId: string): RuntimeSnapshot {
    return this.snapshot(threadId);
  }

  getReloadBlockers(): RuntimeReloadBlocker[] {
    const blockers: RuntimeReloadBlocker[] = [];
    const seen = new Set<string>();

    for (const [threadId, runtime] of this.runtimes) {
      if (runtime.status === "starting" || runtime.status === "running" || runtime.status === "waiting_approval") {
        blockers.push({ threadId, status: runtime.status, reason: "active_runtime" });
        seen.add(threadId);
        continue;
      }
      if (runtime.modelChangeStatus === "pending" || runtime.modelChangeStatus === "confirming") {
        blockers.push({ threadId, status: runtime.status, reason: "model_change" });
        seen.add(threadId);
      }
    }

    for (const threadId of this.operationChains.keys()) {
      if (!seen.has(threadId)) {
        blockers.push({ threadId, status: this.runtimes.get(threadId)?.status ?? "history", reason: "pending_operation" });
      }
    }

    return blockers;
  }

  prepareForAppServerReload(): RuntimeReloadBlocker[] {
    const blockers = this.getReloadBlockers();
    if (blockers.length > 0) return blockers;
    this.appServerReloading = true;
    for (const threadId of this.settingsWaiters.keys()) {
      this.cancelSettingsWaiter(threadId);
    }
    return [];
  }

  finishAppServerReload(success: boolean, message: string | null = null): void {
    this.appServerReloading = false;
    for (const threadId of this.runtimes.keys()) {
      if (success) {
        this.setRuntime(threadId, {
          status: "history",
          activeTurnId: null,
          lastError: null,
          modelChangeStatus: "idle",
          modelChangeError: null
        });
      } else {
        this.setRuntime(threadId, {
          status: "failed",
          activeTurnId: null,
          lastError: message ?? "Codex app-server 重载失败",
          modelChangeStatus: "failed",
          modelChangeError: message ?? "Codex app-server 重载失败"
        });
      }
    }
  }

  submitApproval(threadId: string, approvalId: string, params: SubmitApprovalParams): ApprovalResponse {
    const current = this.approvalService.get(approvalId);
    if (!current || current.threadId !== threadId) throw new Error("Approval not found");
    const approval = this.approvalService.submit(approvalId, params);
    return { approval, runtime: this.runtimes.has(threadId) ? this.snapshot(threadId) : null };
  }

  private createSettingsWaiter(threadId: string, expectedModel: string, expectedEffort: string | null): Promise<SettingsWaiterResult> {
    this.cancelSettingsWaiter(threadId);
    return new Promise((resolve) => {
      const waiter: SettingsWaiter = {
        expectedModel,
        expectedEffort,
        timedOut: false,
        resolve,
        timer: setTimeout(() => {
          waiter.timedOut = true;
          const runtime = this.runtimes.get(threadId);
          if (runtime) {
            this.setRuntime(threadId, {
              modelChangeStatus: "confirming",
              modelSelection: {
                ...runtime.modelSelection,
                confirmationPending: true,
                applied: false
              }
            });
          }
          resolve("timeout");
        }, this.modelConfirmationTimeoutMs)
      };
      this.settingsWaiters.set(threadId, waiter);
    });
  }

  private cancelSettingsWaiter(threadId: string) {
    const waiter = this.settingsWaiters.get(threadId);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.settingsWaiters.delete(threadId);
  }

  private reconcileThreadSettings(threadId: string, settings: Record<string, unknown>) {
    const actualModel = readString(settings.model);
    const actualModelProvider = readString(settings.modelProvider) ?? readString(settings.model_provider);
    const actualEffort =
      readString(settings.effort)
      ?? readString(settings.reasoningEffort)
      ?? readString(settings.reasoning_effort);
    const runtime = this.runtimes.get(threadId);
    if (!runtime) return;

    const waiter = this.settingsWaiters.get(threadId);
    const nextModel = actualModel ?? runtime.model;
    const nextProvider = actualModelProvider ?? runtime.modelProvider;
    const nextEffort = actualEffort ?? runtime.reasoningEffort;
    const mismatch = Boolean(
      waiter
      && ((actualModel && actualModel !== waiter.expectedModel)
        || (waiter.expectedEffort && actualEffort && actualEffort !== waiter.expectedEffort))
    );
    const matched = Boolean(
      waiter
      && nextModel === waiter.expectedModel
      && (!waiter.expectedEffort || nextEffort === waiter.expectedEffort)
    );

    this.setRuntime(threadId, {
      model: nextModel,
      modelProvider: nextProvider,
      reasoningEffort: nextEffort,
      ...(matched ? {
        modelChangeStatus: "applied" as const,
        modelChangeError: null,
        modelSelection: {
          ...runtime.modelSelection,
          actualModel: nextModel,
          actualModelProvider: nextProvider,
          actualReasoningEffort: nextEffort,
          actualModelSupported: true,
          applied: true,
          confirmationPending: false,
          lastError: null
        }
      } : mismatch ? {
        modelChangeStatus: "failed" as const,
        modelChangeError: "app-server 实际模型与请求模型不一致",
        modelSelection: {
          ...runtime.modelSelection,
          actualModel: nextModel,
          actualModelProvider: nextProvider,
          actualReasoningEffort: nextEffort,
          actualModelSupported: null,
          applied: false,
          confirmationPending: false,
          lastError: "app-server 实际模型与请求模型不一致"
        }
      } : {
        modelSelection: {
          ...runtime.modelSelection,
          actualModel: nextModel,
          actualModelProvider: nextProvider,
          actualReasoningEffort: nextEffort
        }
      })
    });

    if (matched || mismatch) {
      if (waiter) {
        clearTimeout(waiter.timer);
        this.settingsWaiters.delete(threadId);
        waiter.resolve(matched ? "matched" : "mismatch");
      }
      if (matched) {
        this.eventHub.publish(threadId, "model_change_completed", {
          requestedModel: waiter?.expectedModel ?? nextModel,
          actualModel: nextModel,
          modelProvider: nextProvider,
          reasoningEffort: nextEffort,
          changedAt: new Date().toISOString()
        });
      } else {
        this.eventHub.publish(threadId, "model_change_failed", {
          requestedModel: waiter?.expectedModel ?? null,
          actualModel: nextModel,
          errorCode: "MODEL_SWITCH_MISMATCH",
          message: "app-server 实际模型与请求模型不一致"
        });
      }
    }
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
      case "thread/settings/updated":
        this.reconcileThreadSettings(threadId, asRecord(params.threadSettings));
        break;
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
        this.setRuntime(threadId, {
          status: this.approvalService.getPendingCount(threadId) > 0 ? "waiting_approval" : "waiting_input",
          activeTurnId: null
        });
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
      case "error": {
        const message = sanitizeModelError(readError(params.error) ?? "Codex 执行失败");
        this.setRuntime(threadId, {
          status: params.willRetry === true ? "running" : "failed",
          lastError: message
        });
        this.eventHub.publish(threadId, "error", { ...params, error: { message } });
        break;
      }
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
      lastError: patch.lastError !== undefined ? patch.lastError : current?.lastError ?? null,
      model: patch.model !== undefined ? patch.model : current?.model ?? null,
      modelProvider: patch.modelProvider !== undefined ? patch.modelProvider : current?.modelProvider ?? null,
      reasoningEffort: patch.reasoningEffort !== undefined ? patch.reasoningEffort : current?.reasoningEffort ?? null,
      modelSelection: patch.modelSelection ?? current?.modelSelection ?? emptyModelState(),
      modelChangeStatus: patch.modelChangeStatus ?? current?.modelChangeStatus ?? "idle",
      modelChangeError: patch.modelChangeError !== undefined ? patch.modelChangeError : current?.modelChangeError ?? null
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
      lastError: null,
      model: null,
      modelProvider: null,
      reasoningEffort: null,
      modelSelection: emptyModelState(),
      modelChangeStatus: "idle" as ModelChangeStatus,
      modelChangeError: null
    };

    return {
      ...runtime,
      pendingApprovalCount: this.approvalService.getPendingCount(threadId),
      eventSeq: this.eventHub.getLastSeq(threadId)
    };
  }

  private runExclusive<T>(threadId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operationChains.get(threadId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(operation);
    const tail = run.then(() => undefined, () => undefined);
    this.operationChains.set(threadId, tail);
    return run.finally(() => {
      if (this.operationChains.get(threadId) === tail) {
        this.operationChains.delete(threadId);
      }
    });
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

function classifyModelRequestError(error: unknown): ModelDomainError {
  const message = sanitizeModelError(error);
  if (/timed out|timeout/i.test(message)) {
    return new ModelDomainError("MODEL_REQUEST_TIMEOUT", "模型设置请求超时", 504, { cause: message });
  }
  if (/provider|proxy|upstream|bad gateway|502/i.test(message)) {
    return new ModelDomainError("MODEL_PROVIDER_UNAVAILABLE", "当前模型提供方不可用", 503, { cause: message });
  }
  return new ModelDomainError("MODEL_SWITCH_FAILED", "模型切换失败", 502, { cause: message });
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
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readError(value: unknown): string | null {
  if (typeof value === "string") return value;
  const record = asRecord(value);
  return readString(record.message) ?? readString(record.error);
}
