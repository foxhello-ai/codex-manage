import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

type AppConfig = {
  host: string;
  port: number;
  password: string;
  defaultPassword: boolean;
  sessionSecret: string;
  codexCliPath: string;
  sessionsDir: string;
  metadataFile: string;
  clientDir: string;
};

function readPort(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

export function loadConfig(): AppConfig {
  const defaultPassword = process.env.CODEX_WEB_PASSWORD === undefined;
  const password = process.env.CODEX_WEB_PASSWORD ?? "fmzh2026";
  const sessionSecret = process.env.CODEX_WEB_SESSION_SECRET ?? randomBytes(32).toString("hex");

  return {
    host: process.env.CODEX_WEB_HOST ?? "0.0.0.0",
    port: readPort(process.env.CODEX_WEB_PORT, 4310),
    password,
    defaultPassword,
    sessionSecret,
    codexCliPath: process.env.CODEX_CLI_PATH ?? "codex",
    sessionsDir: expandHome(process.env.CODEX_SESSIONS_DIR ?? "~/.codex/sessions"),
    metadataFile: expandHome(process.env.CODEX_MANAGE_METADATA_FILE ?? join(process.cwd(), ".codex-manage/session-metadata.json")),
    clientDir: expandHome(process.env.CODEX_WEB_CLIENT_DIR ?? join(process.cwd(), "dist/client"))
  };
}

export type { AppConfig };
