import { ControlError } from "../domain";

type CloudflareResponse<T> = {
  success: boolean;
  result: T;
  errors?: Array<{ code?: number; message?: string }>;
};

export class CloudflareAdapter {
  constructor(
    private readonly apiToken: string,
    private readonly accountId: string,
    private readonly zoneId: string | null
  ) {}

  async createTunnel(name: string): Promise<{ id: string }> {
    const existing = await this.request<Array<{ id: string; name: string }>>(
      `/accounts/${this.accountId}/cfd_tunnel?${new URLSearchParams({ name, is_deleted: "false" }).toString()}`
    );
    const matched = existing.find((tunnel) => tunnel.name === name);
    if (matched) return { id: matched.id };

    return await this.request<{ id: string }>(
      `/accounts/${this.accountId}/cfd_tunnel`,
      {
        method: "POST",
        body: JSON.stringify({ name, config_src: "cloudflare" })
      }
    );
  }

  async configurePublicHostname(tunnelId: string, hostname: string, originPort: number): Promise<void> {
    await this.request(
      `/accounts/${this.accountId}/cfd_tunnel/${tunnelId}/configurations`,
      {
        method: "PUT",
        body: JSON.stringify({
          config: {
            ingress: [
              {
                hostname,
                service: `http://127.0.0.1:${originPort}`,
                originRequest: {}
              },
              { service: "http_status:404" }
            ]
          }
        })
      }
    );
  }

  async createDnsRoute(hostname: string, tunnelId: string, zoneId = this.zoneId): Promise<void> {
    const targetZoneId = this.requireZoneId(zoneId);
    const existing = await this.findDnsRecord(hostname, targetZoneId);
    if (existing) {
      if (existing.content === `${tunnelId}.cfargotunnel.com`) return;
      await this.request(`/zones/${targetZoneId}/dns_records/${existing.id}`, {
        method: "PUT",
        body: JSON.stringify({
          type: "CNAME",
          name: hostname,
          content: `${tunnelId}.cfargotunnel.com`,
          proxied: true
        })
      });
      return;
    }

    await this.request(`/zones/${targetZoneId}/dns_records`, {
      method: "POST",
      body: JSON.stringify({
        type: "CNAME",
        name: hostname,
        content: `${tunnelId}.cfargotunnel.com`,
        proxied: true
      })
    });
  }

  async getTunnelToken(tunnelId: string): Promise<string> {
    return await this.request<string>(`/accounts/${this.accountId}/cfd_tunnel/${tunnelId}/token`);
  }

  async deletePublishedTunnel(tunnelId: string | null, hostname: string, zoneId = this.zoneId): Promise<void> {
    const targetZoneId = this.requireZoneId(zoneId);
    const dns = await this.findDnsRecord(hostname, targetZoneId);
    if (dns) {
      await this.ignoreNotFound(() => this.request(`/zones/${targetZoneId}/dns_records/${dns.id}`, { method: "DELETE" }));
    }
    if (tunnelId) {
      await this.ignoreNotFound(() => this.request(`/accounts/${this.accountId}/cfd_tunnel/${tunnelId}`, { method: "DELETE" }));
    }
  }

  private async findDnsRecord(hostname: string, zoneId: string): Promise<{ id: string; content: string } | null> {
    const params = new URLSearchParams({ type: "CNAME", name: hostname });
    const records = await this.request<Array<{ id: string; content: string }>>(
      `/zones/${zoneId}/dns_records?${params.toString()}`
    );
    return records[0] ?? null;
  }

  private requireZoneId(zoneId: string | null): string {
    if (!zoneId) throw new ControlError("CLOUDFLARE_ZONE_NOT_CONFIGURED", "Cloudflare Zone 尚未配置", 503);
    return zoneId;
  }

  private async request<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(15_000),
      headers: {
        authorization: `Bearer ${this.apiToken}`,
        "content-type": "application/json",
        ...init.headers
      }
    });
    const body = await response.json().catch(() => null) as CloudflareResponse<T> | null;
    if (!response.ok || !body?.success) {
      const firstError = body?.errors?.[0];
      const code = response.status === 429 ? "CLOUDFLARE_RATE_LIMITED" : "CLOUDFLARE_REQUEST_FAILED";
      throw new ControlError(code, firstError?.message ?? `Cloudflare API 请求失败：${response.status}`, 502, {
        status: response.status,
        cloudflareCode: firstError?.code
      });
    }
    return body.result;
  }

  private async ignoreNotFound(work: () => Promise<unknown>): Promise<void> {
    try {
      await work();
    } catch (error) {
      if (error instanceof ControlError) {
        const details = error.details as { status?: number } | undefined;
        if (details?.status === 404) return;
      }
      throw error;
    }
  }
}
