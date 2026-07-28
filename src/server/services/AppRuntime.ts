import type { AppConfig } from "../config";
import { ModelDomainError } from "../modelErrors";
import { CodexAppServerClient, type CodexAppServerSnapshot } from "./CodexAppServerClient";
import { detectCodexVersion } from "./codexVersion";
import { RuntimeManager, type RuntimeReloadBlocker } from "./RuntimeManager";

export type RuntimeReloadTrigger = "manual" | "config_watcher";

export type RuntimeReloadSnapshot = {
  generation: number;
  reloadedAt: string | null;
  trigger: RuntimeReloadTrigger | null;
  reason: string | null;
  lastError: string | null;
};

export type RuntimeSnapshot = {
  codexCliVersion: string | null;
  codexVersionError: string | null;
  appServer: CodexAppServerSnapshot;
  runtimeReload: RuntimeReloadSnapshot;
};

export type RuntimeReloadResult = {
  generation: number;
  reloadedAt: string;
  trigger: RuntimeReloadTrigger;
  reason: string | null;
  codexCliVersion: string | null;
  appServer: CodexAppServerSnapshot;
};

export class AppRuntime {
  readonly appServer: CodexAppServerClient;
  readonly runtimeManager: RuntimeManager;
  private codexCliVersion: string | null = null;
  private codexVersionError: string | null = null;
  private runtimeReload: RuntimeReloadSnapshot = {
    generation: 0,
    reloadedAt: null,
    trigger: null,
    reason: null,
    lastError: null
  };

  constructor(private readonly config: AppConfig) {
    this.appServer = new CodexAppServerClient({
      codexCliPath: config.codexCliPath
    });
    this.runtimeManager = new RuntimeManager(this.appServer);
    this.appServer.on("error", () => {
      // Snapshot state carries the error for diagnostics; avoid an unhandled EventEmitter error.
    });
    this.appServer.on("stderr", (text: string) => {
      console.error(`[codex app-server] ${text}`);
    });
  }

  async start(): Promise<void> {
    await this.detectVersion();
    await this.appServer.start();
  }

  async stop(): Promise<void> {
    await this.appServer.stop();
  }

  async reloadAppServer(input: { trigger?: RuntimeReloadTrigger; reason?: string | null } = {}): Promise<RuntimeReloadResult> {
    const blockers = this.runtimeManager.prepareForAppServerReload();
    if (blockers.length > 0) {
      throw new RuntimeReloadBlockedError(blockers);
    }

    const trigger = input.trigger ?? "manual";
    const reason = input.reason?.trim() ? input.reason.trim().slice(0, 200) : null;
    try {
      await this.detectVersion();
      await this.appServer.stop();
      await this.appServer.start();
      this.runtimeManager.finishAppServerReload(true);
      const reloadedAt = new Date().toISOString();
      this.runtimeReload = {
        generation: this.runtimeReload.generation + 1,
        reloadedAt,
        trigger,
        reason,
        lastError: null
      };
      return {
        generation: this.runtimeReload.generation,
        reloadedAt,
        trigger,
        reason,
        codexCliVersion: this.codexCliVersion,
        appServer: this.appServer.getSnapshot()
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.runtimeManager.finishAppServerReload(false, message);
      this.runtimeReload = {
        ...this.runtimeReload,
        lastError: message
      };
      throw error;
    }
  }

  getSnapshot(): RuntimeSnapshot {
    return {
      codexCliVersion: this.codexCliVersion,
      codexVersionError: this.codexVersionError,
      appServer: this.appServer.getSnapshot(),
      runtimeReload: { ...this.runtimeReload }
    };
  }

  private async detectVersion() {
    try {
      this.codexCliVersion = await detectCodexVersion(this.config.codexCliPath);
      this.codexVersionError = null;
    } catch (error) {
      this.codexCliVersion = null;
      this.codexVersionError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }
}

export class RuntimeReloadBlockedError extends ModelDomainError {
  constructor(readonly blockers: RuntimeReloadBlocker[]) {
    super("RUNTIME_RELOAD_BLOCKED", "当前存在运行中会话，暂时不能刷新 Codex 运行时", 409, { blockers });
  }
}
