import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../config";
import { clearAuthCookie, isAuthenticated, setAuthCookie } from "../auth/session";
import { sendError } from "../httpErrors";

const LoginBody = z.object({
  password: z.string().min(1)
});

export function registerAuthRoutes(app: FastifyInstance, config: AppConfig) {
  app.post("/api/login", async (request, reply) => {
    const parsed = LoginBody.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "INVALID_LOGIN_BODY", "登录参数不正确");
    }

    if (parsed.data.password !== config.password) {
      return sendError(reply, 401, "INVALID_PASSWORD", "密码错误");
    }

    setAuthCookie(reply, config);
    return reply.send({
      authenticated: true,
      defaultPassword: false
    });
  });

  app.post("/api/logout", async (_request, reply) => {
    clearAuthCookie(reply);
    return reply.send({
      authenticated: false,
      defaultPassword: false
    });
  });

  app.get("/api/me", async (request) => ({
    authenticated: isAuthenticated(request),
    defaultPassword: false
  }));
}
