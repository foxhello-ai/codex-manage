import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../config";
import type { RuntimeSnapshot } from "../services/AppRuntime";

export function registerConfigRoutes(
  app: FastifyInstance,
  config: AppConfig,
  getRuntimeSnapshot?: () => RuntimeSnapshot,
  getDefaultPasswordState?: () => boolean
) {
  app.get("/api/config", async () => {
    const runtime = getRuntimeSnapshot?.();
    return {
      host: config.host,
      port: config.port,
      codexCliPath: config.codexCliPath,
      sessionsDir: config.sessionsDir,
      defaultPassword: getDefaultPasswordState?.() ?? config.defaultPassword,
      codexCliVersion: runtime?.codexCliVersion ?? null,
      codexVersionError: runtime?.codexVersionError ?? null,
      appServer: runtime?.appServer ?? null,
      runtimeReload: runtime?.runtimeReload ?? null
    };
  });

  app.get("/api/health", async () => {
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
