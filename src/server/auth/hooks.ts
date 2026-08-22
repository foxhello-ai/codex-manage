import type { FastifyInstance } from "fastify";
import { resolveAuthUser } from "./session";
import { sendError } from "../httpErrors";
import type { CollaborationStore } from "../services/CollaborationStore";

const PUBLIC_PATHS = new Set(["/api/login", "/api/child-login", "/api/child-accounts", "/api/me"]);

export function registerAuthHook(app: FastifyInstance, collaborationStore?: CollaborationStore) {
  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/api")) return;
    const pathname = new URL(request.url, "http://local").pathname;
    if (PUBLIC_PATHS.has(pathname)) return;
    const user = await resolveAuthUser(request, collaborationStore);
    if (user) {
      request.authUser = user;
      return;
    }

    return sendError(reply, 401, "UNAUTHENTICATED", "请先登录");
  });
}
