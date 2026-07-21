import { randomBytes, randomUUID } from "node:crypto";
import type { CloudflareAdapter } from "./cloudflare/CloudflareAdapter";
import type { ControlConfig } from "./config";
import { ControlError, type EntitlementMap, type IdentityType } from "./domain";
import type { VerificationNotifier } from "./notifier";
import {
  hashPassword,
  hashToken,
  hashVerificationCode,
  randomToken,
  randomVerificationCode,
  verifyPassword
} from "./security";
import type { ControlStore } from "./store";

export class ControlService {
  constructor(
    private readonly config: ControlConfig,
    private readonly store: ControlStore,
    private readonly notifier: VerificationNotifier,
    private readonly cloudflare: CloudflareAdapter | null
  ) {}

  async requestVerificationCode(type: IdentityType, rawIdentifier: string, purpose = "register") {
    const identifier = normalizeIdentifier(type, rawIdentifier);
    const code = randomVerificationCode();
    const expiresAt = new Date(Date.now() + this.config.verificationCodeTtlSeconds * 1000).toISOString();
    await this.store.saveVerification({
      type,
      identifier,
      purpose,
      codeHash: hashVerificationCode(identifier, purpose, code),
      expiresAt
    });
    await this.notifier.send({ type, identifier, code, purpose, expiresAt });
    return {
      sent: true,
      expiresAt,
      ...(this.config.allowDebugCodes ? { debugCode: code } : {})
    };
  }

  async register(type: IdentityType, rawIdentifier: string, code: string, password: string) {
    const identifier = normalizeIdentifier(type, rawIdentifier);
    const existing = await this.store.findUserByIdentity(type, identifier);
    if (existing) throw new ControlError("IDENTITY_ALREADY_REGISTERED", "该账号已经注册", 409);
    const verified = await this.store.consumeVerification({
      type,
      identifier,
      purpose: "register",
      codeHash: hashVerificationCode(identifier, "register", code)
    });
    if (!verified) throw new ControlError("VERIFICATION_CODE_INVALID", "验证码无效或已过期", 401);
    const user = await this.store.createUserWithIdentity({
      type,
      identifier,
      passwordHash: hashPassword(password)
    });
    return {
      user: { id: user.id, identityType: type, identifier },
      ...(await this.issueUserTokens(user.id))
    };
  }

  async resetPassword(type: IdentityType, rawIdentifier: string, code: string, password: string) {
    const identifier = normalizeIdentifier(type, rawIdentifier);
    const verified = await this.store.consumeVerification({
      type,
      identifier,
      purpose: "password_reset",
      codeHash: hashVerificationCode(identifier, "password_reset", code)
    });
    if (!verified) throw new ControlError("VERIFICATION_CODE_INVALID", "验证码无效或已过期", 401);
    const updated = await this.store.updateUserPasswordByIdentity(type, identifier, hashPassword(password));
    if (!updated) throw new ControlError("IDENTITY_NOT_FOUND", "账号不存在", 404);
    return { passwordReset: true };
  }

  async bindIdentity(userId: string, type: IdentityType, rawIdentifier: string, code: string) {
    const identifier = normalizeIdentifier(type, rawIdentifier);
    const verified = await this.store.consumeVerification({
      type,
      identifier,
      purpose: "bind_identity",
      codeHash: hashVerificationCode(identifier, "bind_identity", code)
    });
    if (!verified) throw new ControlError("VERIFICATION_CODE_INVALID", "验证码无效或已过期", 401);
    if (!await this.store.addUserIdentity(userId, type, identifier)) {
      throw new ControlError("IDENTITY_ALREADY_BOUND", "该邮箱或手机号已绑定其他账号", 409);
    }
    return { bound: true, identity: { type, identifier } };
  }

  async unbindIdentity(userId: string, type: IdentityType, rawIdentifier: string) {
    const identifier = normalizeIdentifier(type, rawIdentifier);
    const result = await this.store.removeUserIdentity(userId, type, identifier);
    if (result === "not_found") throw new ControlError("IDENTITY_NOT_FOUND", "绑定信息不存在", 404);
    if (result === "last_identity") throw new ControlError("LAST_IDENTITY_REQUIRED", "至少需要保留一个登录邮箱或手机号", 409);
    return { unbound: true };
  }

  async login(rawIdentifier: string, password: string) {
    const type: IdentityType = rawIdentifier.includes("@") ? "email" : "phone";
    const identifier = normalizeIdentifier(type, rawIdentifier);
    const user = await this.store.findUserByIdentity(type, identifier);
    if (!user || user.status !== "active" || !verifyPassword(password, user.passwordHash)) {
      throw new ControlError("INVALID_CREDENTIALS", "账号或密码错误", 401);
    }
    await this.store.updateUserLastLogin(user.id);
    return {
      user: { id: user.id, identityType: type, identifier },
      ...(await this.issueUserTokens(user.id))
    };
  }

  async refresh(refreshToken: string) {
    const accessToken = randomToken("cm_access");
    const nextRefreshToken = randomToken("cm_refresh");
    const accessExpiresAt = new Date(Date.now() + this.config.accessTokenTtlSeconds * 1000).toISOString();
    const refreshExpiresAt = new Date(Date.now() + this.config.refreshTokenTtlSeconds * 1000).toISOString();
    const userId = await this.store.rotateRefreshToken({
      currentTokenHash: hashToken(refreshToken),
      accessTokenHash: hashToken(accessToken),
      accessExpiresAt,
      refreshTokenHash: hashToken(nextRefreshToken),
      refreshExpiresAt
    });
    if (!userId) {
      throw new ControlError("REFRESH_TOKEN_INVALID", "登录凭证已失效", 401);
    }
    return { accessToken, refreshToken: nextRefreshToken, accessExpiresAt, refreshExpiresAt };
  }

  async logout(token: string, refreshToken?: string): Promise<void> {
    await this.store.revokeToken(hashToken(token));
    if (refreshToken) await this.store.revokeToken(hashToken(refreshToken));
  }

  async authenticateUser(token: string): Promise<string> {
    const record = await this.store.findToken(hashToken(token), "access");
    if (!record || record.subjectType !== "user") {
      throw new ControlError("UNAUTHENTICATED", "请先登录", 401);
    }
    return record.subjectId;
  }

  async authenticateAdmin(token: string, requireWrite = false): Promise<string> {
    const record = await this.store.findToken(hashToken(token), "admin_access");
    if (!record || record.subjectType !== "admin") {
      throw new ControlError("ADMIN_UNAUTHENTICATED", "管理员登录已失效", 401);
    }
    const admin = await this.store.findAdminById(record.subjectId);
    if (!admin || admin.status !== "active") throw new ControlError("ADMIN_UNAUTHENTICATED", "管理员账号不可用", 401);
    if (requireWrite && admin.role === "operator_readonly") {
      throw new ControlError("ADMIN_FORBIDDEN", "只读运营账号无权执行该操作", 403);
    }
    return record.subjectId;
  }

  async authenticateDevice(token: string): Promise<string> {
    const record = await this.store.findToken(hashToken(token), "device_access");
    if (!record || record.subjectType !== "device") {
      throw new ControlError("DEVICE_UNAUTHENTICATED", "设备凭证已失效", 401);
    }
    return record.subjectId;
  }

  async registerDevice(userId: string, input: {
    name: string;
    os: string;
    arch: string;
    clientVersion: string;
    codexCliVersion: string | null;
    originPort: number;
  }) {
    const entitlements = await this.store.getEntitlements(userId);
    const configuredMaxCount = Number(entitlements["device.max_count"] ?? 1);
    const maxCount = Number.isFinite(configuredMaxCount) && configuredMaxCount > 0
      ? Math.floor(configuredMaxCount)
      : 1;
    const credential = randomToken("cm_device");
    const device = await this.store.createDevice({
      id: randomUUID(),
      deviceCode: randomDeviceCode(),
      userId,
      name: input.name,
      os: input.os,
      arch: input.arch,
      clientVersion: input.clientVersion,
      codexCliVersion: input.codexCliVersion,
      originPort: input.originPort,
      credentialHash: hashToken(credential)
    }, maxCount);
    if (!device) {
      throw new ControlError("DEVICE_LIMIT_REACHED", "已达到当前套餐的设备数量上限", 409, { maxCount });
    }
    return { device, credential };
  }

  async exchangeDeviceCredential(credential: string) {
    const device = await this.store.findDeviceByCredential(hashToken(credential));
    if (!device) throw new ControlError("DEVICE_CREDENTIAL_INVALID", "设备凭证无效", 401);
    const token = randomToken("cm_device_access");
    const expiresAt = new Date(Date.now() + this.config.deviceTokenTtlSeconds * 1000).toISOString();
    await this.store.createToken({
      subjectType: "device",
      subjectId: device.id,
      tokenType: "device_access",
      tokenHash: hashToken(token),
      expiresAt
    });
    return { accessToken: token, expiresAt, device };
  }

  async recordHeartbeat(deviceId: string, input: {
    clientVersion: string;
    codexCliVersion: string | null;
    originPort: number;
    tunnelStatus: string;
    publicHostname: string | null;
    errorCode: string | null;
  }) {
    if (!await this.store.recordHeartbeat({ deviceId, ...input })) {
      throw new ControlError("DEVICE_NOT_FOUND", "设备不存在或已停用", 404);
    }
    return { accepted: true, serverTime: new Date().toISOString() };
  }

  async requestNamedTunnel(userId: string, deviceId: string) {
    const entitlements = await this.store.getEntitlements(userId);
    if (entitlements["tunnel.named"] !== true) {
      throw new ControlError("NAMED_TUNNEL_NOT_ENTITLED", "当前套餐未开通固定域名", 403);
    }
    const device = await this.store.getDevice(deviceId);
    if (!device || device.userId !== userId || device.status !== "active") {
      throw new ControlError("DEVICE_NOT_FOUND", "设备不存在", 404);
    }
    try {
      return await this.store.requestNamedTunnel(userId, deviceId, `d-${device.deviceCode}.${this.config.publicDomain}`);
    } catch (error) {
      if (error instanceof Error && error.message === "DEVICE_NOT_FOUND") {
        throw new ControlError("DEVICE_NOT_FOUND", "设备不存在", 404);
      }
      throw error;
    }
  }

  async getDeviceTunnelConfig(deviceId: string) {
    const device = await this.store.getDevice(deviceId);
    if (!device || device.status !== "active") throw new ControlError("DEVICE_NOT_FOUND", "设备不存在", 404);
    const entitlements = await this.store.getEntitlements(device.userId);
    const tunnel = await this.store.getNamedTunnelForDevice(device.id);
    if (entitlements["tunnel.named"] === true && tunnel?.status === "active" && tunnel.cloudflareTunnelId) {
      if (!this.cloudflare) throw new ControlError("CLOUDFLARE_NOT_CONFIGURED", "Tunnel 服务尚未配置", 503);
      return {
        mode: "named",
        hostname: tunnel.hostname,
        token: await this.cloudflare.getTunnelToken(tunnel.cloudflareTunnelId)
      };
    }
    return {
      mode: entitlements["tunnel.quick"] === true ? "quick" : "disabled",
      hostname: null,
      token: null,
      namedTunnelStatus: tunnel?.status ?? null
    };
  }

  async adminLogin(email: string, password: string) {
    const admin = await this.store.findAdminByEmail(email.trim().toLowerCase());
    if (!admin || admin.status !== "active" || !verifyPassword(password, admin.passwordHash)) {
      throw new ControlError("ADMIN_INVALID_CREDENTIALS", "管理员账号或密码错误", 401);
    }
    const token = randomToken("cm_admin");
    const expiresAt = new Date(Date.now() + this.config.accessTokenTtlSeconds * 1000).toISOString();
    await this.store.createToken({
      subjectType: "admin",
      subjectId: admin.id,
      tokenType: "admin_access",
      tokenHash: hashToken(token),
      expiresAt
    });
    await this.store.updateAdminLastLogin(admin.id);
    return { accessToken: token, expiresAt, role: admin.role };
  }

  async ensureBootstrapAdmin(email: string, password: string): Promise<void> {
    await this.store.ensureAdmin({
      id: randomUUID(),
      email: email.trim().toLowerCase(),
      passwordHash: hashPassword(password),
      role: "admin"
    });
  }

  async grantFormalSubscription(adminId: string, userId: string, expiresAt: string | null, reason: string) {
    if (expiresAt && Date.parse(expiresAt) <= Date.now()) {
      throw new ControlError("INVALID_SUBSCRIPTION_EXPIRY", "订阅到期时间必须晚于当前时间", 400);
    }
    await this.store.grantFormalSubscription({
      adminId,
      userId,
      startsAt: new Date().toISOString(),
      expiresAt,
      reason
    });
    return { granted: true };
  }

  async setUserStatus(adminId: string, userId: string, status: "active" | "blocked", reason: string) {
    if (!await this.store.setUserStatus({ adminId, userId, status, reason })) {
      throw new ControlError("USER_NOT_FOUND", "用户不存在", 404);
    }
    return { updated: true };
  }

  async setDeviceStatus(adminId: string, deviceId: string, status: "active" | "blocked", reason: string) {
    if (!await this.store.setDeviceStatus({ adminId, deviceId, status, reason })) {
      throw new ControlError("DEVICE_NOT_FOUND", "设备不存在", 404);
    }
    return { updated: true };
  }

  async rebuildNamedTunnel(adminId: string, tunnelId: string, reason: string) {
    if (!await this.store.rebuildNamedTunnel({ adminId, tunnelId, reason })) {
      throw new ControlError("TUNNEL_NOT_FOUND", "Named Tunnel 不存在", 404);
    }
    return { rebuildQueued: true };
  }

  private async issueUserTokens(userId: string) {
    const accessToken = randomToken("cm_access");
    const refreshToken = randomToken("cm_refresh");
    const accessExpiresAt = new Date(Date.now() + this.config.accessTokenTtlSeconds * 1000).toISOString();
    const refreshExpiresAt = new Date(Date.now() + this.config.refreshTokenTtlSeconds * 1000).toISOString();
    await this.store.createTokens([
      {
        subjectType: "user",
        subjectId: userId,
        tokenType: "access",
        tokenHash: hashToken(accessToken),
        expiresAt: accessExpiresAt
      },
      {
        subjectType: "user",
        subjectId: userId,
        tokenType: "refresh",
        tokenHash: hashToken(refreshToken),
        expiresAt: refreshExpiresAt
      }
    ]);
    return { accessToken, refreshToken, accessExpiresAt, refreshExpiresAt };
  }
}

export function normalizeIdentifier(type: IdentityType, value: string): string {
  const trimmed = value.trim();
  if (type === "email") {
    const normalized = trimmed.toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
      throw new ControlError("INVALID_EMAIL", "邮箱格式不正确", 400);
    }
    return normalized;
  }

  const normalized = trimmed.replace(/[\s()-]/g, "");
  const withCountryCode = normalized.startsWith("+") ? normalized : `+86${normalized}`;
  if (!/^\+[1-9]\d{7,14}$/.test(withCountryCode)) {
    throw new ControlError("INVALID_PHONE", "手机号格式不正确", 400);
  }
  return withCountryCode;
}

function randomDeviceCode(): string {
  return randomBytes(5).toString("hex");
}
