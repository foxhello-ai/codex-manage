import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { hostname, release } from "node:os";
import { join, resolve } from "node:path";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  shell,
  Tray
} from "electron";
import { CodexLocator, type CodexLocation } from "./CodexLocator";
import { CodexConfigWatcher, type CodexConfigChange } from "./CodexConfigWatcher";
import { CloudClient, type CloudAuthResponse, type CloudSession } from "./CloudClient";
import { CredentialVault } from "./CredentialVault";
import { DeviceBindingVault } from "./DeviceBindingVault";
import { DiagnosticLog } from "./DiagnosticLog";
import { DesktopSettingsStore } from "./DesktopSettingsStore";
import { IssueReportQueue, type PendingIssueReport } from "./IssueReportQueue";
import { LocalServiceSupervisor } from "./LocalServiceSupervisor";
import { resolveCloudflaredBinary, TunnelSupervisor } from "./TunnelSupervisor";
import { UpdateManager } from "./UpdateManager";
import type { BillingOrderDetail, DesktopStatus, IssueReportCategory, IssueReportSubmissionResult, PaymentChannel } from "../shared/types";

type DesktopAuthStatus = {
  ready: boolean;
  setupRequired: boolean;
  defaultPassword: boolean;
  activeSessionCount: number;
};

class DesktopController {
  private window: BrowserWindow | null = null;
  private tray: Tray | null = null;
  private localService: LocalServiceSupervisor | null = null;
  private tunnel: TunnelSupervisor | null = null;
  private codex: CodexLocation = {
    available: false,
    path: null,
    version: null,
    error: "正在检测 Codex CLI"
  };
  private auth: DesktopAuthStatus = {
    ready: false,
    setupRequired: true,
    defaultPassword: false,
    activeSessionCount: 0
  };
  private readonly cloudClient = new CloudClient(
    process.env.CODEX_CONTROL_API_URL ?? "https://codex-api.xmwefun.cn"
  );
  private credentialVault: CredentialVault | null = null;
  private deviceBindingVault: DeviceBindingVault | null = null;
  private desktopSettingsStore: DesktopSettingsStore | null = null;
  private issueReportQueue: IssueReportQueue | null = null;
  private cloudSession: CloudSession | null = null;
  private entitlements: Record<string, string | number | boolean> = {};
  private subscription: { planCode: string; planName: string; expiresAt: string | null } | null = null;
  private namedTunnelStatus: string | null = null;
  private cloudError: string | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly controlToken = randomBytes(32).toString("base64url");
  private launchAtLogin = false;
  private diagnosticLog: DiagnosticLog | null = null;
  private userRefreshPromise: Promise<void> | null = null;
  private deviceSessionPromise: Promise<void> | null = null;
  private localRestartTimer: ReturnType<typeof setTimeout> | null = null;
  private localStableTimer: ReturnType<typeof setTimeout> | null = null;
  private localRestartAttempts = 0;
  private updateManager: UpdateManager | null = null;
  private codexConfigWatcher: CodexConfigWatcher | null = null;
  private runtimeReloadRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private runtimeReloadRetryAttempt = 0;
  private runtimeReload: DesktopStatus["runtimeReload"] = {
    state: "idle",
    trigger: null,
    reason: null,
    lastDetectedAt: null,
    lastAttemptAt: null,
    lastReloadedAt: null,
    nextRetryAt: null,
    error: null
  };
  private issueReporting: DesktopStatus["issueReporting"] = {
    autoEnabled: true,
    queuedCount: 0,
    lastSubmittedAt: null,
    lastError: null
  };
  private readonly reportedAutomaticFingerprints = new Set<string>();
  private flushingIssueReports = false;

  constructor(private readonly startHidden = false) {}

  async initialize(): Promise<void> {
    this.diagnosticLog = new DiagnosticLog(join(app.getPath("userData"), "logs", "desktop-diagnostics.jsonl"));
    this.desktopSettingsStore = new DesktopSettingsStore(join(app.getPath("userData"), "desktop-settings.json"));
    this.issueReportQueue = new IssueReportQueue(join(app.getPath("userData"), "issue-report-queue.json"));
    const desktopSettings = this.desktopSettingsStore.load();
    this.issueReporting = {
      ...this.issueReporting,
      autoEnabled: desktopSettings.issueAutoReportEnabled,
      queuedCount: this.issueReportQueue.count()
    };
    this.launchAtLogin = app.getLoginItemSettings().openAtLogin;
    this.diagnosticLog.write("desktop", "application_started", {
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      startHidden: this.startHidden
    });
    this.registerIpc();
    this.createWindow();
    this.createTray();
    this.updateManager = new UpdateManager({
      diagnosticLog: this.diagnosticLog,
      beforeInstall: async () => {
        await this.prepareForUpdateInstall();
        isQuitting = true;
      }
    });
    this.updateManager.on("status", () => {
      const updateStatus = this.updateManager?.getStatus();
      if (updateStatus?.state === "error" && updateStatus.error) {
        void this.reportAutomaticIssue(
          "auto_defect",
          "defect",
          "Electron 更新失败",
          updateStatus.error,
          `update:${updateStatus.error}`
        );
      }
      this.updateTrayMenu();
      this.emitStatus();
    });
    this.credentialVault = new CredentialVault(join(app.getPath("userData"), "cloud-credentials.json"));
    this.deviceBindingVault = new DeviceBindingVault(join(app.getPath("userData"), "device-bindings.json"));
    this.cloudSession = this.credentialVault.load();
    this.saveDeviceBinding();

    this.codex = await new CodexLocator().locate();
    this.diagnosticLog.write("codex", "detection_completed", {
      available: this.codex.available,
      version: this.codex.version,
      error: this.codex.error
    });
    this.emitStatus();

    const developmentRoot = resolve(app.getAppPath(), "../..");
    const serverEntry = app.isPackaged
      ? join(process.resourcesPath, "local-server", "desktop-entry.cjs")
      : join(developmentRoot, "dist", "server", "desktop-entry.cjs");
    const clientDir = app.isPackaged
      ? join(process.resourcesPath, "local-client")
      : join(developmentRoot, "dist", "client");
    const port = await findAvailablePort(4310);

    this.localService = new LocalServiceSupervisor({
      electronExecutable: process.execPath,
      serverEntry,
      clientDir,
      userDataDir: app.getPath("userData"),
      port,
      controlToken: this.controlToken,
      codexCliPath: this.codex.path ?? "codex"
    });
    this.localService.on("status", (snapshot) => {
      this.diagnosticLog?.write("local-service", "status_changed", {
        state: snapshot.state,
        port: snapshot.port,
        error: snapshot.error
      });
      if (snapshot.state === "running") {
        if (this.localStableTimer) clearTimeout(this.localStableTimer);
        this.localStableTimer = setTimeout(() => {
          this.localRestartAttempts = 0;
          this.localStableTimer = null;
        }, 60_000);
      } else if (snapshot.state === "failed") {
        void this.reportAutomaticIssue(
          "auto_unavailable",
          "unavailable",
          "本地服务不可用",
          snapshot.error ?? "本地服务启动或运行失败",
          `local-service:${snapshot.error ?? "failed"}`
        );
        this.scheduleLocalServiceRestart();
      }
      this.emitStatus();
    });

    const binaryPath = resolveCloudflaredBinary(process.resourcesPath, developmentRoot);
    this.tunnel = new TunnelSupervisor({
      binaryPath,
      runtimeDirectory: join(app.getPath("userData"), "tunnel")
    });
    this.tunnel.on("status", (snapshot) => {
      this.diagnosticLog?.write("tunnel", "status_changed", {
        state: snapshot.state,
        mode: snapshot.mode,
        error: snapshot.error
      });
      if (snapshot.state === "failed") {
        void this.reportAutomaticIssue(
          "auto_unavailable",
          "unavailable",
          "远程通道不可用",
          snapshot.error ?? "cloudflared 启动或运行失败",
          `tunnel:${snapshot.mode}:${snapshot.error ?? "failed"}`
        );
      }
      this.emitStatus();
      void this.sendHeartbeat();
    });

    this.codexConfigWatcher = new CodexConfigWatcher({
      onChange: (change) => this.handleCodexConfigChange(change)
    });
    this.codexConfigWatcher.start();
    this.diagnosticLog.write("codex", "config_watcher_started", {
      directory: this.codexConfigWatcher.directory
    });

    try {
      await this.localService.start();
      await this.refreshAuthStatus();
      await this.restoreCloudSession();
      await this.flushIssueReportQueue();
    } catch {
      // The status snapshot already contains a user-facing startup error.
    }
    this.emitStatus();
    this.heartbeatTimer = setInterval(() => void this.sendHeartbeat(), 60_000);
    this.updateManager.startAutomaticChecks();
  }

  async shutdown(): Promise<void> {
    this.diagnosticLog?.write("desktop", "application_stopping");
    this.updateManager?.stop();
    this.codexConfigWatcher?.stop();
    if (this.runtimeReloadRetryTimer) clearTimeout(this.runtimeReloadRetryTimer);
    this.runtimeReloadRetryTimer = null;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.localRestartTimer) clearTimeout(this.localRestartTimer);
    if (this.localStableTimer) clearTimeout(this.localStableTimer);
    await this.tunnel?.stop();
    await this.localService?.stop();
    this.diagnosticLog?.write("desktop", "application_stopped");
  }

  private async prepareForUpdateInstall(): Promise<void> {
    this.diagnosticLog?.write("desktop", "update_install_prepare_started");
    this.updateManager?.stop();
    this.codexConfigWatcher?.stop();
    if (this.runtimeReloadRetryTimer) clearTimeout(this.runtimeReloadRetryTimer);
    this.runtimeReloadRetryTimer = null;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.localRestartTimer) clearTimeout(this.localRestartTimer);
    if (this.localStableTimer) clearTimeout(this.localStableTimer);

    const stopTasks: Promise<void>[] = [];
    if (this.tunnel) stopTasks.push(this.tunnel.stop());
    if (this.localService) stopTasks.push(this.localService.stop());
    const stopResults = await withTimeout(
      Promise.allSettled(stopTasks),
      12_000,
      () => this.diagnosticLog?.write("desktop", "update_install_prepare_timeout", { timeoutMs: 12_000 })
    );
    const stopErrors = (stopResults ?? []).flatMap((result) => {
      if (result.status !== "rejected") return [];
      return [result.reason instanceof Error ? result.reason.message : String(result.reason)];
    });
    this.diagnosticLog?.write("desktop", "update_install_prepare_finished", {
      timedOut: stopResults === null,
      stopErrors
    });
  }

  showWindow(): void {
    this.window?.show();
    this.window?.focus();
  }

  private createWindow(): void {
    this.window = new BrowserWindow({
      width: 980,
      height: 760,
      minWidth: 760,
      minHeight: 620,
      title: "Codex Manage",
      show: false,
      webPreferences: {
        preload: join(__dirname, "../preload/index.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    this.window.removeMenu();
    void this.window.loadFile(join(__dirname, "../../renderer/index.html"));
    this.window.once("ready-to-show", () => {
      if (!this.startHidden) this.window?.show();
    });
    this.window.on("close", (event) => {
      if (!isQuitting) {
        event.preventDefault();
        this.window?.hide();
      }
    });
    this.window.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith("https://") || url.startsWith("http://")) void shell.openExternal(url);
      return { action: "deny" };
    });
    this.window.webContents.on("will-navigate", (event) => event.preventDefault());
    this.window.webContents.on("render-process-gone", (_event, details) => {
      void this.reportAutomaticIssue(
        "auto_crash",
        "crash",
        "桌面渲染进程崩溃",
        `reason=${details.reason}; exitCode=${details.exitCode}`,
        `renderer-crash:${details.reason}:${details.exitCode}`
      );
    });
  }

  private createTray(): void {
    const icon = this.createDesktopIcon();
    this.tray = new Tray(icon.resize({ width: 18, height: 18 }));
    this.tray.setToolTip("Codex Manage");
    this.updateTrayMenu();
    this.tray.on("click", () => this.showWindow());
    if (process.platform === "win32") {
      this.tray.on("double-click", () => this.showWindow());
    }
  }

  private createDesktopIcon() {
    const iconCandidates = [
      join(process.resourcesPath, "app-icon.png"),
      resolve(app.getAppPath(), "../../public/icon-512.png"),
      resolve(process.cwd(), "public/icon-512.png"),
      resolve(process.cwd(), "../../public/icon-512.png"),
      resolve(__dirname, "../../../../../public/icon-512.png")
    ];
    for (const iconPath of iconCandidates) {
      if (!existsSync(iconPath)) continue;
      const icon = nativeImage.createFromPath(iconPath);
      if (!icon.isEmpty()) return icon;
    }
    return nativeImage.createFromDataURL(
      `data:image/svg+xml;base64,${Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="7" fill="#1769aa"/><path d="M9 9h14v4H13v6h10v4H9z" fill="white"/></svg>'
      ).toString("base64")}`
    );
  }

  private updateTrayMenu(): void {
    if (!this.tray) return;
    const updateStatus = this.updateManager?.getStatus();
    this.tray.setContextMenu(Menu.buildFromTemplate([
      { label: "打开 Codex Manage", click: () => this.showWindow() },
      { label: "打开本机管理台", click: () => void this.openLocalManage() },
      {
        label: "复制远程访问地址",
        click: () => {
          const url = this.tunnel?.getSnapshot().publicUrl;
          if (url) clipboard.writeText(url);
        }
      },
      { type: "separator" },
      { label: "启动远程通道", click: () => void this.startTunnel() },
      { label: "停止远程通道", click: () => void this.stopTunnel() },
      { type: "separator" },
      { label: "上报问题", click: () => this.showWindow() },
      { type: "separator" },
      {
        label: updateStatus?.state === "downloaded" ? "安装已下载更新" : "检查更新",
        click: () => updateStatus?.state === "downloaded"
          ? void this.installDownloadedUpdate()
          : void this.checkForUpdates()
      },
      { type: "separator" },
      { label: "退出", click: () => app.quit() }
    ]));
  }

  private registerIpc(): void {
    ipcMain.handle("desktop:get-status", async () => {
      await this.refreshAuthStatus();
      await this.refreshCloudState();
      return this.getStatus();
    });
    ipcMain.handle("desktop:setup-password", async (_event, password: unknown) => {
      if (typeof password !== "string") throw new Error("密码格式不正确");
      await this.controlRequest("/api/desktop/setup", { method: "POST", body: { password } });
      await this.refreshAuthStatus();
      this.emitStatus();
      return this.getStatus();
    });
    ipcMain.handle("desktop:request-verification-code", async (_event, type: unknown, identifier: unknown) => {
      if ((type !== "email" && type !== "phone") || typeof identifier !== "string") {
        throw new Error("注册信息格式不正确");
      }
      return await this.cloudClient.requestVerificationCode(type, identifier);
    });
    ipcMain.handle("desktop:register-account", async (_event, type: unknown, identifier: unknown, code: unknown, password: unknown) => {
      if ((type !== "email" && type !== "phone") || typeof identifier !== "string" || typeof code !== "string" || typeof password !== "string") {
        throw new Error("注册信息格式不正确");
      }
      await this.acceptCloudAuthentication(await this.cloudClient.register(type, identifier, code, password));
      return this.getStatus();
    });
    ipcMain.handle("desktop:login-account", async (_event, identifier: unknown, password: unknown) => {
      if (typeof identifier !== "string" || typeof password !== "string") throw new Error("登录信息格式不正确");
      await this.acceptCloudAuthentication(await this.cloudClient.login(identifier, password));
      return this.getStatus();
    });
    ipcMain.handle("desktop:logout-account", async () => this.logoutCloudAccount());
    ipcMain.handle("desktop:unbind-device", async () => this.unbindDevice());
    ipcMain.handle("desktop:provision-named-tunnel", async () => this.provisionNamedTunnel());
    ipcMain.handle("desktop:start-tunnel", async () => this.startTunnel());
    ipcMain.handle("desktop:stop-tunnel", async () => this.stopTunnel());
    ipcMain.handle("desktop:create-pairing-url", async () => this.createPairingUrl());
    ipcMain.handle("desktop:open-local-manage", async () => this.openLocalManage());
    ipcMain.handle("desktop:set-launch-at-login", async (_event, enabled: unknown) => {
      if (typeof enabled !== "boolean") throw new Error("开机启动设置格式不正确");
      app.setLoginItemSettings({
        openAtLogin: enabled,
        openAsHidden: process.platform === "darwin" ? enabled : undefined,
        args: enabled ? ["--hidden"] : []
      });
      this.launchAtLogin = app.getLoginItemSettings().openAtLogin;
      this.diagnosticLog?.write("desktop", "launch_at_login_changed", { enabled: this.launchAtLogin });
      this.emitStatus();
      return this.getStatus();
    });
    ipcMain.handle("desktop:export-diagnostic-logs", async () => this.exportDiagnosticLogs());
    ipcMain.handle("desktop:check-for-updates", async () => this.checkForUpdates());
    ipcMain.handle("desktop:install-update", async () => this.installDownloadedUpdate());
    ipcMain.handle("desktop:submit-issue-report", async (_event, input: unknown) => this.submitIssueReport(input));
    ipcMain.handle("desktop:set-issue-auto-report-enabled", async (_event, enabled: unknown) => {
      if (typeof enabled !== "boolean") throw new Error("自动上报设置格式不正确");
      this.issueReporting = { ...this.issueReporting, autoEnabled: enabled };
      this.desktopSettingsStore?.save({ issueAutoReportEnabled: enabled });
      this.diagnosticLog?.write("issue-report", "auto_setting_changed", { enabled });
      if (enabled) void this.flushIssueReportQueue();
      this.emitStatus();
      return this.getStatus();
    });
    ipcMain.handle("desktop:list-billing-plans", async () => this.listBillingPlans());
    ipcMain.handle("desktop:create-billing-order", async (_event, planId: unknown, channel: unknown) => {
      if (typeof planId !== "string" || !isPaymentChannel(channel)) throw new Error("支付订单参数不正确");
      return await this.createBillingOrder(planId, channel);
    });
    ipcMain.handle("desktop:pay-billing-order", async (_event, orderId: unknown, channel: unknown) => {
      if (typeof orderId !== "string" || !isPaymentChannel(channel)) throw new Error("支付参数不正确");
      return await this.payBillingOrder(orderId, channel);
    });
    ipcMain.handle("desktop:get-billing-order", async (_event, orderId: unknown) => {
      if (typeof orderId !== "string") throw new Error("订单参数不正确");
      return await this.getBillingOrder(orderId);
    });
    ipcMain.handle("desktop:close-billing-order", async (_event, orderId: unknown) => {
      if (typeof orderId !== "string") throw new Error("订单参数不正确");
      return await this.closeBillingOrder(orderId);
    });
  }

  private async checkForUpdates() {
    if (!this.updateManager) throw new Error("更新服务尚未初始化");
    return await this.updateManager.checkForUpdates(true);
  }

  private async installDownloadedUpdate() {
    if (!this.updateManager) throw new Error("更新服务尚未初始化");
    return await this.updateManager.installDownloadedUpdate();
  }

  private handleCodexConfigChange(change: CodexConfigChange): void {
    const reason = `codex_config_changed:${change.signature.slice(0, 12)}`;
    this.runtimeReloadRetryAttempt = 0;
    this.setRuntimeReloadStatus({
      state: "pending",
      trigger: "desktop_auto",
      reason,
      lastDetectedAt: change.changedAt,
      error: null
    });
    this.diagnosticLog?.write("codex", "config_changed", {
      directory: change.directory,
      signature: change.signature.slice(0, 12)
    });
    this.scheduleRuntimeReload(reason, 1500);
  }

  private scheduleRuntimeReload(reason: string, delayMs: number): void {
    if (this.runtimeReloadRetryTimer) clearTimeout(this.runtimeReloadRetryTimer);
    const nextRetryAt = new Date(Date.now() + delayMs).toISOString();
    this.setRuntimeReloadStatus({
      state: this.runtimeReload.state === "blocked" ? "blocked" : "pending",
      trigger: "desktop_auto",
      reason,
      nextRetryAt
    });
    this.runtimeReloadRetryTimer = setTimeout(() => {
      this.runtimeReloadRetryTimer = null;
      void this.reloadRuntimeAfterCodexConfigChange(reason);
    }, delayMs);
  }

  private async reloadRuntimeAfterCodexConfigChange(reason: string): Promise<void> {
    const local = this.localService?.getSnapshot();
    if (!local?.url) {
      this.runtimeReloadRetryAttempt += 1;
      this.setRuntimeReloadStatus({
        state: "pending",
        trigger: "desktop_auto",
        reason,
        error: "本地服务尚未运行"
      });
      this.scheduleRuntimeReload(reason, runtimeReloadRetryDelayMs(this.runtimeReloadRetryAttempt));
      return;
    }

    this.setRuntimeReloadStatus({
      state: "reloading",
      trigger: "desktop_auto",
      reason,
      lastAttemptAt: new Date().toISOString(),
      nextRetryAt: null,
      error: null
    });

    try {
      const response = await this.controlRequest<{
        runtime: {
          generation: number;
          reloadedAt: string;
          trigger: "manual" | "desktop_auto";
          reason: string | null;
        };
      }>("/api/runtime/reload", {
        method: "POST",
        body: {
          trigger: "desktop_auto",
          reason
        }
      });
      this.runtimeReloadRetryAttempt = 0;
      this.codex = await new CodexLocator().locate().catch(() => this.codex);
      this.setRuntimeReloadStatus({
        state: "succeeded",
        trigger: "desktop_auto",
        reason: response.runtime.reason ?? reason,
        lastReloadedAt: response.runtime.reloadedAt,
        nextRetryAt: null,
        error: null
      });
      this.diagnosticLog?.write("codex", "runtime_auto_reloaded", {
        generation: response.runtime.generation,
        reloadedAt: response.runtime.reloadedAt
      });
    } catch (error) {
      this.runtimeReloadRetryAttempt += 1;
      const statusCode = (error as { statusCode?: number }).statusCode;
      const code = (error as { code?: string }).code;
      const blocked = statusCode === 409 || code === "RUNTIME_RELOAD_BLOCKED";
      this.setRuntimeReloadStatus({
        state: blocked ? "blocked" : "failed",
        trigger: "desktop_auto",
        reason,
        error: errorMessage(error)
      });
      this.diagnosticLog?.write("codex", blocked ? "runtime_auto_reload_blocked" : "runtime_auto_reload_failed", {
        attempt: this.runtimeReloadRetryAttempt,
        statusCode,
        code,
        error: errorMessage(error)
      });
      this.scheduleRuntimeReload(reason, runtimeReloadRetryDelayMs(this.runtimeReloadRetryAttempt, blocked));
    }
  }

  private setRuntimeReloadStatus(patch: Partial<DesktopStatus["runtimeReload"]>): void {
    this.runtimeReload = { ...this.runtimeReload, ...patch };
    this.emitStatus();
  }

  private async submitIssueReport(input: unknown): Promise<IssueReportSubmissionResult> {
    if (!input || typeof input !== "object") throw new Error("问题上报内容格式不正确");
    const record = input as Partial<{ category: IssueReportCategory; title: string; description: string }>;
    if (!isIssueReportCategory(record.category) || typeof record.title !== "string" || typeof record.description !== "string") {
      throw new Error("问题上报内容格式不正确");
    }
    const title = record.title.trim();
    const description = record.description.trim();
    if (!title || !description) throw new Error("请填写问题标题和描述");
    if (!this.cloudSession) throw new Error("请先登录平台账号再上报问题");

    const payload = this.buildIssueReportPayload({
      category: record.category,
      title,
      description,
      fingerprint: `manual:${record.category}:${title.slice(0, 80)}`
    });
    try {
      await this.ensureUserAccess();
      const response = await this.cloudClient.submitManualIssueReport(this.cloudSession.accessToken, payload);
      this.markIssueReportSubmitted();
      return {
        queued: false,
        reportId: response.report.id,
        duplicateCount: response.report.duplicateCount ?? null
      };
    } catch (error) {
      if (!shouldQueueIssueReport(error)) throw error;
      this.issueReportQueue?.enqueue("manual", payload, errorMessage(error));
      this.issueReporting = {
        ...this.issueReporting,
        queuedCount: this.issueReportQueue?.count() ?? 0,
        lastError: errorMessage(error)
      };
      this.emitStatus();
      return { queued: true, reportId: null, duplicateCount: null };
    }
  }

  private async startTunnel(): Promise<DesktopStatus> {
    const MAX_RETRIES = 2;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        await this.refreshAuthStatus();
        if (this.auth.setupRequired) throw new Error("请先设置本机访问密码");
        if (!this.cloudSession) throw new Error("请先注册或登录平台账号");
        const local = this.localService?.getSnapshot();
        if (!local?.url) throw new Error("本地服务尚未运行");
        await this.ensureDeviceSession();
        await this.refreshEntitlements();
        const config = await this.cloudClient.getTunnelConfig(
          this.cloudSession.deviceAccessToken!,
          this.cloudSession.deviceId!
        );
        this.namedTunnelStatus = config.namedTunnelStatus ?? (config.mode === "named" ? "active" : null);
        if (config.mode === "named" && config.token && config.hostname) {
          await this.tunnel?.startNamed(config.token, `https://${config.hostname}`);
        } else if (config.mode === "quick") {
          if (this.entitlements["tunnel.named"] === true) {
            const provisioned = await this.cloudClient.provisionNamedTunnel(
              this.cloudSession.accessToken,
              this.cloudSession.deviceId!
            );
            this.namedTunnelStatus = provisioned.tunnel.status;
            const configAfter = await this.cloudClient.getTunnelConfig(
              this.cloudSession.deviceAccessToken!,
              this.cloudSession.deviceId!
            );
            if (configAfter.mode === "named" && configAfter.token && configAfter.hostname) {
              await this.tunnel?.startNamed(configAfter.token, `https://${configAfter.hostname}`);
              await this.sendHeartbeat();
              return this.getStatus();
            }
          }
          await this.tunnel?.startQuick(local.url);
        } else {
          throw new Error("当前账号未开通远程访问权益");
        }
        await this.sendHeartbeat();
        return this.getStatus();
      } catch (error) {
        const statusCode = (error as { statusCode?: number }).statusCode;
        if ((statusCode === 500 || statusCode === 503) && attempt < MAX_RETRIES && !isQuitting) {
          this.diagnosticLog?.write("tunnel", "start_retry", { attempt: attempt + 1, error: errorMessage(error) });
          await new Promise((resolveRetry) => setTimeout(resolveRetry, 1000 * (attempt + 1)));
          continue;
        }
        throw error;
      }
    }
    throw new Error("远程通道启动失败，请稍后重试");
  }

  private async stopTunnel(): Promise<DesktopStatus> {
    await this.tunnel?.stop();
    await this.sendHeartbeat();
    return this.getStatus();
  }

  private async provisionNamedTunnel(): Promise<DesktopStatus> {
    if (!this.cloudSession) throw new Error("请先登录平台账号");
    await this.ensureUserAccess();
    await this.ensureDeviceSession();
    const result = await this.cloudClient.provisionNamedTunnel(
      this.cloudSession.accessToken,
      this.cloudSession.deviceId!
    );
    this.namedTunnelStatus = result.tunnel.status;
    this.emitStatus();
    return this.getStatus();
  }

  private async listBillingPlans() {
    return await this.cloudClient.getPlans();
  }

  private async createBillingOrder(planId: string, channel: PaymentChannel) {
    if (!this.cloudSession) throw new Error("请先登录平台账号");
    await this.ensureUserAccess();
    return await this.cloudClient.createOrder(this.cloudSession.accessToken, {
      planId,
      channel,
      clientType: "desktop"
    });
  }

  private async payBillingOrder(orderId: string, channel: PaymentChannel): Promise<BillingOrderDetail> {
    if (!this.cloudSession) throw new Error("请先登录平台账号");
    await this.ensureUserAccess();
    return await this.cloudClient.payOrder(this.cloudSession.accessToken, orderId, { channel }) as BillingOrderDetail;
  }

  private async getBillingOrder(orderId: string): Promise<BillingOrderDetail> {
    if (!this.cloudSession) throw new Error("请先登录平台账号");
    await this.ensureUserAccess();
    const detail = await this.cloudClient.getOrder(this.cloudSession.accessToken, orderId) as BillingOrderDetail;
    if (detail.order.status === "paid") {
      await this.refreshEntitlements();
      this.emitStatus();
    }
    return detail;
  }

  private async closeBillingOrder(orderId: string): Promise<{ closed: boolean }> {
    if (!this.cloudSession) throw new Error("请先登录平台账号");
    await this.ensureUserAccess();
    return await this.cloudClient.closeOrder(this.cloudSession.accessToken, orderId);
  }

  private async logoutCloudAccount(): Promise<DesktopStatus> {
    if (this.cloudSession) {
      this.saveDeviceBinding();
      await this.cloudClient.logout(this.cloudSession.accessToken, this.cloudSession.refreshToken).catch(() => undefined);
    }
    await this.tunnel?.stop();
    this.cloudSession = null;
    this.entitlements = {};
    this.subscription = null;
    this.namedTunnelStatus = null;
    this.cloudError = null;
    this.credentialVault?.clear();
    this.emitStatus();
    return this.getStatus();
  }

  private async unbindDevice(): Promise<DesktopStatus> {
    if (!this.cloudSession?.deviceId) throw new Error("当前设备尚未绑定");
    await this.ensureUserAccess();
    const session = this.cloudSession;
    this.cloudSession = null;
    try {
      await this.cloudClient.revokeDevice(session.accessToken, session.deviceId!);
      await this.tunnel?.stop();
      await this.controlRequest("/api/desktop/logout-all", { method: "POST", body: {} });
    } catch (error) {
      this.cloudSession = session;
      throw error;
    }
    this.diagnosticLog?.write("account", "device_unbound");
    this.deviceBindingVault?.clear(session.userId);
    this.entitlements = {};
    this.subscription = null;
    this.namedTunnelStatus = null;
    this.cloudError = null;
    this.credentialVault?.clear();
    this.emitStatus();
    return this.getStatus();
  }

  private async exportDiagnosticLogs(): Promise<string | null> {
    const options = {
      title: "导出 Codex Manage 诊断日志",
      defaultPath: `codex-manage-diagnostics-${new Date().toISOString().slice(0, 10)}.jsonl`,
      filters: [{ name: "JSON Lines", extensions: ["jsonl"] }]
    };
    const result = this.window
      ? await dialog.showSaveDialog(this.window, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return null;
    this.diagnosticLog?.write("desktop", "diagnostics_exported");
    this.diagnosticLog?.exportTo(result.filePath);
    return result.filePath;
  }

  private async reportAutomaticIssue(
    source: "auto_crash" | "auto_unavailable" | "auto_defect" | "auto_optimization" | "auto_requirement",
    category: IssueReportCategory,
    title: string,
    description: string,
    fingerprint: string
  ): Promise<void> {
    if (!this.issueReporting.autoEnabled || !this.cloudSession) return;
    const normalizedFingerprint = fingerprint.slice(0, 180);
    if (this.reportedAutomaticFingerprints.has(normalizedFingerprint)) return;
    this.reportedAutomaticFingerprints.add(normalizedFingerprint);

    const payload = {
      ...this.buildIssueReportPayload({
        category,
        title,
        description,
        fingerprint: normalizedFingerprint
      }),
      source
    };

    try {
      await this.ensureDeviceSession();
      if (!this.cloudSession?.deviceAccessToken || !this.cloudSession.deviceId) return;
      await this.cloudClient.submitAutoIssueReport(
        this.cloudSession.deviceAccessToken,
        this.cloudSession.deviceId,
        payload
      );
      this.markIssueReportSubmitted();
    } catch (error) {
      if (shouldQueueIssueReport(error)) {
        this.issueReportQueue?.enqueue("auto", payload, errorMessage(error));
      }
      this.issueReporting = {
        ...this.issueReporting,
        queuedCount: this.issueReportQueue?.count() ?? 0,
        lastError: errorMessage(error)
      };
      this.emitStatus();
    }
  }

  private async flushIssueReportQueue(): Promise<void> {
    if (this.flushingIssueReports || !this.cloudSession || !this.issueReportQueue) return;
    this.flushingIssueReports = true;
    try {
      for (const report of this.issueReportQueue.list()) {
        try {
          await this.submitQueuedIssueReport(report);
          this.issueReportQueue.remove(report.id);
          this.markIssueReportSubmitted(false);
        } catch (error) {
          this.issueReportQueue.update({
            ...report,
            attempts: report.attempts + 1,
            lastError: errorMessage(error)
          });
          this.issueReporting = {
            ...this.issueReporting,
            queuedCount: this.issueReportQueue.count(),
            lastError: errorMessage(error)
          };
          break;
        }
      }
    } finally {
      this.flushingIssueReports = false;
      this.issueReporting = {
        ...this.issueReporting,
        queuedCount: this.issueReportQueue.count()
      };
      this.emitStatus();
    }
  }

  private async submitQueuedIssueReport(report: PendingIssueReport): Promise<void> {
    if (!this.cloudSession) throw new Error("请先登录平台账号");
    if (report.kind === "manual") {
      await this.ensureUserAccess();
      await this.cloudClient.submitManualIssueReport(this.cloudSession.accessToken, report.payload);
      return;
    }
    if (!this.issueReporting.autoEnabled) return;
    await this.ensureDeviceSession();
    if (!this.cloudSession?.deviceAccessToken || !this.cloudSession.deviceId) {
      throw new Error("设备凭证尚未就绪");
    }
    await this.cloudClient.submitAutoIssueReport(
      this.cloudSession.deviceAccessToken,
      this.cloudSession.deviceId,
      report.payload
    );
  }

  private buildIssueReportPayload(input: {
    category: IssueReportCategory;
    title: string;
    description: string;
    fingerprint: string | null;
  }): Record<string, unknown> {
    return {
      category: input.category,
      title: input.title.slice(0, 160),
      description: input.description.slice(0, 4000),
      deviceId: this.cloudSession?.deviceId ?? null,
      clientVersion: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      osVersion: release(),
      channel: process.env.CODEX_RELEASE_CHANNEL ?? "stable",
      fingerprint: input.fingerprint,
      runtimeSnapshot: this.buildRuntimeSnapshot(),
      diagnosticExcerpt: this.diagnosticLog?.recentEntries(80) ?? [],
      redactionVersion: "v1"
    };
  }

  private buildRuntimeSnapshot(): Record<string, unknown> {
    const local = this.localService?.getSnapshot() ?? null;
    const tunnel = this.tunnel?.getSnapshot() ?? null;
    return {
      capturedAt: new Date().toISOString(),
      app: {
        version: app.getVersion(),
        packaged: app.isPackaged,
        platform: process.platform,
        arch: process.arch,
        osVersion: release()
      },
      codex: {
        available: this.codex.available,
        version: this.codex.version,
        error: this.codex.error
      },
      localService: local ? {
        state: local.state,
        port: local.port,
        error: local.error
      } : null,
      tunnel: tunnel ? {
        state: tunnel.state,
        mode: tunnel.mode,
        hostname: tunnel.publicUrl ? safeHostname(tunnel.publicUrl) : null,
        error: tunnel.error
      } : null,
      update: this.updateManager?.getStatus() ?? null,
      account: {
        authenticated: this.cloudSession !== null,
        deviceId: this.cloudSession?.deviceId ?? null,
        namedTunnelStatus: this.namedTunnelStatus,
        error: this.cloudError
      }
    };
  }

  private markIssueReportSubmitted(clearError = true): void {
    this.issueReporting = {
      ...this.issueReporting,
      queuedCount: this.issueReportQueue?.count() ?? 0,
      lastSubmittedAt: new Date().toISOString(),
      lastError: clearError ? null : this.issueReporting.lastError
    };
    this.emitStatus();
  }

  private async createPairingUrl(): Promise<{ url: string; expiresAt: string }> {
    const publicUrl = this.tunnel?.getSnapshot().publicUrl;
    if (!publicUrl) throw new Error("远程通道尚未在线");
    const pairing = await this.controlRequest<{ code: string; expiresAt: string }>(
      "/api/desktop/pairing-code",
      { method: "POST", body: {} }
    );
    return {
      url: `${publicUrl.replace(/\/$/, "")}/#/pair?code=${encodeURIComponent(pairing.code)}`,
      expiresAt: pairing.expiresAt
    };
  }

  private async openLocalManage(): Promise<void> {
    const url = this.localService?.getSnapshot().url;
    if (!url) throw new Error("本地服务尚未运行");
    await shell.openExternal(url);
  }

  private scheduleLocalServiceRestart(): void {
    if (isQuitting || this.localRestartTimer || this.localRestartAttempts >= 3) return;
    this.localRestartAttempts += 1;
    const delay = 1000 * 2 ** (this.localRestartAttempts - 1);
    this.diagnosticLog?.write("local-service", "restart_scheduled", {
      attempt: this.localRestartAttempts,
      delay
    });
    this.localRestartTimer = setTimeout(() => {
      this.localRestartTimer = null;
      if (isQuitting) return;
      void this.localService?.start().catch((error) => {
        this.diagnosticLog?.write("local-service", "restart_failed", {
          attempt: this.localRestartAttempts,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }, delay);
  }

  private async refreshAuthStatus(): Promise<void> {
    if (!this.localService?.getSnapshot().url) return;
    try {
      const nextAuth = await this.controlRequest<Omit<DesktopAuthStatus, "ready">>("/api/desktop/status");
      this.auth = { ...nextAuth, ready: true };
    } catch {
      // Preserve the latest valid snapshot while the local process is restarting.
    }
  }

  private async restoreCloudSession(): Promise<void> {
    if (!this.cloudSession) return;
    try {
      await this.ensureUserAccess();
      await this.ensureDeviceSession();
      await this.refreshCloudState();
      await this.sendHeartbeat();
      this.cloudError = null;
    } catch (error) {
      this.cloudError = error instanceof Error ? error.message : String(error);
      if ((error as { statusCode?: number }).statusCode === 401) {
        this.cloudSession = null;
        this.credentialVault?.clear();
      }
    }
  }

  private async acceptCloudAuthentication(response: CloudAuthResponse): Promise<void> {
    const binding = this.deviceBindingVault?.load(response.user.id);
    this.cloudSession = {
      userId: response.user.id,
      identifier: response.user.identifier,
      accessToken: response.accessToken,
      refreshToken: response.refreshToken,
      accessExpiresAt: response.accessExpiresAt,
      refreshExpiresAt: response.refreshExpiresAt,
      deviceId: binding?.deviceId ?? null,
      deviceCredential: binding?.deviceCredential ?? null,
      deviceAccessToken: null,
      deviceAccessExpiresAt: null
    };
    if (binding) {
      this.diagnosticLog?.write("account", "device_binding_restored", { deviceId: binding.deviceId });
    }
    await this.ensureDeviceSession();
    await this.refreshCloudState();
    this.saveCloudSession();
    this.cloudError = null;
    await this.flushIssueReportQueue();
    this.emitStatus();
  }

  private async ensureUserAccess(): Promise<void> {
    if (!this.cloudSession) throw new Error("请先登录平台账号");
    if (Date.parse(this.cloudSession.accessExpiresAt) > Date.now() + 60_000) return;
    if (this.userRefreshPromise) return await this.userRefreshPromise;
    this.userRefreshPromise = this.refreshUserAccess().finally(() => {
      this.userRefreshPromise = null;
    });
    return await this.userRefreshPromise;
  }

  private async refreshUserAccess(): Promise<void> {
    if (!this.cloudSession) throw new Error("请先登录平台账号");
    const refreshed = await this.cloudClient.refresh(this.cloudSession.refreshToken);
    this.cloudSession = {
      ...this.cloudSession,
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      accessExpiresAt: refreshed.accessExpiresAt,
      refreshExpiresAt: refreshed.refreshExpiresAt
    };
    this.saveCloudSession();
  }

  private async ensureDeviceSession(): Promise<void> {
    if (this.deviceSessionPromise) return await this.deviceSessionPromise;
    this.deviceSessionPromise = this.createOrRefreshDeviceSession().finally(() => {
      this.deviceSessionPromise = null;
    });
    return await this.deviceSessionPromise;
  }

  private async createOrRefreshDeviceSession(): Promise<void> {
    if (!this.cloudSession) throw new Error("请先登录平台账号");
    await this.ensureUserAccess();
    const local = this.localService?.getSnapshot();
    if (!local?.port) throw new Error("本地服务尚未运行");

    if (!this.cloudSession.deviceCredential || !this.cloudSession.deviceId) {
      await this.registerCurrentDevice(local.port);
    }

    if (
      !this.cloudSession.deviceAccessToken
      || !this.cloudSession.deviceAccessExpiresAt
      || Date.parse(this.cloudSession.deviceAccessExpiresAt) <= Date.now() + 60_000
    ) {
      let exchanged;
      try {
        exchanged = await this.cloudClient.exchangeDeviceCredential(this.cloudSession.deviceCredential!);
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code !== "DEVICE_CREDENTIAL_INVALID") throw error;
        this.deviceBindingVault?.clear(this.cloudSession.userId);
        this.cloudSession = {
          ...this.cloudSession,
          deviceId: null,
          deviceCredential: null,
          deviceAccessToken: null,
          deviceAccessExpiresAt: null
        };
        await this.registerCurrentDevice(local.port);
        exchanged = await this.cloudClient.exchangeDeviceCredential(this.cloudSession.deviceCredential!);
      }
      this.cloudSession = {
        ...this.cloudSession,
        deviceId: exchanged.device.id,
        deviceAccessToken: exchanged.accessToken,
        deviceAccessExpiresAt: exchanged.expiresAt
      };
    }
    this.saveCloudSession();
  }

  private async registerCurrentDevice(originPort: number): Promise<void> {
    if (!this.cloudSession) throw new Error("请先登录平台账号");
    const registered = await this.cloudClient.registerDevice(this.cloudSession.accessToken, {
      name: hostname() || "Codex Manage Device",
      os: process.platform,
      arch: process.arch,
      clientVersion: app.getVersion(),
      codexCliVersion: this.codex.version,
      originPort
    });
    this.cloudSession = {
      ...this.cloudSession,
      deviceId: registered.device.id,
      deviceCredential: registered.credential
    };
    this.saveDeviceBinding();
  }

  private saveDeviceBinding(): void {
    if (!this.cloudSession?.deviceId || !this.cloudSession.deviceCredential) return;
    this.deviceBindingVault?.save({
      userId: this.cloudSession.userId,
      deviceId: this.cloudSession.deviceId,
      deviceCredential: this.cloudSession.deviceCredential
    });
  }

  private async refreshEntitlements(): Promise<void> {
    if (!this.cloudSession) return;
    await this.ensureUserAccess();
    this.entitlements = (await this.cloudClient.getEntitlements(this.cloudSession.accessToken)).entitlements;
    const current = (await this.cloudClient.getCurrentSubscription(this.cloudSession.accessToken)).subscription;
    this.subscription = current ? {
      planCode: current.plan_code,
      planName: current.plan_name,
      expiresAt: current.expires_at
    } : null;
  }

  private async refreshCloudState(): Promise<void> {
    if (!this.cloudSession) return;
    try {
      await this.ensureDeviceSession();
      await this.refreshEntitlements();
      const config = await this.cloudClient.getTunnelConfig(
        this.cloudSession.deviceAccessToken!,
        this.cloudSession.deviceId!
      );
      this.namedTunnelStatus = config.namedTunnelStatus ?? (config.mode === "named" ? "active" : null);
      this.cloudError = null;
    } catch (error) {
      this.cloudError = error instanceof Error ? error.message : String(error);
    }
  }

  private async sendHeartbeat(): Promise<void> {
    if (!this.cloudSession) return;
    try {
      await this.ensureDeviceSession();
      if (!this.cloudSession) return;
      const local = this.localService?.getSnapshot();
      const tunnel = this.tunnel?.getSnapshot();
      if (!local?.port || !tunnel) return;
      await this.cloudClient.heartbeat(
        this.cloudSession.deviceAccessToken!,
        this.cloudSession.deviceId!,
        {
          clientVersion: app.getVersion(),
          codexCliVersion: this.codex.version,
          originPort: local.port,
          tunnelStatus: tunnel.state,
          publicHostname: tunnel.publicUrl ? new URL(tunnel.publicUrl).hostname : null,
          errorCode: tunnel.state === "failed" ? "TUNNEL_FAILED" : null
        }
      );
      this.cloudError = null;
      void this.flushIssueReportQueue();
    } catch (error) {
      this.cloudError = error instanceof Error ? error.message : String(error);
      this.diagnosticLog?.write("cloud", "heartbeat_failed", { error: this.cloudError });
      void this.reportAutomaticIssue(
        "auto_unavailable",
        "unavailable",
        "云端心跳失败",
        this.cloudError,
        `heartbeat:${(error as { statusCode?: number }).statusCode ?? "network"}:${this.cloudError}`
      );
      const statusCode = (error as { statusCode?: number }).statusCode;
      if (statusCode === 401 || statusCode === 403 || statusCode === 404) {
        await this.tunnel?.stop();
      }
      this.emitStatus();
    }
  }

  private saveCloudSession(): void {
    if (this.cloudSession) this.credentialVault?.save(this.cloudSession);
  }

  private async controlRequest<T>(
    path: string,
    options: { method?: string; body?: unknown } = {}
  ): Promise<T> {
    const baseUrl = this.localService?.getSnapshot().url;
    if (!baseUrl) throw new Error("本地服务尚未运行");
    const response = await fetch(new URL(path, baseUrl), {
      method: options.method ?? "GET",
      headers: {
        "content-type": "application/json",
        "x-codex-desktop-token": this.controlToken
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: { code?: string; message?: string; details?: unknown } } | null;
      const error = new Error(payload?.error?.message ?? `本地服务请求失败：${response.status}`) as Error & {
        code?: string;
        statusCode?: number;
        details?: unknown;
      };
      error.code = payload?.error?.code;
      error.statusCode = response.status;
      error.details = payload?.error?.details;
      throw error;
    }
    return await response.json() as T;
  }

  private getStatus(): DesktopStatus {
    const local = this.localService?.getSnapshot() ?? {
      state: "idle" as const,
      url: null,
      port: null,
      error: null
    };
    const tunnel = this.tunnel?.getSnapshot() ?? {
      state: "idle" as const,
      mode: "quick" as const,
      publicUrl: null,
      error: null
    };
    return {
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      localService: local,
      codex: this.codex,
      auth: {
        ready: this.auth.ready,
        setupRequired: this.auth.setupRequired,
        activeSessionCount: this.auth.activeSessionCount
      },
      settings: {
        launchAtLogin: this.launchAtLogin
      },
      issueReporting: {
        ...this.issueReporting,
        queuedCount: this.issueReportQueue?.count() ?? this.issueReporting.queuedCount
      },
      runtimeReload: { ...this.runtimeReload },
      account: {
        authenticated: this.cloudSession !== null,
        identifier: this.cloudSession?.identifier ?? null,
        deviceId: this.cloudSession?.deviceId ?? null,
        entitlements: this.entitlements,
        subscription: this.subscription,
        namedTunnelStatus: this.namedTunnelStatus,
        error: this.cloudError
      },
      tunnel,
      update: this.updateManager?.getStatus() ?? {
        state: "idle",
        currentVersion: app.getVersion(),
        targetVersion: null,
        lastCheckedAt: null,
        progressPercent: null,
        error: null,
        manual: false
      }
    };
  }

  private emitStatus(): void {
    const status = this.getStatus();
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send("desktop:status", status);
    }
  }
}

function isIssueReportCategory(value: unknown): value is IssueReportCategory {
  return value === "crash"
    || value === "unavailable"
    || value === "defect"
    || value === "optimization"
    || value === "requirement";
}

function isPaymentChannel(value: unknown): value is PaymentChannel {
  return value === "wechat" || value === "alipay";
}

function shouldQueueIssueReport(error: unknown): boolean {
  const statusCode = (error as { statusCode?: number }).statusCode;
  return statusCode === undefined || statusCode === 408 || statusCode === 429 || statusCode >= 500;
}

function runtimeReloadRetryDelayMs(attempt: number, blocked = false): number {
  const baseDelay = blocked ? 15_000 : 5_000;
  return Math.min(60_000, baseDelay * 2 ** Math.min(Math.max(0, attempt - 1), 3));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeHostname(value: string): string | null {
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}

async function findAvailablePort(preferred: number): Promise<number> {
  if (await canListen(preferred)) return preferred;
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

async function canListen(port: number): Promise<boolean> {
  return await new Promise((resolveResult) => {
    const server = createServer();
    server.once("error", () => resolveResult(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolveResult(true)));
  });
}

async function withTimeout<T>(task: Promise<T>, timeoutMs: number, onTimeout: () => void): Promise<T | null> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      task,
      new Promise<null>((resolveTimeout) => {
        timeout = setTimeout(() => {
          onTimeout();
          resolveTimeout(null);
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

if (process.env.CODEX_DESKTOP_USER_DATA_DIR) {
  app.setPath("userData", process.env.CODEX_DESKTOP_USER_DATA_DIR);
}

const hasLock = app.requestSingleInstanceLock();
let controller: DesktopController | null = null;
let isQuitting = false;

if (!hasLock) {
  app.quit();
} else {
  app.on("second-instance", () => controller?.showWindow());
  app.on("window-all-closed", () => {
    // The application continues in the system tray.
  });
  app.on("before-quit", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    isQuitting = true;
    void controller?.shutdown().finally(() => app.quit());
  });

  void app.whenReady().then(async () => {
    const loginSettings = app.getLoginItemSettings();
    const startHidden = process.argv.includes("--hidden") || loginSettings.wasOpenedAtLogin;
    controller = new DesktopController(startHidden);
    await controller.initialize();
  });
}
