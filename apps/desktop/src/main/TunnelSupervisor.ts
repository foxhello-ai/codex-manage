import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type TunnelSnapshot = {
  state: "idle" | "starting" | "online" | "reconnecting" | "stopped" | "failed";
  mode: "quick" | "named";
  publicUrl: string | null;
  error: string | null;
};

export type TunnelSupervisorOptions = {
  binaryPath: string;
  runtimeDirectory: string;
};

export class TunnelSupervisor extends EventEmitter {
  private child: ChildProcess | null = null;
  private desiredRunning = false;
  private desiredMode: "quick" | "named" = "quick";
  private originUrl: string | null = null;
  private namedToken: string | null = null;
  private namedPublicUrl: string | null = null;
  private retryAttempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private tokenCleanupTimer: ReturnType<typeof setTimeout> | null = null;
  private recentDiagnostic: string | null = null;
  private failureDiagnostic: string | null = null;
  private snapshot: TunnelSnapshot = {
    state: "idle",
    mode: "quick",
    publicUrl: null,
    error: null
  };

  constructor(private readonly options: TunnelSupervisorOptions) {
    super();
  }

  getSnapshot(): TunnelSnapshot {
    return { ...this.snapshot };
  }

  async startQuick(originUrl: string): Promise<TunnelSnapshot> {
    if (!existsSync(this.options.binaryPath)) {
      const message = `未找到 cloudflared：${this.options.binaryPath}`;
      this.update({ state: "failed", publicUrl: null, error: message });
      throw new Error(message);
    }

    this.desiredRunning = true;
    this.desiredMode = "quick";
    this.originUrl = originUrl;
    this.namedToken = null;
    this.namedPublicUrl = null;
    this.retryAttempt = 0;
    await this.spawnTunnel(false);
    return this.getSnapshot();
  }

  async startNamed(token: string, publicUrl: string): Promise<TunnelSnapshot> {
    if (!existsSync(this.options.binaryPath)) {
      const message = `未找到 cloudflared：${this.options.binaryPath}`;
      this.update({ state: "failed", mode: "named", publicUrl: null, error: message });
      throw new Error(message);
    }
    this.desiredRunning = true;
    this.desiredMode = "named";
    this.namedToken = token;
    this.namedPublicUrl = publicUrl.replace(/\/$/, "");
    this.retryAttempt = 0;
    await this.spawnTunnel(false);
    return this.getSnapshot();
  }

  async stop(): Promise<void> {
    this.desiredRunning = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.clearTokenFile();
    const child = this.child;
    this.child = null;
    this.update({ state: "stopped", publicUrl: null, error: null });
    if (!child) return;

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 5000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }

  private async spawnTunnel(reconnecting: boolean): Promise<void> {
    if (this.desiredMode === "quick" && !this.originUrl) throw new Error("缺少本地服务地址");
    if (this.desiredMode === "named" && !this.namedToken) throw new Error("缺少 Named Tunnel Token");
    if (this.child) await this.stopChildOnly();

    mkdirSync(this.options.runtimeDirectory, { recursive: true });
    this.update({
      state: reconnecting ? "reconnecting" : "starting",
      mode: this.desiredMode,
      publicUrl: null,
      error: null
    });
    this.recentDiagnostic = null;
    this.failureDiagnostic = null;

    let tokenFile: string | null = null;
    if (this.desiredMode === "named") {
      this.clearTokenFile();
      tokenFile = join(this.options.runtimeDirectory, "named-tunnel-token");
      writeFileSync(tokenFile, this.namedToken!, { encoding: "utf8", mode: 0o600 });
    }
    const args = this.desiredMode === "quick"
      ? ["--no-autoupdate", "tunnel", "--url", this.originUrl!]
      : ["--no-autoupdate", "tunnel", "run", "--token-file", tokenFile!];
    const child = spawn(this.options.binaryPath, args, {
      env: {
        ...process.env,
        HOME: this.options.runtimeDirectory,
        USERPROFILE: this.options.runtimeDirectory
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    if (tokenFile) {
      this.tokenCleanupTimer = setTimeout(() => this.clearTokenFile(), 10_000);
    }
    this.child = child;
    let stdoutBuffer = "";
    let stderrBuffer = "";

    const processChunk = (chunk: Buffer, source: "stdout" | "stderr") => {
      if (source === "stdout") stdoutBuffer += chunk.toString();
      else stderrBuffer += chunk.toString();
      const buffer = source === "stdout" ? stdoutBuffer : stderrBuffer;
      const lines = buffer.split(/\r?\n/);
      if (source === "stdout") stdoutBuffer = lines.pop() ?? "";
      else stderrBuffer = lines.pop() ?? "";
      lines.forEach((line) => this.processLogLine(line));
    };

    child.stdout?.on("data", (chunk: Buffer) => processChunk(chunk, "stdout"));
    child.stderr?.on("data", (chunk: Buffer) => processChunk(chunk, "stderr"));
    child.on("error", (error) => {
      this.update({ state: "failed", error: error.message, publicUrl: null });
    });
    child.on("exit", (code, signal) => {
      if (this.child === child) this.child = null;
      if (!this.desiredRunning) return;
      const diagnostic = this.failureDiagnostic ?? this.recentDiagnostic;
      const message = `cloudflared 已退出（code=${code ?? "null"}, signal=${signal ?? "null"}）${diagnostic ? `：${diagnostic}` : ""}`;
      this.scheduleReconnect(message);
    });
    if (this.desiredMode === "named" && this.namedPublicUrl) {
      void this.pollNamedTunnel(child, this.namedPublicUrl);
    }
  }

  private processLogLine(line: string): void {
    const diagnostic = stripTerminalFormatting(line).trim();
    if (!diagnostic) return;
    this.recentDiagnostic = diagnostic.slice(0, 500);
    if (/incorrect usage|\b(?:error|fatal|failed)\b/i.test(diagnostic)) {
      this.failureDiagnostic = this.recentDiagnostic;
    }

    const match = diagnostic.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
    if (match) {
      this.retryAttempt = 0;
      this.update({ state: "online", publicUrl: match[0], error: null });
      return;
    }

    try {
      const payload = JSON.parse(diagnostic) as Record<string, unknown>;
      const message = [payload.message, payload.msg, payload.url].filter((value) => typeof value === "string").join(" ");
      const jsonMatch = message.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (jsonMatch) {
        this.retryAttempt = 0;
        this.update({ state: "online", publicUrl: jsonMatch[0], error: null });
        return;
      }
      if (this.desiredMode === "named" && /registered tunnel connection/i.test(message) && this.namedPublicUrl) {
        this.retryAttempt = 0;
        this.update({ state: "online", mode: "named", publicUrl: this.namedPublicUrl, error: null });
      }
    } catch {
      // Non-JSON cloudflared diagnostics are intentionally not forwarded to the renderer.
    }
  }

  private scheduleReconnect(error: string): void {
    this.retryAttempt += 1;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.retryAttempt - 1, 5));
    this.update({ state: "reconnecting", publicUrl: null, error });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.desiredRunning) void this.spawnTunnel(true);
    }, delay);
  }

  private async pollNamedTunnel(child: ChildProcess, publicUrl: string): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (!this.desiredRunning || this.child !== child) return;
      try {
        const response = await fetch(`${publicUrl}/api/me`, { signal: AbortSignal.timeout(2000) });
        if (response.status > 0) {
          this.retryAttempt = 0;
          this.update({ state: "online", mode: "named", publicUrl, error: null });
          return;
        }
      } catch {
        // The connector may still be registering with Cloudflare.
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  private async stopChildOnly(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child) return;
    child.kill("SIGTERM");
  }

  private clearTokenFile(): void {
    if (this.tokenCleanupTimer) clearTimeout(this.tokenCleanupTimer);
    this.tokenCleanupTimer = null;
    rmSync(join(this.options.runtimeDirectory, "named-tunnel-token"), { force: true });
  }

  private update(patch: Partial<TunnelSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.emit("status", this.getSnapshot());
  }
}

function stripTerminalFormatting(value: string): string {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
}

export function resolveCloudflaredBinary(resourcesPath: string, developmentRoot: string): string {
  if (process.env.CODEX_CLOUDFLARED_PATH) return process.env.CODEX_CLOUDFLARED_PATH;
  const suffix = process.platform === "win32" ? ".exe" : "";
  const name = `cloudflared-${process.platform}-${process.arch}${suffix}`;
  const packaged = join(resourcesPath, "cloudflared", name);
  return existsSync(packaged) ? packaged : join(developmentRoot, "resources", "cloudflared", name);
}
