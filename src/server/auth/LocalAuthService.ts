import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

type PasswordRecord = {
  algorithm: "scrypt";
  salt: string;
  derivedKey: string;
  cost: number;
  blockSize: number;
  parallelization: number;
};

type SessionRow = {
  public_id: string;
  source: AuthSessionSource;
  user_agent: string | null;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
};

type PairingCodeRow = {
  expires_at: string;
  consumed_at: string | null;
};

export type AuthSessionSource = "password" | "pairing" | "desktop";

export type LocalAuthSession = {
  id: string;
  source: AuthSessionSource;
  userAgent: string | null;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
};

export type IssuedLocalAuthSession = {
  token: string;
  session: LocalAuthSession;
};

export type PairingCode = {
  code: string;
  expiresAt: string;
};

export type LocalAuthServiceOptions = {
  databaseFile: string;
  bootstrapPassword: string | null;
  bootstrapPasswordIsDefault: boolean;
  sessionTtlSeconds: number;
  pairingCodeTtlSeconds: number;
};

const PASSWORD_CONFIG_KEY = "password_record";
const DEFAULT_PASSWORD_CONFIG_KEY = "password_is_default";
const SCRYPT_COST = 16_384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;

export class LocalAuthService {
  private readonly database: DatabaseSync;

  constructor(private readonly options: LocalAuthServiceOptions) {
    if (options.databaseFile !== ":memory:") {
      mkdirSync(dirname(options.databaseFile), { recursive: true });
    }

    this.database = new DatabaseSync(options.databaseFile);
    this.initializeSchema();

    if (this.isSetupRequired() && options.bootstrapPassword) {
      this.setPassword(options.bootstrapPassword, options.bootstrapPasswordIsDefault);
    }
  }

  close(): void {
    this.database.close();
  }

  isSetupRequired(): boolean {
    return this.readConfig(PASSWORD_CONFIG_KEY) === null;
  }

  isDefaultPassword(): boolean {
    return this.readConfig(DEFAULT_PASSWORD_CONFIG_KEY) === "1";
  }

  setup(password: string): boolean {
    if (!this.isSetupRequired()) return false;
    this.setPassword(password, false);
    return true;
  }

  setPassword(password: string, isDefault = false): void {
    const salt = randomBytes(16);
    const derivedKey = derivePasswordKey(password, salt, {
      cost: SCRYPT_COST,
      blockSize: SCRYPT_BLOCK_SIZE,
      parallelization: SCRYPT_PARALLELIZATION
    });
    const record: PasswordRecord = {
      algorithm: "scrypt",
      salt: salt.toString("base64url"),
      derivedKey: derivedKey.toString("base64url"),
      cost: SCRYPT_COST,
      blockSize: SCRYPT_BLOCK_SIZE,
      parallelization: SCRYPT_PARALLELIZATION
    };

    this.writeConfig(PASSWORD_CONFIG_KEY, JSON.stringify(record));
    this.writeConfig(DEFAULT_PASSWORD_CONFIG_KEY, isDefault ? "1" : "0");
    this.revokeAllSessions();
  }

  verifyPassword(password: string): boolean {
    const serialized = this.readConfig(PASSWORD_CONFIG_KEY);
    if (!serialized) return false;

    try {
      const record = JSON.parse(serialized) as PasswordRecord;
      if (record.algorithm !== "scrypt") return false;
      const expected = Buffer.from(record.derivedKey, "base64url");
      const actual = derivePasswordKey(password, Buffer.from(record.salt, "base64url"), {
        cost: record.cost,
        blockSize: record.blockSize,
        parallelization: record.parallelization
      });
      return expected.length === actual.length && timingSafeEqual(expected, actual);
    } catch {
      return false;
    }
  }

  createSession(source: AuthSessionSource, userAgent: string | null): IssuedLocalAuthSession {
    this.deleteExpiredSessions();
    const token = randomBytes(32).toString("base64url");
    const publicId = randomUUID();
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + this.options.sessionTtlSeconds * 1000);

    this.database.prepare(`
      INSERT INTO auth_sessions (
        token_hash, public_id, source, user_agent, created_at, expires_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL)
    `).run(
      hashToken(token),
      publicId,
      source,
      normalizeUserAgent(userAgent),
      createdAt.toISOString(),
      expiresAt.toISOString()
    );

    return {
      token,
      session: {
        id: publicId,
        source,
        userAgent: normalizeUserAgent(userAgent),
        createdAt: createdAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        revokedAt: null
      }
    };
  }

  authenticate(token: string | null | undefined): LocalAuthSession | null {
    if (!token) return null;
    const row = this.database.prepare(`
      SELECT public_id, source, user_agent, created_at, expires_at, revoked_at
      FROM auth_sessions
      WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?
    `).get(hashToken(token), new Date().toISOString()) as SessionRow | undefined;

    return row ? mapSession(row) : null;
  }

  revokeSessionToken(token: string | null | undefined): void {
    if (!token) return;
    this.database.prepare(`
      UPDATE auth_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL
    `).run(new Date().toISOString(), hashToken(token));
  }

  revokeSessionById(sessionId: string): boolean {
    const result = this.database.prepare(`
      UPDATE auth_sessions SET revoked_at = ? WHERE public_id = ? AND revoked_at IS NULL
    `).run(new Date().toISOString(), sessionId);
    return Number(result.changes) === 1;
  }

  revokeAllSessions(): void {
    this.database.prepare(`
      UPDATE auth_sessions SET revoked_at = ? WHERE revoked_at IS NULL
    `).run(new Date().toISOString());
  }

  listSessions(): LocalAuthSession[] {
    this.deleteExpiredSessions();
    const rows = this.database.prepare(`
      SELECT public_id, source, user_agent, created_at, expires_at, revoked_at
      FROM auth_sessions
      WHERE revoked_at IS NULL AND expires_at > ?
      ORDER BY created_at DESC
    `).all(new Date().toISOString()) as unknown as SessionRow[];
    return rows.map(mapSession);
  }

  createPairingCode(): PairingCode {
    this.deleteExpiredPairingCodes();
    const code = randomBytes(32).toString("base64url");
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + this.options.pairingCodeTtlSeconds * 1000);

    // Refreshing the desktop QR code explicitly revokes every older,
    // unconsumed pairing code so only the latest code can be used.
    this.database.prepare(`
      UPDATE pairing_codes SET consumed_at = ?
      WHERE consumed_at IS NULL AND expires_at > ?
    `).run(createdAt.toISOString(), createdAt.toISOString());

    this.database.prepare(`
      INSERT INTO pairing_codes (code_hash, created_at, expires_at, consumed_at)
      VALUES (?, ?, ?, NULL)
    `).run(hashToken(code), createdAt.toISOString(), expiresAt.toISOString());

    return {
      code,
      expiresAt: expiresAt.toISOString()
    };
  }

  consumePairingCode(code: string, userAgent: string | null): IssuedLocalAuthSession | null {
    const codeHash = hashToken(code);
    const now = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE");

    try {
      const row = this.database.prepare(`
        SELECT expires_at, consumed_at FROM pairing_codes WHERE code_hash = ?
      `).get(codeHash) as PairingCodeRow | undefined;

      if (!row || row.consumed_at !== null || row.expires_at <= now) {
        this.database.exec("ROLLBACK");
        return null;
      }

      const result = this.database.prepare(`
        UPDATE pairing_codes SET consumed_at = ?
        WHERE code_hash = ? AND consumed_at IS NULL AND expires_at > ?
      `).run(now, codeHash, now);

      if (Number(result.changes) !== 1) {
        this.database.exec("ROLLBACK");
        return null;
      }

      const issued = this.createSession("pairing", userAgent);
      this.database.exec("COMMIT");
      return issued;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private initializeSchema(): void {
    this.database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS auth_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS auth_sessions (
        token_hash TEXT PRIMARY KEY,
        public_id TEXT NOT NULL UNIQUE,
        source TEXT NOT NULL,
        user_agent TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS auth_sessions_expiry_idx ON auth_sessions(expires_at);
      CREATE TABLE IF NOT EXISTS pairing_codes (
        code_hash TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS pairing_codes_expiry_idx ON pairing_codes(expires_at);
    `);
  }

  private readConfig(key: string): string | null {
    const row = this.database.prepare("SELECT value FROM auth_config WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  private writeConfig(key: string, value: string): void {
    this.database.prepare(`
      INSERT INTO auth_config (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }

  private deleteExpiredSessions(): void {
    this.database.prepare("DELETE FROM auth_sessions WHERE expires_at <= ?").run(new Date().toISOString());
  }

  private deleteExpiredPairingCodes(): void {
    this.database.prepare("DELETE FROM pairing_codes WHERE expires_at <= ? OR consumed_at IS NOT NULL").run(
      new Date().toISOString()
    );
  }
}

function derivePasswordKey(
  password: string,
  salt: Buffer,
  options: { cost: number; blockSize: number; parallelization: number }
): Buffer {
  return scryptSync(password, salt, 64, {
    N: options.cost,
    r: options.blockSize,
    p: options.parallelization,
    maxmem: 64 * 1024 * 1024
  });
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

function normalizeUserAgent(userAgent: string | null): string | null {
  if (!userAgent) return null;
  return userAgent.slice(0, 512);
}

function mapSession(row: SessionRow): LocalAuthSession {
  return {
    id: row.public_id,
    source: row.source,
    userAgent: row.user_agent,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at
  };
}
