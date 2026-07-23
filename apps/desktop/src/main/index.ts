import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { hostname } from "node:os";
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
import { CloudClient, type CloudAuthResponse, type CloudSession } from "./CloudClient";
import { CredentialVault } from "./CredentialVault";
import { DiagnosticLog } from "./DiagnosticLog";
import { LocalServiceSupervisor } from "./LocalServiceSupervisor";
import { resolveCloudflaredBinary, TunnelSupervisor } from "./TunnelSupervisor";
import type { DesktopStatus } from "../shared/types";

type DesktopAuthStatus = {
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
    setupRequired: true,
    defaultPassword: false,
    activeSessionCount: 0
  };
  private readonly cloudClient = new CloudClient(
    process.env.CODEX_CONTROL_API_URL ?? "https://codex-api.xmwefun.cn"
  );
  private credentialVault: CredentialVault | null = null;
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

  constructor(private readonly startHidden = false) {}

  async initialize(): Promise<void> {
    this.diagnosticLog = new DiagnosticLog(join(app.getPath("userData"), "logs", "desktop-diagnostics.jsonl"));
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
    this.credentialVault = new CredentialVault(join(app.getPath("userData"), "cloud-credentials.json"));
    this.cloudSession = this.credentialVault.load();

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
      this.emitStatus();
      void this.sendHeartbeat();
    });

    try {
      await this.localService.start();
      await this.refreshAuthStatus();
      await this.restoreCloudSession();
    } catch {
      // The status snapshot already contains a user-facing startup error.
    }
    this.emitStatus();
    this.heartbeatTimer = setInterval(() => void this.sendHeartbeat(), 60_000);
  }

  async shutdown(): Promise<void> {
    this.diagnosticLog?.write("desktop", "application_stopping");
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.localRestartTimer) clearTimeout(this.localRestartTimer);
    if (this.localStableTimer) clearTimeout(this.localStableTimer);
    await this.tunnel?.stop();
    await this.localService?.stop();
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
  }

  private createTray(): void {
    const icon = nativeImage.createFromDataURL(
      `data:image/svg+xml;base64,${Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="7" fill="#1769aa"/><path d="M9 9h14v4H13v6h10v4H9z" fill="white"/></svg>'
      ).toString("base64")}`
    );
    this.tray = new Tray(icon.resize({ width: 18, height: 18 }));
    this.tray.setToolTip("Codex Manage");
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
      { label: "退出", click: () => app.quit() }
    ]));
    this.tray.on("click", () => this.showWindow());
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
        args: enabled ? ["--hidden"] : []
      });
      this.launchAtLogin = app.getLoginItemSettings().openAtLogin;
      this.diagnosticLog?.write("desktop", "launch_at_login_changed", { enabled: this.launchAtLogin });
      this.emitStatus();
      return this.getStatus();
    });
    ipcMain.handle("desktop:export-diagnostic-logs", async () => this.exportDiagnosticLogs());
  }

  private async startTunnel(): Promise<DesktopStatus> {
    await this.refreshAuthStatus();
    if (this.auth.setupRequired) throw new Error("请先设置本机访问密码");
    if (!this.cloudSession) throw new Error("请先注册或登录平台账号");
    const local = this.localService?.getSnapshot();
    if (!local?.url) throw new Error("本地服务尚未运行");
    await this.ensureDeviceSession();
    const config = await this.cloudClient.getTunnelConfig(
      this.cloudSession.deviceAccessToken!,
      this.cloudSession.deviceId!
    );
    this.namedTunnelStatus = config.namedTunnelStatus ?? (config.mode === "named" ? "active" : null);
    if (config.mode === "named" && config.token && config.hostname) {
      await this.tunnel?.startNamed(config.token, `https://${config.hostname}`);
    } else if (config.mode === "quick") {
      await this.tunnel?.startQuick(local.url);
    } else {
      throw new Error("当前账号未开通远程访问权益");
    }
    await this.sendHeartbeat();
    return this.getStatus();
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

  private async logoutCloudAccount(): Promise<DesktopStatus> {
    if (this.cloudSession) {
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
      this.auth = await this.controlRequest<DesktopAuthStatus>("/api/desktop/status");
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
    this.cloudSession = {
      userId: response.user.id,
      identifier: response.user.identifier,
      accessToken: response.accessToken,
      refreshToken: response.refreshToken,
      accessExpiresAt: response.accessExpiresAt,
      refreshExpiresAt: response.refreshExpiresAt,
      deviceId: null,
      deviceCredential: null,
      deviceAccessToken: null,
      deviceAccessExpiresAt: null
    };
    await this.ensureDeviceSession();
    await this.refreshCloudState();
    this.saveCloudSession();
    this.cloudError = null;
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
      const registered = await this.cloudClient.registerDevice(this.cloudSession.accessToken, {
        name: hostname() || "Codex Manage Device",
        os: process.platform,
        arch: process.arch,
        clientVersion: app.getVersion(),
        codexCliVersion: this.codex.version,
        originPort: local.port
      });
      this.cloudSession = {
        ...this.cloudSession,
        deviceId: registered.device.id,
        deviceCredential: registered.credential
      };
    }

    if (
      !this.cloudSession.deviceAccessToken
      || !this.cloudSession.deviceAccessExpiresAt
      || Date.parse(this.cloudSession.deviceAccessExpiresAt) <= Date.now() + 60_000
    ) {
      const exchanged = await this.cloudClient.exchangeDeviceCredential(this.cloudSession.deviceCredential!);
      this.cloudSession = {
        ...this.cloudSession,
        deviceId: exchanged.device.id,
        deviceAccessToken: exchanged.accessToken,
        deviceAccessExpiresAt: exchanged.expiresAt
      };
    }
    this.saveCloudSession();
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
    } catch (error) {
      this.cloudError = error instanceof Error ? error.message : String(error);
      this.diagnosticLog?.write("cloud", "heartbeat_failed", { error: this.cloudError });
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
      const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
      throw new Error(payload?.error?.message ?? `本地服务请求失败：${response.status}`);
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
        setupRequired: this.auth.setupRequired,
        activeSessionCount: this.auth.activeSessionCount
      },
      settings: {
        launchAtLogin: this.launchAtLogin
      },
      account: {
        authenticated: this.cloudSession !== null,
        identifier: this.cloudSession?.identifier ?? null,
        deviceId: this.cloudSession?.deviceId ?? null,
        entitlements: this.entitlements,
        subscription: this.subscription,
        namedTunnelStatus: this.namedTunnelStatus,
        error: this.cloudError
      },
      tunnel
    };
  }

  private emitStatus(): void {
    const status = this.getStatus();
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send("desktop:status", status);
    }
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
