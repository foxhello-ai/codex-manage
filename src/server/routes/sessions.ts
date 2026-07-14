import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sendError } from "../httpErrors";
import type { SessionService } from "../services/SessionService";

const ListQuery = z.object({
  search: z.string().optional(),
  limit: z.coerce.number().int().positive().max(200).optional()
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
}
