import { describe, expect, it, vi } from "vitest";
import { createControlApp } from "./app";
import type { ControlConfig } from "./config";
import type { AuthTokenRecord, DeviceRecord, UserRecord } from "./domain";
import type { VerificationNotifier } from "./notifier";
import type { ControlStore } from "./store";

function config(): ControlConfig {
  return {
    host: "127.0.0.1",
    port: 4320,
    databaseUrl: "postgres://test",
    adminOrigin: "https://codex-admin.xmwefun.cn",
    publicDomain: "xmwefun.cn",
    publicApiBaseUrl: "https://codex-api.xmwefun.cn",
    allowDebugCodes: true,
    emailWebhookUrl: null,
    smsWebhookUrl: null,
    accessTokenTtlSeconds: 900,
    refreshTokenTtlSeconds: 3600,
    deviceTokenTtlSeconds: 900,
    verificationCodeTtlSeconds: 600,
    desktop: {
      apiBaseUrl: "https://codex-api.xmwefun.cn",
      updateFeedUrl: "https://codex-api.xmwefun.cn/updates/stable",
      managedDomainSuffixes: ["xmwefun.cn"],
      configTtlSeconds: 3600
    },
    cloudflare: { apiToken: null, accountId: null, zoneId: null }
  };
}

describe("desktop API backward compatibility", () => {
  it("keeps the 1.0.1 desktop cloud API contract compatible", async () => {
    let user: UserRecord | null = null;
    const device: DeviceRecord = {
      id: "11111111-1111-4111-8111-111111111111",
      deviceCode: "abc123def0",
      userId: "user-1",
      name: "MacBook",
      os: "darwin",
      arch: "arm64",
      clientVersion: "1.0.1",
      codexCliVersion: "codex-cli 0.144.3",
      originPort: 4310,
      status: "active",
      lastSeenAt: null,
      createdAt: "2026-07-27T00:00:00.000Z"
    };
    const tokenRecord = (tokenType: AuthTokenRecord["tokenType"], subjectType: AuthTokenRecord["subjectType"], subjectId: string): AuthTokenRecord => ({
      id: `${tokenType}-token`,
      subjectType,
      subjectId,
      tokenType,
      expiresAt: "2026-07-28T00:00:00.000Z"
    });
    const store = {
      saveVerification: vi.fn(async () => undefined),
      consumeVerification: vi.fn(async () => true),
      findUserByIdentity: vi.fn(async () => user),
      createUserWithIdentity: vi.fn(async (input: { passwordHash: string }) => {
        user = {
          id: "user-1",
          passwordHash: input.passwordHash,
          status: "active",
          createdAt: "2026-07-27T00:00:00.000Z"
        };
        return user;
      }),
      updateUserLastLogin: vi.fn(async () => undefined),
      updateUserPasswordByIdentity: vi.fn(async () => true),
      addUserIdentity: vi.fn(async () => true),
      removeUserIdentity: vi.fn(async () => "removed" as const),
      listUserIdentities: vi.fn(async () => []),
      createToken: vi.fn(async () => undefined),
      createTokens: vi.fn(async () => undefined),
      rotateRefreshToken: vi.fn(async () => "user-1"),
      findToken: vi.fn(async (_hash: string, tokenType: AuthTokenRecord["tokenType"]) => {
        if (tokenType === "access") return tokenRecord("access", "user", "user-1");
        if (tokenType === "device_access") return tokenRecord("device_access", "device", device.id);
        return null;
      }),
      revokeToken: vi.fn(async () => undefined),
      revokeSubjectTokens: vi.fn(async () => undefined),
      countActiveDevices: vi.fn(async () => 0),
      createDevice: vi.fn(async () => device),
      findDeviceByCredential: vi.fn(async () => device),
      getDevice: vi.fn(async () => device),
      listDevices: vi.fn(async () => [device]),
      updateDeviceName: vi.fn(async () => device),
      recordHeartbeat: vi.fn(async () => true),
      revokeDevice: vi.fn(async () => true),
      getEntitlements: vi.fn(async () => ({ "tunnel.quick": true, "tunnel.named": true, "device.max_count": 1 })),
      listPlans: vi.fn(async () => [{ code: "free", name: "体验版" }]),
      getCurrentSubscription: vi.fn(async () => ({ plan_code: "formal", plan_name: "正式版", expires_at: null })),
      listOrders: vi.fn(async () => []),
      requestNamedTunnel: vi.fn(async () => ({
        id: "tunnel-1",
        deviceId: device.id,
        cloudflareTunnelId: "cf-tunnel-1",
        cloudflareZoneId: "zone-xmwefun-123456",
        hostname: "d-abc123def0.xmwefun.cn",
        status: "active",
        lastErrorCode: null
      })),
      getNamedTunnelForDevice: vi.fn(async () => ({
        id: "tunnel-1",
        deviceId: device.id,
        cloudflareTunnelId: "cf-tunnel-1",
        cloudflareZoneId: "zone-xmwefun-123456",
        hostname: "d-abc123def0.xmwefun.cn",
        status: "active",
        lastErrorCode: null
      })),
      claimProvisioningJob: vi.fn(async () => null),
      completeProvisioningJob: vi.fn(async () => true),
      convertProvisioningJobToRevocation: vi.fn(async () => undefined),
      retryProvisioningJob: vi.fn(async () => undefined),
      completeRevocationJob: vi.fn(async () => undefined),
      reconcileTunnelJobs: vi.fn(async () => 0),
      findAdminByEmail: vi.fn(async () => null),
      findAdminById: vi.fn(async () => null),
      updateAdminLastLogin: vi.fn(async () => undefined),
      ensureAdmin: vi.fn(async () => undefined),
      listAdminUsers: vi.fn(async () => []),
      listAdminDevices: vi.fn(async () => []),
      listAdminTunnels: vi.fn(async () => []),
      listAdminDomains: vi.fn(async () => []),
      listAdminSubscriptions: vi.fn(async () => []),
      listAdminOrders: vi.fn(async () => []),
      listAdminPayments: vi.fn(async () => []),
      listAdminAuditLogs: vi.fn(async () => []),
      getSystemConfig: vi.fn(async () => null),
      upsertSystemConfig: vi.fn(async (_input: Parameters<ControlStore["upsertSystemConfig"]>[0]) => ({
        publicApiBaseUrl: "https://codex-api.xmwefun.cn",
        desktopUpdateFeedUrl: "https://codex-api.xmwefun.cn/updates/stable",
        deviceDomain: "xmwefun.cn",
        managedDomainSuffixes: ["xmwefun.cn"],
        adminOrigins: ["https://codex-admin.xmwefun.cn"],
        desktopConfigTtlSeconds: 3600,
        cloudflareZoneId: null,
        updatedAt: "2026-07-27T00:00:00.000Z",
        updatedByAdminId: "admin-1"
      })),
      createIssueReport: vi.fn(async () => { throw new Error("not used by 1.0.1"); }),
      listAdminIssueReports: vi.fn(async () => []),
      getAdminIssueReport: vi.fn(async () => null),
      updateIssueReport: vi.fn(async () => null),
      getAdminOverview: vi.fn(async () => ({})),
      grantFormalSubscription: vi.fn(async () => undefined),
      setUserStatus: vi.fn(async () => true),
      setDeviceStatus: vi.fn(async () => true),
      rebuildNamedTunnel: vi.fn(async () => true),
      close: vi.fn(async () => undefined)
    } satisfies ControlStore;
    const notifier: VerificationNotifier = { send: vi.fn(async () => undefined) };
    const cloudflare = { getTunnelToken: vi.fn(async () => "named-tunnel-token") };
    const { app } = await createControlApp(config(), store, notifier, cloudflare as any);

    const code = await app.inject({ method: "POST", url: "/v1/auth/email/codes", payload: { identifier: "user@example.com" } });
    expect(code.statusCode).toBe(200);
    expect(code.json()).toMatchObject({ sent: true, expiresAt: expect.any(String) });

    const register = await app.inject({
      method: "POST",
      url: "/v1/auth/email/register",
      payload: { identifier: "user@example.com", code: "123456", password: "secure-password" }
    });
    expect(register.statusCode).toBe(200);
    expect(register.json()).toMatchObject({
      user: { id: "user-1", identityType: "email", identifier: "user@example.com" },
      accessToken: expect.stringMatching(/^cm_access_/),
      refreshToken: expect.stringMatching(/^cm_refresh_/),
      accessExpiresAt: expect.any(String),
      refreshExpiresAt: expect.any(String)
    });

    const login = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { identifier: "user@example.com", password: "secure-password" }
    });
    expect(login.statusCode).toBe(200);
    expect(login.json()).toMatchObject({
      user: { id: "user-1", identityType: "email", identifier: "user@example.com" },
      accessToken: expect.stringMatching(/^cm_access_/),
      refreshToken: expect.stringMatching(/^cm_refresh_/)
    });

    const refresh = await app.inject({ method: "POST", url: "/v1/auth/refresh", payload: { refreshToken: "cm_refresh_valid_1234567890" } });
    expect(refresh.statusCode).toBe(200);
    expect(refresh.json()).toMatchObject({
      accessToken: expect.stringMatching(/^cm_access_/),
      refreshToken: expect.stringMatching(/^cm_refresh_/),
      accessExpiresAt: expect.any(String),
      refreshExpiresAt: expect.any(String)
    });

    const logout = await app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      headers: { authorization: "Bearer cm_access_valid" },
      payload: { refreshToken: "cm_refresh_valid_1234567890" }
    });
    expect(logout.statusCode).toBe(200);
    expect(logout.json()).toMatchObject({ loggedOut: true });

    const registerDevice = await app.inject({
      method: "POST",
      url: "/v1/devices",
      headers: { authorization: "Bearer cm_access_valid" },
      payload: {
        name: "MacBook",
        os: "darwin",
        arch: "arm64",
        clientVersion: "1.0.1",
        codexCliVersion: null,
        originPort: 4310
      }
    });
    expect(registerDevice.statusCode).toBe(200);
    expect(registerDevice.json()).toMatchObject({ device: { id: device.id }, credential: expect.any(String) });

    const exchange = await app.inject({
      method: "POST",
      url: "/v1/devices/credential/exchange",
      payload: { credential: "cm_device_valid_1234567890" }
    });
    expect(exchange.statusCode).toBe(200);
    expect(exchange.json()).toMatchObject({ accessToken: expect.stringMatching(/^cm_device_access_/), expiresAt: expect.any(String), device: { id: device.id } });

    const entitlements = await app.inject({ method: "GET", url: "/v1/entitlements", headers: { authorization: "Bearer cm_access_valid" } });
    expect(entitlements.statusCode).toBe(200);
    expect(entitlements.json()).toMatchObject({ entitlements: { "tunnel.quick": true, "tunnel.named": true, "device.max_count": 1 } });

    const subscription = await app.inject({ method: "GET", url: "/v1/subscriptions/current", headers: { authorization: "Bearer cm_access_valid" } });
    expect(subscription.statusCode).toBe(200);
    expect(subscription.json()).toMatchObject({ subscription: { plan_code: "formal", plan_name: "正式版", expires_at: null } });

    const plans = await app.inject({ method: "GET", url: "/v1/plans" });
    expect(plans.statusCode).toBe(200);
    expect(plans.json()).toMatchObject({ plans: expect.any(Array) });

    const namedTunnel = await app.inject({
      method: "POST",
      url: `/v1/devices/${device.id}/named-tunnel/provision`,
      headers: { authorization: "Bearer cm_access_valid" },
      payload: {}
    });
    expect(namedTunnel.statusCode).toBe(200);
    expect(namedTunnel.json()).toMatchObject({ tunnel: { hostname: "d-abc123def0.xmwefun.cn", status: "active" } });

    const tunnelConfig = await app.inject({
      method: "GET",
      url: `/v1/devices/${device.id}/tunnel-config`,
      headers: { authorization: "Bearer cm_device_access_valid" }
    });
    expect(tunnelConfig.statusCode).toBe(200);
    expect(tunnelConfig.json()).toMatchObject({ mode: "named", hostname: "d-abc123def0.xmwefun.cn", token: "named-tunnel-token" });

    const heartbeat = await app.inject({
      method: "POST",
      url: `/v1/devices/${device.id}/heartbeat`,
      headers: { authorization: "Bearer cm_device_access_valid" },
      payload: {
        clientVersion: "1.0.1",
        codexCliVersion: null,
        originPort: 4310,
        tunnelStatus: "running",
        publicHostname: "d-abc123def0.xmwefun.cn",
        errorCode: null
      }
    });
    expect(heartbeat.statusCode).toBe(200);
    expect(heartbeat.json()).toMatchObject({ accepted: true, serverTime: expect.any(String) });

    await app.close();
  });
});
