import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_OWNER_NAME = "Jamie Chen";
export const DEFAULT_OWNER_EMAIL = "jamie@local";
export const CHATGPT_BUNDLED_CODEX_CLI_PATH = "/Applications/ChatGPT.app/Contents/Resources/codex";

type AppConfig = {
  host: string;
  port: number;
  password: string;
  defaultPassword: boolean;
  ownerName: string;
  ownerEmail: string;
  sessionSecret: string;
  codexCliPath: string;
  expectedCodexCliVersion?: string;
  sessionsDir: string;
  metadataFile: string;
  collaborationFile?: string;
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

export function getDefaultCodexCliPath(): string {
  return process.platform === "darwin" && existsSync(CHATGPT_BUNDLED_CODEX_CLI_PATH)
    ? CHATGPT_BUNDLED_CODEX_CLI_PATH
    : "codex";
}

export function validateCodexCliVersion(actualVersion: string, expectedVersion: string | undefined): void {
  if (!expectedVersion) return;

  const normalize = (version: string) => version.trim().replace(/^codex-cli\s+/i, "");
  if (normalize(actualVersion) !== normalize(expectedVersion)) {
    throw new Error(`Codex CLI 版本不匹配：期望 ${expectedVersion}，实际 ${actualVersion}`);
  }
}

export function loadConfig(): AppConfig {
  const defaultPassword = process.env.CODEX_WEB_PASSWORD === undefined;
  const password = process.env.CODEX_WEB_PASSWORD ?? "admin";
  const ownerName = process.env.CODEX_OWNER_NAME?.trim() || DEFAULT_OWNER_NAME;
  const ownerEmail = process.env.CODEX_OWNER_EMAIL?.trim() || DEFAULT_OWNER_EMAIL;
  const sessionSecret = process.env.CODEX_WEB_SESSION_SECRET ?? randomBytes(32).toString("hex");
  const expectedCodexCliVersion = process.env.CODEX_EXPECTED_CLI_VERSION?.trim() || undefined;

  return {
    host: process.env.CODEX_WEB_HOST ?? "0.0.0.0",
    port: readPort(process.env.CODEX_WEB_PORT, 4310),
    password,
    defaultPassword,
    ownerName,
    ownerEmail,
    sessionSecret,
    codexCliPath: process.env.CODEX_CLI_PATH?.trim() || getDefaultCodexCliPath(),
    expectedCodexCliVersion,
    sessionsDir: expandHome(process.env.CODEX_SESSIONS_DIR ?? "~/.codex/sessions"),
    metadataFile: expandHome(process.env.CODEX_MANAGE_METADATA_FILE ?? join(process.cwd(), ".codex-manage/session-metadata.json")),
    collaborationFile: expandHome(process.env.CODEX_MANAGE_COLLABORATION_FILE ?? join(process.cwd(), ".codex-manage/collaboration.json")),
    clientDir: expandHome(process.env.CODEX_WEB_CLIENT_DIR ?? join(process.cwd(), "dist/client"))
  };
}

export type { AppConfig };
