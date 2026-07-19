import type { ModelErrorCode } from "../shared/models";

export class ModelDomainError extends Error {
  constructor(
    readonly code: ModelErrorCode,
    message: string,
    readonly statusCode: number,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "ModelDomainError";
  }
}

export function sanitizeModelError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/(authorization|cookie|token|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/([?&](?:token|api[_-]?key|authorization)=)[^&#\s]+/gi, "$1[REDACTED]")
    .replace(/\bhttps?:\/\/[^\s"'<>),;]+/gi, "[REDACTED_URL]")
    .replace(/(?:~\/)?\.codex\/(?:config\.toml|auth\.json)/gi, "[REDACTED_CONFIG]")
    .slice(0, 2000);
}
