import type { JsonRpcRequest } from "./CodexAppServerClient";
import type { EventHub } from "./EventHub";
import type { ApprovalDecision, ApprovalKind, ApprovalStatus, ApprovalSummary } from "../../shared/models";

type AppServerResponder = {
  respondToServerRequest: (id: number, result: unknown) => void;
};

type ApprovalRecord = ApprovalSummary & {
  method: string;
};

type SubmitApprovalParams = {
  decision: ApprovalDecision;
  answers?: Record<string, string[]>;
};

export class ApprovalService {
  private readonly approvals = new Map<string, ApprovalRecord>();

  constructor(
    private readonly appServer: AppServerResponder,
    private readonly eventHub: EventHub,
    private readonly onPendingCountChanged?: (threadId: string, count: number) => void
  ) {}

  handleServerRequest(request: JsonRpcRequest): boolean {
    const kind = toApprovalKind(request.method);
    if (!kind) return false;

    const params = asRecord(request.params);
    const threadId = readString(params.threadId) ?? readString(params.conversationId);
    if (!threadId) {
      this.appServer.respondToServerRequest(request.id, fallbackDeclineResult(kind));
      return true;
    }

    const approvalId = makeApprovalId(request, params);
    const approval: ApprovalRecord = {
      id: approvalId,
      requestId: request.id,
      threadId,
      turnId: readString(params.turnId),
      itemId: readString(params.itemId) ?? readString(params.callId),
      kind,
      status: "pending",
      title: makeTitle(kind),
      command: readCommand(kind, params),
      cwd: readString(params.cwd),
      reason: readString(params.reason),
      questions: readQuestions(params.questions),
      raw: params,
      createdAt: new Date(readNumber(params.startedAtMs) ?? Date.now()).toISOString(),
      resolvedAt: null,
      method: request.method
    };

    this.approvals.set(approval.id, approval);
    this.onPendingCountChanged?.(threadId, this.countPending(threadId));
    this.eventHub.publish(threadId, "approval_requested", { approval: toPublicApproval(approval) });
    return true;
  }

  listPending(threadId: string): ApprovalSummary[] {
    return [...this.approvals.values()]
      .filter((approval) => approval.threadId === threadId && approval.status === "pending")
      .map(toPublicApproval);
  }

  getPendingCount(threadId: string): number {
    return this.countPending(threadId);
  }

  get(approvalId: string): ApprovalSummary | null {
    const approval = this.approvals.get(approvalId);
    return approval ? toPublicApproval(approval) : null;
  }

  submit(approvalId: string, params: SubmitApprovalParams): ApprovalSummary {
    const approval = this.approvals.get(approvalId);
    if (!approval) throw new Error("Approval not found");
    if (approval.status !== "pending") throw new Error("Approval already resolved");

    const result = buildApprovalResult(approval, params);
    this.appServer.respondToServerRequest(approval.requestId, result);

    approval.status = toStatus(params.decision);
    approval.resolvedAt = new Date().toISOString();
    this.approvals.set(approval.id, approval);
    this.onPendingCountChanged?.(approval.threadId, this.countPending(approval.threadId));
    this.eventHub.publish(approval.threadId, "approval_resolved", { approval: toPublicApproval(approval) });
    return toPublicApproval(approval);
  }

  private countPending(threadId: string): number {
    return [...this.approvals.values()].filter((approval) => approval.threadId === threadId && approval.status === "pending").length;
  }
}

function toApprovalKind(method: string): ApprovalKind | null {
  switch (method) {
    case "item/commandExecution/requestApproval":
      return "command_execution";
    case "item/fileChange/requestApproval":
      return "file_change";
    case "item/permissions/requestApproval":
      return "permissions";
    case "item/tool/requestUserInput":
      return "tool_user_input";
    case "execCommandApproval":
      return "legacy_exec";
    case "applyPatchApproval":
      return "legacy_apply_patch";
    default:
      return null;
  }
}

function buildApprovalResult(approval: ApprovalRecord, params: SubmitApprovalParams): unknown {
  if (approval.kind === "tool_user_input") {
    const answers: Record<string, { answers: string[] }> = {};
    for (const question of approval.questions) {
      answers[question.id] = { answers: params.answers?.[question.id] ?? [] };
    }
    return { answers };
  }

  if (approval.kind === "permissions") {
    const rawPermissions = asRecord(approval.raw.permissions);
    const accepted = params.decision === "accept" || params.decision === "acceptForSession";
    return {
      permissions: accepted
        ? { network: rawPermissions.network ?? undefined, fileSystem: rawPermissions.fileSystem ?? undefined }
        : {},
      scope: params.decision === "acceptForSession" ? "session" : "turn",
      strictAutoReview: false
    };
  }

  if (approval.kind === "legacy_exec" || approval.kind === "legacy_apply_patch") {
    return { decision: toLegacyDecision(params.decision) };
  }

  return { decision: params.decision };
}

function fallbackDeclineResult(kind: ApprovalKind): unknown {
  if (kind === "permissions") return { permissions: {}, scope: "turn", strictAutoReview: false };
  if (kind === "tool_user_input") return { answers: {} };
  if (kind === "legacy_exec" || kind === "legacy_apply_patch") return { decision: "denied" };
  return { decision: "decline" };
}

function toLegacyDecision(decision: ApprovalDecision): string {
  switch (decision) {
    case "accept":
      return "approved";
    case "acceptForSession":
      return "approved_for_session";
    case "cancel":
      return "abort";
    case "decline":
    default:
      return "denied";
  }
}

function toStatus(decision: ApprovalDecision): ApprovalStatus {
  switch (decision) {
    case "accept":
      return "approved";
    case "acceptForSession":
      return "approved_for_session";
    case "cancel":
      return "cancelled";
    case "decline":
    default:
      return "declined";
  }
}

function makeApprovalId(request: JsonRpcRequest, params: Record<string, unknown>): string {
  return readString(params.approvalId) ?? `${request.method}:${request.id}`;
}

function makeTitle(kind: ApprovalKind): string {
  switch (kind) {
    case "command_execution":
    case "legacy_exec":
      return "命令执行审批";
    case "file_change":
    case "legacy_apply_patch":
      return "文件变更审批";
    case "permissions":
      return "权限审批";
    case "tool_user_input":
      return "需要补充输入";
  }
}

function readCommand(kind: ApprovalKind, params: Record<string, unknown>): string | null {
  if (kind === "legacy_exec" && Array.isArray(params.command)) {
    return params.command.filter((part): part is string => typeof part === "string").join(" ");
  }
  return readString(params.command);
}

function readQuestions(value: unknown): ApprovalSummary["questions"] {
  if (!Array.isArray(value)) return [];

  return value.map((question, index) => {
    const source = asRecord(question);
    const options = Array.isArray(source.options)
      ? source.options.map((option) => {
          const raw = asRecord(option);
          return {
            label: readString(raw.label) ?? "选项",
            description: readString(raw.description) ?? ""
          };
        })
      : null;

    return {
      id: readString(source.id) ?? `question-${index + 1}`,
      header: readString(source.header) ?? "问题",
      question: readString(source.question) ?? "",
      isOther: source.isOther === true,
      isSecret: source.isSecret === true,
      options
    };
  });
}

function toPublicApproval(approval: ApprovalRecord): ApprovalSummary {
  const { method: _method, ...publicApproval } = approval;
  return publicApproval;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
