import type { AuthTokenRecord, DeviceRecord, EntitlementMap, IdentityType, NamedTunnelRecord, SubjectType, TokenType, UserRecord } from "./domain";

export type CreatedDevice = {
  device: DeviceRecord;
  credential: string;
};

export type ProvisioningJob = {
  id: string;
  jobType: "provision_named_tunnel" | "revoke_named_tunnel";
  device: DeviceRecord;
  tunnel: NamedTunnelRecord;
};

export interface ControlStore {
  saveVerification(input: {
    type: IdentityType;
    identifier: string;
    purpose: string;
    codeHash: string;
    expiresAt: string;
  }): Promise<void>;
  consumeVerification(input: {
    type: IdentityType;
    identifier: string;
    purpose: string;
    codeHash: string;
  }): Promise<boolean>;
  findUserByIdentity(type: IdentityType, identifier: string): Promise<UserRecord | null>;
  createUserWithIdentity(input: {
    type: IdentityType;
    identifier: string;
    passwordHash: string;
  }): Promise<UserRecord>;
  updateUserLastLogin(userId: string): Promise<void>;
  updateUserPasswordByIdentity(type: IdentityType, identifier: string, passwordHash: string): Promise<boolean>;
  addUserIdentity(userId: string, type: IdentityType, identifier: string): Promise<boolean>;
  removeUserIdentity(userId: string, type: IdentityType, identifier: string): Promise<"removed" | "not_found" | "last_identity">;
  listUserIdentities(userId: string): Promise<Array<{ type: IdentityType; identifier: string; verifiedAt: string }>>;
  createToken(input: {
    subjectType: SubjectType;
    subjectId: string;
    tokenType: TokenType;
    tokenHash: string;
    expiresAt: string;
  }): Promise<void>;
  createTokens(inputs: Array<{
    subjectType: SubjectType;
    subjectId: string;
    tokenType: TokenType;
    tokenHash: string;
    expiresAt: string;
  }>): Promise<void>;
  rotateRefreshToken(input: {
    currentTokenHash: string;
    accessTokenHash: string;
    accessExpiresAt: string;
    refreshTokenHash: string;
    refreshExpiresAt: string;
  }): Promise<string | null>;
  findToken(tokenHash: string, tokenType: TokenType): Promise<AuthTokenRecord | null>;
  revokeToken(tokenHash: string): Promise<void>;
  revokeSubjectTokens(subjectType: SubjectType, subjectId: string): Promise<void>;
  countActiveDevices(userId: string): Promise<number>;
  createDevice(input: Omit<DeviceRecord, "id" | "createdAt" | "lastSeenAt" | "status"> & {
    id: string;
    credentialHash: string;
  }, maxActiveDevices: number): Promise<DeviceRecord | null>;
  findDeviceByCredential(credentialHash: string): Promise<DeviceRecord | null>;
  getDevice(deviceId: string): Promise<DeviceRecord | null>;
  listDevices(userId: string): Promise<DeviceRecord[]>;
  updateDeviceName(userId: string, deviceId: string, name: string): Promise<DeviceRecord | null>;
  recordHeartbeat(input: {
    deviceId: string;
    clientVersion: string;
    codexCliVersion: string | null;
    originPort: number;
    tunnelStatus: string;
    publicHostname: string | null;
    errorCode: string | null;
  }): Promise<boolean>;
  revokeDevice(userId: string, deviceId: string): Promise<boolean>;
  getEntitlements(userId: string): Promise<EntitlementMap>;
  listPlans(): Promise<Array<Record<string, unknown>>>;
  getCurrentSubscription(userId: string): Promise<Record<string, unknown> | null>;
  listOrders(userId: string): Promise<Array<Record<string, unknown>>>;
  requestNamedTunnel(userId: string, deviceId: string, hostname: string): Promise<NamedTunnelRecord>;
  getNamedTunnelForDevice(deviceId: string): Promise<NamedTunnelRecord | null>;
  claimProvisioningJob(): Promise<ProvisioningJob | null>;
  completeProvisioningJob(jobId: string, tunnelId: string, cloudflareTunnelId: string): Promise<boolean>;
  convertProvisioningJobToRevocation(
    jobId: string,
    tunnelId: string,
    cloudflareTunnelId: string,
    errorCode: string,
    message: string
  ): Promise<void>;
  retryProvisioningJob(jobId: string, tunnelId: string, errorCode: string, message: string): Promise<void>;
  completeRevocationJob(jobId: string, tunnelId: string): Promise<void>;
  reconcileTunnelJobs(): Promise<number>;
  findAdminByEmail(email: string): Promise<{ id: string; passwordHash: string; role: string; status: string } | null>;
  findAdminById(adminId: string): Promise<{ id: string; role: string; status: string } | null>;
  updateAdminLastLogin(adminId: string): Promise<void>;
  ensureAdmin(input: { id: string; email: string; passwordHash: string; role: string }): Promise<void>;
  listAdminUsers(): Promise<Array<Record<string, unknown>>>;
  listAdminDevices(): Promise<Array<Record<string, unknown>>>;
  listAdminTunnels(): Promise<Array<Record<string, unknown>>>;
  listAdminDomains(): Promise<Array<Record<string, unknown>>>;
  listAdminSubscriptions(): Promise<Array<Record<string, unknown>>>;
  listAdminOrders(): Promise<Array<Record<string, unknown>>>;
  listAdminPayments(): Promise<Array<Record<string, unknown>>>;
  listAdminAuditLogs(): Promise<Array<Record<string, unknown>>>;
  getAdminOverview(): Promise<Record<string, number>>;
  grantFormalSubscription(input: {
    adminId: string;
    userId: string;
    startsAt: string;
    expiresAt: string | null;
    reason: string;
  }): Promise<void>;
  setUserStatus(input: { adminId: string; userId: string; status: "active" | "blocked"; reason: string }): Promise<boolean>;
  setDeviceStatus(input: { adminId: string; deviceId: string; status: "active" | "blocked"; reason: string }): Promise<boolean>;
  rebuildNamedTunnel(input: { adminId: string; tunnelId: string; reason: string }): Promise<boolean>;
  close(): Promise<void>;
}
