export type CloudAuthResponse = {
  user: { id: string; identityType: "email" | "phone"; identifier: string };
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: string;
  refreshExpiresAt: string;
};

export type CloudSession = {
  userId: string;
  identifier: string;
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: string;
  refreshExpiresAt: string;
  deviceId: string | null;
  deviceCredential: string | null;
  deviceAccessToken: string | null;
  deviceAccessExpiresAt: string | null;
};

export type DesktopCloudConfig = {
  schema_version: number;
  api_base_url: string;
  update_feed_url: string;
  managed_domain_suffixes: string[];
  config_ttl_seconds: number;
  generated_at: string;
};

export class CloudClient {
  constructor(private baseUrl: string) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  setBaseUrl(baseUrl: string): void {
    this.baseUrl = normalizeBaseUrl(baseUrl);
  }

  getDesktopConfig(baseUrl = this.baseUrl) {
    return this.request<{ desktop: DesktopCloudConfig }>("/v1/desktop/config", {
      baseUrl: normalizeBaseUrl(baseUrl)
    });
  }

  requestVerificationCode(type: "email" | "phone", identifier: string) {
    return this.request<{ sent: boolean; expiresAt: string; debugCode?: string }>(`/v1/auth/${type}/codes`, {
      method: "POST",
      body: { identifier }
    });
  }

  register(type: "email" | "phone", identifier: string, code: string, password: string) {
    return this.request<CloudAuthResponse>(`/v1/auth/${type}/register`, {
      method: "POST",
      body: { identifier, code, password }
    });
  }

  login(identifier: string, password: string) {
    return this.request<CloudAuthResponse>("/v1/auth/login", {
      method: "POST",
      body: { identifier, password }
    });
  }

  refresh(refreshToken: string) {
    return this.request<Omit<CloudAuthResponse, "user">>("/v1/auth/refresh", {
      method: "POST",
      body: { refreshToken }
    });
  }

  logout(accessToken: string, refreshToken: string) {
    return this.request<{ loggedOut: boolean }>("/v1/auth/logout", {
      method: "POST",
      token: accessToken,
      body: { refreshToken }
    });
  }

  registerDevice(accessToken: string, input: {
    name: string;
    os: string;
    arch: string;
    clientVersion: string;
    codexCliVersion: string | null;
    originPort: number;
  }) {
    return this.request<{ device: { id: string }; credential: string }>("/v1/devices", {
      method: "POST",
      token: accessToken,
      body: input
    });
  }

  revokeDevice(accessToken: string, deviceId: string) {
    return this.request<{ revoked: boolean }>(`/v1/devices/${encodeURIComponent(deviceId)}`, {
      method: "DELETE",
      token: accessToken
    });
  }

  exchangeDeviceCredential(credential: string) {
    return this.request<{ accessToken: string; expiresAt: string; device: { id: string } }>(
      "/v1/devices/credential/exchange",
      { method: "POST", body: { credential } }
    );
  }

  getEntitlements(accessToken: string) {
    return this.request<{ entitlements: Record<string, string | number | boolean> }>("/v1/entitlements", {
      token: accessToken
    });
  }

  getCurrentSubscription(accessToken: string) {
    return this.request<{
      subscription: {
        plan_code: string;
        plan_name: string;
        expires_at: string | null;
      } | null;
    }>("/v1/subscriptions/current", { token: accessToken });
  }

  getPlans() {
    return this.request<{ plans: Array<Record<string, unknown>> }>("/v1/plans");
  }

  provisionNamedTunnel(accessToken: string, deviceId: string) {
    return this.request<{ tunnel: { hostname: string; status: string } }>(
      `/v1/devices/${encodeURIComponent(deviceId)}/named-tunnel/provision`,
      { method: "POST", token: accessToken, body: {} }
    );
  }

  getTunnelConfig(deviceAccessToken: string, deviceId: string) {
    return this.request<{
      mode: "quick" | "named" | "disabled";
      hostname: string | null;
      token: string | null;
      namedTunnelStatus?: string | null;
    }>(`/v1/devices/${encodeURIComponent(deviceId)}/tunnel-config`, {
      token: deviceAccessToken
    });
  }

  heartbeat(deviceAccessToken: string, deviceId: string, input: {
    clientVersion: string;
    codexCliVersion: string | null;
    originPort: number;
    tunnelStatus: string;
    publicHostname: string | null;
    errorCode: string | null;
  }) {
    return this.request<{ accepted: boolean; serverTime: string }>(
      `/v1/devices/${encodeURIComponent(deviceId)}/heartbeat`,
      { method: "POST", token: deviceAccessToken, body: input }
    );
  }

  submitManualIssueReport(accessToken: string, input: Record<string, unknown>) {
    return this.request<{
      report: { id: string; duplicateCount?: number; deduplicated?: boolean };
    }>("/v1/issue-reports/manual", {
      method: "POST",
      token: accessToken,
      body: input
    });
  }

  submitAutoIssueReport(deviceAccessToken: string, deviceId: string, input: Record<string, unknown>) {
    return this.request<{
      report: { id: string; duplicateCount?: number; deduplicated?: boolean };
    }>(`/v1/devices/${encodeURIComponent(deviceId)}/issue-reports/auto`, {
      method: "POST",
      token: deviceAccessToken,
      body: input
    });
  }

  private async request<T>(
    path: string,
    options: { method?: string; token?: string; body?: unknown; baseUrl?: string } = {}
  ): Promise<T> {
    const maxRetries = 2;
    const baseUrl = options.baseUrl ?? this.baseUrl;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const response = await fetch(new URL(path, baseUrl), {
        method: options.method ?? "GET",
        signal: AbortSignal.timeout(15_000),
        headers: {
          "content-type": "application/json",
          ...(options.token ? { authorization: `Bearer ${options.token}` } : {})
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body)
      });
      const payload = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
      if (!response.ok) {
        const error = new Error(payload?.error?.message ?? `云端请求失败：${response.status}`) as Error & { code?: string; statusCode?: number };
        error.code = payload?.error?.code;
        error.statusCode = response.status;
        if ((response.status === 503 || response.status === 500) && attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        throw error;
      }
      return payload as T;
    }
    throw new Error("云端请求失败");
  }
}

function normalizeBaseUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/, "");
  if (!normalized) throw new Error("云端 API 地址不能为空");
  return normalized;
}
