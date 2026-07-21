export type IdentityType = "email" | "phone";
export type SubjectType = "user" | "device" | "admin";
export type TokenType = "access" | "refresh" | "device_access" | "admin_access";

export type UserRecord = {
  id: string;
  passwordHash: string;
  status: "active" | "blocked";
  createdAt: string;
};

export type DeviceRecord = {
  id: string;
  deviceCode: string;
  userId: string;
  name: string;
  os: string;
  arch: string;
  clientVersion: string;
  codexCliVersion: string | null;
  originPort: number;
  status: "active" | "revoked" | "blocked";
  lastSeenAt: string | null;
  createdAt: string;
};

export type AuthTokenRecord = {
  id: string;
  subjectType: SubjectType;
  subjectId: string;
  tokenType: TokenType;
  expiresAt: string;
};

export type EntitlementMap = Record<string, string | number | boolean>;

export type NamedTunnelRecord = {
  id: string;
  deviceId: string;
  cloudflareTunnelId: string | null;
  hostname: string;
  status: string;
  lastErrorCode: string | null;
};

export class ControlError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 400,
    readonly details?: unknown
  ) {
    super(message);
    this.name = "ControlError";
  }
}
