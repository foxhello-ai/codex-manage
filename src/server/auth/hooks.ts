import type { FastifyInstance } from "fastify";
import { resolveAuthUser } from "./session";
import { sendError } from "../httpErrors";
import type { LocalAuthService } from "./LocalAuthService";
import type { CollaborationStore } from "../services/CollaborationStore";

const PUBLIC_PATHS = new Set([
  "/api/login",
  "/api/me",
  "/api/child-login",
  "/api/child-accounts",
  "/api/local-auth/setup",
  "/api/local-auth/pair"
]);

export function registerAuthHook(
  app: FastifyInstance,
  authOrCollaboration?: LocalAuthService | CollaborationStore,
  desktopControlToken?: string | null,
  collaborationStore?: CollaborationStore
) {
  const authService = isLocalAuthService(authOrCollaboration) ? authOrCollaboration : undefined;
  const store = isCollaborationStore(authOrCollaboration) ? authOrCollaboration : collaborationStore;

  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/api")) return;
    const pathname = new URL(request.url, "http://local").pathname;
    if (PUBLIC_PATHS.has(pathname)) return;
    if (
      isDesktopControlPath(pathname)
      && desktopControlToken
      && request.headers["x-codex-desktop-token"] === desktopControlToken
    ) return;

    const user = await resolveAuthUser(request, store, authService);
    if (user) {
      request.authUser = user;
      return;
    }

    return sendError(reply, 401, "UNAUTHENTICATED", "请先登录");
  });
}

function isLocalAuthService(value: LocalAuthService | CollaborationStore | undefined): value is LocalAuthService {
  return Boolean(value && "authenticate" in value);
}

function isCollaborationStore(value: LocalAuthService | CollaborationStore | undefined): value is CollaborationStore {
  return Boolean(value && "resolveIdentity" in value);
}

function isDesktopControlPath(pathname: string): boolean {
  return pathname.startsWith("/api/desktop/") || pathname === "/api/runtime/reload";
}
