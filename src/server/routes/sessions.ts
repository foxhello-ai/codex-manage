import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sendError } from "../httpErrors";
import type { SessionService } from "../services/SessionService";

const ListQuery = z.object({
  search: z.string().optional(),
  limit: z.coerce.number().int().positive().max(200).optional()
});

const SessionParams = z.object({
  id: z.string().min(1)
});

const MetadataBody = z.object({
  remarkTitle: z.string().max(120).nullable()
});

export function registerSessionRoutes(app: FastifyInstance, sessionService: SessionService) {
  app.get("/api/sessions", async (request, reply) => {
    const parsed = ListQuery.safeParse(request.query);
    if (!parsed.success) {
      return sendError(reply, 400, "INVALID_SESSION_QUERY", "会话查询参数不正确");
    }

    try {
      const sessions = await sessionService.listSessions(parsed.data);
      return reply.send({ sessions });
    } catch (error) {
      return sendError(
        reply,
        503,
        "CODEX_APP_SERVER_UNAVAILABLE",
        error instanceof Error ? error.message : "Codex app-server 不可用"
      );
    }
  });


  app.get("/api/sessions/:id", async (request, reply) => {
    const params = SessionParams.safeParse(request.params);
    if (!params.success) {
      return sendError(reply, 400, "INVALID_SESSION_PARAMS", "会话参数不正确");
    }

    try {
      const session = await sessionService.getSessionDetail(params.data.id);
      return reply.send({ session });
    } catch (error) {
      if (error instanceof Error && error.message === "Session not found") {
        return sendError(reply, 404, "SESSION_NOT_FOUND", "会话不存在");
      }

      return sendError(
        reply,
        503,
        "CODEX_APP_SERVER_UNAVAILABLE",
        error instanceof Error ? error.message : "Codex app-server 不可用"
      );
    }
  });

  app.patch("/api/sessions/:id/metadata", async (request, reply) => {
    const params = SessionParams.safeParse(request.params);
    if (!params.success) {
      return sendError(reply, 400, "INVALID_SESSION_PARAMS", "会话参数不正确");
    }

    const body = MetadataBody.safeParse(request.body);
    if (!body.success) {
      return sendError(reply, 400, "INVALID_SESSION_METADATA", "会话备注标题不正确");
    }

    const remarkTitle = body.data.remarkTitle?.trim() || null;

    try {
      const session = await sessionService.updateMetadata(params.data.id, remarkTitle);
      return reply.send({ session });
    } catch (error) {
      if (error instanceof Error && error.message === "Session not found") {
        return sendError(reply, 404, "SESSION_NOT_FOUND", "会话不存在");
      }

      return sendError(
        reply,
        503,
        "CODEX_APP_SERVER_UNAVAILABLE",
        error instanceof Error ? error.message : "Codex app-server 不可用"
      );
    }
  });
}
