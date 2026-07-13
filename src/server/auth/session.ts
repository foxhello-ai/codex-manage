import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "../config";

const AUTH_COOKIE = "codex_manage_session";
const AUTH_VALUE = "authenticated";

export function isAuthenticated(request: FastifyRequest): boolean {
  return request.unsignCookie(request.cookies[AUTH_COOKIE] ?? "").valid === true;
}

export function setAuthCookie(reply: FastifyReply, config: AppConfig) {
  reply.setCookie(AUTH_COOKIE, AUTH_VALUE, {
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
