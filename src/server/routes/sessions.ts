import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sendError } from "../httpErrors";
import type { SessionService } from "../services/SessionService";
import type { JsonlSessionParser } from "../services/JsonlSessionParser";
import type { RuntimeManager } from "../services/RuntimeManager";
import { isAuthenticated } from "../auth/session";

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

const InputBody = z.object({
  text: z.string().trim().min(1).max(20000)
});

const ApprovalParams = z.object({
  id: z.string().min(1),
  approvalId: z.string().min(1)
});

const ApprovalBody = z.object({
  decision: z.enum(["accept", "acceptForSession", "decline", "cancel"]),
  answers: z.record(z.string(), z.array(z.string().max(4000))).optional()
});

export function registerSessionRoutes(
  app: FastifyInstance,
  sessionService: SessionService,
  jsonlSessionParser?: JsonlSessionParser,
  runtimeManager?: RuntimeManager
) {
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




  app.get("/api/sessions/:id/runtime", async (request, reply) => {
    const params = SessionParams.safeParse(request.params);
    if (!params.success) {
      return sendError(reply, 400, "INVALID_SESSION_PARAMS", "会话参数不正确");
    }

    if (!runtimeManager) {
      return sendError(reply, 503, "RUNTIME_UNAVAILABLE", "运行态管理器不可用");
    }

    return reply.send({ runtime: runtimeManager.getRuntime(params.data.id) });
  });

  app.post("/api/sessions/:id/resume", async (request, reply) => {
    const params = SessionParams.safeParse(request.params);
    if (!params.success) {
      return sendError(reply, 400, "INVALID_SESSION_PARAMS", "会话参数不正确");
    }

    if (!runtimeManager) {
      return sendError(reply, 503, "RUNTIME_UNAVAILABLE", "运行态管理器不可用");
    }

    try {
      const runtime = await runtimeManager.resumeThread(params.data.id);
      return reply.send({ runtime });
    } catch (error) {
      return sendError(reply, 503, "SESSION_RESUME_FAILED", error instanceof Error ? error.message : "会话恢复失败");
    }
  });

  app.post("/api/sessions/:id/input", async (request, reply) => {
    const params = SessionParams.safeParse(request.params);
    if (!params.success) {
      return sendError(reply, 400, "INVALID_SESSION_PARAMS", "会话参数不正确");
    }

    const body = InputBody.safeParse(request.body);
    if (!body.success) {
      return sendError(reply, 400, "INVALID_SESSION_INPUT", "输入内容不正确");
    }

    if (!runtimeManager) {
      return sendError(reply, 503, "RUNTIME_UNAVAILABLE", "运行态管理器不可用");
    }

    try {
      const runtime = await runtimeManager.sendInput(params.data.id, body.data);
      return reply.send({ runtime });
    } catch (error) {
      return sendError(reply, 409, "SESSION_INPUT_FAILED", error instanceof Error ? error.message : "任务发送失败");
    }
  });

  app.post("/api/sessions/:id/approvals/:approvalId", async (request, reply) => {
    const params = ApprovalParams.safeParse(request.params);
    if (!params.success) {
      return sendError(reply, 400, "INVALID_APPROVAL_PARAMS", "审批参数不正确");
    }

    const body = ApprovalBody.safeParse(request.body);
    if (!body.success) {
      return sendError(reply, 400, "INVALID_APPROVAL_BODY", "审批内容不正确");
    }

    if (!runtimeManager) {
      return sendError(reply, 503, "RUNTIME_UNAVAILABLE", "运行态管理器不可用");
    }

    try {
      const result = runtimeManager.submitApproval(params.data.id, params.data.approvalId, body.data);
      return reply.send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "审批处理失败";
      return sendError(reply, message.includes("not found") ? 404 : 409, "APPROVAL_FAILED", message);
    }
  });

  if (runtimeManager) {
    app.get("/api/sessions/:id/ws", { websocket: true }, (socket, request) => {
      const params = SessionParams.safeParse(request.params);
      if (!params.success || !isAuthenticated(request)) {
        socket.close(1008, "unauthenticated");
        return;
      }

      const threadId = params.data.id;
      const query = request.query && typeof request.query === "object" ? (request.query as Record<string, unknown>) : {};
      const afterSeq = Number(query.afterSeq ?? 0);

      const send = (message: unknown) => {
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify(message));
        }
      };

      send({
        seq: runtimeManager.eventHub.getLastSeq(threadId),
        threadId,
        type: "snapshot",
        payload: {
          runtime: runtimeManager.getRuntime(threadId),
          approvals: runtimeManager.approvalService.listPending(threadId),
          events: runtimeManager.eventHub.getEvents(threadId, Number.isFinite(afterSeq) ? afterSeq : 0)
        },
        createdAt: new Date().toISOString()
      });

      const unsubscribe = runtimeManager.eventHub.subscribe(threadId, send);
      socket.on("close", unsubscribe);
      socket.on("error", unsubscribe);
    });
  }

  app.get("/api/sessions/:id/commands", async (request, reply) => {
    const params = SessionParams.safeParse(request.params);
    if (!params.success) {
      return sendError(reply, 400, "INVALID_SESSION_PARAMS", "会话参数不正确");
    }

    if (!jsonlSessionParser) {
      return sendError(reply, 503, "JSONL_PARSER_UNAVAILABLE", "历史命令解析器不可用");
    }

    try {
      const result = await jsonlSessionParser.listCommands(params.data.id);
      return reply.send(result);
    } catch (error) {
      return sendError(
        reply,
        500,
        "SESSION_COMMANDS_UNAVAILABLE",
        error instanceof Error ? error.message : "历史命令读取失败"
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
