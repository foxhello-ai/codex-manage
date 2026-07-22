import cors from "@fastify/cors";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { z } from "zod";
import type { CloudflareAdapter } from "./cloudflare/CloudflareAdapter";
import type { ControlConfig } from "./config";
import { ControlService } from "./ControlService";
import { ControlError } from "./domain";
import type { VerificationNotifier } from "./notifier";
import type { ControlStore } from "./store";

const CodeRequest = z.object({ identifier: z.string().min(3).max(320) });
const RegisterRequest = z.object({
  identifier: z.string().min(3).max(320),
  code: z.string().regex(/^\d{6}$/),
  password: z.string().min(8).max(256)
});
const LoginRequest = z.object({
  identifier: z.string().min(3).max(320),
  password: z.string().min(1).max(256)
});
const RefreshRequest = z.object({ refreshToken: z.string().min(20) });
const LogoutRequest = z.object({ refreshToken: z.string().min(20).optional() });
const PasswordResetRequest = RegisterRequest;
const DeviceRequest = z.object({
  name: z.string().trim().min(1).max(100),
  os: z.string().trim().min(1).max(40),
  arch: z.string().trim().min(1).max(40),
  clientVersion: z.string().trim().min(1).max(40),
  codexCliVersion: z.string().trim().max(100).nullable().default(null),
  originPort: z.number().int().min(1).max(65535).default(4310)
});
const DeviceCredentialRequest = z.object({ credential: z.string().min(20) });
const DeviceParams = z.object({ deviceId: z.string().uuid() });
const DeviceNameRequest = z.object({ name: z.string().trim().min(1).max(100) });
const HeartbeatRequest = z.object({
  clientVersion: z.string().min(1).max(40),
  codexCliVersion: z.string().max(100).nullable().default(null),
  originPort: z.number().int().min(1).max(65535),
  tunnelStatus: z.string().min(1).max(40),
  publicHostname: z.string().max(255).nullable().default(null),
  errorCode: z.string().max(100).nullable().default(null)
});
const AdminLoginRequest = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(256)
});
const GrantRequest = z.object({
  expiresAt: z.string().datetime().nullable().default(null),
  reason: z.string().trim().min(1).max(500)
});
const StatusRequest = z.object({
  status: z.enum(["active", "blocked"]),
  reason: z.string().trim().min(1).max(500)
});

export async function createControlApp(
  config: ControlConfig,
  store: ControlStore,
  notifier: VerificationNotifier,
  cloudflare: CloudflareAdapter | null
): Promise<{ app: FastifyInstance; service: ControlService }> {
  const app = Fastify({ logger: true, genReqId: () => crypto.randomUUID() });
  const service = new ControlService(config, store, notifier, cloudflare);
  const rateLimiter = new ApiRateLimiter();

  await app.register(cors, {
    origin: config.adminOrigin.split(",").map((origin) => origin.trim()).filter(Boolean),
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"]
  });

  app.addHook("onSend", async (_request, reply) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ControlError) {
      return reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          requestId: request.id,
          retryable: error.statusCode >= 500 || error.statusCode === 429,
          ...(error.details === undefined ? {} : { details: error.details })
        }
      });
    }
    request.log.error({ err: error }, "Unhandled control API error");
    return reply.status(500).send({
      error: {
        code: "INTERNAL_ERROR",
        message: "服务暂时不可用",
        requestId: request.id,
        retryable: true
      }
    });
  });

  app.get("/", async () => ({
    name: "codex-manage-control-api",
    ok: true,
    health: "/health"
  }));
  app.get("/health", async () => ({ ok: true, checkedAt: new Date().toISOString() }));

  app.post("/v1/auth/email/codes", async (request) => {
    const body = parseBody(CodeRequest, request.body);
    rateLimiter.enforce(`email-code:${request.ip}:${body.identifier.toLowerCase()}`, 5, 10 * 60_000);
    return await service.requestVerificationCode("email", body.identifier);
  });
  app.post("/v1/auth/phone/codes", async (request) => {
    const body = parseBody(CodeRequest, request.body);
    rateLimiter.enforce(`phone-code:${request.ip}:${body.identifier}`, 5, 10 * 60_000);
    return await service.requestVerificationCode("phone", body.identifier);
  });
  app.post("/v1/auth/password/email/codes", async (request) => {
    const body = parseBody(CodeRequest, request.body);
    rateLimiter.enforce(`email-reset:${request.ip}:${body.identifier.toLowerCase()}`, 5, 10 * 60_000);
    return await service.requestVerificationCode("email", body.identifier, "password_reset");
  });
  app.post("/v1/auth/password/phone/codes", async (request) => {
    const body = parseBody(CodeRequest, request.body);
    rateLimiter.enforce(`phone-reset:${request.ip}:${body.identifier}`, 5, 10 * 60_000);
    return await service.requestVerificationCode("phone", body.identifier, "password_reset");
  });
  app.post("/v1/auth/email/register", async (request) => {
    const body = parseBody(RegisterRequest, request.body);
    return await service.register("email", body.identifier, body.code, body.password);
  });
  app.post("/v1/auth/phone/register", async (request) => {
    const body = parseBody(RegisterRequest, request.body);
    return await service.register("phone", body.identifier, body.code, body.password);
  });
  app.post("/v1/auth/password/email/reset", async (request) => {
    const body = parseBody(PasswordResetRequest, request.body);
    return await service.resetPassword("email", body.identifier, body.code, body.password);
  });
  app.post("/v1/auth/password/phone/reset", async (request) => {
    const body = parseBody(PasswordResetRequest, request.body);
    return await service.resetPassword("phone", body.identifier, body.code, body.password);
  });
  app.post("/v1/auth/login", async (request) => {
    const body = parseBody(LoginRequest, request.body);
    rateLimiter.enforce(`login:${request.ip}:${body.identifier.toLowerCase()}`, 10, 60_000);
    return await service.login(body.identifier, body.password);
  });
  app.post("/v1/auth/refresh", async (request) => {
    const body = parseBody(RefreshRequest, request.body);
    return await service.refresh(body.refreshToken);
  });
  app.post("/v1/auth/logout", async (request) => {
    const token = readBearerToken(request);
    const body = parseBody(LogoutRequest, request.body ?? {});
    await service.logout(token, body.refreshToken);
    return { loggedOut: true };
  });
  app.get("/v1/account/identities", async (request) => {
    const userId = await service.authenticateUser(readBearerToken(request));
    return { identities: await store.listUserIdentities(userId) };
  });
  app.get("/v1/account", async (request) => {
    const userId = await service.authenticateUser(readBearerToken(request));
    return { id: userId, identities: await store.listUserIdentities(userId) };
  });
  app.post("/v1/account/identities/email/codes", async (request) => {
    await service.authenticateUser(readBearerToken(request));
    const body = parseBody(CodeRequest, request.body);
    rateLimiter.enforce(`bind-email:${request.ip}:${body.identifier.toLowerCase()}`, 5, 10 * 60_000);
    return await service.requestVerificationCode("email", body.identifier, "bind_identity");
  });
  app.post("/v1/account/identities/phone/codes", async (request) => {
    await service.authenticateUser(readBearerToken(request));
    const body = parseBody(CodeRequest, request.body);
    rateLimiter.enforce(`bind-phone:${request.ip}:${body.identifier}`, 5, 10 * 60_000);
    return await service.requestVerificationCode("phone", body.identifier, "bind_identity");
  });
  app.post("/v1/account/identities/email/bind", async (request) => {
    const userId = await service.authenticateUser(readBearerToken(request));
    const body = parseBody(z.object({ identifier: z.string(), code: z.string().regex(/^\d{6}$/) }), request.body);
    return await service.bindIdentity(userId, "email", body.identifier, body.code);
  });
  app.post("/v1/account/identities/phone/bind", async (request) => {
    const userId = await service.authenticateUser(readBearerToken(request));
    const body = parseBody(z.object({ identifier: z.string(), code: z.string().regex(/^\d{6}$/) }), request.body);
    return await service.bindIdentity(userId, "phone", body.identifier, body.code);
  });
  app.delete("/v1/account/identities/:type", async (request) => {
    const userId = await service.authenticateUser(readBearerToken(request));
    const params = parseBody(z.object({ type: z.enum(["email", "phone"]) }), request.params);
    const body = parseBody(z.object({ identifier: z.string().min(3).max(320) }), request.body);
    return await service.unbindIdentity(userId, params.type, body.identifier);
  });

  app.post("/v1/devices", async (request) => {
    const userId = await service.authenticateUser(readBearerToken(request));
    return await service.registerDevice(userId, parseBody(DeviceRequest, request.body));
  });
  app.get("/v1/devices", async (request) => {
    const userId = await service.authenticateUser(readBearerToken(request));
    return { devices: await store.listDevices(userId) };
  });
  app.patch("/v1/devices/:deviceId", async (request) => {
    const userId = await service.authenticateUser(readBearerToken(request));
    const params = parseBody(DeviceParams, request.params);
    const body = parseBody(DeviceNameRequest, request.body);
    const device = await store.updateDeviceName(userId, params.deviceId, body.name);
    if (!device) throw new ControlError("DEVICE_NOT_FOUND", "设备不存在", 404);
    return { device };
  });
  app.delete("/v1/devices/:deviceId", async (request) => {
    const userId = await service.authenticateUser(readBearerToken(request));
    const params = parseBody(DeviceParams, request.params);
    if (!await store.revokeDevice(userId, params.deviceId)) {
      throw new ControlError("DEVICE_NOT_FOUND", "设备不存在", 404);
    }
    return { revoked: true };
  });
  app.post("/v1/devices/credential/exchange", async (request) => {
    const body = parseBody(DeviceCredentialRequest, request.body);
    return await service.exchangeDeviceCredential(body.credential);
  });
  app.post("/v1/devices/:deviceId/heartbeat", async (request) => {
    const authenticatedDeviceId = await service.authenticateDevice(readBearerToken(request));
    const params = parseBody(DeviceParams, request.params);
    if (authenticatedDeviceId !== params.deviceId) throw new ControlError("DEVICE_FORBIDDEN", "设备无权上报该记录", 403);
    return await service.recordHeartbeat(params.deviceId, parseBody(HeartbeatRequest, request.body));
  });
  app.post("/v1/devices/:deviceId/named-tunnel/provision", async (request, reply) => {
    const userId = await service.authenticateUser(readBearerToken(request));
    const params = parseBody(DeviceParams, request.params);
    const tunnel = await service.requestNamedTunnel(userId, params.deviceId);
    return reply.status(tunnel.status === "active" ? 200 : 202).send({ tunnel });
  });
  app.get("/v1/devices/:deviceId/tunnel-config", async (request) => {
    const authenticatedDeviceId = await service.authenticateDevice(readBearerToken(request));
    const params = parseBody(DeviceParams, request.params);
    if (authenticatedDeviceId !== params.deviceId) throw new ControlError("DEVICE_FORBIDDEN", "设备无权读取该配置", 403);
    return await service.getDeviceTunnelConfig(params.deviceId);
  });

  app.get("/v1/plans", async () => ({ plans: await store.listPlans() }));
  app.get("/v1/entitlements", async (request) => {
    const userId = await service.authenticateUser(readBearerToken(request));
    return { entitlements: await store.getEntitlements(userId) };
  });
  app.get("/v1/subscriptions/current", async (request) => {
    const userId = await service.authenticateUser(readBearerToken(request));
    return { subscription: await store.getCurrentSubscription(userId) };
  });
  app.get("/v1/orders", async (request) => {
    const userId = await service.authenticateUser(readBearerToken(request));
    return { orders: await store.listOrders(userId) };
  });
  app.post("/v1/orders", async () => {
    throw new ControlError("PAYMENT_NOT_AVAILABLE", "支付功能即将开放", 503);
  });
  app.post("/v1/orders/:orderId/pay", async () => {
    throw new ControlError("PAYMENT_NOT_AVAILABLE", "支付功能即将开放", 503);
  });
  app.post("/v1/orders/:orderId/refund", async () => {
    throw new ControlError("PAYMENT_NOT_AVAILABLE", "退款功能尚未开放", 503);
  });
  app.post("/v1/payments/callback", async () => {
    throw new ControlError("PAYMENT_NOT_AVAILABLE", "支付回调尚未开放", 503);
  });

  app.post("/v1/admin/login", async (request) => {
    const body = parseBody(AdminLoginRequest, request.body);
    rateLimiter.enforce(`admin-login:${request.ip}:${body.email.toLowerCase()}`, 8, 5 * 60_000);
    return await service.adminLogin(body.email, body.password);
  });
  app.get("/v1/admin/overview", async (request) => {
    await service.authenticateAdmin(readBearerToken(request));
    return await store.getAdminOverview();
  });
  app.get("/v1/admin/users", async (request) => {
    await service.authenticateAdmin(readBearerToken(request));
    return { users: await store.listAdminUsers() };
  });
  app.get("/v1/admin/devices", async (request) => {
    await service.authenticateAdmin(readBearerToken(request));
    return { devices: await store.listAdminDevices() };
  });
  app.get("/v1/admin/tunnels", async (request) => {
    await service.authenticateAdmin(readBearerToken(request));
    return { tunnels: await store.listAdminTunnels() };
  });
  app.get("/v1/admin/domains", async (request) => {
    await service.authenticateAdmin(readBearerToken(request));
    return { domains: await store.listAdminDomains() };
  });
  app.get("/v1/admin/subscriptions", async (request) => {
    await service.authenticateAdmin(readBearerToken(request));
    return { subscriptions: await store.listAdminSubscriptions() };
  });
  app.get("/v1/admin/orders", async (request) => {
    await service.authenticateAdmin(readBearerToken(request));
    return { orders: await store.listAdminOrders() };
  });
  app.get("/v1/admin/payments", async (request) => {
    await service.authenticateAdmin(readBearerToken(request));
    return { payments: await store.listAdminPayments() };
  });
  app.get("/v1/admin/audit-logs", async (request) => {
    await service.authenticateAdmin(readBearerToken(request));
    return { auditLogs: await store.listAdminAuditLogs() };
  });
  app.post("/v1/admin/users/:userId/formal-subscription", async (request) => {
    const adminId = await service.authenticateAdmin(readBearerToken(request), true);
    const params = parseBody(z.object({ userId: z.string().uuid() }), request.params);
    const body = parseBody(GrantRequest, request.body);
    return await service.grantFormalSubscription(adminId, params.userId, body.expiresAt, body.reason);
  });
  app.post("/v1/admin/users/:userId/status", async (request) => {
    const adminId = await service.authenticateAdmin(readBearerToken(request), true);
    const params = parseBody(z.object({ userId: z.string().uuid() }), request.params);
    const body = parseBody(StatusRequest, request.body);
    return await service.setUserStatus(adminId, params.userId, body.status, body.reason);
  });
  app.post("/v1/admin/devices/:deviceId/status", async (request) => {
    const adminId = await service.authenticateAdmin(readBearerToken(request), true);
    const params = parseBody(DeviceParams, request.params);
    const body = parseBody(StatusRequest, request.body);
    return await service.setDeviceStatus(adminId, params.deviceId, body.status, body.reason);
  });
  app.post("/v1/admin/tunnels/:tunnelId/rebuild", async (request) => {
    const adminId = await service.authenticateAdmin(readBearerToken(request), true);
    const params = parseBody(z.object({ tunnelId: z.string().uuid() }), request.params);
    const body = parseBody(z.object({ reason: z.string().trim().min(1).max(500) }), request.body);
    return await service.rebuildNamedTunnel(adminId, params.tunnelId, body.reason);
  });

  app.addHook("onClose", async () => store.close());
  return { app, service };
}

function parseBody<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ControlError("INVALID_REQUEST", "请求参数不正确", 400, parsed.error.flatten());
  }
  return parsed.data;
}

function readBearerToken(request: FastifyRequest): string {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) {
    throw new ControlError("UNAUTHENTICATED", "缺少登录凭证", 401);
  }
  return authorization.slice("Bearer ".length).trim();
}

class ApiRateLimiter {
  private readonly entries = new Map<string, { count: number; resetAt: number }>();

  enforce(key: string, limit: number, windowMs: number): void {
    const now = Date.now();
    if (this.entries.size > 10_000) {
      for (const [entryKey, value] of this.entries) {
        if (value.resetAt <= now) this.entries.delete(entryKey);
      }
    }
    const entry = this.entries.get(key);
    if (!entry || entry.resetAt <= now) {
      this.entries.set(key, { count: 1, resetAt: now + windowMs });
      return;
    }
    if (entry.count >= limit) {
      throw new ControlError("RATE_LIMITED", "操作过于频繁，请稍后重试", 429, {
        retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000))
      });
    }
    entry.count += 1;
  }
}
