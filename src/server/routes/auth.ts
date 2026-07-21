import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../config";
import type { LocalAuthService } from "../auth/LocalAuthService";
import { clearAuthCookie, getAuthToken, isAuthenticated, setAuthCookie } from "../auth/session";
import { sendError } from "../httpErrors";
import { LocalRateLimiter } from "../security/LocalRateLimiter";
import { requestClientKey } from "../security/requestSecurity";

const LoginBody = z.object({
  password: z.string().min(1)
});

const SetupBody = z.object({
  password: z.string().min(8).max(256)
});

const PairBody = z.object({
  code: z.string().min(20).max(256)
});

const SessionParams = z.object({
  sessionId: z.string().uuid()
});

export function registerAuthRoutes(app: FastifyInstance, config: AppConfig, authService: LocalAuthService) {
  const rateLimiter = new LocalRateLimiter();

  app.post("/api/login", async (request, reply) => {
    if (!consumeRateLimit(rateLimiter, requestClientKey(request), "login", 10, reply)) return;
    const parsed = LoginBody.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "INVALID_LOGIN_BODY", "登录参数不正确");
    }

    if (authService.isSetupRequired()) {
      return sendError(reply, 409, "AUTH_SETUP_REQUIRED", "请先设置本机访问密码");
    }

    if (!authService.verifyPassword(parsed.data.password)) {
      return sendError(reply, 401, "INVALID_PASSWORD", "密码错误");
    }

    const issued = authService.createSession("password", request.headers["user-agent"] ?? null);
    setAuthCookie(request, reply, config, issued.token);
    return reply.send({
      authenticated: true,
      defaultPassword: authService.isDefaultPassword(),
      setupRequired: false
    });
  });

  app.post("/api/logout", async (request, reply) => {
    authService.revokeSessionToken(getAuthToken(request));
    clearAuthCookie(reply);
    return reply.send({
      authenticated: false,
      defaultPassword: authService.isDefaultPassword(),
      setupRequired: authService.isSetupRequired()
    });
  });

  app.get("/api/me", async (request) => ({
    authenticated: isAuthenticated(request, authService),
    defaultPassword: authService.isDefaultPassword(),
    setupRequired: authService.isSetupRequired()
  }));

  app.post("/api/local-auth/setup", async (request, reply) => {
    if (!consumeRateLimit(rateLimiter, requestClientKey(request), "setup", 5, reply)) return;
    const parsed = SetupBody.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "INVALID_SETUP_BODY", "密码至少需要 8 个字符");
    }
    if (!authService.setup(parsed.data.password)) {
      return sendError(reply, 409, "AUTH_ALREADY_CONFIGURED", "本机访问密码已经设置");
    }

    const issued = authService.createSession("password", request.headers["user-agent"] ?? null);
    setAuthCookie(request, reply, config, issued.token);
    return reply.send({
      authenticated: true,
      defaultPassword: false,
      setupRequired: false
    });
  });

  app.post("/api/local-auth/pairing-code", async (_request, reply) => {
    if (!consumeRateLimit(rateLimiter, "pairing-code:authenticated", "pairing-code", 30, reply)) return;
    return reply.send(authService.createPairingCode());
  });

  app.post("/api/local-auth/pair", async (request, reply) => {
    if (!consumeRateLimit(rateLimiter, requestClientKey(request), "pair", 20, reply)) return;
    const parsed = PairBody.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "INVALID_PAIRING_CODE", "配对码格式不正确");
    }
    const issued = authService.consumePairingCode(parsed.data.code, request.headers["user-agent"] ?? null);
    if (!issued) {
      return sendError(reply, 401, "PAIRING_CODE_INVALID", "配对码无效或已过期");
    }

    setAuthCookie(request, reply, config, issued.token);
    return reply.send({
      authenticated: true,
      defaultPassword: authService.isDefaultPassword(),
      setupRequired: false
    });
  });

  app.get("/api/local-auth/sessions", async () => ({
    sessions: authService.listSessions()
  }));

  app.delete("/api/local-auth/sessions/:sessionId", async (request, reply) => {
    const parsed = SessionParams.safeParse(request.params);
    if (!parsed.success) {
      return sendError(reply, 400, "INVALID_SESSION_ID", "登录会话 ID 不正确");
    }
    if (!authService.revokeSessionById(parsed.data.sessionId)) {
      return sendError(reply, 404, "SESSION_NOT_FOUND", "登录会话不存在");
    }
    return reply.send({ revoked: true });
  });

  app.post("/api/local-auth/logout-all", async (_request, reply) => {
    authService.revokeAllSessions();
    clearAuthCookie(reply);
    return reply.send({
      authenticated: false,
      defaultPassword: authService.isDefaultPassword(),
      setupRequired: false
    });
  });
}

function consumeRateLimit(
  rateLimiter: LocalRateLimiter,
  clientKey: string,
  scope: string,
  limit: number,
  reply: Parameters<typeof sendError>[0]
): boolean {
  const result = rateLimiter.consume(`${scope}:${clientKey}`, limit, 60_000);
  if (result.allowed) return true;
  reply.header("retry-after", String(result.retryAfterSeconds));
  sendError(reply, 429, "RATE_LIMITED", "操作过于频繁，请稍后重试");
  return false;
}
