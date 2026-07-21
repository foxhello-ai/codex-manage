import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppConfig } from "../config";
import { sendError } from "../httpErrors";

const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function registerRequestSecurityHook(app: FastifyInstance, config: AppConfig): void {
  app.addHook("onRequest", async (request, reply) => {
    if (!config.enforceHostCheck) return;

    const requestHost = normalizeHostname(request.headers.host);
    if (!requestHost || !isAllowedHostname(requestHost, config.allowedHosts)) {
      return sendError(reply, 421, "HOST_NOT_ALLOWED", "请求主机不在允许范围内");
    }

    const isWebSocket = request.headers.upgrade?.toLowerCase() === "websocket";
    if (!STATE_CHANGING_METHODS.has(request.method) && !isWebSocket) return;

    const originHeader = request.headers.origin;
    if (!originHeader) return;

    const originHost = parseOriginHostname(originHeader);
    if (!originHost || originHost !== requestHost || !isAllowedHostname(originHost, config.allowedHosts)) {
      return sendError(reply, 403, "ORIGIN_NOT_ALLOWED", "请求来源校验失败");
    }
  });
}

export function isAllowedHostname(hostname: string, allowedHosts: string[]): boolean {
  const normalized = normalizeHostname(hostname);
  if (!normalized) return false;

  return allowedHosts.some((pattern) => {
    const candidate = normalizeHostname(pattern);
    if (!candidate) return false;
    if (!candidate.startsWith("*.")) return normalized === candidate;
    const suffix = candidate.slice(1);
    return normalized.endsWith(suffix) && normalized.length > suffix.length;
  });
}

function normalizeHostname(host: string | undefined): string | null {
  if (!host) return null;
  const trimmed = host.trim().toLowerCase();
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    return end >= 0 ? trimmed.slice(1, end) : null;
  }
  return trimmed.split(":")[0] || null;
}

function parseOriginHostname(origin: string): string | null {
  try {
    return normalizeHostname(new URL(origin).hostname);
  } catch {
    return null;
  }
}

export function requestClientKey(request: FastifyRequest): string {
  return request.ip || request.socket.remoteAddress || "unknown";
}
