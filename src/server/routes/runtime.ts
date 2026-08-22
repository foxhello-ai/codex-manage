import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sendError } from "../httpErrors";
import { RuntimeReloadBlockedError, type AppRuntime } from "../services/AppRuntime";
import type { ModelCatalogService } from "../services/ModelCatalogService";
import { isOwner } from "../auth/session";

const ReloadRequest = z.object({
  trigger: z.enum(["manual", "desktop_auto", "config_watcher"]).default("manual"),
  reason: z.string().trim().max(200).nullable().default(null)
});

export function registerRuntimeRoutes(
  app: FastifyInstance,
  runtime: AppRuntime,
  modelCatalog: ModelCatalogService
): void {
  app.post("/api/runtime/reload", async (request, reply) => {
    if (!isOwner(request)) return sendError(reply, 403, "OWNER_REQUIRED", "只有主用户可以刷新运行时");
    const parsed = ReloadRequest.safeParse(request.body ?? {});
    if (!parsed.success) {
      return sendError(reply, 400, "INVALID_RUNTIME_RELOAD_BODY", "运行时刷新请求格式不正确", parsed.error.flatten());
    }

    try {
      const result = await runtime.reloadAppServer(parsed.data);
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
