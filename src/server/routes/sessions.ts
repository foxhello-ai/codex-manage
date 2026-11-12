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
import type { TaskStore } from "../services/TaskStore";
import { stripAmbientBrowserContext } from "../../shared/messageText";
import { performance } from "node:perf_hooks";
import { createReadStream } from "node:fs";
import { mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

const ListQuery = z.object({
  search: z.string().max(500).optional(),
  paginated: z.enum(["true", "false"]).optional(),
  compact: z.enum(["true", "false"]).optional(),
  cursor: z.string().min(1).max(8192).optional(),
  limit: z.coerce.number().int().positive().max(200).optional()
});

const CreateSessionBody = z.object({
  cwd: z.string().trim().min(1).max(4096)
});

const CreateTaskBody = z.object({ name: z.string().trim().min(1).max(120) });
const UpdateTaskBody = z.object({ name: z.string().trim().min(1).max(120).optional(), pinned: z.boolean().optional() }).refine((body) => body.name !== undefined || body.pinned !== undefined);
const TaskSessionBody = z.object({ cwd: z.string().trim().min(1).max(4096) });

const SessionParams = z.object({
  id: z.string().min(1)
});

const SessionDetailQuery = z.object({
  turns: z.union([z.literal("true"), z.literal("false"), z.boolean()]).optional(),
  turnLimit: z.coerce.number().int().positive().max(100).optional(),
  turnCursor: z.string().min(1).max(8192).optional(),
  historyVersion: z.string().max(200).optional()
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
  permissionMode: PermissionMode.optional(),
  clientRequestId: z.string().min(1).max(128).optional(),
  useDesktopSettings: z.boolean().optional(),
  attachmentPaths: z.array(z.string().trim().min(1).max(4096)).max(10).optional()
});

const AttachmentBody = z.object({
  cwd: z.string().trim().min(1).max(4096),
  name: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().max(200).default("application/octet-stream"),
  size: z.number().int().nonnegative().max(20 * 1024 * 1024),
  data: z.string().min(1).max(28 * 1024 * 1024)
});

const FileQuery = z.object({
  path: z.string().trim().min(1).max(8192)
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
  collaborationStore?: CollaborationStore,
  taskStore?: TaskStore
) {
  app.addHook("onResponse", async (request, reply) => {
    if (request.method !== "GET" && request.method !== "HEAD" && reply.statusCode < 400
      && /^\/api\/(sessions|tasks)(\/|$)/.test(request.url)) sessionService.invalidateList?.();
  });

  app.get("/api/tasks", async (request, reply) => {
    const user = await resolveRouteUser(request, collaborationStore);
    if (!user) return sendError(reply, 401, "UNAUTHENTICATED", "请先登录");
    if (!taskStore) return sendError(reply, 503, "TASK_SERVICE_UNAVAILABLE", "任务服务不可用");
    try {
      const sessions = await sessionService.getSessionSummaries(await taskStore.sessionIds());
      const visible = collaborationStore ? await collaborationStore.filterSessions(user.id, sessions) : sessions;
      return reply.send({ tasks: await taskStore.list(visible) });
    } catch (error) {
      return sendError(reply, 503, "TASK_LIST_FAILED", sanitizeModelError(error));
    }
  });

  app.post("/api/tasks", async (request, reply) => {
    const user = await resolveRouteUser(request, collaborationStore);
    if (!user) return sendError(reply, 401, "UNAUTHENTICATED", "请先登录");
    if (user.role === "child") return sendError(reply, 403, "OWNER_REQUIRED", "子用户不能创建任务");
    if (!taskStore) return sendError(reply, 503, "TASK_SERVICE_UNAVAILABLE", "任务服务不可用");
    const body = CreateTaskBody.safeParse(request.body);
    if (!body.success) return sendError(reply, 400, "INVALID_TASK", "任务名称不正确");
    try {
      const task = await taskStore.create(body.data.name);
      return reply.status(201).send({ task: (await taskStore.get(task.id, []))! });
    } catch (error) {
      return sendError(reply, 400, "TASK_CREATE_FAILED", sanitizeModelError(error));
    }
  });

  app.get("/api/tasks/:id", async (request, reply) => {
    const user = await resolveRouteUser(request, collaborationStore);
    if (!user) return sendError(reply, 401, "UNAUTHENTICATED", "请先登录");
    if (!taskStore) return sendError(reply, 503, "TASK_SERVICE_UNAVAILABLE", "任务服务不可用");
    const params = SessionParams.safeParse(request.params);
    if (!params.success) return sendError(reply, 400, "INVALID_TASK_PARAMS", "任务参数不正确");
    try {
      const stored = await taskStore.get(params.data.id, []);
      if (!stored) return sendError(reply, 404, "TASK_NOT_FOUND", "任务不存在");
      const sessions = await sessionService.getSessionSummaries(stored.sessionIds);
      const visible = collaborationStore ? await collaborationStore.filterSessions(user.id, sessions) : sessions;
      const task = await taskStore.get(params.data.id, visible);
      if (!task) return sendError(reply, 404, "TASK_NOT_FOUND", "任务不存在");
      return reply.send({ task });
    } catch (error) {
      return sendError(reply, 503, "TASK_DETAIL_FAILED", sanitizeModelError(error));
    }
  });

  app.patch("/api/tasks/:id", async (request, reply) => {
    const user = await resolveRouteUser(request, collaborationStore);
    if (!user) return sendError(reply, 401, "UNAUTHENTICATED", "请先登录");
    if (user.role === "child") return sendError(reply, 403, "OWNER_REQUIRED", "子用户不能编辑任务");
    if (!taskStore) return sendError(reply, 503, "TASK_SERVICE_UNAVAILABLE", "任务服务不可用");
    const params = SessionParams.safeParse(request.params);
    const body = UpdateTaskBody.safeParse(request.body);
    if (!params.success || !body.success) return sendError(reply, 400, "INVALID_TASK", "任务参数不正确");
    try {
      const task = await taskStore.update(params.data.id, body.data);
      const sessions = await sessionService.getSessionSummaries(task.sessionIds);
      return reply.send({ task: (await taskStore.get(task.id, sessions))! });
    } catch (error) {
      return sendError(reply, 400, "TASK_UPDATE_FAILED", sanitizeModelError(error));
    }
  });

  app.post("/api/tasks/:id/sessions", async (request, reply) => {
    const user = await resolveRouteUser(request, collaborationStore);
    if (!user) return sendError(reply, 401, "UNAUTHENTICATED", "请先登录");
    if (user.role === "child") return sendError(reply, 403, "OWNER_REQUIRED", "子用户不能创建新会话");
    if (!taskStore || !runtimeManager) return sendError(reply, 503, "TASK_SERVICE_UNAVAILABLE", "任务服务不可用");
    const params = SessionParams.safeParse(request.params);
    const body = TaskSessionBody.safeParse(request.body);
    if (!params.success || !body.success) return sendError(reply, 400, "INVALID_TASK_SESSION", "任务会话参数不正确");
    try {
      const stored = await taskStore.get(params.data.id, []);
      if (!stored) return sendError(reply, 404, "TASK_NOT_FOUND", "任务不存在");
      const sessions = await sessionService.getSessionSummaries(stored.sessionIds);
      const task = await taskStore.get(params.data.id, sessions);
      if (!task) return sendError(reply, 404, "TASK_NOT_FOUND", "任务不存在");
      const contextPrompt = buildTaskContextPrompt(task.name, task.sessions);
      await mkdir(body.data.cwd, { recursive: true });
      const result = await runtimeManager.startThread(body.data.cwd);
      const runtime = await runtimeManager.sendInput(result.threadId, { text: contextPrompt });
      await taskStore.addSession(task.id, result.threadId);
      const nextSessions = [...sessions, makeCreatedSession(result.threadId, body.data.cwd, runtime)];
      return reply.status(201).send({
        threadId: result.threadId,
        runtime,
        session: makeCreatedSession(result.threadId, body.data.cwd, runtime),
        task: (await taskStore.get(task.id, nextSessions))!,
        contextPrompt
      });
    } catch (error) {
      return sendError(reply, 503, "TASK_SESSION_CREATE_FAILED", sanitizeModelError(error));
    }
  });

  app.post("/api/tasks/:id/sessions/:sessionId", async (request, reply) => {
    const user = await resolveRouteUser(request, collaborationStore);
    if (!user) return sendError(reply, 401, "UNAUTHENTICATED", "请先登录");
    if (user.role === "child") return sendError(reply, 403, "OWNER_REQUIRED", "子用户不能归属会话");
    if (!taskStore) return sendError(reply, 503, "TASK_SERVICE_UNAVAILABLE", "任务服务不可用");
    const params = z.object({ id: z.string().min(1), sessionId: z.string().min(1) }).safeParse(request.params);
    if (!params.success) return sendError(reply, 400, "INVALID_TASK_SESSION", "任务会话参数不正确");
    try {
      const task = await taskStore.addSession(params.data.id, params.data.sessionId);
      const sessions = await sessionService.getSessionSummaries(task.sessionIds);
      return reply.send({ task: (await taskStore.get(params.data.id, sessions))! });
    } catch (error) {
      return sendError(reply, 400, "TASK_SESSION_ATTACH_FAILED", sanitizeModelError(error));
    }
  });

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
      return reply.status(201).send({
        threadId: result.threadId,
        runtime: result.runtime,
        session: makeCreatedSession(result.threadId, body.data.cwd, result.runtime)
      });
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
      // Child accounts are filtered before returning data. Their catalog stays permission scoped.
      const page = parsed.data.paginated === "true" && !parsed.data.search?.trim() && user.role === "owner"
        ? await sessionService.listSessionPage({ limit: parsed.data.limit, cursor: parsed.data.cursor })
        : { sessions: await sessionService.listSessions(parsed.data), nextCursor: null };
      const visible = collaborationStore ? await collaborationStore.filterSessions(user.id, page.sessions) : page.sessions;
      const sessions = parsed.data.compact === "true" || parsed.data.paginated === "true"
        ? visible.map((session) => ({ ...session, summary: stripAmbientBrowserContext(session.summary).replace(/\s+/g, " ").slice(0, 240) }))
        : visible;
      return reply.send({ sessions, ...(parsed.data.paginated === "true" ? { nextCursor: page.nextCursor } : {}) });
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
      // GET must not acquire a writer, including for controlled collaborators.
      const runtime = runtimeManager.hydratePermissionMode(
        params.data.id,
        user.role === "child" ? "default" : await readStoredPermissionMode(sessionService, params.data.id) ?? "default"
      );
      const refreshed = typeof runtimeManager.refreshExternal === "function"
        ? await runtimeManager.refreshExternal(params.data.id) : runtime;
      return reply.send({ runtime: refreshed, approvals: runtimeManager.approvalService.listPending(params.data.id) });
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
      if (runtimeManager?.getRuntime(params.data.id).executionSource === "external_queue" && body.data.mode !== "follow_session") {
        throw new ModelDomainError("DESKTOP_QUEUE_TEXT_ONLY", "此会话的模型和权限请到桌面调整", 409);
      }
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
    const useDesktopSettings = user.role === "owner" && body.data.useDesktopSettings === true;
    if (useDesktopSettings && body.data.permissionMode !== undefined) {
      return sendError(reply, 400, "INVALID_SESSION_INPUT", "跟随桌面设置时不能同时指定权限覆盖");
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
      const modelOverride = sessionModelService && !useDesktopSettings
        ? await sessionModelService.resolveForTurn(params.data.id)
        : undefined;
      const runtime = await runtimeManager.sendInput(params.data.id, {
        ...body.data,
        permissionMode: useDesktopSettings ? undefined : permissionMode,
        modelOverride,
        clientRequestId: body.data.clientRequestId ?? randomUUID(),
        allowExternalQueue: user.role !== "child"
      });
      return reply.status(runtime.executionSource === "external_queue" ? 202 : 200).send({ runtime });
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

  app.post("/api/sessions/:id/attachments", async (request, reply) => {
    const params = SessionParams.safeParse(request.params);
    if (!params.success) return sendError(reply, 400, "INVALID_SESSION_PARAMS", "会话参数不正确");
    const body = AttachmentBody.safeParse(request.body);
    if (!body.success) return sendError(reply, 400, "INVALID_ATTACHMENT", "附件格式或大小不正确");
    const user = await requireSessionAccess(request, reply, params.data.id, collaborationStore);
    if (!user) return;
    try {
      let workspace = body.data.cwd;
      try {
        workspace = (await sessionService.getSessionDetail(params.data.id, { includeTurns: false })).workspace;
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "Session not found") throw error;
      }
      const decoded = Buffer.from(body.data.data, "base64");
      if (decoded.length !== body.data.size || decoded.length > 20 * 1024 * 1024) {
        return sendError(reply, 413, "ATTACHMENT_TOO_LARGE", "附件大小不正确");
      }
      const safeName = basename(body.data.name).replace(/[^a-zA-Z0-9._-]/g, "_") || "attachment";
      const directory = resolve(workspace, ".codex-manage", "attachments", params.data.id);
      await mkdir(directory, { recursive: true });
      const path = join(directory, `${randomUUID()}-${safeName}`);
      await writeFile(path, decoded, { flag: "wx" });
      return reply.status(201).send({ attachment: { name: body.data.name, mimeType: body.data.mimeType, size: decoded.length, path } });
    } catch (error) {
      return sendError(reply, 503, "ATTACHMENT_UPLOAD_FAILED", sanitizeModelError(error));
    }
  });

  app.get("/api/sessions/:id/files", async (request, reply) => {
    const params = SessionParams.safeParse(request.params);
    if (!params.success) return sendError(reply, 400, "INVALID_SESSION_PARAMS", "会话参数不正确");
    const query = FileQuery.safeParse(request.query ?? {});
    if (!query.success) return sendError(reply, 400, "INVALID_FILE_QUERY", "文件路径不正确");
    const user = await requireSessionAccess(request, reply, params.data.id, collaborationStore);
    if (!user) return;

    try {
      const session = await sessionService.getSessionDetail(params.data.id, { includeTurns: false });
      const workspace = await realpath(session.workspace);
      const candidate = resolve(query.data.path);
      const filePath = await realpath(candidate);
      const fileRelative = relative(workspace, filePath);
      if (!fileRelative || fileRelative === ".." || fileRelative.startsWith(`..${sep}`) || fileRelative.startsWith(sep)) {
        return sendError(reply, 403, "FILE_OUTSIDE_WORKSPACE", "文件不在当前会话工作目录内");
      }
      const info = await stat(filePath);
      if (!info.isFile()) return sendError(reply, 404, "FILE_NOT_FOUND", "文件不存在");
      const fileName = basename(filePath);
      reply.header("content-type", mimeTypeFor(fileName));
      reply.header("content-length", String(info.size));
      reply.header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
      return reply.send(createReadStream(filePath));
    } catch (error) {
      if (error instanceof Error && ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        return sendError(reply, 404, "FILE_NOT_FOUND", "文件不存在");
      }
      return sendError(reply, 503, "FILE_DOWNLOAD_FAILED", sanitizeModelError(error));
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
      if (user.role === "child") {
        const observedRuntime = runtimeManager.getRuntime(threadId);
        if (observedRuntime.permissionMode === "full_access" && ["starting", "running", "waiting_approval", "waiting_user"].includes(observedRuntime.status)) {
          socket.close(1008, "controlled mode required");
          return;
        }
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

    const startedAt = performance.now();
    try {
      const session = await sessionService.getSessionDetail(params.data.id, {
        includeTurns: query.data.turns !== false && query.data.turns !== "false",
        turnLimit: query.data.turnLimit,
        turnCursor: query.data.turnCursor,
        historyVersion: query.data.historyVersion
      });
      const elapsedMs = Math.round(performance.now() - startedAt);
      reply.header("server-timing", `session-detail;dur=${elapsedMs}`);
      if (elapsedMs >= 250) request.log.info({ sessionId: params.data.id, elapsedMs }, "slow session detail");
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

function buildTaskContextPrompt(taskName: string, sessions: SessionSummary[]): string {
  const history = sessions.length === 0
    ? "（暂无历史会话）"
    : sessions.map((session, index) => `${index + 1}. 名称：${session.title}\n   时间：${session.updatedAt}\n   访问标识：${session.id}\n   摘要：${session.summary}`).join("\n");
  return `你正在继续任务「${taskName}」。请先读取该任务下的所有历史会话，了解已有背景、讨论过程、结论和未完成事项，并将它们作为当前任务的共享上下文。优先继承已确认内容，同时明确区分已确认内容和待确认内容，避免重复询问已经明确的信息。\n\n任务历史会话：\n${history}\n\n请基于以上上下文继续处理本次任务。`;
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
  return ["starting", "running", "waiting_input", "waiting_approval", "waiting_user"].includes(runtime.status);
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
    "此会话由其他客户端持有写入权，当前操作无法继续。文字续聊可通过兼容版本的原生队列投递；请保留输入，勿重复发送",
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

function makeCreatedSession(threadId: string, cwd: string, runtime: RuntimeSnapshot): SessionSummary {
  return {
    id: threadId,
    sessionId: threadId,
    title: "新会话",
    defaultTitle: "新会话",
    remarkTitle: null,
    summary: "新建会话，可以开始输入任务",
    workspace: cwd,
    createdAt: runtime.startedAt,
    updatedAt: runtime.updatedAt,
    status: runtime.status,
    cliVersion: null,
    source: "codex_manage_created"
  };
}

function mimeTypeFor(fileName: string): string {
  switch (extname(fileName).toLowerCase()) {
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".pdf": return "application/pdf";
    case ".json": return "application/json; charset=utf-8";
    case ".txt":
    case ".md": return "text/plain; charset=utf-8";
    case ".zip": return "application/zip";
    case ".exe": return "application/vnd.microsoft.portable-executable";
    default: return "application/octet-stream";
  }
}
