import { EventEmitter } from "node:events";
import { app } from "electron";
import { autoUpdater } from "electron-updater";
import type { Logger } from "electron-updater";
import type { UpdateStatus } from "../shared/types";
import type { DiagnosticLog } from "./DiagnosticLog";

type UpdateManagerOptions = {
  diagnosticLog: DiagnosticLog;
  beforeInstall: () => Promise<void>;
  updateUrl?: string;
};

export class UpdateManager extends EventEmitter {
  private status: UpdateStatus = {
    state: "idle",
    currentVersion: app.getVersion(),
    targetVersion: null,
    lastCheckedAt: null,
    progressPercent: null,
    error: null,
    manual: false
  };
  private manualInstallRequested = false;
  private checkTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: UpdateManagerOptions) {
    super();
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.autoRunAppAfterInstall = true;
    autoUpdater.allowDowngrade = false;
    autoUpdater.allowPrerelease = false;
    autoUpdater.logger = this.createLogger();

    const updateUrl = options.updateUrl ?? process.env.CODEX_UPDATE_URL ?? "https://codex-api.xmwefun.cn/updates/stable";
    if (app.isPackaged) {
      autoUpdater.setFeedURL({ provider: "generic", url: updateUrl });
    }

    autoUpdater.on("checking-for-update", () => {
      this.update({ state: "checking", lastCheckedAt: new Date().toISOString(), error: null });
    });
    autoUpdater.on("update-not-available", () => {
      this.manualInstallRequested = false;
      this.update({ state: "not_available", targetVersion: null, progressPercent: null, error: null });
    });
    autoUpdater.on("update-available", (info) => {
      this.update({ state: "available", targetVersion: info.version, progressPercent: null, error: null });
      void this.download();
    });
    autoUpdater.on("download-progress", (progress) => {
      this.update({ state: "downloading", progressPercent: Number(progress.percent.toFixed(1)), error: null });
    });
    autoUpdater.on("update-downloaded", (info) => {
      this.update({ state: "downloaded", targetVersion: info.version, progressPercent: 100, error: null });
      if (this.manualInstallRequested) {
        void this.installDownloadedUpdate();
      }
    });
    autoUpdater.on("error", (error) => {
      this.manualInstallRequested = false;
      this.update({ state: "error", error: this.normalizeError(error) });
    });
  }

  getStatus(): UpdateStatus {
    return { ...this.status };
  }

  startAutomaticChecks(): void {
    if (!app.isPackaged) return;
    setTimeout(() => void this.checkForUpdates(false), 15_000);
    this.checkTimer = setInterval(() => void this.checkForUpdates(false), 6 * 60 * 60_000);
  }

  stop(): void {
    if (this.checkTimer) clearInterval(this.checkTimer);
    this.checkTimer = null;
  }

  async checkForUpdates(manual: boolean): Promise<UpdateStatus> {
    if (!app.isPackaged) {
      this.update({
        state: "error",
        manual,
        lastCheckedAt: new Date().toISOString(),
        error: "开发环境不支持 Electron 自动更新，请使用打包应用验证"
      });
      return this.getStatus();
    }
    this.manualInstallRequested = manual;
    this.update({ state: "checking", manual, lastCheckedAt: new Date().toISOString(), error: null });
    await autoUpdater.checkForUpdates();
    return this.getStatus();
  }

  async installDownloadedUpdate(): Promise<UpdateStatus> {
    if (this.status.state !== "downloaded") {
      throw new Error("没有已下载的新版本");
    }
    this.manualInstallRequested = false;
    this.update({ state: "installing", error: null });
    this.options.diagnosticLog.write("update", "install_requested", {
      currentVersion: this.status.currentVersion,
      targetVersion: this.status.targetVersion,
      platform: process.platform
    });
    try {
      await this.options.beforeInstall();
      this.options.diagnosticLog.write("update", "quit_and_install_invoked", {
        currentVersion: this.status.currentVersion,
        targetVersion: this.status.targetVersion,
        platform: process.platform
      });
      setImmediate(() => autoUpdater.quitAndInstall(false, true));
    } catch (error) {
      this.update({ state: "error", error: this.normalizeError(error) });
    }
    return this.getStatus();
  }

  private async download(): Promise<void> {
    try {
      this.update({ state: "downloading", progressPercent: 0, error: null });
      await autoUpdater.downloadUpdate();
    } catch (error) {
      this.manualInstallRequested = false;
      this.update({ state: "error", error: this.normalizeError(error) });
    }
  }

  private createLogger(): Logger {
    return {
      info: (message?: unknown) => this.writeUpdaterLog("info", message),
      warn: (message?: unknown) => this.writeUpdaterLog("warn", message),
      error: (message?: unknown) => this.writeUpdaterLog("error", message),
      debug: (message: string) => this.writeUpdaterLog("debug", message)
    };
  }

  private writeUpdaterLog(level: "debug" | "info" | "warn" | "error", message: unknown): void {
    this.options.diagnosticLog.write("update", "electron_updater_log", {
      level,
      message: message instanceof Error ? message.message : String(message ?? "")
    });
  }

  private normalizeError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    if (process.platform === "darwin" && message.includes("Could not get code signature")) {
      return "当前 macOS 安装包未完成代码签名，系统更新器无法校验正在运行的应用签名；请使用已签名并公证的正式安装包验证自动升级。";
    }
    return message;
  }

  private update(patch: Partial<UpdateStatus>): void {
    this.status = { ...this.status, ...patch };
    this.options.diagnosticLog.write("update", this.status.state, {
      currentVersion: this.status.currentVersion,
      targetVersion: this.status.targetVersion,
      manual: this.status.manual,
      progressPercent: this.status.progressPercent,
      error: this.status.error
    });
    this.emit("status", this.getStatus());
  }
}
