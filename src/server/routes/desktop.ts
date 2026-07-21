import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { LocalAuthService } from "../auth/LocalAuthService";
import { sendError } from "../httpErrors";

const SetupBody = z.object({
  password: z.string().min(8).max(256)
});

export function registerDesktopRoutes(app: FastifyInstance, authService: LocalAuthService): void {
  app.get("/api/desktop/status", async () => ({
    setupRequired: authService.isSetupRequired(),
    defaultPassword: authService.isDefaultPassword(),
    activeSessionCount: authService.listSessions().length
  }));

  app.post("/api/desktop/setup", async (request, reply) => {
    const parsed = SetupBody.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "INVALID_SETUP_BODY", "密码至少需要 8 个字符");
    }
    if (!authService.setup(parsed.data.password)) {
      return sendError(reply, 409, "AUTH_ALREADY_CONFIGURED", "本机访问密码已经设置");
    }
    return reply.send({ setupRequired: false });
  });

  app.post("/api/desktop/pairing-code", async (_request, reply) => {
    if (authService.isSetupRequired()) {
      return sendError(reply, 409, "AUTH_SETUP_REQUIRED", "请先设置本机访问密码");
    }
    return reply.send(authService.createPairingCode());
  });

  app.post("/api/desktop/logout-all", async (_request, reply) => {
    authService.revokeAllSessions();
    return reply.send({ revoked: true });
  });
}
