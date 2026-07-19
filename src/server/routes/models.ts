import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sendError } from "../httpErrors";
import { ModelDomainError, sanitizeModelError } from "../modelErrors";
import type { ModelCatalogService } from "../services/ModelCatalogService";

const ModelListQuery = z.object({
  refresh: z.union([z.literal("true"), z.literal("false"), z.boolean()]).optional()
});

export function registerModelRoutes(app: FastifyInstance, modelCatalog: ModelCatalogService) {
  app.get("/api/models", async (request, reply) => {
    const query = ModelListQuery.safeParse(request.query ?? {});
    if (!query.success) {
      return sendError(reply, 400, "INVALID_MODEL_QUERY", "模型查询参数不正确");
    }

    try {
      const result = await modelCatalog.list({
        forceRefresh: query.data.refresh === true || query.data.refresh === "true"
      });
      return reply.send(result);
    } catch (error) {
      if (error instanceof ModelDomainError) {
        return sendError(reply, error.statusCode, error.code, error.message, error.details);
      }
      return sendError(reply, 503, "MODEL_LIST_UNAVAILABLE", "无法读取当前支持模型列表", {
        cause: sanitizeModelError(error)
      });
    }
  });
}
