import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type AppConfig = {
  runtimeMode: "standalone" | "desktop";
  host: string;
  port: number;
  password: string;
  defaultPassword: boolean;
  sessionSecret: string;
  codexCliPath: string;
  sessionsDir: string;
  userDataDir: string;
  metadataFile: string;
  localDatabaseFile: string;
  clientDir: string;
  allowedHosts: string[];
  enforceHostCheck: boolean;
  sessionTtlSeconds: number;
  pairingCodeTtlSeconds: number;
  desktopControlToken: string | null;
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

function readPositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readAllowedHosts(value: string | undefined): string[] {
  const defaults = [
    "localhost",
    "127.0.0.1",
    "::1",
    "codex.foxhello.com",
    "codex.foxhello.cn",
    "*.trycloudflare.com",
    "*.xmwefun.cn"
  ];
  const configured = value?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
  return Array.from(new Set([...defaults, ...configured]));
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const runtimeMode = process.env.CODEX_MANAGE_RUNTIME_MODE === "desktop" ? "desktop" : "standalone";
  const defaultPassword = process.env.CODEX_WEB_PASSWORD === undefined;
  const password = process.env.CODEX_WEB_PASSWORD ?? "fmzh2026";
  const userDataDir = expandHome(
    process.env.CODEX_MANAGE_USER_DATA_DIR ?? join(process.cwd(), ".codex-manage")
  );
  const sessionSecret = process.env.CODEX_WEB_SESSION_SECRET
    ?? (runtimeMode === "desktop" ? loadOrCreateSessionSecret(userDataDir) : randomBytes(32).toString("hex"));

  const config: AppConfig = {
    runtimeMode,
    host: process.env.CODEX_WEB_HOST ?? (runtimeMode === "desktop" ? "127.0.0.1" : "0.0.0.0"),
    port: readPort(process.env.CODEX_WEB_PORT, 4310),
    password,
    defaultPassword,
    sessionSecret,
    codexCliPath: process.env.CODEX_CLI_PATH ?? "codex",
    sessionsDir: expandHome(process.env.CODEX_SESSIONS_DIR ?? "~/.codex/sessions"),
    userDataDir,
    metadataFile: expandHome(process.env.CODEX_MANAGE_METADATA_FILE ?? join(userDataDir, "session-metadata.json")),
    localDatabaseFile: expandHome(process.env.CODEX_MANAGE_DATABASE_FILE ?? join(userDataDir, "local.db")),
    clientDir: expandHome(process.env.CODEX_WEB_CLIENT_DIR ?? join(process.cwd(), "dist/client")),
    allowedHosts: readAllowedHosts(process.env.CODEX_WEB_ALLOWED_HOSTS),
    enforceHostCheck: process.env.CODEX_WEB_ENFORCE_HOST_CHECK !== "false",
    sessionTtlSeconds: readPositiveInteger(process.env.CODEX_WEB_SESSION_TTL_SECONDS, 60 * 60 * 24 * 7),
    pairingCodeTtlSeconds: readPositiveInteger(process.env.CODEX_WEB_PAIRING_TTL_SECONDS, 60 * 5),
    desktopControlToken: process.env.CODEX_DESKTOP_CONTROL_TOKEN ?? null
  };

  return {
    ...config,
    ...overrides
  };
}

function loadOrCreateSessionSecret(userDataDir: string): string {
  const secretFile = join(userDataDir, "session-secret");
  try {
    const existing = readFileSync(secretFile, "utf8").trim();
    if (existing.length >= 32) return existing;
  } catch {
    // The first desktop launch creates a new persistent secret below.
  }

  mkdirSync(userDataDir, { recursive: true });
  const secret = randomBytes(32).toString("hex");
  writeFileSync(secretFile, `${secret}\n`, { encoding: "utf8", mode: 0o600 });
  return secret;
}

export type { AppConfig };
