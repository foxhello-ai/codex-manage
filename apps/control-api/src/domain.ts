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

export type IssueReportSource =
  | "manual"
  | "auto_crash"
  | "auto_unavailable"
  | "auto_defect"
  | "auto_optimization"
  | "auto_requirement";

export type IssueReportLevel =
  | "P0_MANUAL"
  | "P1_CRASH"
  | "P2_UNAVAILABLE"
  | "P3_DEFECT"
  | "P4_OPTIMIZATION"
  | "P5_REQUIREMENT";

export type IssueReportCategory =
  | "crash"
  | "unavailable"
  | "defect"
  | "optimization"
  | "requirement";

export type IssueReportStatus =
  | "new"
  | "triaged"
  | "in_progress"
  | "waiting_user"
  | "resolved"
  | "closed"
  | "ignored";

export type IssueReportRecord = {
  id: string;
  source: IssueReportSource;
  level: IssueReportLevel;
  category: IssueReportCategory;
  title: string;
  description: string;
  userId: string | null;
  deviceId: string | null;
  clientVersion: string;
  platform: string;
  arch: string;
  osVersion: string | null;
  channel: string;
  fingerprint: string | null;
  status: IssueReportStatus;
  assignee: string | null;
  linkedIncidentId: string | null;
  createdAt: string;
  updatedAt: string;
  duplicateCount?: number;
  deduplicated?: boolean;
};

export type NamedTunnelRecord = {
  id: string;
  deviceId: string;
  cloudflareTunnelId: string | null;
  cloudflareZoneId: string | null;
  hostname: string;
  status: string;
  lastErrorCode: string | null;
};

export type SystemConfigRecord = {
  publicApiBaseUrl: string;
  desktopUpdateFeedUrl: string;
  deviceDomain: string;
  managedDomainSuffixes: string[];
  adminOrigins: string[];
  desktopConfigTtlSeconds: number;
  cloudflareZoneId: string | null;
  updatedAt: string | null;
  updatedByAdminId: string | null;
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
