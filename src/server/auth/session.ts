import type { FastifyReply, FastifyRequest } from "fastify";
import { DEFAULT_OWNER_EMAIL, DEFAULT_OWNER_NAME, type AppConfig } from "../config";
import { CollaborationStore, OWNER_USER_ID } from "../services/CollaborationStore";
import type { UserIdentity } from "../../shared/models";

declare module "fastify" {
  interface FastifyRequest {
    authUser?: UserIdentity;
  }
}

const AUTH_COOKIE = "codex_manage_session";

export function isAuthenticated(request: FastifyRequest): boolean {
  return request.unsignCookie(request.cookies[AUTH_COOKIE] ?? "").valid === true;
}

export function readAuthUserId(request: FastifyRequest): string | null {
  const parsed = request.unsignCookie(request.cookies[AUTH_COOKIE] ?? "");
  return parsed.valid && parsed.value ? parsed.value : null;
}

export async function resolveAuthUser(
  request: FastifyRequest,
  collaborationStore?: CollaborationStore
): Promise<UserIdentity | null> {
  const userId = readAuthUserId(request);
  if (!userId) return null;
  if (!collaborationStore) {
    return { ...ownerIdentity(), id: userId === "authenticated" ? OWNER_USER_ID : userId };
  }
  return collaborationStore.resolveIdentity(userId);
}

export function getRequestUser(request: FastifyRequest): UserIdentity {
  return request.authUser ?? ownerIdentity();
}

export function isOwner(request: FastifyRequest): boolean {
  return getRequestUser(request).role === "owner";
}

export function ownerIdentity(): UserIdentity {
  return {
    id: OWNER_USER_ID,
    role: "owner",
    displayName: DEFAULT_OWNER_NAME,
    localEmail: DEFAULT_OWNER_EMAIL,
    active: true,
    ownerUserId: null
  };
}

export function setAuthCookie(reply: FastifyReply, _config: AppConfig, userId = OWNER_USER_ID) {
  reply.setCookie(AUTH_COOKIE, userId, {
    httpOnly: true,
    sameSite: "lax",
    signed: true,
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
    secure: false
  });
}

export function clearAuthCookie(reply: FastifyReply) {
  reply.clearCookie(AUTH_COOKIE, {
    path: "/"
  });
}
