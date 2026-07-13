import type { FastifyInstance } from "fastify";
import { isAuthenticated } from "./session";
import { sendError } from "../httpErrors";

const PUBLIC_PATHS = new Set(["/api/login", "/api/me"]);

export function registerAuthHook(app: FastifyInstance) {
  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/api")) return;
    const pathname = new URL(request.url, "http://local").pathname;
    if (PUBLIC_PATHS.has(pathname)) return;
    if (isAuthenticated(request)) return;

    return sendError(reply, 401, "UNAUTHENTICATED", "请先登录");
  });
}
