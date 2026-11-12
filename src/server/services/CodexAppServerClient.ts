import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { delimiter, dirname, isAbsolute } from "node:path";
import { createInterface, type Interface } from "node:readline";

export type JsonRpcId = number | string;

export type JsonRpcRequest = {
  id: JsonRpcId;
  method: string;
  params?: unknown;
};

export type JsonRpcNotification = {
  method: string;
  params?: unknown;
};

export type JsonRpcResponse<T = unknown> = {
  id: JsonRpcId;
  result?: T;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
};

export type AppServerStatus = "idle" | "starting" | "ready" | "failed" | "exited";

export type CodexAppServerSnapshot = {
  status: AppServerStatus;
  pid: number | null;
  lastError: string | null;
  initialized: boolean;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeout: NodeJS.Timeout;
};

export type CodexAppServerClientOptions = {
  codexCliPath: string;
  spawnProcess?: typeof spawn;
  requestTimeoutMs?: number;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  threadUnloadDelaySecs?: number;
};

export class CodexAppServerClient extends EventEmitter {
  private readonly codexCliPath: string;
  private readonly spawnProcess: typeof spawn;
  private readonly requestTimeoutMs: number;
  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;
  private readonly threadUnloadDelaySecs?: number;
  private process: ChildProcessWithoutNullStreams | null = null;
  private stdoutLines: Interface | null = null;
  private nextRequestId = 1;
  private pending = new Map<JsonRpcId, PendingRequest>();
  private status: AppServerStatus = "idle";
  private lastError: string | null = null;
  private initialized = false;

  constructor(options: CodexAppServerClientOptions) {
    super();
    this.codexCliPath = options.codexCliPath;
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 60000;
    this.platform = options.platform ?? process.platform;
    this.env = options.env ?? process.env;
    this.threadUnloadDelaySecs = options.threadUnloadDelaySecs;
  }

  getSnapshot(): CodexAppServerSnapshot {
    return {
      status: this.status,
      pid: this.process?.pid ?? null,
      lastError: this.lastError,
      initialized: this.initialized
    };
  }

  async start(): Promise<void> {
    if (this.status === "ready" || this.status === "starting") return;

    this.status = "starting";
    this.lastError = null;
    this.initialized = false;

    let child: ChildProcessWithoutNullStreams;
    try {
      const args = ["app-server"];
      if (this.threadUnloadDelaySecs !== undefined) args.push("-c", `thread_unload_delay_secs=${this.threadUnloadDelaySecs}`);
      child = this.spawnProcess(this.codexCliPath, args, {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        shell: this.platform === "win32" && this.codexCliPath.toLowerCase().endsWith(".cmd"),
        env: this.injectCodexDirectoryIntoPath()
      });
      this.process = child;
    } catch (error) {
      this.fail(error);
      throw this.toError(error);
    }

    child.stderr.on("data", (chunk) => {
      const text = String(chunk).trim();
      if (text) this.emit("stderr", text);
    });

    child.on("error", (error) => {
      if (this.process !== child) return;
      this.fail(error);
    });

    child.on("exit", (code, signal) => {
      if (this.process !== child) return;
      this.status = this.status === "failed" ? "failed" : "exited";
      this.initialized = false;
      this.lastError = code === 0 || code === null ? null : `app-server exited with code ${code}`;
      this.rejectAll(new Error(this.lastError ?? `app-server exited: ${signal ?? "unknown"}`));
      this.emit("exit", { code, signal });
    });

    this.stdoutLines = createInterface({
      input: child.stdout
    });
    this.stdoutLines.on("line", (line) => {
      if (this.process === child) this.handleLine(line);
    });

    await this.initialize();
    this.status = "ready";
    this.initialized = true;
  }

  async stop(): Promise<void> {
    this.stdoutLines?.close();
    this.stdoutLines = null;

    const child = this.process;
    if (!child) {
      this.initialized = false;
      this.status = "exited";
      return;
    }
    this.process = null;
    this.rejectAll(new Error("app-server stopped"));
    this.initialized = false;
    this.status = "exited";

    if (!child.killed) await this.terminate(child);
  }

  async initialize(): Promise<unknown> {
    const result = await this.request("initialize", {
      clientInfo: {
        name: "codex_manage",
        title: "Codex Manage",
        version: "1.0.0"
      },
      capabilities: {
        experimentalApi: true
      }
    });

    this.notify("initialized", {});
    return result;
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.process || !this.process.stdin.writable) {
      return Promise.reject(new Error("codex app-server is not running"));
    }

    const id = this.nextRequestId++;
    const message: JsonRpcRequest = { id, method, params };

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex app-server request timed out: ${method}`));
      }, this.requestTimeoutMs);

      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout
      });

      this.process?.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pending.delete(id);
        }
        reject(error);
      });
    });
  }

  notify(method: string, params?: unknown): void {
    if (!this.process || !this.process.stdin.writable) {
      throw new Error("codex app-server is not running");
    }

    const message: JsonRpcNotification = { method, params };
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  respondToServerRequest(id: JsonRpcId, result: unknown): void {
    if (!this.process || !this.process.stdin.writable) {
      throw new Error("codex app-server is not running");
    }

    this.process.stdin.write(`${JSON.stringify({ id, result })}\n`);
  }

  rejectServerRequest(id: JsonRpcId, message: string): void {
    if (!this.process || !this.process.stdin.writable) throw new Error("codex app-server is not running");
    this.process.stdin.write(`${JSON.stringify({ id, error: { code: -32601, message } })}\n`);
  }

  private handleLine(line: string) {
    let message: unknown;

    try {
      message = JSON.parse(line) as unknown;
    } catch {
      this.emit("protocolError", new Error("app-server emitted non-JSON output"));
      return;
    }

    if (!message || typeof message !== "object") return;

    const maybeResponse = message as Partial<JsonRpcResponse>;
    if ((typeof maybeResponse.id === "number" || typeof maybeResponse.id === "string") && ("result" in maybeResponse || "error" in maybeResponse)) {
      this.handleResponse(maybeResponse as JsonRpcResponse);
      return;
    }

    const maybeRequest = message as Partial<JsonRpcRequest>;
    if ((typeof maybeRequest.id === "number" || typeof maybeRequest.id === "string") && typeof maybeRequest.method === "string") {
      this.emit("serverRequest", maybeRequest);
      return;
    }

    const maybeNotification = message as Partial<JsonRpcNotification>;
    if (typeof maybeNotification.method === "string") {
      this.emit("notification", maybeNotification);
    }
  }

  private handleResponse(response: JsonRpcResponse) {
    const pending = this.pending.get(response.id);
    if (!pending) return;

    this.pending.delete(response.id);
    clearTimeout(pending.timeout);

    if (response.error) {
      pending.reject(new Error(response.error.message));
      return;
    }

    pending.resolve(response.result);
  }

  private fail(error: unknown) {
    const normalized = this.toError(error);
    this.status = "failed";
    this.lastError = normalized.message;
    this.initialized = false;
    this.rejectAll(normalized);
    this.emit("error", normalized);
  }

  private rejectAll(error: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private terminate(child: ChildProcessWithoutNullStreams): Promise<void> {
    return new Promise((resolve) => {
      const exitCode = (child as { exitCode?: number | null }).exitCode;
      const signalCode = (child as { signalCode?: NodeJS.Signals | null }).signalCode;
      if (exitCode !== undefined && exitCode !== null) {
        resolve();
        return;
      }
      if (signalCode !== undefined && signalCode !== null) {
        resolve();
        return;
      }

      const timer = setTimeout(resolve, 3000);
      timer.unref?.();
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }

  private toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
  }

  private injectCodexDirectoryIntoPath(): NodeJS.ProcessEnv {
    if (!isAbsolute(this.codexCliPath) && !this.codexCliPath.includes("/") && !this.codexCliPath.includes("\\")) {
      return { ...this.env };
    }
    const pathKey = Object.keys(this.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
    const currentPath = this.env[pathKey] ?? "";
    const executableDirectory = dirname(this.codexCliPath);
    const separator = this.platform === "win32" ? ";" : delimiter;
    const entries = currentPath.split(separator).filter(Boolean);
    const nextPath = [executableDirectory, ...entries.filter((entry) => entry !== executableDirectory)].join(separator);
    return { ...this.env, [pathKey]: nextPath };
  }
}
