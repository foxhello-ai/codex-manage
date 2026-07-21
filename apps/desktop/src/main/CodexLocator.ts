import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

export type CodexLocation = {
  available: boolean;
  path: string | null;
  version: string | null;
  error: string | null;
};

export class CodexLocator {
  async locate(): Promise<CodexLocation> {
    const candidates = unique([
      process.env.CODEX_CLI_PATH,
      "codex",
      ...(process.platform === "darwin"
        ? ["/opt/homebrew/bin/codex", "/usr/local/bin/codex"]
        : []),
      ...(process.platform === "win32" ? await findWindowsCandidates() : [])
    ].filter((candidate): candidate is string => Boolean(candidate)));

    let lastError: string | null = null;
    for (const candidate of candidates) {
      if (candidate.includes("/") && !existsSync(candidate)) continue;
      const result = await readVersion(candidate);
      if (result.version) {
        return {
          available: true,
          path: candidate,
          version: result.version,
          error: null
        };
      }
      lastError = result.error;
    }

    return {
      available: false,
      path: null,
      version: null,
      error: lastError ?? "未找到 Codex CLI，请先安装并登录 Codex"
    };
  }
}

async function readVersion(command: string): Promise<{ version: string | null; error: string | null }> {
  return new Promise((resolve) => {
    const child = spawn(command, ["--version"], {
      env: process.env,
      shell: process.platform === "win32" && command.toLowerCase().endsWith(".cmd"),
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), 5000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ version: null, error: error.message });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      const version = stdout.trim() || stderr.trim();
      resolve(code === 0 && version ? { version, error: null } : {
        version: null,
        error: version || `Codex CLI 退出码 ${code ?? "unknown"}`
      });
    });
  });
}

async function findWindowsCandidates(): Promise<string[]> {
  return new Promise((resolve) => {
    const child = spawn("where.exe", ["codex"], { windowsHide: true });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.on("error", () => resolve([]));
    child.on("exit", () => resolve(output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)));
  });
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}
