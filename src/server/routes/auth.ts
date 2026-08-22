import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../config";
import { clearAuthCookie, resolveAuthUser, setAuthCookie } from "../auth/session";
import { sendError } from "../httpErrors";
import type { CollaborationStore } from "../services/CollaborationStore";

const LoginBody = z.object({
  password: z.string().min(1),
  accountId: z.string().trim().min(1).optional()
});

export function registerAuthRoutes(app: FastifyInstance, config: AppConfig, collaborationStore?: CollaborationStore) {
  app.get("/api/child-accounts", async (_request, reply) => {
    const accounts = collaborationStore ? await collaborationStore.listLoginAccounts() : [];
    const owner = collaborationStore?.ownerIdentity();
    return reply.send({
      accounts: [
        {
          id: "owner",
          role: "owner" as const,
          displayName: owner?.displayName ?? config.ownerName,
          localEmail: owner?.localEmail ?? config.ownerEmail
        },
        ...accounts
      ]
    });
  });

  app.post("/api/login", async (request, reply) => {
    const parsed = LoginBody.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "INVALID_LOGIN_BODY", "登录参数不正确");
    }

    const accountId = parsed.data.accountId ?? "owner";
    if (accountId !== "owner") {
      const child = collaborationStore
        ? await collaborationStore.authenticateChild(accountId, parsed.data.password)
        : null;
      if (!child) return sendError(reply, 401, "INVALID_PASSWORD", "密码错误");
      setAuthCookie(reply, config, child.id);
      return reply.send({
        authenticated: true,
        defaultPassword: false,
        user: child
      });
    }

    if (parsed.data.password !== config.password) {
      return sendError(reply, 401, "INVALID_PASSWORD", "密码错误");
    }

    const owner = collaborationStore?.ownerIdentity();
    setAuthCookie(reply, config, owner?.id ?? "owner");
    return reply.send({
      authenticated: true,
      defaultPassword: config.defaultPassword,
      user: owner
    });
  });

  app.post("/api/logout", async (_request, reply) => {
    clearAuthCookie(reply);
    return reply.send({
      authenticated: false,
      defaultPassword: false
    });
  });

  app.get("/api/me", async (request) => {
    const user = await resolveAuthUser(request, collaborationStore);
    if (!user) {
      return {
        authenticated: false,
        defaultPassword: false
      };
    }
    return {
      authenticated: true,
      defaultPassword: user.role === "owner" ? config.defaultPassword : false,
      user
    };
  });
}
