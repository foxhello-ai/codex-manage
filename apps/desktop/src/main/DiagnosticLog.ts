import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export class DiagnosticLog {
  constructor(private readonly file: string) {}

  write(component: string, event: string, details: Record<string, unknown> = {}): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      this.rotateIfNeeded();
      const line = JSON.stringify({
        timestamp: new Date().toISOString(),
        component,
        event,
        details
      });
      appendFileSync(this.file, `${sanitizeDiagnosticText(line)}\n`, { encoding: "utf8", mode: 0o600 });
    } catch {
      // Diagnostics must never prevent the desktop application from running.
    }
  }

  exportTo(destination: string): void {
    const previous = readOptional(`${this.file}.1`);
    const source = `${previous}${readOptional(this.file)}`;
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, sanitizeDiagnosticText(source), { encoding: "utf8", mode: 0o600 });
  }

  recentEntries(limit = 80): Array<Record<string, unknown>> {
    const previous = readOptional(`${this.file}.1`);
    const source = `${previous}${readOptional(this.file)}`;
    return source
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-Math.max(1, limit))
      .map((line) => {
        try {
          const parsed = JSON.parse(sanitizeDiagnosticText(line));
          return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : { message: sanitizeDiagnosticText(line) };
        } catch {
          return { message: sanitizeDiagnosticText(line).slice(0, 1000) };
        }
      });
  }

  private rotateIfNeeded(): void {
    try {
      if (statSync(this.file).size < 5 * 1024 * 1024) return;
      rmSync(`${this.file}.1`, { force: true });
      renameSync(this.file, `${this.file}.1`);
    } catch {
      // The log does not exist yet.
    }
  }
}

function readOptional(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

export function sanitizeDiagnosticText(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer <redacted>")
    .replace(/cm_(?:access|refresh|device|device_access|admin)_[A-Za-z0-9_-]+/g, "cm_<redacted>")
    .replace(/([#?&](?:code|token)=)[^&\s"']+/gi, "$1<redacted>")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "<redacted-email>")
    .replace(/\+?\d[\d\s()-]{7,}\d/g, "<redacted-phone>")
    .replace(/https?:\/\/[^\s"']+/gi, "https://<redacted-host>")
    .replace(/\/Users\/[^/\s"']+/g, "/Users/<redacted>")
    .replace(/[A-Z]:\\Users\\[^\\\s"']+/gi, "C:\\Users\\<redacted>");
}
