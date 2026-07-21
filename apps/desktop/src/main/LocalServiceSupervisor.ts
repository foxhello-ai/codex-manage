import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

export type LocalServiceSnapshot = {
  state: "idle" | "starting" | "running" | "stopped" | "failed";
  url: string | null;
  port: number | null;
  error: string | null;
};

export type LocalServiceOptions = {
  electronExecutable: string;
  serverEntry: string;
  clientDir: string;
  userDataDir: string;
  port: number;
  controlToken: string;
  codexCliPath: string;
};

export class LocalServiceSupervisor extends EventEmitter {
  private child: ChildProcess | null = null;
  private snapshot: LocalServiceSnapshot = {
    state: "idle",
    url: null,
    port: null,
    error: null
  };

  constructor(private readonly options: LocalServiceOptions) {
    super();
  }

  getSnapshot(): LocalServiceSnapshot {
    return { ...this.snapshot };
  }

  async start(): Promise<LocalServiceSnapshot> {
    if (this.child && this.snapshot.state === "running") return this.getSnapshot();
    this.update({ state: "starting", url: null, port: null, error: null });

    return new Promise((resolve, reject) => {
      const child = spawn(this.options.electronExecutable, [this.options.serverEntry], {
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
          NODE_ENV: "production",
          CODEX_MANAGE_RUNTIME_MODE: "desktop",
          CODEX_MANAGE_USER_DATA_DIR: this.options.userDataDir,
          CODEX_WEB_HOST: "127.0.0.1",
          CODEX_WEB_PORT: String(this.options.port),
          CODEX_WEB_CLIENT_DIR: this.options.clientDir,
          CODEX_DESKTOP_CONTROL_TOKEN: this.options.controlToken,
          CODEX_CLI_PATH: this.options.codexCliPath
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });
      this.child = child;
      let stdoutBuffer = "";
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        const error = new Error("本地服务启动超时");
        this.update({ state: "failed", error: error.message });
        child.kill();
        reject(error);
      }, 30_000);

      const finishStart = (line: string) => {
        if (!line.startsWith("CODEX_MANAGE_READY ")) return;
        try {
          const payload = JSON.parse(line.slice("CODEX_MANAGE_READY ".length)) as {
            url: string;
            port: number;
          };
          clearTimeout(timeout);
          settled = true;
          this.update({ state: "running", url: payload.url, port: payload.port, error: null });
          resolve(this.getSnapshot());
        } catch (error) {
          this.update({ state: "failed", error: error instanceof Error ? error.message : String(error) });
        }
      };

      child.stdout?.on("data", (chunk) => {
        stdoutBuffer += chunk.toString();
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? "";
        lines.forEach(finishStart);
      });
      child.stderr?.on("data", (chunk) => {
        const text = chunk.toString().trim();
        if (text) this.emit("log", text);
      });
      child.on("error", (error) => {
        clearTimeout(timeout);
        this.child = null;
        this.update({ state: "failed", error: error.message });
        if (!settled) {
          settled = true;
          reject(error);
        }
      });
      child.on("exit", (code, signal) => {
        clearTimeout(timeout);
        this.child = null;
        if (this.snapshot.state !== "stopped") {
          const message = `本地服务已退出（code=${code ?? "null"}, signal=${signal ?? "null"}）`;
          this.update({ state: "failed", url: null, port: null, error: message });
          if (!settled) {
            settled = true;
            reject(new Error(message));
          }
        }
      });
    });
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.update({ state: "stopped", url: null, port: null, error: null });
    if (!child) return;

    await new Promise<void>((resolve) => {
      const forceTimer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 5000);
      child.once("exit", () => {
        clearTimeout(forceTimer);
        resolve();
      });
      child.kill("SIGTERM");
    });
    this.child = null;
  }

  private update(patch: Partial<LocalServiceSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.emit("status", this.getSnapshot());
  }
}
