import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "../config";
import type { LocalAuthService } from "./LocalAuthService";

export const AUTH_COOKIE = "codex_manage_session";

export function getAuthToken(request: FastifyRequest): string | null {
  return request.cookies[AUTH_COOKIE] ?? null;
}

export function isAuthenticated(request: FastifyRequest, authService?: LocalAuthService): boolean {
  if (authService) return authService.authenticate(getAuthToken(request)) !== null;
  return request.unsignCookie(getAuthToken(request) ?? "").valid === true;
}

export function setAuthCookie(
  request: FastifyRequest,
  reply: FastifyReply,
  config: AppConfig,
  token: string
) {
  reply.setCookie(AUTH_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    signed: false,
    path: "/",
    maxAge: config.sessionTtlSeconds,
    secure: isHttpsRequest(request)
  });
}

export function clearAuthCookie(reply: FastifyReply) {
  reply.clearCookie(AUTH_COOKIE, {
    path: "/"
  });
}

function isHttpsRequest(request: FastifyRequest): boolean {
  if (request.protocol === "https") return true;
  const forwardedProto = request.headers["x-forwarded-proto"];
  const value = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
  return value?.split(",")[0]?.trim().toLowerCase() === "https";
}
