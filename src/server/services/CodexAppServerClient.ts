import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface, type Interface } from "node:readline";

export type JsonRpcId = number;

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
};

export type CodexAppServerClientOptions = {
  codexCliPath: string;
  spawnProcess?: typeof spawn;
};

export class CodexAppServerClient extends EventEmitter {
  private readonly codexCliPath: string;
  private readonly spawnProcess: typeof spawn;
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

    try {
      this.process = this.spawnProcess(this.codexCliPath, ["app-server"], {
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (error) {
      this.fail(error);
      throw this.toError(error);
    }

    this.process.stderr.on("data", (chunk) => {
      const text = String(chunk).trim();
      if (text) this.emit("stderr", text);
    });

    this.process.on("error", (error) => {
      this.fail(error);
    });

    this.process.on("exit", (code, signal) => {
      this.status = this.status === "failed" ? "failed" : "exited";
      this.initialized = false;
      this.lastError = code === 0 || code === null ? null : `app-server exited with code ${code}`;
      this.rejectAll(new Error(this.lastError ?? `app-server exited: ${signal ?? "unknown"}`));
      this.emit("exit", { code, signal });
    });

    this.stdoutLines = createInterface({
      input: this.process.stdout
    });
    this.stdoutLines.on("line", (line) => this.handleLine(line));

    await this.initialize();
    this.status = "ready";
    this.initialized = true;
  }

  async stop(): Promise<void> {
    this.stdoutLines?.close();
    this.stdoutLines = null;

    if (this.process && !this.process.killed) {
      this.process.kill("SIGTERM");
    }

    this.rejectAll(new Error("app-server stopped"));
    this.process = null;
    this.initialized = false;
    this.status = "exited";
  }

  async initialize(): Promise<unknown> {
    const result = await this.request("initialize", {
      clientInfo: {
        name: "codex_manage",
        title: "Codex Manage",
        version: "0.1.0"
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
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject
      });

      this.process?.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (!error) return;
        this.pending.delete(id);
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
    if (typeof maybeResponse.id === "number" && ("result" in maybeResponse || "error" in maybeResponse)) {
      this.handleResponse(maybeResponse as JsonRpcResponse);
      return;
    }

    const maybeRequest = message as Partial<JsonRpcRequest>;
    if (typeof maybeRequest.id === "number" && typeof maybeRequest.method === "string") {
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
      pending.reject(error);
    }
    this.pending.clear();
  }

  private toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
  }
}
