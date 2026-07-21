import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { Pool, PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { PgControlStore } from "./PgControlStore";

describe("PgControlStore", () => {
  it("keeps account, device, entitlement and tunnel state consistent", async () => {
    const database = new PGlite();
    const sql = await readFile(new URL("./migrations/001_initial.sql", import.meta.url), "utf8");
    await database.exec(sql);
    const store = new PgControlStore(createPglitePool(database));

    try {
      const user = await store.createUserWithIdentity({
        type: "email",
        identifier: "owner@example.com",
        passwordHash: "password-hash"
      });
      expect(await store.getEntitlements(user.id)).toMatchObject({
        "tunnel.quick": true,
        "tunnel.named": false,
        "device.max_count": 1
      });

      await store.createTokens([{
        subjectType: "user",
        subjectId: user.id,
        tokenType: "refresh",
        tokenHash: "refresh-old",
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      }]);
      expect(await store.rotateRefreshToken({
        currentTokenHash: "refresh-old",
        accessTokenHash: "access-next",
        accessExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        refreshTokenHash: "refresh-next",
        refreshExpiresAt: new Date(Date.now() + 120_000).toISOString()
      })).toBe(user.id);
      expect(await store.rotateRefreshToken({
        currentTokenHash: "refresh-old",
        accessTokenHash: "access-replay",
        accessExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        refreshTokenHash: "refresh-replay",
        refreshExpiresAt: new Date(Date.now() + 120_000).toISOString()
      })).toBeNull();

      const firstDevice = await store.createDevice({
        id: "device-1",
        deviceCode: "a83k2m",
        userId: user.id,
        name: "MacBook",
        os: "darwin",
        arch: "arm64",
        clientVersion: "1.0.0",
        codexCliVersion: null,
        originPort: 4310,
        credentialHash: "credential-hash-1"
      }, 1);
      expect(firstDevice?.id).toBe("device-1");
      await expect(store.createDevice({
        id: "device-2",
        deviceCode: "b83k2m",
        userId: user.id,
        name: "Second",
        os: "win32",
        arch: "x64",
        clientVersion: "1.0.0",
        codexCliVersion: null,
        originPort: 4310,
        credentialHash: "credential-hash-2"
      }, 1)).resolves.toBeNull();

      expect(await store.recordHeartbeat({
        deviceId: "device-1",
        clientVersion: "1.0.1",
        codexCliVersion: "codex-cli 1.0.0",
        originPort: 4311,
        tunnelStatus: "online",
        publicHostname: "quick-test.trycloudflare.com",
        errorCode: null
      })).toBe(true);

      await store.ensureAdmin({ id: "admin-1", email: "admin@example.com", passwordHash: "hash", role: "admin" });
      await store.grantFormalSubscription({
        adminId: "admin-1",
        userId: user.id,
        startsAt: new Date().toISOString(),
        expiresAt: null,
        reason: "integration test"
      });
      const tunnel = await store.requestNamedTunnel(user.id, "device-1", "d-a83k2m.xmwefun.cn");
      const claimed = await store.claimProvisioningJob();
      expect(claimed?.tunnel.id).toBe(tunnel.id);
      expect(await store.completeProvisioningJob(claimed!.id, tunnel.id, "cf-tunnel-1")).toBe(true);

      expect(await store.rebuildNamedTunnel({
        adminId: "admin-1",
        tunnelId: tunnel.id,
        reason: "rotate token"
      })).toBe(true);
      const rebuildRevocation = await store.claimProvisioningJob();
      expect(rebuildRevocation?.jobType).toBe("revoke_named_tunnel");
      await store.completeRevocationJob(rebuildRevocation!.id, tunnel.id);
      const rebuildProvision = await store.claimProvisioningJob();
      expect(rebuildProvision?.jobType).toBe("provision_named_tunnel");
      expect(await store.completeProvisioningJob(rebuildProvision!.id, tunnel.id, "cf-tunnel-2")).toBe(true);

      await store.setDeviceStatus({
        adminId: "admin-1",
        deviceId: "device-1",
        status: "blocked",
        reason: "integration test"
      });
      expect((await store.getDevice("device-1"))?.status).toBe("blocked");
      expect((await store.getNamedTunnelForDevice("device-1"))?.status).toBe("revoked");
      expect((await store.claimProvisioningJob())?.jobType).toBe("revoke_named_tunnel");
    } finally {
      await database.close();
    }
  }, 20_000);

  it("queues a Named Tunnel revocation when the entitlement expires", async () => {
    const database = new PGlite();
    const sql = await readFile(new URL("./migrations/001_initial.sql", import.meta.url), "utf8");
    await database.exec(sql);
    const store = new PgControlStore(createPglitePool(database));

    try {
      const user = await store.createUserWithIdentity({
        type: "email",
        identifier: "expiry@example.com",
        passwordHash: "hash"
      });
      await store.ensureAdmin({ id: "admin-expiry", email: "expiry-admin@example.com", passwordHash: "hash", role: "admin" });
      await store.grantFormalSubscription({
        adminId: "admin-expiry",
        userId: user.id,
        startsAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        reason: "expiry test"
      });
      await store.createDevice({
        id: "device-expiry",
        deviceCode: "expiry01",
        userId: user.id,
        name: "Expiry Device",
        os: "darwin",
        arch: "x64",
        clientVersion: "1.0.0",
        codexCliVersion: null,
        originPort: 4310,
        credentialHash: "expiry-credential"
      }, 5);
      const tunnel = await store.requestNamedTunnel(user.id, "device-expiry", "d-expiry01.xmwefun.cn");
      const provision = await store.claimProvisioningJob();
      await store.completeProvisioningJob(provision!.id, tunnel.id, "cf-expiry");

      await database.query(`
        UPDATE entitlements SET expires_at = now() - interval '1 second'
        WHERE user_id = $1 AND entitlement_key = 'tunnel.named' AND entitlement_value = 'true'::jsonb
      `, [user.id]);

      expect(await store.reconcileTunnelJobs()).toBeGreaterThan(0);
      expect((await store.getNamedTunnelForDevice("device-expiry"))?.status).toBe("revoked");
      expect((await store.claimProvisioningJob())?.jobType).toBe("revoke_named_tunnel");
    } finally {
      await database.close();
    }
  }, 20_000);
});

function createPglitePool(database: PGlite): Pool {
  const query = async (text: string, values?: unknown[]) => {
    const result = await database.query(text, values as never[] | undefined);
    return {
      ...result,
      rowCount: text.trimStart().toUpperCase().startsWith("SELECT")
        ? result.rows.length
        : (result.affectedRows ?? result.rows.length)
    };
  };
  const client = { query, release: () => undefined } as unknown as PoolClient;
  return {
    query,
    connect: async () => client,
    end: async () => undefined
  } as unknown as Pool;
}
