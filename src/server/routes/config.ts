import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../config";
import type { RuntimeSnapshot } from "../services/AppRuntime";
import { isOwner } from "../auth/session";
import { sendError } from "../httpErrors";

export function registerConfigRoutes(
  app: FastifyInstance,
  config: AppConfig,
  getRuntimeSnapshot?: () => RuntimeSnapshot
) {
  app.get("/api/config", async (request, reply) => {
    if (!isOwner(request)) return sendError(reply, 403, "OWNER_REQUIRED", "只有主用户可以查看系统配置");
    const runtime = getRuntimeSnapshot?.();
    return {
      host: config.host,
      port: config.port,
      codexCliPath: config.codexCliPath,
      sessionsDir: config.sessionsDir,
      defaultPassword: config.defaultPassword,
      codexCliVersion: runtime?.codexCliVersion ?? null,
      codexVersionError: runtime?.codexVersionError ?? null,
      appServer: runtime?.appServer ?? null,
      runtimeReload: runtime?.runtimeReload ?? null
    };
  });

  app.get("/api/health", async (request, reply) => {
    if (!isOwner(request)) return sendError(reply, 403, "OWNER_REQUIRED", "只有主用户可以查看系统诊断");
    const runtime = getRuntimeSnapshot?.();
    const appServer = runtime?.appServer ?? null;
    const codexAvailable = Boolean(runtime?.codexCliVersion);
    return {
      ok: codexAvailable && appServer?.status === "ready" && appServer.initialized,
      checkedAt: new Date().toISOString(),
      codexCli: {
        available: codexAvailable,
        version: runtime?.codexCliVersion ?? null,
        error: runtime?.codexVersionError ?? null
      },
      appServer
    };
  });
}
