import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { isOwner } from "../auth/session";
import { sendError } from "../httpErrors";
import type { CollaborationStore } from "../services/CollaborationStore";

const CollaboratorParams = z.object({ id: z.string().trim().min(1) });
const CreateBody = z.object({
  displayName: z.string().trim().min(1).max(80),
  localEmail: z.string().trim().email().max(160),
  password: z.string().trim().min(8).max(200).optional()
});
const StatusBody = z.object({ active: z.boolean() });
const GrantsBody = z.object({ sessionIds: z.array(z.string().trim().min(1)).max(500) });

export function registerCollaborationRoutes(app: FastifyInstance, store: CollaborationStore): void {
  app.get("/api/collaborators", async (request, reply) => {
    if (!isOwner(request)) return sendError(reply, 403, "OWNER_REQUIRED", "只有主用户可以管理子用户");
    return reply.send({ collaborators: await store.listCollaborators() });
  });

  app.post("/api/collaborators", async (request, reply) => {
    if (!isOwner(request)) return sendError(reply, 403, "OWNER_REQUIRED", "只有主用户可以管理子用户");
    const parsed = CreateBody.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "INVALID_COLLABORATOR", "子用户信息不正确");

    try {
      const result = await store.createChild(parsed.data);
      return reply.status(201).send(result);
    } catch (error) {
      if (error instanceof Error && error.message === "LOCAL_EMAIL_EXISTS") {
        return sendError(reply, 409, "LOCAL_EMAIL_EXISTS", "本地邮箱已存在");
      }
      if (error instanceof Error && error.message === "PASSWORD_INVALID") {
        return sendError(reply, 400, "PASSWORD_INVALID", "密码长度需要为 8 到 200 位");
      }
      return sendError(reply, 400, "INVALID_COLLABORATOR", "子用户信息不正确");
    }
  });

  app.patch("/api/collaborators/:id", async (request, reply) => {
    if (!isOwner(request)) return sendError(reply, 403, "OWNER_REQUIRED", "只有主用户可以管理子用户");
    const params = CollaboratorParams.safeParse(request.params);
    const body = StatusBody.safeParse(request.body);
    if (!params.success || !body.success) return sendError(reply, 400, "INVALID_COLLABORATOR_STATUS", "子用户状态不正确");

    try {
      return reply.send({ collaborator: await store.setChildActive(params.data.id, body.data.active) });
    } catch (error) {
      if (error instanceof Error && error.message === "CHILD_NOT_FOUND") {
        return sendError(reply, 404, "COLLABORATOR_NOT_FOUND", "子用户不存在");
      }
      return sendError(reply, 500, "COLLABORATOR_UPDATE_FAILED", "子用户状态更新失败");
    }
  });

  app.put("/api/collaborators/:id/grants", async (request, reply) => {
    if (!isOwner(request)) return sendError(reply, 403, "OWNER_REQUIRED", "只有主用户可以管理子用户");
    const params = CollaboratorParams.safeParse(request.params);
    const body = GrantsBody.safeParse(request.body);
    if (!params.success || !body.success) return sendError(reply, 400, "INVALID_SESSION_GRANTS", "会话授权信息不正确");

    try {
      return reply.send({ collaborator: await store.replaceGrants(params.data.id, body.data.sessionIds) });
    } catch (error) {
      if (error instanceof Error && error.message === "CHILD_NOT_FOUND") {
        return sendError(reply, 404, "COLLABORATOR_NOT_FOUND", "子用户不存在");
      }
      return sendError(reply, 500, "SESSION_GRANTS_UPDATE_FAILED", "会话授权更新失败");
    }
  });
}
