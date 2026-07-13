import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../config";

export function registerConfigRoutes(app: FastifyInstance, config: AppConfig) {
  app.get("/api/config", async () => ({
    host: config.host,
    port: config.port,
    codexCliPath: config.codexCliPath,
    sessionsDir: config.sessionsDir,
    defaultPassword: config.password === "admin"
  }));

  app.get("/api/health", async () => ({
    ok: true
  }));
}
