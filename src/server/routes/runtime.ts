import type { FastifyInstance } from "fastify";
import { sendError } from "../httpErrors";
import { RuntimeReloadBlockedError, type AppRuntime } from "../services/AppRuntime";
import type { ModelCatalogService } from "../services/ModelCatalogService";

export function registerRuntimeRoutes(
  app: FastifyInstance,
  runtime: AppRuntime,
  modelCatalog: ModelCatalogService
): void {
  app.post("/api/runtime/reload", async (_request, reply) => {
    try {
      const result = await runtime.reloadAppServer();
      modelCatalog.invalidate();
      return reply.send({ runtime: result });
    } catch (error) {
      if (error instanceof RuntimeReloadBlockedError) {
        return sendError(reply, error.statusCode, error.code, error.message, error.details);
      }
      return sendError(
        reply,
        503,
        "RUNTIME_RELOAD_FAILED",
        error instanceof Error ? error.message : "Codex 运行时刷新失败"
      );
    }
  });
}
