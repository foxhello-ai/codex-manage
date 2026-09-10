import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sendError } from "../httpErrors";
import { ModelDomainError, sanitizeModelError } from "../modelErrors";
import type { SessionService } from "../services/SessionService";
import type { JsonlSessionParser } from "../services/JsonlSessionParser";
import type { RuntimeManager } from "../services/RuntimeManager";
import type { SessionModelService } from "../services/SessionModelService";
import { ownerIdentity, resolveAuthUser } from "../auth/session";
import type { RuntimeSnapshot, SessionBranchMode, SessionPermissionMode, SessionSummary, UserIdentity } from "../../shared/models";
import type { CollaborationStore } from "../services/CollaborationStore";

const ListQuery = z.object({
  search: z.string().optional(),
  limit: z.coerce.number().int().positive().max(200).optional()
});

const CreateSessionBody = z.object({
  cwd: z.string().trim().min(1).max(4096)
});

const SessionParams = z.object({
  id: z.string().min(1)
});

const SessionDetailQuery = z.object({
  turns: z.union([z.literal("true"), z.literal("false"), z.boolean()]).optional()
});

const MetadataBody = z.object({
  remarkTitle: z.string().max(120).nullable()
});

const PermissionMode = z.enum(["default", "full_access"]);

const ResumeBody = z.object({
  permissionMode: PermissionMode.optional(),
  model: z.string().trim().min(1).max(200).nullable().optional(),
  reasoningEffort: z.string().trim().min(1).max(40).nullable().optional()
});

const InputBody = z.object({
  text: z.string().trim().min(1).max(20000),
  permissionMode: PermissionMode.optional()
});

const BranchBody = z.object({
  mode: z.enum(["compact_new_topic", "full_fork"] satisfies [SessionBranchMode, SessionBranchMode])
});

const HistoryContinuationBody = z.object({
  cwd: z.string().trim().min(1).max(4096),
  sourceTitle: z.string().trim().max(120),
  text: z.string().trim().min(1).max(20000),
  permissionMode: PermissionMode.optional()
});

const UpdateModelBody = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("follow_session"),
    model: z.null().optional(),
    reasoningEffort: z.null().optional()
  }),
  z.object({
    mode: z.literal("override"),
    model: z.string().trim().min(1).max(200),
    reasoningEffort: z.string().trim().min(1).max(40).nullable().optional()
  })
]);

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
  runtimeManager?: RuntimeManager,
  sessionModelService?: SessionModelService,
  collaborationStore?: CollaborationStore
) {
  app.post("/api/sessions", async (request, reply) => {
    const body = CreateSessionBody.safeParse(request.body);
    if (!body.success) {
      return sendError(reply, 400, "INVALID_SESSION_CREATE", "新会话工作目录不正确");
    }

    if (!runtimeManager) {
      return sendError(reply, 503, "RUNTIME_UNAVAILABLE", "运行态管理器不可用");
    }

    const user = await resolveRouteUser(request, collaborationStore);
    if (!user) return sendError(reply, 401, "UNAUTHENTICATED", "请先登录");
    if (user.role === "child") return sendError(reply, 403, "OWNER_REQUIRED", "子用户不能创建新会话");

    try {
      const result = await runtimeManager.startThread(body.data.cwd);
      return reply.status(201).send({ threadId: result.threadId, runtime: result.runtime });
    } catch (error) {
      return sendError(reply, 503, "SESSION_CREATE_FAILED", sanitizeModelError(error));
    }
  });

  app.get("/api/sessions", async (request, reply) => {
    const parsed = ListQuery.safeParse(request.query);
    if (!parsed.success) {
      return sendError(reply, 400, "INVALID_SESSION_QUERY", "会话查询参数不正确");
    }

    try {
      const user = await resolveRouteUser(request, collaborationStore);
      if (!user) return sendError(reply, 401, "UNAUTHENTICATED", "请先登录");
      const sessions = await sessionService.listSessions(parsed.data);
      return reply.send({ sessions: collaborationStore ? await collaborationStore.filterSessions(user.id, sessions) : sessions });
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

    const user = await requireSessionAccess(request, reply, params.data.id, collaborationStore);
    if (!user) return;

    try {
      const runtime = user.role === "child"
        ? await ensureChildControlledRuntime(user, params.data.id, runtimeManager)
        : runtimeManager.hydratePermissionMode(
            params.data.id,
            await readStoredPermissionMode(sessionService, params.data.id) ?? "default"
          );
      return reply.send({ runtime });
    } catch (error) {
      return sendChildRuntimeError(reply, error);
    }
  });

  app.patch("/api/sessions/:id/model", async (request, reply) => {
    const params = SessionParams.safeParse(request.params);
    if (!params.success) {
      return sendError(reply, 400, "INVALID_SESSION_PARAMS", "会话参数不正确");
    }
    const body = UpdateModelBody.safeParse(request.body);
    if (!body.success) {
      return sendError(reply, 400, "INVALID_MODEL_SELECTION", "模型选择参数不正确");
    }
    if (!sessionModelService) {
      return sendError(reply, 503, "MODEL_SERVICE_UNAVAILABLE", "模型服务不可用");
    }

    const user = await requireSessionAccess(request, reply, params.data.id, collaborationStore);
    if (!user) return;

    try {
      if (runtimeManager) await ensureChildControlledRuntime(user, params.data.id, runtimeManager);
      const result = await sessionModelService.updateSelection(params.data.id, body.data);
      return reply.status(result.confirmationPending ? 202 : 200).send(result);
    } catch (error) {
      if (error instanceof Error && error.message === "CHILD_RUNTIME_REQUIRES_CONTROLLED_MODE") {
        return sendChildRuntimeError(reply, error);
      }
      return sendModelError(reply, error);
    }
  });

  app.post("/api/sessions/:id/resume", async (request, reply) => {
    const params = SessionParams.safeParse(request.params);
    if (!params.success) {
      return sendError(reply, 400, "INVALID_SESSION_PARAMS", "会话参数不正确");
    }

    const body = ResumeBody.safeParse(request.body ?? {});
    if (!body.success) {
      return sendError(reply, 400, "INVALID_PERMISSION_MODE", "会话权限模式不正确");
    }

    if (!runtimeManager) {
      return sendError(reply, 503, "RUNTIME_UNAVAILABLE", "运行态管理器不可用");
    }

    const user = await requireSessionAccess(request, reply, params.data.id, collaborationStore);
    if (!user) return;
    if (user.role === "child" && body.data.permissionMode === "full_access") {
      return sendError(reply, 403, "FULL_ACCESS_FORBIDDEN", "子用户只能使用默认受控模式");
    }

    try {
      await ensureChildControlledRuntime(user, params.data.id, runtimeManager);
      const permissionMode = user.role === "child"
        ? "default"
        : body.data.permissionMode
          ?? await readStoredPermissionMode(sessionService, params.data.id)
          ?? "default";
      if (user.role !== "child" && body.data.permissionMode !== undefined) {
        await persistPermissionMode(sessionService, params.data.id, permissionMode);
      }
      const modelOverride = sessionModelService
        ? await sessionModelService.resolveForResume(
            params.data.id,
            body.data.model ? { model: body.data.model, reasoningEffort: body.data.reasoningEffort } : undefined
          )
        : undefined;
      const runtime = await runtimeManager.resumeThread(params.data.id, {
        permissionMode,
        modelOverride
      });
      return reply.send({ runtime });
    } catch (error) {
      if (error instanceof ModelDomainError) return sendModelError(reply, error);
      if (error instanceof Error && error.message === "CHILD_RUNTIME_REQUIRES_CONTROLLED_MODE") {
        return sendChildRuntimeError(reply, error);
      }
      if (isActiveWriterError(error)) {
        return sendActiveWriterError(reply, error);
      }
      return sendError(reply, 503, "SESSION_RESUME_FAILED", sanitizeModelError(error));
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

    const user = await requireSessionAccess(request, reply, params.data.id, collaborationStore);
    if (!user) return;
    if (user.role === "child" && body.data.permissionMode === "full_access") {
      return sendError(reply, 403, "FULL_ACCESS_FORBIDDEN", "子用户只能使用默认受控模式");
    }

    try {
      await ensureChildControlledRuntime(user, params.data.id, runtimeManager);
      const currentRuntime = runtimeManager.getRuntime(params.data.id);
      const storedPermissionMode = user.role === "child"
        ? null
        : await readStoredPermissionMode(sessionService, params.data.id);
      const permissionMode = user.role === "child"
        ? "default"
        : isLiveRuntime(currentRuntime)
          ? currentRuntime.permissionMode
          : body.data.permissionMode === "full_access"
            ? "full_access"
            : storedPermissionMode ?? "default";
      if (user.role !== "child" && permissionMode === "full_access" && storedPermissionMode !== "full_access") {
        await persistPermissionMode(sessionService, params.data.id, permissionMode);
      }
      const modelOverride = sessionModelService
        ? await sessionModelService.resolveForTurn(params.data.id)
        : undefined;
      const runtime = await runtimeManager.sendInput(params.data.id, {
        ...body.data,
        permissionMode,
        modelOverride
      });
      return reply.send({ runtime });
    } catch (error) {
      if (error instanceof ModelDomainError) return sendModelError(reply, error);
      if (error instanceof Error && error.message === "CHILD_RUNTIME_REQUIRES_CONTROLLED_MODE") {
        return sendChildRuntimeError(reply, error);
      }
      if (isActiveWriterError(error)) {
        return sendActiveWriterError(reply, error);
      }
      return sendError(reply, 409, "SESSION_INPUT_FAILED", sanitizeModelError(error));
    }
  });

  app.post("/api/sessions/:id/branch", async (request, reply) => {
    const params = SessionParams.safeParse(request.params);
    if (!params.success) {
      return sendError(reply, 400, "INVALID_SESSION_PARAMS", "会话参数不正确");
    }

    const body = BranchBody.safeParse(request.body);
    if (!body.success) {
      return sendError(reply, 400, "INVALID_SESSION_BRANCH", "分支模式不正确");
    }

    if (!runtimeManager) {
      return sendError(reply, 503, "RUNTIME_UNAVAILABLE", "运行态管理器不可用");
    }

    const user = await requireSessionAccess(request, reply, params.data.id, collaborationStore);
    if (!user) return;

    try {
      await ensureChildControlledRuntime(user, params.data.id, runtimeManager);
      const sourceSession = await sessionService.getSessionDetail(params.data.id, { includeTurns: false });
      const sourcePermissionMode = await readStoredPermissionMode(sessionService, params.data.id);
      if (sourcePermissionMode && typeof runtimeManager.hydratePermissionMode === "function") {
        runtimeManager.hydratePermissionMode(params.data.id, sourcePermissionMode);
      }
      const result = await runtimeManager.branchThread(params.data.id, body.data.mode);
      await sessionService.updateMetadata(
        result.threadId,
        makeBranchTitle(sourceSession.title, body.data.mode)
      );
      await persistPermissionMode(sessionService, result.threadId, result.runtime.permissionMode);
      const session = await sessionService.getSessionDetail(result.threadId, { includeTurns: true });
      return reply.status(201).send({ session, runtime: result.runtime, mode: body.data.mode });
    } catch (error) {
      if (error instanceof Error && error.message === "CHILD_RUNTIME_REQUIRES_CONTROLLED_MODE") {
        return sendChildRuntimeError(reply, error);
      }
      if (isActiveWriterError(error)) {
        return sendActiveWriterError(reply, error);
      }
      return sendError(reply, 409, "SESSION_BRANCH_FAILED", sanitizeModelError(error));
    }
  });

  app.post("/api/sessions/:id/continue-from-history", async (request, reply) => {
    const params = SessionParams.safeParse(request.params);
    if (!params.success) {
      return sendError(reply, 400, "INVALID_SESSION_PARAMS", "会话参数不正确");
    }

    const body = HistoryContinuationBody.safeParse(request.body);
    if (!body.success) {
      return sendError(reply, 400, "INVALID_HISTORY_CONTINUATION", "历史续聊参数不正确");
    }

    if (!runtimeManager) {
      return sendError(reply, 503, "RUNTIME_UNAVAILABLE", "运行态管理器不可用");
    }

    const user = await requireSessionAccess(request, reply, params.data.id, collaborationStore);
    if (!user) return;
    if (user.role === "child") return sendError(reply, 403, "OWNER_REQUIRED", "子用户不能创建历史续聊会话");

    const sourcePermissionMode = await readStoredPermissionMode(sessionService, params.data.id);
    const permissionMode = body.data.permissionMode ?? sourcePermissionMode ?? "default";

    try {
      const modelOverride = sessionModelService
        ? await sessionModelService.resolveForTurn(params.data.id).catch(() => undefined)
        : undefined;
      const result = await runtimeManager.startHistoryContinuation(
        body.data.cwd,
        params.data.id,
        body.data.text,
        { permissionMode, modelOverride }
      );
      const title = makeHistoryContinuationTitle(body.data.sourceTitle);
      let metadataError: string | null = null;
      try {
        await sessionService.setRemarkTitle(result.threadId, title);
        await persistPermissionMode(sessionService, result.threadId, result.runtime.permissionMode);
      } catch (error) {
        metadataError = sanitizeModelError(error);
      }

      const session = makeHistoryContinuationSession(result.threadId, title, body.data.cwd, result.runtime);
      return reply.status(201).send({
        session,
        runtime: result.runtime,
        sourceSessionId: params.data.id,
        inputError: result.inputError,
        metadataError
      });
    } catch (error) {
      return sendError(reply, 409, "SESSION_HISTORY_CONTINUATION_FAILED", sanitizeModelError(error));
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

    const user = await requireSessionAccess(request, reply, params.data.id, collaborationStore);
    if (!user) return;

    try {
      await ensureChildControlledRuntime(user, params.data.id, runtimeManager);
      const result = runtimeManager.submitApproval(params.data.id, params.data.approvalId, body.data);
      return reply.send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "审批处理失败";
      if (message === "CHILD_RUNTIME_REQUIRES_CONTROLLED_MODE") return sendChildRuntimeError(reply, error);
      return sendError(reply, message.includes("not found") ? 404 : 409, "APPROVAL_FAILED", message);
    }
  });

  if (runtimeManager) {
    app.get("/api/sessions/:id/ws", { websocket: true }, async (socket, request) => {
      const params = SessionParams.safeParse(request.params);
      if (!params.success) {
        socket.close(1008, "unauthenticated");
        return;
      }

      const user = await resolveRouteUser(request, collaborationStore);
      if (!user || (collaborationStore && user.role === "child" && !(await collaborationStore.canAccessSession(user.id, params.data.id)))) {
        socket.close(1008, "forbidden");
        return;
      }

      const threadId = params.data.id;
      try {
        await ensureChildControlledRuntime(user, threadId, runtimeManager);
      } catch {
        socket.close(1008, "controlled mode required");
        return;
      }
      const query = request.query && typeof request.query === "object" ? (request.query as Record<string, unknown>) : {};
      const afterSeq = Number(query.afterSeq ?? 0);

      const send = (message: unknown) => {
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify(message));
        }
      };

      // Subscribe before taking/sending the initial snapshot. If an approval
      // arrives between those two operations, the subscriber must receive it;
      // otherwise the client can miss both the snapshot state and the live
      // approval_requested event until the next browser refresh.
      const unsubscribe = runtimeManager.eventHub.subscribe(threadId, send);

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

      let closed = false;
      const accessTimer = collaborationStore && user.role === "child"
        ? setInterval(() => {
            void collaborationStore.canAccessSession(user.id, threadId).then((allowed) => {
              if (!allowed && socket.readyState === socket.OPEN) socket.close(1008, "access revoked");
            }).catch(() => {
              if (socket.readyState === socket.OPEN) socket.close(1011, "access check failed");
            });
          }, 1000)
        : null;
      accessTimer?.unref?.();
      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (accessTimer) clearInterval(accessTimer);
        unsubscribe();
      };
      socket.on("close", cleanup);
      socket.on("error", cleanup);
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

    const user = await requireSessionAccess(request, reply, params.data.id, collaborationStore);
    if (!user) return;

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
    const query = SessionDetailQuery.safeParse(request.query ?? {});
    if (!query.success) {
      return sendError(reply, 400, "INVALID_SESSION_QUERY", "会话详情查询参数不正确");
    }

    const user = await requireSessionAccess(request, reply, params.data.id, collaborationStore);
    if (!user) return;

    try {
      const session = await sessionService.getSessionDetail(params.data.id, {
        includeTurns: query.data.turns !== false && query.data.turns !== "false"
      });
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

    const user = await requireSessionAccess(request, reply, params.data.id, collaborationStore);
    if (!user) return;
    if (user.role === "child") return sendError(reply, 403, "OWNER_REQUIRED", "子用户不能修改会话元数据");

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

async function resolveRouteUser(request: Parameters<typeof resolveAuthUser>[0], collaborationStore?: CollaborationStore): Promise<UserIdentity | null> {
  if (!collaborationStore) return request.authUser ?? ownerIdentity();
  return await resolveAuthUser(request, collaborationStore);
}

async function requireSessionAccess(
  request: Parameters<typeof resolveAuthUser>[0],
  reply: Parameters<typeof sendError>[0],
  sessionId: string,
  collaborationStore?: CollaborationStore
): Promise<UserIdentity | null> {
  const user = await resolveRouteUser(request, collaborationStore);
  if (!user) {
    sendError(reply, 401, "UNAUTHENTICATED", "请先登录");
    return null;
  }
  if (collaborationStore && user.role === "child" && !(await collaborationStore.canAccessSession(user.id, sessionId))) {
    sendError(reply, 403, "SESSION_ACCESS_DENIED", "你没有权限访问该会话");
    return null;
  }
  return user;
}

function sendModelError(reply: Parameters<typeof sendError>[0], error: unknown) {
  if (error instanceof ModelDomainError) {
    return sendError(reply, error.statusCode, error.code, error.message, error.details);
  }
  return sendError(reply, 502, "MODEL_SWITCH_FAILED", "模型切换失败", {
    cause: sanitizeModelError(error)
  });
}

async function ensureChildControlledRuntime(
  user: UserIdentity,
  sessionId: string,
  runtimeManager: RuntimeManager
) {
  if (user.role !== "child") return null;
  const runtime = runtimeManager.getRuntime(sessionId);
  if (runtime.permissionMode !== "full_access") return runtime;

  if (runtime.status === "history" || runtime.status === "waiting_input" || runtime.status === "exited" || runtime.status === "failed") {
    return runtimeManager.resumeThread(sessionId, { permissionMode: "default" });
  }

  throw new Error("CHILD_RUNTIME_REQUIRES_CONTROLLED_MODE");
}

async function readStoredPermissionMode(sessionService: SessionService, sessionId: string): Promise<SessionPermissionMode | null> {
  if (typeof sessionService.getPermissionMode !== "function") return null;
  return await sessionService.getPermissionMode(sessionId);
}

async function persistPermissionMode(sessionService: SessionService, sessionId: string, permissionMode: SessionPermissionMode): Promise<void> {
  if (typeof sessionService.updatePermissionMode !== "function") return;
  await sessionService.updatePermissionMode(sessionId, permissionMode);
}

function isLiveRuntime(runtime: ReturnType<RuntimeManager["getRuntime"]>): boolean {
  return ["starting", "running", "waiting_input", "waiting_approval"].includes(runtime.status);
}

function sendChildRuntimeError(reply: Parameters<typeof sendError>[0], error: unknown) {
  if (error instanceof Error && error.message === "CHILD_RUNTIME_REQUIRES_CONTROLLED_MODE") {
    return sendError(reply, 409, "CHILD_RUNTIME_REQUIRES_CONTROLLED_MODE", "该会话当前未处于受控运行模式，请先由主用户切换为受控模式");
  }
  return sendError(reply, 503, "RUNTIME_UNAVAILABLE", error instanceof Error ? error.message : "运行态管理器不可用");
}

function isActiveWriterError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /already has an active writer|active writer|writer lock/i.test(message);
}

function sendActiveWriterError(reply: Parameters<typeof sendError>[0], error: unknown) {
  return sendError(
    reply,
    409,
    "SESSION_ACTIVE_WRITER",
    "检测到 ChatGPT 正在占用此会话。切换会话或关闭窗口可能不会释放锁，请完全退出 ChatGPT（⌘Q）或重启 ChatGPT，也可以从下方创建新分支",
    { cause: sanitizeModelError(error) }
  );
}

function makeBranchTitle(sourceTitle: string, mode: SessionBranchMode): string {
  const suffix = mode === "compact_new_topic"
    ? " · 压缩后新话题"
    : " · Fork（保留全部历史）";
  const title = sourceTitle.trim() || "未命名会话";
  const maxSourceLength = Math.max(1, 120 - suffix.length);
  return `${Array.from(title).slice(0, maxSourceLength).join("")}${suffix}`;
}

function makeHistoryContinuationTitle(sourceTitle: string): string {
  const suffix = " · 历史续聊（新会话）";
  const title = sourceTitle.trim() || "未命名会话";
  const maxSourceLength = Math.max(1, 120 - suffix.length);
  return `${Array.from(title).slice(0, maxSourceLength).join("")}${suffix}`;
}

function makeHistoryContinuationSession(
  threadId: string,
  title: string,
  cwd: string,
  runtime: RuntimeSnapshot
): SessionSummary {
  return {
    id: threadId,
    sessionId: threadId,
    title,
    defaultTitle: threadId,
    remarkTitle: title,
    summary: "从原会话历史继续处理",
    workspace: cwd,
    createdAt: runtime.startedAt,
    updatedAt: runtime.updatedAt,
    status: runtime.status,
    cliVersion: null,
    source: "codex_manage_history_continuation"
  };
}
