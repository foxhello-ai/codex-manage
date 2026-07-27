import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

export type CodexConfigChange = {
  directory: string;
  signature: string;
  changedAt: string;
};

export type CodexConfigWatcherOptions = {
  directory?: string;
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  debounceMs?: number;
  pollIntervalMs?: number;
  onChange: (change: CodexConfigChange) => void;
};

export class CodexConfigWatcher {
  private watcher: FSWatcher | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private signature: string | null = null;

  readonly directory: string;

  constructor(private readonly options: CodexConfigWatcherOptions) {
    this.directory = resolveCodexConfigDirectory(options.environment, options.homeDirectory, options.directory);
  }

  start(): void {
    this.signature = this.readSignature();
    this.ensureFsWatcher();
    if (!this.pollTimer) {
      this.pollTimer = setInterval(() => this.checkNow(), this.options.pollIntervalMs ?? 5000);
    }
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
  }

  checkNow(): boolean {
    this.ensureFsWatcher();
    const nextSignature = this.readSignature();
    if (this.signature === null) {
      this.signature = nextSignature;
      return false;
    }
    if (nextSignature === this.signature) return false;
    this.signature = nextSignature;
    this.scheduleChange();
    return true;
  }

  private ensureFsWatcher(): void {
    if (this.watcher || !existsSync(this.directory)) return;
    try {
      this.watcher = watch(this.directory, { persistent: false }, (_eventType, changedFile) => {
        if (changedFile && !isCodexConfigFile(basename(String(changedFile)))) return;
        this.checkNow();
      });
      this.watcher.on("error", () => {
        this.watcher?.close();
        this.watcher = null;
      });
    } catch {
      this.watcher = null;
    }
  }

  private scheduleChange(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      const stableSignature = this.readSignature();
      this.signature = stableSignature;
      this.options.onChange({
        directory: this.directory,
        signature: stableSignature,
        changedAt: new Date().toISOString()
      });
    }, this.options.debounceMs ?? 1200);
  }

  private readSignature(): string {
    const hash = createHash("sha256");
    hash.update(this.directory);
    for (const file of listCodexConfigFiles(this.directory)) {
      const path = join(this.directory, file);
      hash.update(file);
      try {
        hash.update(readFileSync(path));
      } catch {
        hash.update("<unreadable>");
      }
    }
    return hash.digest("hex");
  }
}

export function resolveCodexConfigDirectory(
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory = homedir(),
  explicitDirectory?: string
): string {
  return resolve(explicitDirectory ?? environment.CODEX_HOME ?? join(homeDirectory, ".codex"));
}

function listCodexConfigFiles(directory: string): string[] {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && isCodexConfigFile(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function isCodexConfigFile(file: string): boolean {
  if (file === "config.toml" || file === "auth.json") return true;
  return false;
}
