import type { FastifyInstance } from "fastify";
import { isAuthenticated } from "./session";
import { sendError } from "../httpErrors";
import type { LocalAuthService } from "./LocalAuthService";

const PUBLIC_PATHS = new Set([
  "/api/login",
  "/api/me",
  "/api/local-auth/setup",
  "/api/local-auth/pair"
]);

export function registerAuthHook(
  app: FastifyInstance,
  authService?: LocalAuthService,
  desktopControlToken?: string | null
) {
  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/api")) return;
    const pathname = new URL(request.url, "http://local").pathname;
    if (PUBLIC_PATHS.has(pathname)) return;
    if (
      isDesktopControlPath(pathname)
      && desktopControlToken
      && request.headers["x-codex-desktop-token"] === desktopControlToken
    ) return;
    if (isAuthenticated(request, authService)) return;

    return sendError(reply, 401, "UNAUTHENTICATED", "请先登录");
  });
}

function isDesktopControlPath(pathname: string): boolean {
  return pathname.startsWith("/api/desktop/")
    || pathname === "/api/runtime/reload";
}
