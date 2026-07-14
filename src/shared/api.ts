import type { ApiErrorBody, PublicConfig, SessionsResponse, UserSession } from "./models";

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
