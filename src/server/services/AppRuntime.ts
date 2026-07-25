import type { AppConfig } from "../config";
import { ModelDomainError } from "../modelErrors";
import { CodexAppServerClient, type CodexAppServerSnapshot } from "./CodexAppServerClient";
import { detectCodexVersion } from "./codexVersion";
import { RuntimeManager, type RuntimeReloadBlocker } from "./RuntimeManager";

export type RuntimeSnapshot = {
  codexCliVersion: string | null;
  codexVersionError: string | null;
  appServer: CodexAppServerSnapshot;
};

export type RuntimeReloadResult = {
  reloadedAt: string;
  codexCliVersion: string | null;
  appServer: CodexAppServerSnapshot;
};

export class AppRuntime {
  readonly appServer: CodexAppServerClient;
  readonly runtimeManager: RuntimeManager;
  private codexCliVersion: string | null = null;
  private codexVersionError: string | null = null;

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

  async reloadAppServer(): Promise<RuntimeReloadResult> {
    const blockers = this.runtimeManager.prepareForAppServerReload();
    if (blockers.length > 0) {
      throw new RuntimeReloadBlockedError(blockers);
    }

    try {
      await this.detectVersion();
      await this.appServer.stop();
      await this.appServer.start();
      this.runtimeManager.finishAppServerReload(true);
      return {
        reloadedAt: new Date().toISOString(),
        codexCliVersion: this.codexCliVersion,
        appServer: this.appServer.getSnapshot()
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.runtimeManager.finishAppServerReload(false, message);
      throw error;
    }
  }

  getSnapshot(): RuntimeSnapshot {
    return {
      codexCliVersion: this.codexCliVersion,
      codexVersionError: this.codexVersionError,
      appServer: this.appServer.getSnapshot()
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
