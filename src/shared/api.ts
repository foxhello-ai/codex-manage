import type { ApiErrorBody, ApprovalDecision, ApprovalResponse, Collaborator, CollaboratorsResponse, CreateCollaboratorResponse, CreateSessionResponse, CreateTaskResponse, CreateTaskSessionResponse, HealthStatus, InputResponse, LoginAccountsResponse, ModelCatalogResponse, ModelSelectionResponse, PublicConfig, RuntimeReloadResponse, RuntimeResponse, SessionBranchMode, SessionBranchResponse, SessionCommandsResponse, SessionDetailResponse, SessionHistoryContinuationResponse, SessionMetadataResponse, SessionPermissionMode, SessionsResponse, TaskDetailResponse, TasksResponse, UpdateModelSelectionInput, UserSession } from "./models";

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

export function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  return requestApi<T>(path, init, true);
}

async function requestApi<T>(path: string, init: RequestInit | undefined, retryRuntimeRead: boolean): Promise<T> {
  const response = await fetch(path, {
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...init?.headers
    },
    ...init
  });

  if (!response.ok) {
    let body: ApiErrorBody | undefined;
    try {
      body = (await response.json()) as ApiErrorBody;
    } catch {
      body = undefined;
    }
    // Config reload stops in-flight app-server reads. Retry only that known transient
    // failure; writes and unrelated 503 responses must surface without replaying.
    if (retryRuntimeRead && (init?.method ?? "GET").toUpperCase() === "GET" && response.status === 503
      && ["CODEX_APP_SERVER_UNAVAILABLE", "TASK_LIST_FAILED", "TASK_DETAIL_FAILED"].includes(body?.error?.code ?? "")
      && /^(?:app-server stopped|Codex app-server is not ready)$/i.test(body?.error?.message ?? "")
      && !init?.signal?.aborted) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return requestApi<T>(path, init, false);
    }
    throw new ApiRequestError(
      body?.error?.message ?? `Request failed: ${response.status}`,
      response.status,
      body?.error?.code ?? "REQUEST_FAILED",
      body?.error?.details
    );
  }

  return (await response.json()) as T;
}

export function getMe(): Promise<UserSession> {
  return apiRequest<UserSession>("/api/me");
}

export function getPublicConfig(): Promise<PublicConfig> {
  return apiRequest<PublicConfig>("/api/config");
}

export function getHealthStatus(): Promise<HealthStatus> {
  return apiRequest<HealthStatus>("/api/health");
}

export function login(password: string, accountId = "owner"): Promise<UserSession> {
  return apiRequest<UserSession>("/api/login", {
    method: "POST",
    body: JSON.stringify({ password, accountId })
  });
}

export function getLoginAccounts(): Promise<LoginAccountsResponse> {
  return apiRequest<LoginAccountsResponse>("/api/child-accounts");
}

export function logout(): Promise<UserSession> {
  return apiRequest<UserSession>("/api/logout", {
    method: "POST",
    body: JSON.stringify({})
  });
}

export function getSessions(search?: string, options: { paginated?: boolean; limit?: number; cursor?: string; signal?: AbortSignal } = {}): Promise<SessionsResponse> {
  const params = new URLSearchParams();
  if (search?.trim()) params.set("search", search.trim());
  params.set("compact", "true");
  if (options.paginated) params.set("paginated", "true");
  if (options.limit) params.set("limit", String(options.limit));
  if (options.cursor) params.set("cursor", options.cursor);
  return apiRequest<SessionsResponse>(`/api/sessions?${params.toString()}`, { signal: options.signal });
}

export function createSession(cwd: string): Promise<CreateSessionResponse> {
  return apiRequest<CreateSessionResponse>("/api/sessions", {
    method: "POST",
    body: JSON.stringify({ cwd })
  });
}

export function getTasks(): Promise<TasksResponse> {
  return apiRequest<TasksResponse>("/api/tasks");
}

export function createTask(name: string): Promise<CreateTaskResponse> {
  return apiRequest<CreateTaskResponse>("/api/tasks", { method: "POST", body: JSON.stringify({ name }) });
}

export function getTask(taskId: string): Promise<TaskDetailResponse> {
  return apiRequest<TaskDetailResponse>(`/api/tasks/${encodeURIComponent(taskId)}`);
}

export function updateTask(taskId: string, input: { name?: string; pinned?: boolean }): Promise<TaskDetailResponse> {
  return apiRequest<TaskDetailResponse>(`/api/tasks/${encodeURIComponent(taskId)}`, { method: "PATCH", body: JSON.stringify(input) });
}

export function attachSessionToTask(taskId: string, sessionId: string): Promise<TaskDetailResponse> {
  return apiRequest<TaskDetailResponse>(`/api/tasks/${encodeURIComponent(taskId)}/sessions/${encodeURIComponent(sessionId)}`, { method: "POST", body: JSON.stringify({}) });
}

export function createTaskSession(taskId: string, cwd: string): Promise<CreateTaskSessionResponse> {
  return apiRequest<CreateTaskSessionResponse>(`/api/tasks/${encodeURIComponent(taskId)}/sessions`, { method: "POST", body: JSON.stringify({ cwd }) });
}

export function getCollaborators(): Promise<CollaboratorsResponse> {
  return apiRequest<CollaboratorsResponse>("/api/collaborators");
}

export function createCollaborator(input: { displayName: string; localEmail: string; password?: string }): Promise<CreateCollaboratorResponse> {
  return apiRequest<CreateCollaboratorResponse>("/api/collaborators", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function updateCollaboratorStatus(userId: string, active: boolean): Promise<{ collaborator: Collaborator }> {
  return apiRequest<{ collaborator: Collaborator }>(`/api/collaborators/${encodeURIComponent(userId)}`, {
    method: "PATCH",
    body: JSON.stringify({ active })
  });
}

export function updateCollaboratorGrants(userId: string, sessionIds: string[]): Promise<{ collaborator: Collaborator }> {
  return apiRequest<{ collaborator: Collaborator }>(`/api/collaborators/${encodeURIComponent(userId)}/grants`, {
    method: "PUT",
    body: JSON.stringify({ sessionIds })
  });
}

export function getModels(forceRefresh = false): Promise<ModelCatalogResponse> {
  return apiRequest<ModelCatalogResponse>(`/api/models${forceRefresh ? "?refresh=true" : ""}`);
}

export function reloadRuntime(): Promise<RuntimeReloadResponse> {
  return apiRequest<RuntimeReloadResponse>("/api/runtime/reload", {
    method: "POST",
    body: JSON.stringify({})
  });
}

export function getSessionDetail(sessionId: string, includeTurns = true): Promise<SessionDetailResponse> {
  const query = includeTurns ? "" : "?turns=false";
  return apiRequest<SessionDetailResponse>(`/api/sessions/${encodeURIComponent(sessionId)}${query}`);
}

export function getSessionCommands(sessionId: string): Promise<SessionCommandsResponse> {
  return apiRequest<SessionCommandsResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/commands`);
}

export function updateSessionMetadata(sessionId: string, remarkTitle: string | null): Promise<SessionMetadataResponse> {
  return apiRequest<SessionMetadataResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/metadata`, {
    method: "PATCH",
    body: JSON.stringify({ remarkTitle })
  });
}

export function updateSessionModel(sessionId: string, input: UpdateModelSelectionInput): Promise<ModelSelectionResponse> {
  return apiRequest<ModelSelectionResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/model`, {
    method: "PATCH",
    body: JSON.stringify(input)
  });
}

export function getSessionRuntime(sessionId: string): Promise<RuntimeResponse> {
  return apiRequest<RuntimeResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/runtime`);
}

export function resumeSession(sessionId: string, permissionMode?: SessionPermissionMode): Promise<RuntimeResponse> {
  return apiRequest<RuntimeResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/resume`, {
    method: "POST",
    body: JSON.stringify(permissionMode ? { permissionMode } : {})
  });
}

export function sendSessionInput(sessionId: string, text: string, permissionMode?: SessionPermissionMode, clientRequestId?: string, attachmentPaths?: string[], useDesktopSettings = false): Promise<InputResponse> {
  return apiRequest<InputResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/input`, {
    method: "POST",
    body: JSON.stringify({ text, ...(permissionMode ? { permissionMode } : {}), clientRequestId, attachmentPaths, useDesktopSettings })
  });
}

export type UploadedSessionAttachment = { name: string; mimeType: string; size: number; path: string };

export async function uploadSessionAttachment(sessionId: string, cwd: string, file: File): Promise<{ attachment: UploadedSessionAttachment }> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return apiRequest<{ attachment: UploadedSessionAttachment }>(`/api/sessions/${encodeURIComponent(sessionId)}/attachments`, {
    method: "POST",
    body: JSON.stringify({ cwd, name: file.name, mimeType: file.type || "application/octet-stream", size: file.size, data: btoa(binary) })
  });
}

export function branchSession(sessionId: string, mode: SessionBranchMode): Promise<SessionBranchResponse> {
  return apiRequest<SessionBranchResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/branch`, {
    method: "POST",
    body: JSON.stringify({ mode })
  });
}

export function continueSessionFromHistory(
  sourceSessionId: string,
  input: { cwd: string; sourceTitle: string; text: string; permissionMode?: SessionPermissionMode }
): Promise<SessionHistoryContinuationResponse> {
  return apiRequest<SessionHistoryContinuationResponse>(
    `/api/sessions/${encodeURIComponent(sourceSessionId)}/continue-from-history`,
    {
      method: "POST",
      body: JSON.stringify(input)
    }
  );
}

export function submitApproval(
  sessionId: string,
  approvalId: string,
  decision: ApprovalDecision,
  answers?: Record<string, string[]>
): Promise<ApprovalResponse> {
  return apiRequest<ApprovalResponse>(
    `/api/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(approvalId)}`,
    {
      method: "POST",
      body: JSON.stringify({ decision, answers })
    }
  );
}

export function getSessionWebSocketUrl(sessionId: string, afterSeq?: number): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const params = new URLSearchParams();
  if (afterSeq && afterSeq > 0) params.set("afterSeq", String(afterSeq));
  return `${protocol}//${window.location.host}/api/sessions/${encodeURIComponent(sessionId)}/ws${
    params.size ? `?${params.toString()}` : ""
  }`;
}
