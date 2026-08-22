import type { FastifyReply, FastifyRequest } from "fastify";
import { DEFAULT_OWNER_EMAIL, DEFAULT_OWNER_NAME, type AppConfig } from "../config";
import type { LocalAuthService } from "./LocalAuthService";
import { CollaborationStore, OWNER_USER_ID } from "../services/CollaborationStore";
import type { UserIdentity } from "../../shared/models";

export const AUTH_COOKIE = "codex_manage_session";

declare module "fastify" {
  interface FastifyRequest {
    authUser?: UserIdentity;
  }
}

export function getAuthToken(request: FastifyRequest): string | null {
  return request.cookies[AUTH_COOKIE] ?? null;
}

export function isAuthenticated(request: FastifyRequest, authService?: LocalAuthService): boolean {
  if (authService) return authService.authenticate(getAuthToken(request)) !== null;
  return request.unsignCookie(getAuthToken(request) ?? "").valid === true;
}

export function readAuthUserId(request: FastifyRequest): string | null {
  try {
    const parsed = request.unsignCookie(getAuthToken(request) ?? "");
    return parsed.valid && parsed.value ? parsed.value : null;
  } catch {
    return null;
  }
}

export async function resolveAuthUser(
  request: FastifyRequest,
  collaborationStore?: CollaborationStore,
  authService?: LocalAuthService
): Promise<UserIdentity | null> {
  const userId = readAuthUserId(request);
  if (userId) {
    if (collaborationStore) return collaborationStore.resolveIdentity(userId);
    return { ...ownerIdentity(), id: userId === "authenticated" ? OWNER_USER_ID : userId };
  }

  if (authService?.authenticate(getAuthToken(request))) {
    return collaborationStore?.ownerIdentity() ?? ownerIdentity();
  }

  return null;
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

export function setAuthCookie(
  request: FastifyRequest,
  reply: FastifyReply,
  config: AppConfig,
  token: string
): void;
export function setAuthCookie(reply: FastifyReply, config: AppConfig, userId?: string): void;
export function setAuthCookie(
  first: FastifyRequest | FastifyReply,
  second: FastifyReply | AppConfig,
  third: AppConfig | string | undefined,
  fourth?: string
): void {
  const localToken = fourth !== undefined;
  const request = localToken ? first as FastifyRequest : undefined;
  const reply = (localToken ? second : first) as FastifyReply;
  const config = (localToken ? third : second) as AppConfig;
  const value = localToken ? fourth : (third as string | undefined) ?? OWNER_USER_ID;

  reply.setCookie(AUTH_COOKIE, value, {
    httpOnly: true,
    sameSite: "lax",
    signed: !localToken,
    path: "/",
    maxAge: config.sessionTtlSeconds,
    secure: request ? isHttpsRequest(request) : false
  });
}

export function clearAuthCookie(reply: FastifyReply): void {
  reply.clearCookie(AUTH_COOKIE, { path: "/" });
}

function isHttpsRequest(request: FastifyRequest): boolean {
  if (request.protocol === "https") return true;
  const forwardedProto = request.headers["x-forwarded-proto"];
  const value = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
  return value?.split(",")[0]?.trim().toLowerCase() === "https";
}
