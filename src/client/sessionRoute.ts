export type SessionRoute =
  | { kind: "list" }
  | { kind: "detail"; sessionId: string }
  | { kind: "invalid"; message: string };

export function parseSessionRoute(pathname: string): SessionRoute {
  if (pathname === "" || pathname === "/") {
    return { kind: "list" };
  }

  if (!pathname.startsWith("/") || pathname.slice(1).includes("/")) {
    return { kind: "invalid", message: "会话链接格式不正确" };
  }

  try {
    const sessionId = decodeURIComponent(pathname.slice(1));
    if (!sessionId) {
      return { kind: "invalid", message: "会话链接缺少会话 ID" };
    }
    return { kind: "detail", sessionId };
  } catch {
    return { kind: "invalid", message: "会话链接包含无效编码" };
  }
}

export function buildSessionDetailPath(sessionId: string): string {
  if (!sessionId) {
    throw new Error("Session ID is required");
  }
  return `/${encodeURIComponent(sessionId)}`;
}
