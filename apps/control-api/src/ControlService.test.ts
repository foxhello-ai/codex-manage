import { describe, expect, it, vi } from "vitest";
import type { ControlConfig } from "./config";
import { ControlService, normalizeIdentifier } from "./ControlService";
import { ControlError } from "./domain";
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
      apiBaseUrl: "https://codex-api.xmwefun.cn",
      updateFeedUrl: "https://codex-api.xmwefun.cn/updates/stable",
      managedDomainSuffixes: ["xmwefun.cn"],
      configTtlSeconds: 3600
    },
    cloudflare: { apiToken: null, accountId: null, zoneId: null }
  };
}

function mockStore(overrides: Partial<ControlStore> = {}): ControlStore {
  return {
    saveVerification: vi.fn(async () => undefined),
    consumeVerification: vi.fn(async () => true),
    findUserByIdentity: vi.fn(async () => null),
    createUserWithIdentity: vi.fn(async () => ({
      id: "user-1",
      passwordHash: "hash",
      status: "active" as const,
      createdAt: new Date().toISOString()
    })),
    updateUserLastLogin: vi.fn(async () => undefined),
    updateUserPasswordByIdentity: vi.fn(async () => true),
    addUserIdentity: vi.fn(async () => true),
    removeUserIdentity: vi.fn(async () => "removed" as const),
    listUserIdentities: vi.fn(async () => []),
    createToken: vi.fn(async () => undefined),
    createTokens: vi.fn(async () => undefined),
    rotateRefreshToken: vi.fn(async () => null),
    findToken: vi.fn(async () => null),
    revokeToken: vi.fn(async () => undefined),
    revokeSubjectTokens: vi.fn(async () => undefined),
    countActiveDevices: vi.fn(async () => 0),
    createDevice: vi.fn(async () => { throw new Error("not used"); }),
    findDeviceByCredential: vi.fn(async () => null),
    getDevice: vi.fn(async () => null),
    listDevices: vi.fn(async () => []),
    updateDeviceName: vi.fn(async () => null),
    recordHeartbeat: vi.fn(async () => true),
    revokeDevice: vi.fn(async () => false),
    getEntitlements: vi.fn(async () => ({ "tunnel.quick": true, "tunnel.named": false, "device.max_count": 1 })),
    listPlans: vi.fn(async () => []),
    getCurrentSubscription: vi.fn(async () => null),
    listOrders: vi.fn(async () => []),
    requestNamedTunnel: vi.fn(async () => { throw new Error("not used"); }),
    getNamedTunnelForDevice: vi.fn(async () => null),
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
      updatedAt: new Date().toISOString(),
      updatedByAdminId: "admin-1"
    })),
    createIssueReport: vi.fn(async () => ({
      id: "issue-1",
      source: "manual" as const,
      level: "P0_MANUAL" as const,
      category: "defect" as const,
      title: "Issue",
      description: "Description",
      userId: "user-1",
      deviceId: null,
      clientVersion: "1.0.0",
      platform: "darwin",
      arch: "arm64",
      osVersion: null,
      channel: "stable",
      fingerprint: null,
      status: "new" as const,
      assignee: null,
      linkedIncidentId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    })),
    listAdminIssueReports: vi.fn(async () => []),
    getAdminIssueReport: vi.fn(async () => null),
    updateIssueReport: vi.fn(async () => null),
    getAdminOverview: vi.fn(async () => ({})),
    grantFormalSubscription: vi.fn(async () => undefined),
    setUserStatus: vi.fn(async () => true),
    setDeviceStatus: vi.fn(async () => true),
    rebuildNamedTunnel: vi.fn(async () => true),
    close: vi.fn(async () => undefined),
    ...overrides
  };
}

describe("identifier normalization", () => {
  it("normalizes email and mainland phone identifiers", () => {
    expect(normalizeIdentifier("email", " User@Example.COM ")).toBe("user@example.com");
    expect(normalizeIdentifier("phone", "138 0013 8000")).toBe("+8613800138000");
  });

  it("rejects invalid values", () => {
    expect(() => normalizeIdentifier("email", "missing-at")).toThrow(ControlError);
    expect(() => normalizeIdentifier("phone", "123")).toThrow(ControlError);
  });
});

describe("ControlService", () => {
  it("sends and consumes an email verification code during registration", async () => {
    const store = mockStore();
    const notifier: VerificationNotifier = { send: vi.fn(async () => undefined) };
    const service = new ControlService(config(), store, notifier, null);

    const requested = await service.requestVerificationCode("email", "user@example.com");
    expect(requested.debugCode).toMatch(/^\d{6}$/);
    expect(notifier.send).toHaveBeenCalledWith(expect.objectContaining({
      type: "email",
      identifier: "user@example.com",
      code: requested.debugCode
    }));

    const registered = await service.register("email", "user@example.com", requested.debugCode!, "secure-password");
    expect(registered.user.id).toBe("user-1");
    expect(registered.accessToken).toMatch(/^cm_access_/);
    expect(registered.refreshToken).toMatch(/^cm_refresh_/);
    expect(store.createTokens).toHaveBeenCalledTimes(1);
  });

  it("rotates a refresh token atomically and rejects replay", async () => {
    const store = mockStore({
      rotateRefreshToken: vi.fn()
        .mockResolvedValueOnce("user-1")
        .mockResolvedValueOnce(null)
    });
    const service = new ControlService(config(), store, { send: vi.fn(async () => undefined) }, null);

    const refreshed = await service.refresh("cm_refresh_original-token");
    expect(refreshed.refreshToken).toMatch(/^cm_refresh_/);
    await expect(service.refresh("cm_refresh_original-token")).rejects.toMatchObject({
      code: "REFRESH_TOKEN_INVALID",
      statusCode: 401
    });
  });

  it("blocks Named Tunnel provisioning without the entitlement", async () => {
    const service = new ControlService(
      config(),
      mockStore(),
      { send: vi.fn(async () => undefined) },
      null
    );

    await expect(service.requestNamedTunnel("user-1", "device-1")).rejects.toMatchObject({
      code: "NAMED_TUNNEL_NOT_ENTITLED",
      statusCode: 403
    });
  });

  it("uses runtime system config for desktop config and Named Tunnel hostname", async () => {
    const store = mockStore({
      getSystemConfig: vi.fn(async () => ({
        publicApiBaseUrl: "https://codex-api.newroot.cn",
        desktopUpdateFeedUrl: "https://codex-api.newroot.cn/updates/stable",
        deviceDomain: "newroot.cn",
        managedDomainSuffixes: ["newroot.cn", "xmwefun.cn"],
        adminOrigins: ["https://codex-admin.newroot.cn"],
        desktopConfigTtlSeconds: 300,
        cloudflareZoneId: "zone-newroot-123456",
        updatedAt: "2026-07-31T00:00:00.000Z",
        updatedByAdminId: "admin-1"
      })),
      getEntitlements: vi.fn(async () => ({ "tunnel.named": true })),
      getDevice: vi.fn(async () => ({
        id: "device-1",
        deviceCode: "abc123",
        userId: "user-1",
        name: "Windows",
        os: "win32",
        arch: "x64",
        clientVersion: "1.0.6",
        codexCliVersion: null,
        originPort: 4310,
        status: "active" as const,
        lastSeenAt: null,
        createdAt: "2026-07-31T00:00:00.000Z"
      })),
      requestNamedTunnel: vi.fn(async (_userId, deviceId, hostname) => ({
        id: "tunnel-1",
        deviceId,
        cloudflareTunnelId: null,
        cloudflareZoneId: "zone-newroot-123456",
        hostname,
        status: "provisioning",
        lastErrorCode: null
      }))
    });
    const service = new ControlService(config(), store, { send: vi.fn(async () => undefined) }, null);

    await expect(service.getSystemConfig()).resolves.toMatchObject({
      publicApiBaseUrl: "https://codex-api.newroot.cn",
      deviceDomain: "newroot.cn"
    });
    await expect(service.requestNamedTunnel("user-1", "device-1")).resolves.toMatchObject({
      hostname: "d-abc123.newroot.cn"
    });
  });
});
