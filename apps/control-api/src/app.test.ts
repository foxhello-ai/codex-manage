import { describe, expect, it, vi } from "vitest";
import { createControlApp } from "./app";
import type { ControlConfig } from "./config";
import type { VerificationNotifier } from "./notifier";
import type { ControlStore } from "./store";

describe("control API", () => {
  it("serves health and keeps payment disabled", async () => {
    const store = new Proxy({}, {
      get: (_target, property) => property === "close" ? vi.fn(async () => undefined) : vi.fn(async () => [])
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
});
