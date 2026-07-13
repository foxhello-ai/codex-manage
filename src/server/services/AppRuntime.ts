import type { AppConfig } from "../config";
import { CodexAppServerClient, type CodexAppServerSnapshot } from "./CodexAppServerClient";
import { detectCodexVersion } from "./codexVersion";

export type RuntimeSnapshot = {
  codexCliVersion: string | null;
  codexVersionError: string | null;
  appServer: CodexAppServerSnapshot;
};

export class AppRuntime {
  readonly appServer: CodexAppServerClient;
  private codexCliVersion: string | null = null;
  private codexVersionError: string | null = null;

  constructor(private readonly config: AppConfig) {
    this.appServer = new CodexAppServerClient({
      codexCliPath: config.codexCliPath
    });
    this.appServer.on("error", () => {
      // Snapshot state carries the error for diagnostics; avoid an unhandled EventEmitter error.
    });
  }

  async start(): Promise<void> {
    await this.detectVersion();
    await this.appServer.start();
  }

  async stop(): Promise<void> {
    await this.appServer.stop();
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
