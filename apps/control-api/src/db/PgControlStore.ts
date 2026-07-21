import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { AuthTokenRecord, DeviceRecord, EntitlementMap, IdentityType, NamedTunnelRecord, SubjectType, TokenType, UserRecord } from "../domain";
import type { ControlStore, ProvisioningJob } from "../store";

export class PgControlStore implements ControlStore {
  constructor(private readonly pool: Pool) {}

  async close(): Promise<void> {
    await this.pool.end();
  }

  async saveVerification(input: { type: IdentityType; identifier: string; purpose: string; codeHash: string; expiresAt: string }): Promise<void> {
    await this.pool.query(`
      INSERT INTO verification_codes (id, identity_type, identifier, purpose, code_hash, expires_at)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [randomUUID(), input.type, input.identifier, input.purpose, input.codeHash, input.expiresAt]);
  }

  async consumeVerification(input: { type: IdentityType; identifier: string; purpose: string; codeHash: string }): Promise<boolean> {
    return this.transaction(async (client) => {
      const latest = await client.query(`
        SELECT id, code_hash, attempt_count
        FROM verification_codes
        WHERE identity_type = $1 AND identifier = $2 AND purpose = $3
          AND consumed_at IS NULL AND expires_at > now()
        ORDER BY created_at DESC LIMIT 1
        FOR UPDATE
      `, [input.type, input.identifier, input.purpose]);
      const row = latest.rows[0];
      if (!row || Number(row.attempt_count) >= 5) return false;

      if (row.code_hash !== input.codeHash) {
        await client.query(`
          UPDATE verification_codes
          SET attempt_count = attempt_count + 1,
            consumed_at = CASE WHEN attempt_count + 1 >= 5 THEN now() ELSE consumed_at END
          WHERE id = $1
        `, [row.id]);
        return false;
      }

      const result = await client.query(`
        UPDATE verification_codes SET consumed_at = now()
        WHERE id = $1 AND consumed_at IS NULL RETURNING id
      `, [row.id]);
      return result.rowCount === 1;
    });
  }

  async findUserByIdentity(type: IdentityType, identifier: string): Promise<UserRecord | null> {
    const result = await this.pool.query(`
      SELECT u.id, u.password_hash, u.status, u.created_at
      FROM users u
      JOIN user_identities i ON i.user_id = u.id
      WHERE i.identity_type = $1 AND i.identifier = $2
    `, [type, identifier]);
    return result.rows[0] ? mapUser(result.rows[0]) : null;
  }

  async createUserWithIdentity(input: { type: IdentityType; identifier: string; passwordHash: string }): Promise<UserRecord> {
    return this.transaction(async (client) => {
      const userId = randomUUID();
      const created = await client.query(`
        INSERT INTO users (id, password_hash) VALUES ($1, $2)
        RETURNING id, password_hash, status, created_at
      `, [userId, input.passwordHash]);
      await client.query(`
        INSERT INTO user_identities (id, user_id, identity_type, identifier, verified_at)
        VALUES ($1, $2, $3, $4, now())
      `, [randomUUID(), userId, input.type, input.identifier]);

      const subscriptionId = randomUUID();
      await client.query(`
        INSERT INTO subscriptions (id, user_id, plan_id, source, status, starts_at)
        VALUES ($1, $2, 'plan-free', 'promotion', 'active', now())
      `, [subscriptionId, userId]);
      await insertEntitlement(client, userId, subscriptionId, "tunnel.quick", true, null);
      await insertEntitlement(client, userId, subscriptionId, "tunnel.named", false, null);
      await insertEntitlement(client, userId, subscriptionId, "device.max_count", 1, null);

      return mapUser(created.rows[0]);
    });
  }

  async updateUserLastLogin(userId: string): Promise<void> {
    await this.pool.query("UPDATE users SET last_login_at = now(), updated_at = now() WHERE id = $1", [userId]);
  }

  async updateUserPasswordByIdentity(type: IdentityType, identifier: string, passwordHash: string): Promise<boolean> {
    return this.transaction(async (client) => {
      const result = await client.query(`
        UPDATE users SET password_hash = $3, updated_at = now()
        WHERE id = (
          SELECT user_id FROM user_identities WHERE identity_type = $1 AND identifier = $2
        ) RETURNING id
      `, [type, identifier, passwordHash]);
      const userId = result.rows[0]?.id;
      if (!userId) return false;
      await client.query(`
        UPDATE auth_tokens SET revoked_at = now()
        WHERE subject_type = 'user' AND subject_id = $1 AND revoked_at IS NULL
      `, [userId]);
      return true;
    });
  }

  async addUserIdentity(userId: string, type: IdentityType, identifier: string): Promise<boolean> {
    const result = await this.pool.query(`
      INSERT INTO user_identities (id, user_id, identity_type, identifier, verified_at)
      VALUES ($1,$2,$3,$4,now()) ON CONFLICT (identity_type, identifier) DO NOTHING
      RETURNING id
    `, [randomUUID(), userId, type, identifier]);
    return result.rowCount === 1;
  }

  async removeUserIdentity(userId: string, type: IdentityType, identifier: string): Promise<"removed" | "not_found" | "last_identity"> {
    return this.transaction(async (client) => {
      await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [userId]);
      const count = await client.query("SELECT count(*)::int AS count FROM user_identities WHERE user_id = $1", [userId]);
      const existing = await client.query(`
        SELECT id FROM user_identities
        WHERE user_id = $1 AND identity_type = $2 AND identifier = $3
      `, [userId, type, identifier]);
      if (existing.rowCount !== 1) return "not_found";
      if (Number(count.rows[0]?.count ?? 0) <= 1) return "last_identity";
      await client.query("DELETE FROM user_identities WHERE id = $1", [existing.rows[0].id]);
      return "removed";
    });
  }

  async listUserIdentities(userId: string): Promise<Array<{ type: IdentityType; identifier: string; verifiedAt: string }>> {
    const result = await this.pool.query(`
      SELECT identity_type, identifier, verified_at FROM user_identities
      WHERE user_id = $1 ORDER BY created_at ASC
    `, [userId]);
    return result.rows.map((row) => ({
      type: row.identity_type,
      identifier: row.identifier,
      verifiedAt: new Date(row.verified_at).toISOString()
    }));
  }

  async createToken(input: { subjectType: SubjectType; subjectId: string; tokenType: TokenType; tokenHash: string; expiresAt: string }): Promise<void> {
    await this.pool.query(`
      INSERT INTO auth_tokens (id, subject_type, subject_id, token_type, token_hash, expires_at)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [randomUUID(), input.subjectType, input.subjectId, input.tokenType, input.tokenHash, input.expiresAt]);
  }

  async createTokens(inputs: Array<{ subjectType: SubjectType; subjectId: string; tokenType: TokenType; tokenHash: string; expiresAt: string }>): Promise<void> {
    await this.transaction(async (client) => {
      for (const input of inputs) {
        await client.query(`
          INSERT INTO auth_tokens (id, subject_type, subject_id, token_type, token_hash, expires_at)
          VALUES ($1, $2, $3, $4, $5, $6)
        `, [randomUUID(), input.subjectType, input.subjectId, input.tokenType, input.tokenHash, input.expiresAt]);
      }
    });
  }

  async rotateRefreshToken(input: {
    currentTokenHash: string;
    accessTokenHash: string;
    accessExpiresAt: string;
    refreshTokenHash: string;
    refreshExpiresAt: string;
  }): Promise<string | null> {
    return this.transaction(async (client) => {
      const current = await client.query(`
        SELECT t.subject_id
        FROM auth_tokens t
        JOIN users u ON u.id = t.subject_id
        WHERE t.token_hash = $1 AND t.token_type = 'refresh'
          AND t.subject_type = 'user' AND t.revoked_at IS NULL
          AND t.expires_at > now() AND u.status = 'active'
        FOR UPDATE OF t
      `, [input.currentTokenHash]);
      const userId = current.rows[0]?.subject_id as string | undefined;
      if (!userId) return null;

      const revoked = await client.query(`
        UPDATE auth_tokens SET revoked_at = now()
        WHERE token_hash = $1 AND revoked_at IS NULL
        RETURNING id
      `, [input.currentTokenHash]);
      if (revoked.rowCount !== 1) return null;

      await client.query(`
        INSERT INTO auth_tokens (id, subject_type, subject_id, token_type, token_hash, expires_at)
        VALUES
          ($1, 'user', $2, 'access', $3, $4),
          ($5, 'user', $2, 'refresh', $6, $7)
      `, [
        randomUUID(), userId, input.accessTokenHash, input.accessExpiresAt,
        randomUUID(), input.refreshTokenHash, input.refreshExpiresAt
      ]);
      return userId;
    });
  }

  async findToken(tokenHash: string, tokenType: TokenType): Promise<AuthTokenRecord | null> {
    const result = await this.pool.query(`
      SELECT id, subject_type, subject_id, token_type, expires_at
      FROM auth_tokens
      WHERE token_hash = $1 AND token_type = $2 AND revoked_at IS NULL AND expires_at > now()
    `, [tokenHash, tokenType]);
    const row = result.rows[0];
    return row ? {
      id: row.id,
      subjectType: row.subject_type,
      subjectId: row.subject_id,
      tokenType: row.token_type,
      expiresAt: new Date(row.expires_at).toISOString()
    } : null;
  }

  async revokeToken(tokenHash: string): Promise<void> {
    await this.pool.query("UPDATE auth_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL", [tokenHash]);
  }

  async revokeSubjectTokens(subjectType: SubjectType, subjectId: string): Promise<void> {
    await this.pool.query(`
      UPDATE auth_tokens SET revoked_at = now()
      WHERE subject_type = $1 AND subject_id = $2 AND revoked_at IS NULL
    `, [subjectType, subjectId]);
  }

  async countActiveDevices(userId: string): Promise<number> {
    const result = await this.pool.query("SELECT count(*)::int AS count FROM devices WHERE user_id = $1 AND status = 'active'", [userId]);
    return result.rows[0]?.count ?? 0;
  }

  async createDevice(
    input: Omit<DeviceRecord, "createdAt" | "lastSeenAt" | "status"> & { credentialHash: string },
    maxActiveDevices: number
  ): Promise<DeviceRecord | null> {
    return this.transaction(async (client) => {
      // Serialize registrations per user so concurrent clients cannot exceed
      // the entitlement limit between a count and an insert.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [input.userId]);
      const count = await client.query(`
        SELECT count(*)::int AS count FROM devices
        WHERE user_id = $1 AND status = 'active'
      `, [input.userId]);
      if (Number(count.rows[0]?.count ?? 0) >= maxActiveDevices) return null;

      const result = await client.query(`
        INSERT INTO devices (
          id, device_code, user_id, name, os, arch, client_version, codex_cli_version, origin_port
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        RETURNING *
      `, [
        input.id,
        input.deviceCode,
        input.userId,
        input.name,
        input.os,
        input.arch,
        input.clientVersion,
        input.codexCliVersion,
        input.originPort
      ]);
      await client.query(`
        INSERT INTO device_credentials (id, device_id, credential_hash) VALUES ($1, $2, $3)
      `, [randomUUID(), input.id, input.credentialHash]);
      return mapDevice(result.rows[0]);
    });
  }

  async findDeviceByCredential(credentialHash: string): Promise<DeviceRecord | null> {
    const result = await this.pool.query(`
      SELECT d.* FROM devices d
      JOIN device_credentials c ON c.device_id = d.id
      WHERE c.credential_hash = $1 AND c.revoked_at IS NULL AND d.status = 'active'
    `, [credentialHash]);
    return result.rows[0] ? mapDevice(result.rows[0]) : null;
  }

  async getDevice(deviceId: string): Promise<DeviceRecord | null> {
    const result = await this.pool.query("SELECT * FROM devices WHERE id = $1", [deviceId]);
    return result.rows[0] ? mapDevice(result.rows[0]) : null;
  }

  async listDevices(userId: string): Promise<DeviceRecord[]> {
    const result = await this.pool.query("SELECT * FROM devices WHERE user_id = $1 ORDER BY created_at DESC", [userId]);
    return result.rows.map(mapDevice);
  }

  async updateDeviceName(userId: string, deviceId: string, name: string): Promise<DeviceRecord | null> {
    const result = await this.pool.query(`
      UPDATE devices SET name = $3, updated_at = now()
      WHERE id = $1 AND user_id = $2 RETURNING *
    `, [deviceId, userId, name]);
    return result.rows[0] ? mapDevice(result.rows[0]) : null;
  }

  async recordHeartbeat(input: { deviceId: string; clientVersion: string; codexCliVersion: string | null; originPort: number; tunnelStatus: string; publicHostname: string | null; errorCode: string | null }): Promise<boolean> {
    return this.transaction(async (client) => {
      const current = await client.query(`
        SELECT origin_port FROM devices WHERE id = $1 AND status = 'active' FOR UPDATE
      `, [input.deviceId]);
      if (current.rowCount !== 1) return false;
      const originPortChanged = Number(current.rows[0].origin_port) !== input.originPort;

      await client.query(`
        UPDATE devices SET client_version = $2, codex_cli_version = $3, origin_port = $4,
          last_seen_at = now(), updated_at = now()
        WHERE id = $1 AND status = 'active'
      `, [input.deviceId, input.clientVersion, input.codexCliVersion, input.originPort]);
      await client.query(`
        INSERT INTO device_heartbeats (
          id, device_id, client_version, tunnel_status, public_hostname, error_code
        ) VALUES ($1,$2,$3,$4,$5,$6)
      `, [randomUUID(), input.deviceId, input.clientVersion, input.tunnelStatus, input.publicHostname, input.errorCode]);
      if (input.publicHostname) {
        await client.query(`
          UPDATE domains SET status = 'released', released_at = now(), updated_at = now()
          WHERE device_id = $1 AND domain_type = 'quick_tunnel' AND status = 'active' AND hostname <> $2
        `, [input.deviceId, input.publicHostname]);
        await client.query(`
          INSERT INTO domains (id, device_id, hostname, domain_type, status)
          VALUES ($1,$2,$3,'quick_tunnel','active')
          ON CONFLICT DO NOTHING
        `, [randomUUID(), input.deviceId, input.publicHostname]);
      }
      if (originPortChanged) {
        const tunnels = await client.query(`
          UPDATE tunnels SET status = 'provisioning', updated_at = now()
          WHERE device_id = $1 AND mode = 'named' AND status = 'active'
          RETURNING id
        `, [input.deviceId]);
        for (const tunnel of tunnels.rows) {
          await client.query(`
            INSERT INTO provisioning_jobs (id, device_id, tunnel_id, job_type, status)
            SELECT $1,$2,$3,'provision_named_tunnel','queued'
            WHERE NOT EXISTS (
              SELECT 1 FROM provisioning_jobs
              WHERE tunnel_id = $3 AND job_type = 'provision_named_tunnel'
                AND status IN ('queued','retry','running')
            )
          `, [randomUUID(), input.deviceId, tunnel.id]);
        }
      }
      return true;
    });
  }

  async revokeDevice(userId: string, deviceId: string): Promise<boolean> {
    return this.transaction(async (client) => {
      const result = await client.query(`
        UPDATE devices SET status = 'revoked', updated_at = now()
        WHERE id = $1 AND user_id = $2 AND status = 'active' RETURNING id
      `, [deviceId, userId]);
      if (result.rowCount !== 1) return false;
      await client.query("UPDATE device_credentials SET revoked_at = now() WHERE device_id = $1 AND revoked_at IS NULL", [deviceId]);
      await client.query("UPDATE auth_tokens SET revoked_at = now() WHERE subject_type = 'device' AND subject_id = $1 AND revoked_at IS NULL", [deviceId]);
      const tunnels = await client.query(`
        UPDATE tunnels SET status = 'revoked', updated_at = now()
        WHERE device_id = $1 AND status NOT IN ('revoked', 'deleted') RETURNING id
      `, [deviceId]);
      await client.query("UPDATE domains SET status = 'released', released_at = now(), updated_at = now() WHERE device_id = $1 AND status = 'active'", [deviceId]);
      for (const tunnel of tunnels.rows) {
        await client.query(`
          INSERT INTO provisioning_jobs (id, device_id, tunnel_id, job_type, status)
          VALUES ($1,$2,$3,'revoke_named_tunnel','queued')
        `, [randomUUID(), deviceId, tunnel.id]);
      }
      return true;
    });
  }

  async getEntitlements(userId: string): Promise<EntitlementMap> {
    const result = await this.pool.query(`
      SELECT DISTINCT ON (entitlement_key) entitlement_key, entitlement_value
      FROM entitlements
      WHERE user_id = $1 AND starts_at <= now() AND (expires_at IS NULL OR expires_at > now())
      ORDER BY entitlement_key, starts_at DESC, created_at DESC
    `, [userId]);
    return Object.fromEntries(result.rows.map((row) => [row.entitlement_key, row.entitlement_value]));
  }

  async listPlans(): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(`
      SELECT id, code, name, description, price_cents, currency, billing_period, status
      FROM plans WHERE status = 'active' ORDER BY price_cents ASC
    `);
    return result.rows;
  }

  async getCurrentSubscription(userId: string): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(`
      SELECT s.id, s.status, s.starts_at, s.expires_at, p.code AS plan_code,
        p.name AS plan_name, p.description
      FROM subscriptions s JOIN plans p ON p.id = s.plan_id
      WHERE s.user_id = $1 AND s.status = 'active' AND s.starts_at <= now()
        AND (s.expires_at IS NULL OR s.expires_at > now())
      ORDER BY CASE WHEN p.code = 'formal' THEN 0 ELSE 1 END, s.starts_at DESC
      LIMIT 1
    `, [userId]);
    return result.rows[0] ?? null;
  }

  async listOrders(userId: string): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(`
      SELECT id, order_no, plan_id, amount_cents, currency, status, created_at, paid_at, closed_at
      FROM orders WHERE user_id = $1 ORDER BY created_at DESC
    `, [userId]);
    return result.rows;
  }

  async requestNamedTunnel(userId: string, deviceId: string, hostname: string): Promise<NamedTunnelRecord> {
    return this.transaction(async (client) => {
      const owned = await client.query("SELECT id FROM devices WHERE id = $1 AND user_id = $2 AND status = 'active'", [deviceId, userId]);
      if (owned.rowCount !== 1) throw new Error("DEVICE_NOT_FOUND");
      const existing = await client.query(`
        SELECT * FROM tunnels WHERE device_id = $1 AND status NOT IN ('revoked','deleted') LIMIT 1
      `, [deviceId]);
      if (existing.rows[0]) return mapTunnel(existing.rows[0]);

      const tunnelId = randomUUID();
      const created = await client.query(`
        INSERT INTO tunnels (id, device_id, mode, hostname, status)
        VALUES ($1,$2,'named',$3,'provisioning') RETURNING *
      `, [tunnelId, deviceId, hostname]);
      await client.query(`
        INSERT INTO domains (id, device_id, tunnel_id, hostname, domain_type, status)
        VALUES ($1,$2,$3,$4,'managed_subdomain','reserved')
      `, [randomUUID(), deviceId, tunnelId, hostname]);
      await client.query(`
        INSERT INTO provisioning_jobs (id, device_id, tunnel_id, job_type, status)
        VALUES ($1,$2,$3,'provision_named_tunnel','queued')
      `, [randomUUID(), deviceId, tunnelId]);
      return mapTunnel(created.rows[0]);
    });
  }

  async getNamedTunnelForDevice(deviceId: string): Promise<NamedTunnelRecord | null> {
    const result = await this.pool.query(`
      SELECT * FROM tunnels WHERE device_id = $1 AND mode = 'named'
      ORDER BY created_at DESC LIMIT 1
    `, [deviceId]);
    return result.rows[0] ? mapTunnel(result.rows[0]) : null;
  }

  async claimProvisioningJob(): Promise<ProvisioningJob | null> {
    return this.transaction(async (client) => {
      const result = await client.query(`
        SELECT j.id AS job_id, j.job_type, t.*, d.id AS device_id_value, d.device_code,
          d.user_id, d.name AS device_name, d.os, d.arch, d.client_version,
          d.codex_cli_version, d.origin_port, d.status AS device_status,
          d.last_seen_at, d.created_at AS device_created_at
        FROM provisioning_jobs j
        JOIN tunnels t ON t.id = j.tunnel_id
        JOIN devices d ON d.id = j.device_id
        WHERE (
          (j.status IN ('queued','retry') AND j.next_attempt_at <= now())
          OR (j.status = 'running' AND j.locked_at < now() - interval '5 minutes')
        )
          AND (j.job_type = 'revoke_named_tunnel' OR d.status = 'active')
        ORDER BY j.created_at ASC
        FOR UPDATE OF j SKIP LOCKED
        LIMIT 1
      `);
      const row = result.rows[0];
      if (!row) return null;
      await client.query(`
        UPDATE provisioning_jobs SET status = 'running', locked_at = now(), attempt_count = attempt_count + 1,
          updated_at = now() WHERE id = $1
      `, [row.job_id]);
      return {
        id: row.job_id,
        jobType: row.job_type,
        device: {
          id: row.device_id_value,
          deviceCode: row.device_code,
          userId: row.user_id,
          name: row.device_name,
          os: row.os,
          arch: row.arch,
          clientVersion: row.client_version,
          codexCliVersion: row.codex_cli_version,
          originPort: row.origin_port,
          status: row.device_status,
          lastSeenAt: row.last_seen_at ? new Date(row.last_seen_at).toISOString() : null,
          createdAt: new Date(row.device_created_at).toISOString()
        },
        tunnel: mapTunnel(row)
      };
    });
  }

  async completeProvisioningJob(jobId: string, tunnelId: string, cloudflareTunnelId: string): Promise<boolean> {
    return this.transaction(async (client) => {
      const updated = await client.query(`
        UPDATE tunnels SET cloudflare_tunnel_id = $2, status = 'active', last_error_code = NULL, updated_at = now()
        WHERE id = $1 AND status = 'provisioning'
          AND EXISTS (SELECT 1 FROM devices WHERE id = tunnels.device_id AND status = 'active')
          AND EXISTS (SELECT 1 FROM provisioning_jobs WHERE id = $3 AND status = 'running')
        RETURNING id
      `, [tunnelId, cloudflareTunnelId, jobId]);
      if (updated.rowCount !== 1) return false;
      await client.query("UPDATE domains SET status = 'active', updated_at = now() WHERE tunnel_id = $1", [tunnelId]);
      await client.query("UPDATE provisioning_jobs SET status = 'succeeded', updated_at = now() WHERE id = $1", [jobId]);
      return true;
    });
  }

  async convertProvisioningJobToRevocation(
    jobId: string,
    tunnelId: string,
    cloudflareTunnelId: string,
    errorCode: string,
    message: string
  ): Promise<void> {
    await this.transaction(async (client) => {
      await client.query(`
        UPDATE tunnels SET cloudflare_tunnel_id = $2, status = 'revoked',
          last_error_code = $3, updated_at = now() WHERE id = $1
      `, [tunnelId, cloudflareTunnelId, errorCode]);
      await client.query(`
        UPDATE provisioning_jobs SET job_type = 'revoke_named_tunnel', status = 'retry',
          next_attempt_at = now() + interval '10 seconds', last_error_code = $2,
          last_error_message = $3, updated_at = now() WHERE id = $1
      `, [jobId, errorCode, message.slice(0, 1000)]);
    });
  }

  async retryProvisioningJob(jobId: string, tunnelId: string, errorCode: string, message: string): Promise<void> {
    await this.transaction(async (client) => {
      const result = await client.query("SELECT attempt_count, job_type, status FROM provisioning_jobs WHERE id = $1 FOR UPDATE", [jobId]);
      if (result.rows[0]?.status !== "running") return;
      const attempts = Number(result.rows[0]?.attempt_count ?? 1);
      const isRevocation = result.rows[0]?.job_type === "revoke_named_tunnel";
      const exhausted = attempts >= 5;
      const delaySeconds = Math.min(300, 2 ** attempts * 5);
      await client.query(`
        UPDATE provisioning_jobs SET status = $2, next_attempt_at = now() + ($3 * interval '1 second'),
          last_error_code = $4, last_error_message = $5, updated_at = now()
        WHERE id = $1
      `, [jobId, exhausted ? "failed" : "retry", delaySeconds, errorCode, message.slice(0, 1000)]);
      await client.query(`
        UPDATE tunnels SET status = $2, last_error_code = $3, updated_at = now() WHERE id = $1
      `, [tunnelId, isRevocation ? "revoked" : (exhausted ? "failed" : "provisioning"), errorCode]);
    });
  }

  async completeRevocationJob(jobId: string, tunnelId: string): Promise<void> {
    await this.transaction(async (client) => {
      const job = await client.query("SELECT job_type FROM provisioning_jobs WHERE id = $1 FOR UPDATE", [jobId]);
      if (job.rows[0]?.job_type !== "revoke_named_tunnel") {
        const tunnel = await client.query("SELECT status FROM tunnels WHERE id = $1 FOR UPDATE", [tunnelId]);
        if (tunnel.rows[0]?.status === "revoked") {
          await client.query("UPDATE tunnels SET status = 'deleted', updated_at = now() WHERE id = $1", [tunnelId]);
        }
        await client.query("UPDATE provisioning_jobs SET status = 'succeeded', updated_at = now() WHERE id = $1", [jobId]);
        return;
      }
      const rebuild = job.rows[0]?.job_type === "revoke_named_tunnel"
        ? await client.query(`
          SELECT j.id
          FROM provisioning_jobs j
          JOIN tunnels t ON t.id = j.tunnel_id
          JOIN devices d ON d.id = t.device_id
          WHERE j.tunnel_id = $1 AND j.job_type = 'provision_named_tunnel' AND j.status = 'blocked'
            AND d.status = 'active'
            AND EXISTS (
              SELECT 1 FROM entitlements e
              WHERE e.user_id = d.user_id AND e.entitlement_key = 'tunnel.named'
                AND e.entitlement_value = 'true'::jsonb AND e.starts_at <= now()
                AND (e.expires_at IS NULL OR e.expires_at > now())
            )
          ORDER BY j.created_at ASC LIMIT 1
          FOR UPDATE OF j
        `, [tunnelId])
        : { rows: [] };

      if (rebuild.rows[0]) {
        await client.query(`
          UPDATE tunnels SET cloudflare_tunnel_id = NULL, status = 'provisioning',
            last_error_code = NULL, updated_at = now() WHERE id = $1
        `, [tunnelId]);
        await client.query(`
          UPDATE domains SET status = 'reserved', released_at = NULL, updated_at = now()
          WHERE tunnel_id = $1
        `, [tunnelId]);
        await client.query(`
          UPDATE provisioning_jobs SET status = 'queued', next_attempt_at = now(),
            locked_at = NULL, updated_at = now() WHERE id = $1
        `, [rebuild.rows[0].id]);
      } else {
        await client.query("UPDATE tunnels SET status = 'deleted', updated_at = now() WHERE id = $1", [tunnelId]);
        await client.query(`
          UPDATE provisioning_jobs SET status = 'failed', last_error_code = 'REBUILD_CANCELLED',
            last_error_message = 'Device or entitlement is no longer active', updated_at = now()
          WHERE tunnel_id = $1 AND job_type = 'provision_named_tunnel' AND status = 'blocked'
        `, [tunnelId]);
      }
      await client.query("UPDATE provisioning_jobs SET status = 'succeeded', updated_at = now() WHERE id = $1", [jobId]);
    });
  }

  async reconcileTunnelJobs(): Promise<number> {
    return this.transaction(async (client) => {
      let queued = 0;
      const expired = await client.query(`
        UPDATE tunnels t SET status = 'revoked', updated_at = now(), last_error_code = 'ENTITLEMENT_EXPIRED'
        FROM devices d
        WHERE t.device_id = d.id AND t.mode = 'named' AND t.status NOT IN ('revoked','deleted')
          AND NOT EXISTS (
            SELECT 1 FROM entitlements e
            WHERE e.user_id = d.user_id AND e.entitlement_key = 'tunnel.named'
              AND e.entitlement_value = 'true'::jsonb AND e.starts_at <= now()
              AND (e.expires_at IS NULL OR e.expires_at > now())
          )
        RETURNING t.id, t.device_id
      `);
      for (const tunnel of expired.rows) {
        await client.query(`
          UPDATE domains SET status = 'released', released_at = now(), updated_at = now()
          WHERE tunnel_id = $1 AND status IN ('active','reserved')
        `, [tunnel.id]);
      }

      const missingProvision = await client.query(`
        SELECT t.id, t.device_id FROM tunnels t
        JOIN devices d ON d.id = t.device_id
        WHERE t.mode = 'named' AND t.status = 'provisioning' AND d.status = 'active'
          AND EXISTS (
            SELECT 1 FROM entitlements e
            WHERE e.user_id = d.user_id AND e.entitlement_key = 'tunnel.named'
              AND e.entitlement_value = 'true'::jsonb AND e.starts_at <= now()
              AND (e.expires_at IS NULL OR e.expires_at > now())
          )
          AND NOT EXISTS (
            SELECT 1 FROM provisioning_jobs j WHERE j.tunnel_id = t.id
              AND j.job_type = 'provision_named_tunnel' AND j.status IN ('queued','retry','running','blocked')
          )
      `);
      for (const tunnel of missingProvision.rows) {
        await client.query(`
          INSERT INTO provisioning_jobs (id, device_id, tunnel_id, job_type, status)
          VALUES ($1,$2,$3,'provision_named_tunnel','queued')
        `, [randomUUID(), tunnel.device_id, tunnel.id]);
        queued += 1;
      }

      const missingRevocation = await client.query(`
        SELECT t.id, t.device_id FROM tunnels t
        WHERE t.mode = 'named' AND t.status = 'revoked'
          AND NOT EXISTS (
            SELECT 1 FROM provisioning_jobs j WHERE j.tunnel_id = t.id
              AND j.job_type = 'revoke_named_tunnel' AND j.status IN ('queued','retry','running')
          )
      `);
      for (const tunnel of missingRevocation.rows) {
        await client.query(`
          INSERT INTO provisioning_jobs (id, device_id, tunnel_id, job_type, status)
          VALUES ($1,$2,$3,'revoke_named_tunnel','queued')
        `, [randomUUID(), tunnel.device_id, tunnel.id]);
        queued += 1;
      }
      return queued;
    });
  }

  async findAdminByEmail(email: string): Promise<{ id: string; passwordHash: string; role: string; status: string } | null> {
    const result = await this.pool.query("SELECT id, password_hash, role, status FROM admin_users WHERE email = $1", [email]);
    const row = result.rows[0];
    return row ? { id: row.id, passwordHash: row.password_hash, role: row.role, status: row.status } : null;
  }

  async findAdminById(adminId: string): Promise<{ id: string; role: string; status: string } | null> {
    const result = await this.pool.query("SELECT id, role, status FROM admin_users WHERE id = $1", [adminId]);
    const row = result.rows[0];
    return row ? { id: row.id, role: row.role, status: row.status } : null;
  }

  async updateAdminLastLogin(adminId: string): Promise<void> {
    await this.pool.query("UPDATE admin_users SET last_login_at = now() WHERE id = $1", [adminId]);
  }

  async ensureAdmin(input: { id: string; email: string; passwordHash: string; role: string }): Promise<void> {
    await this.pool.query(`
      INSERT INTO admin_users (id, email, password_hash, role)
      VALUES ($1,$2,$3,$4) ON CONFLICT (email) DO NOTHING
    `, [input.id, input.email, input.passwordHash, input.role]);
  }

  async listAdminUsers(): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(`
      SELECT u.id, u.status, u.created_at, u.last_login_at,
        json_agg(json_build_object('type', i.identity_type, 'identifier', i.identifier)) AS identities
      FROM users u LEFT JOIN user_identities i ON i.user_id = u.id
      GROUP BY u.id ORDER BY u.created_at DESC LIMIT 500
    `);
    return result.rows.map((row) => ({
      ...row,
      identities: Array.isArray(row.identities)
        ? row.identities
          .filter((identity: unknown) => identity && typeof identity === "object" && (identity as { type?: unknown }).type)
          .map((identity: { type: IdentityType; identifier: string }) => ({
            ...identity,
            identifier: maskIdentifier(identity.type, identity.identifier)
          }))
        : []
    }));
  }

  async listAdminDevices(): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(`
      SELECT d.*, t.hostname, t.status AS tunnel_status, t.mode AS tunnel_mode
      FROM devices d LEFT JOIN tunnels t ON t.device_id = d.id AND t.status NOT IN ('revoked','deleted')
      ORDER BY d.created_at DESC LIMIT 500
    `);
    return result.rows;
  }

  async listAdminTunnels(): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(`
      SELECT t.*, d.device_code, d.user_id FROM tunnels t
      JOIN devices d ON d.id = t.device_id ORDER BY t.created_at DESC LIMIT 500
    `);
    return result.rows;
  }

  async listAdminDomains(): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(`
      SELECT dm.*, d.device_code, d.user_id
      FROM domains dm JOIN devices d ON d.id = dm.device_id
      ORDER BY dm.created_at DESC LIMIT 500
    `);
    return result.rows;
  }

  async listAdminSubscriptions(): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(`
      SELECT s.*, p.code AS plan_code, p.name AS plan_name
      FROM subscriptions s JOIN plans p ON p.id = s.plan_id
      ORDER BY s.created_at DESC LIMIT 500
    `);
    return result.rows;
  }

  async listAdminOrders(): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(`
      SELECT o.*, p.code AS plan_code, p.name AS plan_name
      FROM orders o JOIN plans p ON p.id = o.plan_id
      ORDER BY o.created_at DESC LIMIT 500
    `);
    return result.rows;
  }

  async listAdminPayments(): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(`
      SELECT p.*, o.order_no, o.user_id
      FROM payments p JOIN orders o ON o.id = p.order_id
      ORDER BY p.created_at DESC LIMIT 500
    `);
    return result.rows;
  }

  async listAdminAuditLogs(): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(`
      SELECT a.id, a.action, a.target_type, a.target_id, a.summary, a.created_at,
        ad.email AS admin_email
      FROM audit_logs a LEFT JOIN admin_users ad ON ad.id = a.admin_user_id
      ORDER BY a.created_at DESC LIMIT 500
    `);
    return result.rows.map((row) => ({
      ...row,
      admin_email: row.admin_email ? maskIdentifier("email", String(row.admin_email)) : null
    }));
  }

  async getAdminOverview(): Promise<Record<string, number>> {
    const result = await this.pool.query(`
      SELECT
        (SELECT count(*) FROM users)::int AS users,
        (SELECT count(DISTINCT user_id) FROM user_identities WHERE identity_type = 'email')::int AS email_users,
        (SELECT count(DISTINCT user_id) FROM user_identities WHERE identity_type = 'phone')::int AS phone_users,
        (SELECT count(*) FROM users WHERE created_at >= date_trunc('day', now()))::int AS users_today,
        (SELECT count(*) FROM devices)::int AS devices,
        (SELECT count(*) FROM devices WHERE last_seen_at > now() - interval '3 minutes')::int AS online_devices,
        (SELECT count(*) FROM tunnels WHERE status = 'active')::int AS active_tunnels,
        (SELECT count(*) FROM domains WHERE domain_type = 'quick_tunnel' AND status = 'active')::int AS quick_tunnels,
        (SELECT count(*) FROM tunnels WHERE mode = 'named' AND status = 'active')::int AS named_tunnels,
        (SELECT count(*) FROM domains WHERE status = 'active')::int AS active_domains,
        (SELECT count(*) FROM domains WHERE domain_type = 'managed_subdomain' AND status = 'active')::int AS fixed_domains,
        (SELECT count(DISTINCT user_id) FROM entitlements
          WHERE entitlement_key = 'tunnel.named' AND entitlement_value = 'true'::jsonb
            AND starts_at <= now() AND (expires_at IS NULL OR expires_at > now()))::int AS formal_users
    `);
    return result.rows[0];
  }

  async grantFormalSubscription(input: { adminId: string; userId: string; startsAt: string; expiresAt: string | null; reason: string }): Promise<void> {
    await this.transaction(async (client) => {
      const subscriptionId = randomUUID();
      await client.query(`
        INSERT INTO subscriptions (id, user_id, plan_id, source, status, starts_at, expires_at)
        VALUES ($1,$2,'plan-formal','manual','active',$3,$4)
      `, [subscriptionId, input.userId, input.startsAt, input.expiresAt]);
      await insertEntitlement(client, input.userId, subscriptionId, "tunnel.quick", true, input.expiresAt);
      await insertEntitlement(client, input.userId, subscriptionId, "tunnel.named", true, input.expiresAt);
      await insertEntitlement(client, input.userId, subscriptionId, "device.max_count", 5, input.expiresAt);
      await client.query(`
        INSERT INTO audit_logs (id, admin_user_id, action, target_type, target_id, summary)
        VALUES ($1,$2,'subscription.grant','user',$3,$4::jsonb)
      `, [randomUUID(), input.adminId, input.userId, JSON.stringify({ reason: input.reason, expiresAt: input.expiresAt })]);
    });
  }

  async setUserStatus(input: { adminId: string; userId: string; status: "active" | "blocked"; reason: string }): Promise<boolean> {
    return this.transaction(async (client) => {
      const result = await client.query("UPDATE users SET status = $2, updated_at = now() WHERE id = $1 RETURNING id", [input.userId, input.status]);
      if (result.rowCount !== 1) return false;
      if (input.status === "blocked") {
        await client.query("UPDATE auth_tokens SET revoked_at = now() WHERE subject_type = 'user' AND subject_id = $1 AND revoked_at IS NULL", [input.userId]);
        const devices = await client.query("SELECT id FROM devices WHERE user_id = $1 AND status = 'active'", [input.userId]);
        for (const device of devices.rows) {
          await blockDeviceResources(client, device.id);
        }
      }
      await insertAudit(client, input.adminId, "user.status.update", "user", input.userId, {
        status: input.status,
        reason: input.reason
      });
      return true;
    });
  }

  async setDeviceStatus(input: { adminId: string; deviceId: string; status: "active" | "blocked"; reason: string }): Promise<boolean> {
    return this.transaction(async (client) => {
      const result = await client.query("UPDATE devices SET status = $2, updated_at = now() WHERE id = $1 RETURNING id", [input.deviceId, input.status]);
      if (result.rowCount !== 1) return false;
      if (input.status === "blocked") await blockDeviceResources(client, input.deviceId);
      else {
        await client.query(`
          UPDATE device_credentials SET revoked_at = NULL
          WHERE id = (
            SELECT id FROM device_credentials WHERE device_id = $1 ORDER BY created_at DESC LIMIT 1
          )
        `, [input.deviceId]);
      }
      await insertAudit(client, input.adminId, "device.status.update", "device", input.deviceId, {
        status: input.status,
        reason: input.reason
      });
      return true;
    });
  }

  async rebuildNamedTunnel(input: { adminId: string; tunnelId: string; reason: string }): Promise<boolean> {
    return this.transaction(async (client) => {
      const current = await client.query(`
        SELECT t.id, t.device_id, t.status, d.status AS device_status
        FROM tunnels t JOIN devices d ON d.id = t.device_id
        WHERE t.id = $1 AND t.mode = 'named'
        FOR UPDATE OF t
      `, [input.tunnelId]);
      const tunnel = current.rows[0];
      if (!tunnel || tunnel.status === "deleted" || tunnel.device_status !== "active") return false;

      await client.query(`
        UPDATE tunnels SET status = 'revoked', updated_at = now(), last_error_code = 'ADMIN_REBUILD'
        WHERE id = $1
      `, [input.tunnelId]);
      await client.query(`
        UPDATE domains SET status = 'released', released_at = now(), updated_at = now()
        WHERE tunnel_id = $1 AND status IN ('active','reserved')
      `, [input.tunnelId]);
      await client.query(`
        UPDATE provisioning_jobs SET status = 'failed', last_error_code = 'ADMIN_REBUILD',
          last_error_message = 'Superseded by an administrator rebuild', updated_at = now()
        WHERE tunnel_id = $1 AND job_type = 'provision_named_tunnel'
          AND status IN ('queued','retry','running')
      `, [input.tunnelId]);
      await client.query(`
        INSERT INTO provisioning_jobs (id, device_id, tunnel_id, job_type, status)
        SELECT $1,$2,$3,'revoke_named_tunnel','queued'
        WHERE NOT EXISTS (
          SELECT 1 FROM provisioning_jobs WHERE tunnel_id = $3 AND job_type = 'revoke_named_tunnel'
            AND status IN ('queued','retry','running')
        )
      `, [randomUUID(), tunnel.device_id, input.tunnelId]);
      await client.query(`
        INSERT INTO provisioning_jobs (id, device_id, tunnel_id, job_type, status)
        SELECT $1,$2,$3,'provision_named_tunnel','blocked'
        WHERE NOT EXISTS (
          SELECT 1 FROM provisioning_jobs WHERE tunnel_id = $3 AND job_type = 'provision_named_tunnel'
            AND status = 'blocked'
        )
      `, [randomUUID(), tunnel.device_id, input.tunnelId]);
      await insertAudit(client, input.adminId, "tunnel.rebuild", "tunnel", input.tunnelId, {
        reason: input.reason
      });
      return true;
    });
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

async function insertEntitlement(
  client: PoolClient,
  userId: string,
  subscriptionId: string,
  key: string,
  value: string | number | boolean,
  expiresAt: string | null
): Promise<void> {
  await client.query(`
    INSERT INTO entitlements (
      id, user_id, subscription_id, entitlement_key, entitlement_value, starts_at, expires_at
    ) VALUES ($1,$2,$3,$4,$5::jsonb,now(),$6)
  `, [randomUUID(), userId, subscriptionId, key, JSON.stringify(value), expiresAt]);
}

async function blockDeviceResources(client: PoolClient, deviceId: string): Promise<void> {
  await client.query("UPDATE devices SET status = 'blocked', updated_at = now() WHERE id = $1", [deviceId]);
  await client.query("UPDATE device_credentials SET revoked_at = now() WHERE device_id = $1 AND revoked_at IS NULL", [deviceId]);
  await client.query("UPDATE auth_tokens SET revoked_at = now() WHERE subject_type = 'device' AND subject_id = $1 AND revoked_at IS NULL", [deviceId]);
  const tunnels = await client.query(`
    UPDATE tunnels SET status = 'revoked', updated_at = now()
    WHERE device_id = $1 AND status NOT IN ('revoked','deleted') RETURNING id
  `, [deviceId]);
  await client.query("UPDATE domains SET status = 'released', released_at = now(), updated_at = now() WHERE device_id = $1 AND status IN ('active','reserved')", [deviceId]);
  for (const tunnel of tunnels.rows) {
    await client.query(`
      INSERT INTO provisioning_jobs (id, device_id, tunnel_id, job_type, status)
      VALUES ($1,$2,$3,'revoke_named_tunnel','queued')
    `, [randomUUID(), deviceId, tunnel.id]);
  }
}

async function insertAudit(
  client: PoolClient,
  adminId: string,
  action: string,
  targetType: string,
  targetId: string,
  summary: Record<string, unknown>
): Promise<void> {
  await client.query(`
    INSERT INTO audit_logs (id, admin_user_id, action, target_type, target_id, summary)
    VALUES ($1,$2,$3,$4,$5,$6::jsonb)
  `, [randomUUID(), adminId, action, targetType, targetId, JSON.stringify(summary)]);
}

function mapUser(row: Record<string, unknown>): UserRecord {
  return {
    id: String(row.id),
    passwordHash: String(row.password_hash),
    status: row.status as UserRecord["status"],
    createdAt: new Date(String(row.created_at)).toISOString()
  };
}

function mapDevice(row: Record<string, unknown>): DeviceRecord {
  return {
    id: String(row.id),
    deviceCode: String(row.device_code),
    userId: String(row.user_id),
    name: String(row.name),
    os: String(row.os),
    arch: String(row.arch),
    clientVersion: String(row.client_version),
    codexCliVersion: row.codex_cli_version ? String(row.codex_cli_version) : null,
    originPort: Number(row.origin_port),
    status: row.status as DeviceRecord["status"],
    lastSeenAt: row.last_seen_at ? new Date(String(row.last_seen_at)).toISOString() : null,
    createdAt: new Date(String(row.created_at)).toISOString()
  };
}

function mapTunnel(row: Record<string, unknown>): NamedTunnelRecord {
  return {
    id: String(row.id),
    deviceId: String(row.device_id),
    cloudflareTunnelId: row.cloudflare_tunnel_id ? String(row.cloudflare_tunnel_id) : null,
    hostname: String(row.hostname),
    status: String(row.status),
    lastErrorCode: row.last_error_code ? String(row.last_error_code) : null
  };
}

function maskIdentifier(type: IdentityType, value: string): string {
  if (type === "email") {
    const [local, domain] = value.split("@");
    if (!domain) return "***";
    return `${local.slice(0, Math.min(2, local.length))}***@${domain}`;
  }
  if (value.length <= 7) return `${value.slice(0, 2)}***`;
  return `${value.slice(0, 3)}****${value.slice(-4)}`;
}
