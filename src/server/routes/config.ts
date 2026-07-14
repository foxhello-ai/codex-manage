import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../config";
import type { RuntimeSnapshot } from "../services/AppRuntime";

export function registerConfigRoutes(
  app: FastifyInstance,
  config: AppConfig,
  getRuntimeSnapshot?: () => RuntimeSnapshot
) {
  app.get("/api/config", async () => ({
    host: config.host,
    port: config.port,
    codexCliPath: config.codexCliPath,
    sessionsDir: config.sessionsDir,
    defaultPassword: false,
    codexCliVersion: getRuntimeSnapshot?.().codexCliVersion ?? null,
    codexVersionError: getRuntimeSnapshot?.().codexVersionError ?? null,
    appServer: getRuntimeSnapshot?.().appServer ?? null
  }));

  app.get("/api/health", async () => ({
    ok: true,
    appServer: getRuntimeSnapshot?.().appServer ?? null
  }));
}
