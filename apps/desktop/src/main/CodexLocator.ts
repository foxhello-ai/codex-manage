import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";

export type CodexLocation = {
  available: boolean;
  path: string | null;
  version: string | null;
  error: string | null;
};

export type CodexLocatorOptions = {
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
};

export class CodexLocator {
  constructor(private readonly options: CodexLocatorOptions = {}) {}

  async locate(): Promise<CodexLocation> {
    const platform = this.options.platform ?? process.platform;
    const environment = this.options.environment ?? process.env;
    const homeDirectory = this.options.homeDirectory ?? homedir();
    const candidates = unique([
      environment.CODEX_CLI_PATH,
      "codex",
      ...findKnownCandidates(platform, homeDirectory, environment),
      ...(platform === "win32" ? await findWindowsCandidates(environment) : [])
    ].filter((candidate): candidate is string => Boolean(candidate)));

    let lastError: string | null = null;
    for (const candidate of candidates) {
      if (isPathCandidate(candidate) && !existsSync(candidate)) continue;
      const result = await readVersion(candidate, environment, platform);
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

async function readVersion(
  command: string,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): Promise<{ version: string | null; error: string | null }> {
  return new Promise((resolve) => {
    const child = spawn(command, ["--version"], {
      env: withExecutableDirectory(environment, command, platform),
      shell: platform === "win32" && command.toLowerCase().endsWith(".cmd"),
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), 5000);
    let settled = false;

    const finish = (result: { version: string | null; error: string | null }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      finish({ version: null, error: error.message });
    });
    child.on("exit", (code) => {
      const version = stdout.trim() || stderr.trim();
      finish(code === 0 && version ? { version, error: null } : {
        version: null,
        error: version || `Codex CLI 退出码 ${code ?? "unknown"}`
      });
    });
  });
}

function findKnownCandidates(
  platform: NodeJS.Platform,
  homeDirectory: string,
  environment: NodeJS.ProcessEnv
): string[] {
  const executable = platform === "win32" ? "codex.cmd" : "codex";
  const candidates = platform === "darwin"
    ? ["/opt/homebrew/bin/codex", "/usr/local/bin/codex"]
    : platform === "linux" ? ["/usr/local/bin/codex", "/usr/bin/codex"] : [];

  if (platform !== "win32") {
    candidates.push(
      join(homeDirectory, ".volta", "bin", executable),
      join(homeDirectory, ".asdf", "shims", executable),
      join(homeDirectory, ".local", "share", "mise", "shims", executable),
      join(homeDirectory, ".local", "bin", executable),
      join(homeDirectory, ".bun", "bin", executable),
      join(homeDirectory, "Library", "pnpm", executable),
      join(homeDirectory, ".local", "share", "pnpm", executable),
      ...findNvmCandidates(homeDirectory, executable)
    );
  } else if (environment.APPDATA) {
    candidates.push(join(environment.APPDATA, "npm", executable));
  }

  return candidates;
}

function findNvmCandidates(homeDirectory: string, executable: string): string[] {
  const versionsDirectory = join(homeDirectory, ".nvm", "versions", "node");
  try {
    return readdirSync(versionsDirectory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))
      .map((version) => join(versionsDirectory, version, "bin", executable));
  } catch {
    return [];
  }
}

async function findWindowsCandidates(environment: NodeJS.ProcessEnv): Promise<string[]> {
  return new Promise((resolve) => {
    const child = spawn("where.exe", ["codex"], { env: environment, windowsHide: true });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.on("error", () => resolve([]));
    child.on("exit", () => resolve(output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)));
  });
}

export function withExecutableDirectory(
  environment: NodeJS.ProcessEnv,
  command: string,
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  if (!isPathCandidate(command)) return { ...environment };
  const pathKey = Object.keys(environment).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const currentPath = environment[pathKey] ?? "";
  const executableDirectory = dirname(command);
  const separator = platform === "win32" ? ";" : delimiter;
  const entries = currentPath.split(separator).filter(Boolean);
  const nextPath = [executableDirectory, ...entries.filter((entry) => entry !== executableDirectory)].join(separator);
  return { ...environment, [pathKey]: nextPath };
}

function isPathCandidate(command: string): boolean {
  return isAbsolute(command) || command.includes("/") || command.includes("\\");
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}
