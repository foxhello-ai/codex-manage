import { describe, expect, it, vi } from "vitest";
import { createControlApp } from "./app";
import type { ControlConfig } from "./config";
import type { VerificationNotifier } from "./notifier";
import type { ControlStore } from "./store";

describe("control API", () => {
  it("serves health and keeps payment disabled", async () => {
    const store = new Proxy({}, {
      get: (_target, property) => {
        if (property === "close") return vi.fn(async () => undefined);
        if (property === "getSystemConfig") return vi.fn(async () => null);
        return vi.fn(async () => []);
      }
    }) as ControlStore;
    const config: ControlConfig = {
      host: "127.0.0.1",
      port: 4320,
      databaseUrl: "postgres://test",
      adminOrigin: "https://codex-admin.foxhello.com,http://192.168.31.107",
      publicDomain: "foxhello.com",
      publicApiBaseUrl: "https://codex-api.foxhello.com",
      allowDebugCodes: true,
      emailWebhookUrl: null,
      smsWebhookUrl: null,
      smtp: {
        host: null,
        port: 465,
        secure: true,
        user: null,
        password: null,
        fromEmail: null,
        fromName: "Codex Manage"
      },
      accessTokenTtlSeconds: 900,
      refreshTokenTtlSeconds: 3600,
      deviceTokenTtlSeconds: 900,
      verificationCodeTtlSeconds: 600,
      desktop: {
        apiBaseUrl: "https://codex-api.foxhello.com",
        updateFeedUrl: "https://codex-api.foxhello.com/updates/stable",
        managedDomainSuffixes: ["foxhello.com", "xmwefun.cn"],
        configTtlSeconds: 3600
      },
      cloudflare: { apiToken: null, accountId: null, zoneId: null }
    };
    const notifier: VerificationNotifier = { send: vi.fn(async () => undefined) };
    const { app } = await createControlApp(config, store, notifier, null);

    const root = await app.inject({
      method: "GET",
      url: "/",
      headers: { origin: "http://192.168.31.107" }
    });
    const health = await app.inject({ method: "GET", url: "/health" });
    const desktopConfig = await app.inject({ method: "GET", url: "/v1/desktop/config" });
    const payment = await app.inject({ method: "POST", url: "/v1/orders" });

    expect(root.statusCode).toBe(200);
    expect(root.json()).toMatchObject({ name: "codex-manage-control-api", ok: true, health: "/health" });
    expect(root.headers["access-control-allow-origin"]).toBe("http://192.168.31.107");
    expect(health.statusCode).toBe(200);
    expect(health.json().ok).toBe(true);
    expect(desktopConfig.statusCode).toBe(200);
    expect(desktopConfig.json()).toMatchObject({
      desktop: {
        schema_version: 1,
        api_base_url: "https://codex-api.foxhello.com",
        update_feed_url: "https://codex-api.foxhello.com/updates/stable",
        managed_domain_suffixes: ["foxhello.com", "xmwefun.cn"]
      }
    });
    expect(payment.statusCode).toBe(503);
    expect(payment.json()).toMatchObject({ error: { code: "PAYMENT_NOT_AVAILABLE" } });

    await app.close();
  });

  it("serves and updates runtime system config without restarting", async () => {
    const dynamicConfig = {
      publicApiBaseUrl: "https://codex-api.newroot.cn",
      desktopUpdateFeedUrl: "https://codex-api.newroot.cn/updates/stable",
      deviceDomain: "newroot.cn",
      managedDomainSuffixes: ["newroot.cn", "xmwefun.cn"],
      adminOrigins: ["https://codex-admin.newroot.cn"],
      desktopConfigTtlSeconds: 300,
      cloudflareZoneId: "zone-newroot-123456",
      updatedAt: "2026-07-31T00:00:00.000Z",
      updatedByAdminId: "admin-1"
    };
    const store = new Proxy({}, {
      get: (_target, property) => {
        if (property === "close") return vi.fn(async () => undefined);
        if (property === "getSystemConfig") return vi.fn(async () => dynamicConfig);
        if (property === "upsertSystemConfig") return vi.fn(async (input: Parameters<ControlStore["upsertSystemConfig"]>[0]) => ({
          ...input.config,
          updatedAt: "2026-07-31T00:10:00.000Z",
          updatedByAdminId: input.adminId
        }));
        if (property === "findToken") return vi.fn(async () => ({
          id: "token-1",
          subjectType: "admin",
          subjectId: "admin-1",
          tokenType: "admin_access",
          expiresAt: "2026-08-01T00:00:00.000Z"
        }));
        if (property === "findAdminById") return vi.fn(async () => ({ id: "admin-1", role: "admin", status: "active" }));
        if (property === "revokeToken") return vi.fn(async () => undefined);
        return vi.fn(async () => []);
      }
    }) as ControlStore;
    const config: ControlConfig = {
      host: "127.0.0.1",
      port: 4320,
      databaseUrl: "postgres://test",
      adminOrigin: "https://codex-admin.foxhello.com",
      publicDomain: "foxhello.com",
      publicApiBaseUrl: "https://codex-api.foxhello.com",
      allowDebugCodes: true,
      emailWebhookUrl: null,
      smsWebhookUrl: null,
      smtp: {
        host: null,
        port: 465,
        secure: true,
        user: null,
        password: null,
        fromEmail: null,
        fromName: "Codex Manage"
      },
      accessTokenTtlSeconds: 900,
      refreshTokenTtlSeconds: 3600,
      deviceTokenTtlSeconds: 900,
      verificationCodeTtlSeconds: 600,
      desktop: {
        apiBaseUrl: "https://codex-api.foxhello.com",
        updateFeedUrl: "https://codex-api.foxhello.com/updates/stable",
        managedDomainSuffixes: ["foxhello.com"],
        configTtlSeconds: 3600
      },
      cloudflare: { apiToken: null, accountId: null, zoneId: null }
    };
    const { app } = await createControlApp(config, store, { send: vi.fn(async () => undefined) }, null);

    const desktopConfig = await app.inject({ method: "GET", url: "/v1/desktop/config" });
    expect(desktopConfig.statusCode).toBe(200);
    expect(desktopConfig.json()).toMatchObject({
      desktop: {
        api_base_url: "https://codex-api.newroot.cn",
        update_feed_url: "https://codex-api.newroot.cn/updates/stable",
        managed_domain_suffixes: ["newroot.cn", "xmwefun.cn"],
        config_ttl_seconds: 300
      }
    });

    const adminConfig = await app.inject({
      method: "GET",
      url: "/v1/admin/system-config",
      headers: { authorization: "Bearer cm_admin_access_valid" }
    });
    expect(adminConfig.statusCode).toBe(200);
    expect(adminConfig.json()).toMatchObject({ systemConfig: { deviceDomain: "newroot.cn" } });

    const updated = await app.inject({
      method: "PATCH",
      url: "/v1/admin/system-config",
      headers: { authorization: "Bearer cm_admin_access_valid" },
      payload: {
        publicApiBaseUrl: "https://codex-api.nextroot.cn/",
        desktopUpdateFeedUrl: "https://codex-api.nextroot.cn/updates/stable/",
        deviceDomain: "nextroot.cn",
        managedDomainSuffixes: ["xmwefun.cn"],
        adminOrigins: ["https://codex-admin.nextroot.cn/"],
        desktopConfigTtlSeconds: 600,
        cloudflareZoneId: "zone-nextroot-123456"
      }
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      systemConfig: {
        publicApiBaseUrl: "https://codex-api.nextroot.cn",
        desktopUpdateFeedUrl: "https://codex-api.nextroot.cn/updates/stable",
        deviceDomain: "nextroot.cn",
        managedDomainSuffixes: ["xmwefun.cn", "nextroot.cn"],
        adminOrigins: ["https://codex-admin.nextroot.cn"],
        desktopConfigTtlSeconds: 600,
        cloudflareZoneId: "zone-nextroot-123456"
      }
    });

    await app.close();
  });
});
