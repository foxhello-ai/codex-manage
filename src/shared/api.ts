import type { ApiErrorBody, ApprovalDecision, ApprovalResponse, InputResponse, PublicConfig, RuntimeResponse, SessionCommandsResponse, SessionDetailResponse, SessionMetadataResponse, SessionsResponse, UserSession } from "./models";

export async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
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
    throw new Error(body?.error.message ?? `Request failed: ${response.status}`);
  }

  return (await response.json()) as T;
}

export function getMe(): Promise<UserSession> {
  return apiRequest<UserSession>("/api/me");
}

export function getPublicConfig(): Promise<PublicConfig> {
  return apiRequest<PublicConfig>("/api/config");
}

export function login(password: string): Promise<UserSession> {
  return apiRequest<UserSession>("/api/login", {
    method: "POST",
    body: JSON.stringify({ password })
  });
}

export function logout(): Promise<UserSession> {
  return apiRequest<UserSession>("/api/logout", {
    method: "POST",
    body: JSON.stringify({})
  });
}

export function getSessions(search?: string): Promise<SessionsResponse> {
  const params = new URLSearchParams();
  if (search?.trim()) params.set("search", search.trim());
  return apiRequest<SessionsResponse>(`/api/sessions${params.size ? `?${params.toString()}` : ""}`);
}

export function getSessionDetail(sessionId: string): Promise<SessionDetailResponse> {
  return apiRequest<SessionDetailResponse>(`/api/sessions/${encodeURIComponent(sessionId)}`);
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

export function getSessionRuntime(sessionId: string): Promise<RuntimeResponse> {
  return apiRequest<RuntimeResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/runtime`);
}

export function resumeSession(sessionId: string): Promise<RuntimeResponse> {
  return apiRequest<RuntimeResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/resume`, {
    method: "POST",
    body: JSON.stringify({})
  });
}

export function sendSessionInput(sessionId: string, text: string): Promise<InputResponse> {
  return apiRequest<InputResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/input`, {
    method: "POST",
    body: JSON.stringify({ text })
  });
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
