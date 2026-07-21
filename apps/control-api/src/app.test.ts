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
      adminOrigin: "https://codex-admin.xmwefun.cn",
      publicDomain: "xmwefun.cn",
      allowDebugCodes: true,
      emailWebhookUrl: null,
      smsWebhookUrl: null,
      accessTokenTtlSeconds: 900,
      refreshTokenTtlSeconds: 3600,
      deviceTokenTtlSeconds: 900,
      verificationCodeTtlSeconds: 600,
      cloudflare: { apiToken: null, accountId: null, zoneId: null }
    };
    const notifier: VerificationNotifier = { send: vi.fn(async () => undefined) };
    const { app } = await createControlApp(config, store, notifier, null);

    const health = await app.inject({ method: "GET", url: "/health" });
    const payment = await app.inject({ method: "POST", url: "/v1/orders" });

    expect(health.statusCode).toBe(200);
    expect(health.json().ok).toBe(true);
    expect(payment.statusCode).toBe(503);
    expect(payment.json()).toMatchObject({ error: { code: "PAYMENT_NOT_AVAILABLE" } });

    await app.close();
  });
});
